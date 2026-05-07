/**
 * `startMill()` — programmatic entrypoint for a TOON Mill (swap peer).
 *
 * Story 12.7 — wires together:
 *   - Node identity          (`fromMnemonic` / `fromSecretKey` from SDK)
 *   - Mill chain keys        (`deriveMillKeys` from ./wallet.js — BIP-44
 *                             account index 2 per D12-011)
 *   - Payment-channel signers per chain family
 *   - Inventory + channel state
 *   - `MultiChainClaimIssuer` — populated with `signerAddresses` (closes
 *     the TODO(12.7) hook from Story 12.6)
 *   - `createSwapHandler` from the SDK, registered on kind:1059 (gift-wrap)
 *     via `HandlerRegistry`
 *   - An embedded / caller-supplied / URL-referenced connector
 *   - A minimal Hono-based BLS server serving `GET /health`
 *   - One fire-and-forget kind:10032 `IlpPeerInfo` publish at boot with
 *     `swapPairs` populated
 *
 * The shape mirrors `packages/town/src/town.ts`'s `startTown()` — same
 * composition pipeline, same ownership-based cleanup semantics, same
 * `MillInstance.stop()` idempotence guarantees.
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  ConnectorNode,
  createLogger as createConnectorLogger,
} from '@toon-protocol/connector';
import type { TransportConfig } from '@toon-protocol/connector';

import {
  HandlerRegistry,
  createSwapHandler,
  fromMnemonic,
  base58Encode,
} from '@toon-protocol/sdk';
import type { NodeIdentity, CreateSwapHandlerConfig } from '@toon-protocol/sdk';
import { buildIlpPeerInfoEvent, VERSION } from '@toon-protocol/core';
import type {
  EmbeddableConnectorLike,
  IlpPeerInfo,
  SwapPair,
} from '@toon-protocol/core';

import { deriveMillKeys } from './wallet.js';
import type { MillKeys, MillChainKind } from './wallet.js';
import { MillInventory } from './inventory.js';
import { MillChannelState } from './channel-state.js';
import type { ChannelEntry } from './channel-state.js';
import {
  EvmPaymentChannelSigner,
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
} from './payment-channel-signer.js';
import type { PaymentChannelSigner } from './payment-channel-signer.js';
import { MultiChainClaimIssuer } from './claim-issuer.js';
import { MillStartError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MillLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Story 12.8 AC-13 — injectable relay publisher.
 *
 * Default implementation uses `SimplePool.publish()` against
 * `config.relayUrls`. Tests substitute a capturing implementation so
 * they can assert the kind:10032 broadcast without spinning up a relay.
 * Publish failures are logged at `warn` and DO NOT fail Mill boot — a
 * flaky relay must not prevent a Mill from coming up.
 */
export interface Publisher {
  publish(event: unknown): Promise<void>;
}

/**
 * Configuration for starting a TOON Mill via `startMill()`.
 *
 * Exactly one of `mnemonic` or `secretKey` MUST be supplied.
 *
 * Connector wiring — three modes (mutually exclusive `connector` / `connectorUrl`):
 *   - `connector` supplied        → operator owns lifecycle; not closed on stop()
 *   - `connectorUrl` supplied     → embedded ConnectorNode auto-created with that
 *                                   URL as a parent BTP peer + a self-route for
 *                                   local delivery (Mill becomes a child of the
 *                                   parent connector). Mill owns lifecycle.
 *   - Neither supplied            → standalone embedded connector (no parent),
 *                                   gated on `btpServerPort`. Mill owns lifecycle.
 *
 * `swapPairs` MUST be non-empty.
 * `chains` MUST cover every distinct `pair.to.chain` family referenced.
 * `channels[chain]` + `inventory[chain]` MUST exist for every distinct
 * `pair.to.chain`.
 */
export interface MillConfig {
  // --- Identity (exactly one required) ---
  mnemonic?: string;
  secretKey?: Uint8Array;

  // --- Connector (at most one) ---
  connector?: EmbeddableConnectorLike;
  /**
   * Parent BTP URL. When set (and `connector` is not), the Mill auto-creates
   * an embedded ConnectorNode wired to this URL as a parent peer with a
   * self-route for local delivery. The Mill becomes a child of the parent
   * connector at `parentPeerId`.
   */
  connectorUrl?: string;
  /**
   * Peer ID of the parent connector when `connectorUrl` is set. Default `'apex'`.
   * Pure-routing identifier; the connector's `PeerConfig` has no `relation`
   * field — parent semantics live in the routing table (default `g.` route
   * points to this peer).
   */
  parentPeerId?: string;
  /**
   * BTP auth token for the parent peer. Default `''` (apex accepts no-auth).
   */
  parentAuthToken?: string;
  /**
   * Override for the embedded connector `nodeId` derivation. Default
   * `toon-mill-<pubkey16>`. Useful when an operator wants a stable identifier
   * across restarts that the parent's routing table can target.
   */
  nodeId?: string;

  // --- Mill-specific ---
  swapPairs: readonly SwapPair[];
  chains: readonly MillChainKind[];
  channels: Record<string, readonly ChannelEntry[]>;
  inventory: Record<string, bigint>;

  rateProvider?: CreateSwapHandlerConfig['rateProvider'];
  /**
   * Optional operator-supplied replay-protection set for the swap handler.
   *
   * SECURITY: this `Set<string>` is unbounded by default. The Mill accepts
   * gift-wrap packets from any peer (handler-level dispatch), so a malicious
   * sender can flood the Mill with distinct packet IDs and grow this set
   * until memory is exhausted. Operators SHOULD supply a bounded / LRU-backed
   * `Set`-like impl (or rely on `createSwapHandler`'s default policy — see
   * `@toon-protocol/sdk/swap-handler` for the in-process bound). This field
   * is forwarded verbatim; `startMill()` does NOT size-cap it.
   */
  seenPacketIds?: Set<string>;

  // --- Shared infra ---
  relayUrls: readonly string[];
  knownPeers?: readonly { ilpAddress: string; btpUrl?: string }[];
  blsPort?: number;
  /**
   * Story 12.8 AC-11 — BTP server port for the auto-created embedded
   * ConnectorNode (when `config.connector` and `config.connectorUrl`
   * are both omitted). Ignored if the operator supplies a connector.
   * Defaults to `3400` (distinct from Town's `3000` default so a Mill
   * and a Town can run side-by-side on one host without collision).
   */
  btpServerPort?: number;
  /**
   * Transport configuration for the auto-created embedded connector
   * (ator/SOCKS5 privacy overlay). When provided, passed directly to
   * ConnectorNode as `transport`. Ignored if `connector` is supplied.
   */
  transport?: TransportConfig;
  /**
   * Optional chainProviders to wire into the embedded connector for
   * per-packet claim verification + signing. One entry per EVM chain the
   * Mill plans to settle on; the shape mirrors the apex YAML
   * `chainProviders` block exactly. Ignored if `connector` is supplied
   * (operator owns its connector lifecycle and config in that mode).
   *
   * `keyId` defaults to the 0x-prefixed identity.secretKey hex when
   * omitted — the same secp256k1 key that derives the Nostr identity
   * doubles as the EVM signing key for claim issuance.
   */
  chainProviders?: readonly {
    chainType: 'evm';
    chainId: string;
    rpcUrl: string;
    registryAddress: string;
    tokenAddress: string;
    keyId?: string;
  }[];
  /**
   * EVM private key for embedded-connector ClaimReceiver / chainProviders
   * `keyId` defaults. When set, used in place of the 0x-hex identity
   * secret key. Lets operators wire the embedded connector's signer to a
   * funded EVM account (e.g. Anvil deterministic privkey) distinct from
   * the Nostr identity. Validated as `0x[0-9a-fA-F]{64}` at boot.
   */
  settlementPrivateKey?: string;
  /**
   * EVM treasury address advertised to the parent connector for the
   * embedded-with-parent peer entry. The apex's PerPacketClaimService uses
   * this as `peerAddress` when opening a settlement channel toward the
   * Mill. Only meaningful when `connectorUrl` is set; when omitted, the
   * parent peer entry has no `evmAddress` and the apex must supply
   * `peerAddress` explicitly via the `/channels` admin call.
   */
  parentEvmAddress?: string;
  passphrase?: string;
  logger?: MillLogger;

  /**
   * Published in kind:10032 as the Mill's ILP address. Used by peers to
   * route packets toward this node. Default: `g.toon.mill.<pubkey16>`.
   */
  ilpAddress?: string;
  /**
   * Published in kind:10032 as the Mill's BTP endpoint. Operators SHOULD
   * supply a reachable WebSocket URL (use the `wss://host:port` scheme for
   * production; the unencrypted WebSocket scheme is acceptable only for
   * local development) so peers can establish BTP sessions. Default: `''`
   * (indicates "not advertised"; peers will use BLS / bootstrap paths only).
   */
  btpEndpoint?: string;
  /**
   * Advertised asset code/scale on kind:10032 (independent of swapPairs).
   * Defaults to `{ assetCode: 'USD', assetScale: 6 }`.
   */
  advertisedAsset?: { assetCode: string; assetScale: number };

  /**
   * Story 12.8 AC-13 — optional injectable relay publisher.
   *
   * When omitted, the default implementation uses a
   * {@link SimplePool}-backed publisher that calls
   * `pool.publish(relayUrls, event)` with `Promise.allSettled` semantics
   * (per-relay failures logged at `warn`; boot does NOT fail). Tests
   * inject a capturing or rejecting publisher to assert the broadcast
   * path without spinning up a relay.
   */
  publisher?: Publisher;

  /**
   * @internal — test hook. When supplied, called exactly once with the
   * signed kind:10032 event immediately after `buildIlpPeerInfoEvent`
   * returns. Used by AC-6 tests to capture the event without reaching
   * into implementation internals. NOT part of the public contract.
   */
  __testHooks?: {
    onPeerInfoBuilt?: (event: unknown) => void;
  };
}

export interface MillInstance {
  readonly identity: NodeIdentity;
  readonly blsPort: number;
  readonly millKeys: MillKeys;
  /**
   * Story 12.8 AC-11 — the effective connector the Mill is wired to.
   *
   * - When `config.connector` was supplied: that value, verbatim.
   * - When neither `config.connector` nor `config.connectorUrl` were
   *   supplied: an auto-created embedded {@link ConnectorNode}.
   * - Otherwise: `undefined`.
   *
   * Ownership: lifecycle of auto-created connectors is managed by the
   * Mill (`stop()` closes them). Operator-supplied connectors are
   * owned by the caller and NOT closed on `stop()`.
   */
  readonly connector?: EmbeddableConnectorLike;
  stop(): Promise<void>;
  health(): MillHealthResponse;
  /** @internal — AC-10 test hook. */
  readonly _handlerRegistry?: HandlerRegistry;
}

export interface MillHealthResponse {
  status: 'ok' | 'starting' | 'stopping' | 'stopped';
  version: string;
  nodePubkey: string;
  swapPairsCount: number;
  chains: readonly MillChainKind[];
  uptimeSec: number;
  inventory: Record<string, string>;
  /** Configured swap pairs — operator-config, no secrets. */
  swapPairs: SwapPair[];
  /** Per-asset available reserves, parallel to `inventory` (which is total). */
  inventoryAvailable: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map each distinct `pair.to.chain` to the Mill's on-chain signer address
 * for that chain. Closes the TODO(12.7) hook from
 * `packages/mill/src/claim-issuer.ts:40-43`.
 *
 * @internal — exported for unit testability (AC-5).
 */
export function buildSignerAddresses(
  pairs: readonly SwapPair[],
  keys: MillKeys
): Record<string, string> {
  const result: Record<string, string> = {};
  const distinctChains = new Set(pairs.map((p) => p.to.chain));
  for (const chain of distinctChains) {
    if (chain.startsWith('evm:')) {
      if (!keys.evm) {
        throw new MillStartError(
          'MISSING_KEY',
          `No EVM key derived but pair targets ${chain}`
        );
      }
      // Lowercase for deterministic byte-equal comparison across claims
      // during settlement (EVM verification is case-insensitive, but the
      // sender-side `build-settlement-tx.ts` consensus check is strict
      // string-equality). Note: `wallet.ts` emits EIP-55 mixed-case here;
      // we normalize to lowercase.
      result[chain] = keys.evm.address.toLowerCase();
    } else if (chain.startsWith('solana:')) {
      if (!keys.solana) {
        throw new MillStartError(
          'MISSING_KEY',
          `No Solana key derived but pair targets ${chain}`
        );
      }
      result[chain] = base58Encode(keys.solana.publicKey);
    } else if (chain.startsWith('mina:')) {
      if (!keys.mina) {
        throw new MillStartError(
          'MISSING_KEY',
          `No Mina key derived but pair targets ${chain}`
        );
      }
      result[chain] = keys.mina.publicKey;
    } else {
      throw new MillStartError(
        'UNSUPPORTED_CHAIN_FAMILY',
        `Unknown chain family in pair.to.chain=${chain}`
      );
    }
  }
  return result;
}

function noopLogger(): MillLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/**
 * Extract a log-safe summary from an unknown error value. Avoids serializing
 * raw `Error` instances (which may include a stack capturing surrounding
 * closure state — e.g. secretKey-derived intermediates — and any `cause`
 * chain that could leak sensitive signer material). We emit `{ name, message }`
 * only; operators who need stacks should install a debug-level custom logger.
 */
function errSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: String(err) };
}

function chainFamily(chain: string): MillChainKind | null {
  if (chain.startsWith('evm:')) return 'evm';
  if (chain.startsWith('solana:')) return 'solana';
  if (chain.startsWith('mina:')) return 'mina';
  return null;
}

function validateConfig(config: MillConfig): void {
  const hasMnemonic = config.mnemonic !== undefined;
  const hasSecretKey = config.secretKey !== undefined;

  if (hasMnemonic && hasSecretKey) {
    throw new MillStartError(
      'INVALID_CONFIG',
      'MillConfig: provide either mnemonic or secretKey, not both'
    );
  }
  if (!hasMnemonic && !hasSecretKey) {
    throw new MillStartError(
      'INVALID_CONFIG',
      'MillConfig: one of mnemonic or secretKey is required'
    );
  }
  if (hasSecretKey) {
    const sk = config.secretKey as Uint8Array;
    if (!(sk instanceof Uint8Array) || sk.length !== 32) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig.secretKey must be a 32-byte Uint8Array (got ${sk instanceof Uint8Array ? `${sk.length} bytes` : typeof sk})`
      );
    }
  }

  if (config.connector !== undefined && config.connectorUrl !== undefined) {
    throw new MillStartError(
      'INVALID_CONFIG',
      'MillConfig: provide either connector or connectorUrl, not both'
    );
  }

  if (!Array.isArray(config.swapPairs) || config.swapPairs.length === 0) {
    throw new MillStartError(
      'INVALID_CONFIG',
      'MillConfig.swapPairs MUST be a non-empty array'
    );
  }

  if (!Array.isArray(config.relayUrls) || config.relayUrls.length === 0) {
    throw new MillStartError(
      'INVALID_CONFIG',
      'MillConfig.relayUrls MUST be a non-empty array'
    );
  }

  const distinctTargetChains = new Set(config.swapPairs.map((p) => p.to.chain));
  for (const chain of distinctTargetChains) {
    const fam = chainFamily(chain);
    if (!fam) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig: unknown chain family in pair.to.chain=${chain}`
      );
    }
    if (!config.chains.includes(fam)) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig.chains missing family "${fam}" required by pair.to.chain=${chain}`
      );
    }
    const chanList = config.channels[chain];
    if (!Array.isArray(chanList) || chanList.length === 0) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig.channels["${chain}"] MUST be a non-empty array`
      );
    }
    const inv = config.inventory[chain];
    if (inv === undefined || typeof inv !== 'bigint' || inv < 0n) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig.inventory["${chain}"] MUST be a non-negative bigint`
      );
    }
  }

  if (config.chainProviders !== undefined) {
    if (!Array.isArray(config.chainProviders)) {
      throw new MillStartError(
        'INVALID_CONFIG',
        'MillConfig.chainProviders MUST be an array when set'
      );
    }
    for (const [i, p] of config.chainProviders.entries()) {
      const required: readonly (keyof typeof p)[] = [
        'chainType',
        'chainId',
        'rpcUrl',
        'registryAddress',
        'tokenAddress',
      ];
      for (const k of required) {
        const v = p[k];
        if (typeof v !== 'string' || v.length === 0) {
          throw new MillStartError(
            'INVALID_CONFIG',
            `MillConfig.chainProviders[${i}].${String(k)} MUST be a non-empty string`
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// startMill()
// ---------------------------------------------------------------------------

export async function startMill(config: MillConfig): Promise<MillInstance> {
  // 1. Validate config — fail BEFORE allocating resources.
  validateConfig(config);

  const logger = config.logger ?? noopLogger();
  const startedAt = Date.now();

  // 2/3. Mill key derivation (BIP-32) REQUIRES a mnemonic (D12-011). Check
  //      this before resolving identity so callers passing only a secretKey
  //      get a domain-specific error instead of a generic `IdentityError`.
  if (!config.mnemonic) {
    throw new MillStartError(
      'MILL_REQUIRES_MNEMONIC',
      'Mill key derivation (BIP-32) requires a BIP-39 mnemonic; pass config.mnemonic instead of secretKey'
    );
  }

  // Cryptographic-correctness guard: `fromMnemonic()` (SDK) does NOT accept
  // a BIP-39 passphrase, but `deriveMillKeys()` below does. Silently splitting
  // the derivation across two different seeds (identity without passphrase,
  // mill keys with) would yield a non-deterministic operator key tree that
  // cannot be recreated from the same mnemonic+passphrase pair. Reject at
  // boot so operators cannot misconfigure themselves into key-recovery hell.
  if (config.passphrase !== undefined && config.passphrase !== '') {
    throw new MillStartError(
      'INVALID_CONFIG',
      'MillConfig.passphrase is not supported: the Nostr-identity SDK derivation (fromMnemonic) does not accept a BIP-39 passphrase, so setting one would split identity and Mill-key derivation across inconsistent seeds. Use a passphrase-less mnemonic until SDK identity derivation supports passphrases.'
    );
  }

  const identity: NodeIdentity = fromMnemonic(config.mnemonic);
  const millKeys: MillKeys = await deriveMillKeys({
    mnemonic: config.mnemonic,
    chains: config.chains,
    // NOTE: passphrase intentionally omitted — rejected above for consistency
    // with `fromMnemonic()`. Re-enable once SDK identity derivation supports it.
  });

  // 4. Construct payment-channel signers per configured family.
  //    Re-use one signer instance per family across every `evm:*`/`solana:*`/
  //    `mina:*` chain — the chain-id is baked into `BalanceProofParams` at
  //    signing time, not into the signer itself (per AC-4 phase 4).
  const signers: Record<string, PaymentChannelSigner> = {};
  const distinctTargetChains = Array.from(
    new Set(config.swapPairs.map((p) => p.to.chain))
  );
  let sharedEvmSigner: EvmPaymentChannelSigner | undefined;
  let sharedSolanaSigner: SolanaPaymentChannelSigner | undefined;
  let sharedMinaSigner: MinaPaymentChannelSigner | undefined;
  for (const chain of distinctTargetChains) {
    if (chain.startsWith('evm:')) {
      if (!millKeys.evm) {
        throw new MillStartError(
          'MISSING_KEY',
          `Pair targets ${chain} but no EVM key was derived`
        );
      }
      // Re-use a single signer across all `evm:*` chains (AC-4 phase 4).
      sharedEvmSigner ??= new EvmPaymentChannelSigner({
        chain,
        privateKey: millKeys.evm.privateKey,
      });
      signers[chain] = sharedEvmSigner;
    } else if (chain.startsWith('solana:')) {
      if (!millKeys.solana) {
        throw new MillStartError(
          'MISSING_KEY',
          `Pair targets ${chain} but no Solana key was derived`
        );
      }
      sharedSolanaSigner ??= new SolanaPaymentChannelSigner({
        chain,
        privateKey: millKeys.solana.privateKey,
      });
      signers[chain] = sharedSolanaSigner;
    } else if (chain.startsWith('mina:')) {
      if (!millKeys.mina) {
        throw new MillStartError(
          'MISSING_KEY',
          `Pair targets ${chain} but no Mina key was derived`
        );
      }
      sharedMinaSigner ??= new MinaPaymentChannelSigner({
        chain,
        privateKey: millKeys.mina.privateKey,
        publicKey: millKeys.mina.publicKey,
      });
      signers[chain] = sharedMinaSigner;
    } else {
      throw new MillStartError(
        'UNSUPPORTED_CHAIN_FAMILY',
        `Unknown chain family in pair.to.chain=${chain}`
      );
    }
  }

  // 5. Inventory — map operator-supplied `Record<chain, bigint>` into the
  //    `MillInventory` per-asset/per-chain shape. We key off pair.to.assetCode
  //    for each referenced chain.
  const inventoryInit: Record<string, { available: bigint; total: bigint }> =
    {};
  for (const pair of config.swapPairs) {
    const chain = pair.to.chain;
    const asset = pair.to.assetCode;
    const bal = config.inventory[chain] ?? 0n;
    inventoryInit[`${asset}:${chain}`] = { available: bal, total: bal };
  }
  const inventory = new MillInventory({ balances: inventoryInit });

  // 6. Channel state — flatten `Record<chain, ChannelEntry[]>` into the
  //    `MillChannelState` key scheme (`assetCode:chain:senderPubkey`). For
  //    bootstrap we only know `chain`, not a sender — so we register each
  //    channel under `*` (wildcard) sender. The Story 12.8 E2E will replace
  //    this with per-sender provisioning as real peers connect.
  const channelInit: Record<string, ChannelEntry> = {};
  for (const pair of config.swapPairs) {
    const entries = config.channels[pair.to.chain] ?? [];
    for (const entry of entries) {
      const key = `${pair.to.assetCode}:${pair.to.chain}:${entry.channelId}`;
      channelInit[key] = { ...entry };
    }
  }
  const channelState = new MillChannelState({
    channels: channelInit,
    logger: { warn: logger.warn },
  });

  // 7. signerAddresses map + claim issuer.
  const signerAddresses = buildSignerAddresses(config.swapPairs, millKeys);
  const claimIssuer = new MultiChainClaimIssuer({
    inventory,
    signers,
    channelState,
    signerAddresses,
    logger: {
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
      error: logger.error,
    },
  });

  // 8. Swap handler.
  const swapHandler = createSwapHandler({
    recipientSecretKey: identity.secretKey,
    swapPairs: [...config.swapPairs],
    claimIssuer,
    ...(config.rateProvider && { rateProvider: config.rateProvider }),
    ...(config.seenPacketIds && { seenPacketIds: config.seenPacketIds }),
    logger: {
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
      error: logger.error,
    },
  });

  // 9/10. HandlerRegistry — register on kind:1059 (NIP-59 gift-wrap).
  const registry = new HandlerRegistry();
  try {
    registry.on(1059, swapHandler);
  } catch (err) {
    throw new MillStartError(
      'HANDLER_REGISTRATION_FAILED',
      'Failed to register swap handler on kind:1059',
      { cause: err }
    );
  }

  // 11. Connector ownership.
  //
  // Three ownership modes — see MillConfig docblock:
  //   - `config.connector` supplied         → caller owns; never closed by stop().
  //   - `config.connectorUrl` supplied      → embedded-with-parent: auto-create
  //                                           a ConnectorNode wired to the URL as
  //                                           a parent BTP peer, plus a self-route
  //                                           so packets addressed at `ilpAddress`
  //                                           land on the local handler. Mill owns.
  //   - Neither supplied (+ btpServerPort)  → standalone embedded connector. Mill owns.
  //
  // The embedded-with-parent path makes the Mill a child of an apex connector:
  // outbound packets fall through `g.*` to the parent, inbound packets matching
  // our own ilp prefix dispatch locally (PacketHandler zeros fees on local
  // delivery — see connector packet-handler.ts:1074-1077). `connectorFeePercentage:
  // 0` is set defensively to zero fees on the child even on non-local hops.
  let ownsConnector = false;
  let autoCreatedConnector: ConnectorNode | null = null;
  let effectiveConnector: EmbeddableConnectorLike | undefined =
    config.connector;

  if (config.connector === undefined && config.connectorUrl !== undefined) {
    const nodeId = config.nodeId ?? `toon-mill-${identity.pubkey.slice(0, 16)}`;
    // `btpServerPort` is required by ConnectorNode (rejects port=0 / undefined).
    // Default to 3000 to match the parent-link assumption documented in the
    // dev infra fixtures; operators may override via config.btpServerPort.
    const btpServerPort = config.btpServerPort ?? 3000;
    const parentPeerId = config.parentPeerId ?? 'apex';
    const parentAuthToken = config.parentAuthToken ?? '';
    const ilpAddress =
      config.ilpAddress ?? `g.toon.mill.${identity.pubkey.slice(0, 16)}`;
    const connectorLogger = createConnectorLogger(
      nodeId,
      (process.env['TOON_CONNECTOR_LOG_LEVEL'] as
        | 'debug'
        | 'info'
        | 'warn'
        | 'error'
        | undefined) ?? 'warn'
    );
    // Default each chainProviders entry's keyId to the operator-supplied
    // settlementPrivateKey when set, otherwise the 0x-prefixed identity
    // secret-key hex. Setting `settlementPrivateKey` lets the embedded
    // connector's ClaimReceiver/PerPacketClaimService sign with a funded
    // EVM account (e.g. Anvil deterministic privkey) distinct from the
    // Nostr identity.
    const millKeyHex =
      config.settlementPrivateKey ??
      `0x${Buffer.from(identity.secretKey).toString('hex')}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(millKeyHex)) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig.settlementPrivateKey must be a 0x-prefixed 32-byte hex string`
      );
    }
    const resolvedChainProviders = config.chainProviders?.map((p) => ({
      ...p,
      keyId: p.keyId ?? millKeyHex,
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connectorConfig: any = {
        nodeId,
        btpServerPort,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [
          {
            id: parentPeerId,
            url: config.connectorUrl,
            authToken: parentAuthToken,
            // Advertise our EVM treasury to the parent so the apex's
            // PerPacketClaimService can open a settlement channel toward
            // this Mill without needing kind:10032 discovery first.
            ...(config.parentEvmAddress && {
              evmAddress: config.parentEvmAddress,
            }),
          },
        ],
        routes: [
          // Self-route — packets addressed to our ILP prefix dispatch to the
          // local handler. `nextHop: nodeId` is the connector's local-delivery
          // convention; PacketHandler zeros fees on this hop.
          { prefix: ilpAddress, nextHop: nodeId, priority: 100 },
          // Default-up-to-parent — anything in the global `g` namespace that
          // didn't match the self-route falls through to the parent peer.
          // (Connector RoutingTable does longest-prefix match with trailing-
          // dot delimiter, so `g` matches `g.foo.bar` but not `gx`.)
          { prefix: 'g', nextHop: parentPeerId, priority: 0 },
        ],
        localDelivery: { enabled: false },
        // Children don't expose an admin API — the apex parent is the
        // operator-facing surface. Disabling avoids a hard runtime dep on
        // express in the mill docker bundle.
        adminApi: { enabled: false },
        // Belt-and-braces: zero fees on the child connector for any path
        // (local delivery already gets fee=0 from the connector itself).
        settlement: { connectorFeePercentage: 0 },
        ...(resolvedChainProviders &&
          resolvedChainProviders.length > 0 && {
            chainProviders: resolvedChainProviders,
          }),
      };
      if (config.transport) {
        connectorConfig.transport = config.transport;
      }
      autoCreatedConnector = new ConnectorNode(
        connectorConfig,
        connectorLogger
      );
      effectiveConnector =
        autoCreatedConnector as unknown as EmbeddableConnectorLike;
      ownsConnector = true;
      logger.debug?.('mill.connector.embedded_with_parent', {
        nodeId,
        btpServerPort,
        parentPeerId,
        parentUrl: config.connectorUrl,
        ilpAddress,
      });
    } catch (err) {
      logger.warn?.('mill.connector.auto_create_failed', {
        err: errSummary(err),
      });
    }
  } else if (
    config.connector === undefined &&
    config.connectorUrl === undefined &&
    config.btpServerPort !== undefined
  ) {
    // Standalone mode: auto-wire an embedded ConnectorNode with no parent
    // peer or routes. `ConnectorNode` rejects port=0 (OS-assigned), so the
    // explicit `btpServerPort` opt-in is what gates this branch.
    const nodeId = config.nodeId ?? `toon-mill-${identity.pubkey.slice(0, 16)}`;
    const btpServerPort = config.btpServerPort;
    const connectorLogger = createConnectorLogger(
      nodeId,
      (process.env['TOON_CONNECTOR_LOG_LEVEL'] as
        | 'debug'
        | 'info'
        | 'warn'
        | 'error'
        | undefined) ?? 'warn'
    );
    // Same chainProviders default-keyId behaviour as the embedded-with-parent
    // branch — see comment above. Standalone mills still benefit from
    // per-packet claim signing/verification when an operator wants it.
    const millKeyHex =
      config.settlementPrivateKey ??
      `0x${Buffer.from(identity.secretKey).toString('hex')}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(millKeyHex)) {
      throw new MillStartError(
        'INVALID_CONFIG',
        `MillConfig.settlementPrivateKey must be a 0x-prefixed 32-byte hex string`
      );
    }
    const resolvedChainProviders = config.chainProviders?.map((p) => ({
      ...p,
      keyId: p.keyId ?? millKeyHex,
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connectorConfig: any = {
        nodeId,
        btpServerPort,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [],
        routes: [],
        localDelivery: { enabled: false },
        ...(resolvedChainProviders &&
          resolvedChainProviders.length > 0 && {
            chainProviders: resolvedChainProviders,
          }),
      };
      if (config.transport) {
        connectorConfig.transport = config.transport;
      }
      autoCreatedConnector = new ConnectorNode(
        connectorConfig,
        connectorLogger
      );
      effectiveConnector =
        autoCreatedConnector as unknown as EmbeddableConnectorLike;
      ownsConnector = true;
      logger.debug?.('mill.connector.auto_created', { nodeId, btpServerPort });
    } catch (err) {
      logger.warn?.('mill.connector.auto_create_failed', {
        err: errSummary(err),
      });
    }
  }

  // 12. BLS server (Hono).
  let status: MillHealthResponse['status'] = 'starting';
  const getHealth = (): MillHealthResponse => {
    const snapshot = inventory.snapshot();
    const inv: Record<string, string> = {};
    const invAvailable: Record<string, string> = {};
    // Count distinct assetCodes per chain so we don't mask a multi-asset
    // chain behind a single `chain`-only key.
    const assetsPerChain = new Map<string, Set<string>>();
    for (const b of snapshot) {
      let set = assetsPerChain.get(b.chain);
      if (!set) {
        set = new Set<string>();
        assetsPerChain.set(b.chain, set);
      }
      set.add(b.assetCode);
    }
    for (const b of snapshot) {
      inv[`${b.assetCode}:${b.chain}`] = b.total.toString();
      invAvailable[`${b.assetCode}:${b.chain}`] = b.available.toString();
      // Operator convenience: also expose the chain key alone ONLY when
      // the chain has a single asset (otherwise the chain-only key would
      // silently overwrite between assets).
      if ((assetsPerChain.get(b.chain)?.size ?? 0) === 1) {
        inv[b.chain] = b.total.toString();
        invAvailable[b.chain] = b.available.toString();
      }
    }
    return {
      status,
      version: VERSION,
      nodePubkey: identity.pubkey,
      swapPairsCount: config.swapPairs.length,
      chains: config.chains,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      inventory: inv,
      swapPairs: [...config.swapPairs],
      inventoryAvailable: invAvailable,
    };
  };

  const app = new Hono();
  app.get('/health', (c: Context) => c.json(getHealth()));

  const blsServer: ServerType = serve({
    fetch: app.fetch,
    port: config.blsPort ?? 0,
  });

  // Resolve the live port (ephemeral when blsPort=0).
  const addrInfo = (
    blsServer as unknown as {
      address?: () => { port: number } | null;
    }
  ).address?.();
  const livePort = addrInfo?.port ?? config.blsPort ?? 0;

  // 12b. knownPeers acceptance — the config field is reserved for Story 12.8
  //      E2E, which will wire bootstrap-via-ILP publishing. For now, warn
  //      the operator so an erroneously-set knownPeers entry doesn't silently
  //      fail to advertise the Mill.
  if (config.knownPeers && config.knownPeers.length > 0) {
    logger.warn?.('mill.knownPeers.ignored', {
      count: config.knownPeers.length,
      reason:
        'bootstrap-via-ILP publishing is deferred to Story 12.8 E2E; knownPeers are accepted but not currently dispatched',
    });
  }

  // 13. Publish kind:10032 with swapPairs.
  //
  // Story 12.8 AC-13: resolve the publisher seam (either the operator-
  // supplied injection or a SimplePool-backed default), then broadcast
  // the built event. Publish is fire-and-forget with Promise.allSettled
  // semantics — a rejecting relay MUST NOT fail boot. The broadcast
  // runs on the next microtask (after `startMill()` resolves) so the
  // caller observes a ready Mill before relay I/O begins.
  let autoPool: SimplePool | undefined;
  const effectivePublisher: Publisher =
    config.publisher ??
    (() => {
      autoPool = new SimplePool();
      return {
        async publish(event: unknown): Promise<void> {
          // `Promise.allSettled` ensures a single rejecting relay cannot
          // surface an aggregate rejection back to the caller.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const promises = autoPool!.publish(
            [...config.relayUrls],
            event as NostrEvent
          );
          const results = await Promise.allSettled(promises);
          for (const r of results) {
            if (r.status === 'rejected') {
              logger.warn?.('mill.peerInfo.relay_publish_failed', {
                err: errSummary(r.reason),
              });
            }
          }
        },
      };
    })();

  try {
    const ownIlpInfo: IlpPeerInfo = {
      pubkey: identity.pubkey,
      ilpAddress:
        config.ilpAddress ?? `g.toon.mill.${identity.pubkey.slice(0, 16)}`,
      btpEndpoint: config.btpEndpoint ?? '',
      assetCode: config.advertisedAsset?.assetCode ?? 'USD',
      assetScale: config.advertisedAsset?.assetScale ?? 6,
      swapPairs: [...config.swapPairs],
    };
    const ilpInfoEvent = buildIlpPeerInfoEvent(ownIlpInfo, identity.secretKey);
    config.__testHooks?.onPeerInfoBuilt?.(ilpInfoEvent);
    logger.debug?.('mill.peerInfo.built', {
      id: ilpInfoEvent.id,
      swapPairs: config.swapPairs.length,
      relayUrls: config.relayUrls,
    });

    // Actually broadcast. Swallow promise rejection at this level — the
    // publisher impl already logs per-relay failures.
    void effectivePublisher.publish(ilpInfoEvent).catch((err) => {
      logger.warn?.('mill.peerInfo.publish_failed', { err: errSummary(err) });
    });
  } catch (err) {
    logger.warn?.('mill.peerInfo.publish_failed', { err: errSummary(err) });
  }

  status = 'ok';

  // 14. Build MillInstance.
  let stopped = false;
  const instance: MillInstance = {
    identity,
    blsPort: livePort,
    millKeys,
    ...(effectiveConnector !== undefined && { connector: effectiveConnector }),
    _handlerRegistry: registry,
    health: getHealth,
    async stop() {
      if (stopped) return;
      stopped = true;
      status = 'stopping';
      try {
        await new Promise<void>((resolve) => {
          blsServer.close(() => resolve());
        });
      } catch (err) {
        logger.warn?.('mill.stop.bls_close_failed', { err: errSummary(err) });
      }
      if (ownsConnector && effectiveConnector) {
        const closable = effectiveConnector as unknown as {
          close?: () => Promise<void> | void;
          stop?: () => Promise<void> | void;
        };
        try {
          if (typeof closable.close === 'function') {
            await closable.close();
          } else if (typeof closable.stop === 'function') {
            await closable.stop();
          }
        } catch (err) {
          logger.warn?.('mill.stop.connector_close_failed', {
            err: errSummary(err),
          });
        }
      }
      try {
        channelState.releaseAll();
      } catch (err) {
        logger.warn?.('mill.stop.release_all_failed', {
          err: errSummary(err),
        });
      }
      // Story 12.8 AC-13: close the auto-created SimplePool (if any) so the
      // Mill does not leak relay sockets on shutdown. Operator-injected
      // publishers are the caller's responsibility to close.
      if (autoPool) {
        try {
          (autoPool as unknown as { close?: (urls: string[]) => void }).close?.(
            [...config.relayUrls]
          );
        } catch (err) {
          logger.warn?.('mill.stop.pool_close_failed', {
            err: errSummary(err),
          });
        }
      }
      status = 'stopped';
    },
  };

  return instance;
}
