/**
 * `startSwapNode()` — programmatic entrypoint for a TOON swap node (swap peer).
 *
 * Story 12.7 — wires together:
 *   - Node identity          (`fromMnemonic` / `fromSecretKey` from SDK)
 *   - swap node chain keys        (`deriveSwapNodeKeys` from ./wallet.js — BIP-44
 *                             account index 2 per D12-011)
 *   - Payment-channel signers per chain family
 *   - Inventory + channel state
 *   - `MultiChainClaimIssuer` — populated with `signerAddresses` (closes
 *     the TODO(12.7) hook from Story 12.6)
 *   - The rolling swap engine + RFQ intake, registered on kind:1059
 *     (gift-wrap) local delivery (swap#154 retired the legacy
 *     `createSwapHandler` / `HandlerRegistry` wiring this used to also serve)
 *   - An embedded / caller-supplied / URL-referenced connector
 *   - A minimal Hono-based BLS server serving `GET /health`
 *   - One fire-and-forget kind:10032 `IlpPeerInfo` publish at boot with
 *     `swapPairs` populated
 *
 * The shape mirrors `packages/town/src/town.ts`'s `startTown()` — same
 * composition pipeline, same ownership-based cleanup semantics, same
 * `SwapNodeInstance.stop()` idempotence guarantees.
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  ConnectorNode,
  createLogger as createConnectorLogger,
  createPaymentHandlerAdapter,
} from '@toon-protocol/connector';
import type {
  LocalDeliveryHandler,
  LocalDeliveryRequest,
  TransportConfig,
} from '@toon-protocol/connector';

import { fromMnemonic, base58Encode } from '@toon-protocol/sdk';
import type { NodeIdentity } from '@toon-protocol/sdk';
import {
  buildIlpPeerInfoEvent,
  createDirectIlpClient,
  encodeEventToToon,
  VERSION,
} from '@toon-protocol/core';
import type {
  ConnectorNodeLike,
  EmbeddableConnectorLike,
  HandlePacketRequest,
  HandlePacketResponse,
  IlpPeerInfo,
  SwapPair,
} from '@toon-protocol/core';

import { deriveSwapNodeKeys } from './wallet.js';
import type { SwapNodeKeys, SwapNodeChainKind } from './wallet.js';
import type { SettlementEvent } from './settlement-event.js';
import { SwapInventory } from './inventory.js';
import { SwapChannelState } from './channel-state.js';
import type { ChannelEntry } from './channel-state.js';
import { createChannelOnChainReader } from './channel-reader.js';
import type { SolanaChannelReaderProvider } from './solana-channel-reader.js';
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  SwapInventoryReconciler,
} from './inventory-reconciler.js';
import type { ReconcileResult } from './inventory-reconciler.js';
import { registerAdminRoutes } from './admin-surface.js';
import {
  EvmPaymentChannelSigner,
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
} from './payment-channel-signer.js';
import type { PaymentChannelSigner } from './payment-channel-signer.js';
import { MultiChainClaimIssuer } from './claim-issuer.js';
import { SwapNodeStartError } from './errors.js';
import {
  JsonFileSwapStateStore,
  SwapStatePersister,
  PersistentSeenPacketIds,
} from './state-store.js';
import type { SwapStateStore, PersistedSwapState } from './state-store.js';
import {
  RateFreshnessGuard,
  validateMaxRateAgeConfig,
} from './rate-staleness.js';
import type { MaxRateAgeConfig, SwapRateProvider } from './rate-staleness.js';
import {
  RollingSessionStore,
  RollingSwapEngine,
  ROLLING_REJECT_REASONS,
  buildRollingReject,
  createConnectorLegBSender,
  parseRollingFillPayload,
} from './rolling-engine.js';
import type { LegBSender, RollingSession } from './rolling-engine.js';
import { createRollingRfqIntake } from './rolling-rfq.js';
import type { RollingRfqConfig } from './rolling-rfq.js';
import { createLegBReturnRouteBinder } from './leg-b-return-path.js';
import type { LegBReturnRouteBinder } from './leg-b-return-path.js';
import { SWAP_INTAKE_EVENT, formatPairLabel } from './intake-event.js';
import type { SwapIntakeClass } from './intake-event.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SwapNodeLogger {
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
 * Publish failures are logged at `warn` and DO NOT fail swap node boot — a
 * flaky relay must not prevent a swap node from coming up.
 */
export interface Publisher {
  publish(event: unknown): Promise<void>;
}

/**
 * Configuration for starting a TOON swap node via `startSwapNode()`.
 *
 * Exactly one of `mnemonic` or `secretKey` MUST be supplied.
 *
 * Connector wiring — three modes (mutually exclusive `connector` / `connectorUrl`):
 *   - `connector` supplied        → operator owns lifecycle; not closed on stop()
 *   - `connectorUrl` supplied     → embedded ConnectorNode auto-created with that
 *                                   URL as a parent BTP peer + a self-route for
 *                                   local delivery (swap node becomes a child of the
 *                                   parent connector). swap node owns lifecycle.
 *   - Neither supplied            → standalone embedded connector (no parent),
 *                                   gated on `btpServerPort`. swap node owns lifecycle.
 *
 * `swapPairs` MUST be non-empty.
 * `chains` MUST cover every distinct `pair.to.chain` family referenced.
 * `channels[chain]` + `inventory[chain]` MUST exist for every distinct
 * `pair.to.chain`.
 */

/**
 * Per-chain provider config wired into the swap node's embedded connector for
 * per-packet claim verification + signing. This is a structural mirror of
 * the connector's `ChainProviderConfigEntry` (`ProviderConfig & { chainId }`)
 * discriminated union — declared here (rather than imported) so the swap node's
 * public config surface does not take a compile-time type dep on a connector
 * internal. The connector validates these again at boot; the shapes MUST stay
 * in sync with `@toon-protocol/connector`'s
 * `settlement/provider/payment-channel-provider.ts`.
 *
 * `keyId` is declared optional on every variant because the swap node defaults it
 * (see {@link SwapNodeConfig.chainProviders}); the connector requires it for
 * evm/solana and treats it as optional for mina.
 */
export interface SwapNodeEvmChainProvider {
  chainType: 'evm';
  /** Namespaced chain id used by the connector registry, e.g. `evm:base:8453`. */
  chainId: string;
  /** JSON-RPC endpoint URL. */
  rpcUrl: string;
  /** TokenNetworkRegistry / PaymentChannel registry contract address. */
  registryAddress: string;
  /** Settlement token (USDC, M2M, …) contract address. */
  tokenAddress: string;
  /**
   * **Leg A** — the deployed `TokenNetwork` contract for `tokenAddress` on
   * this chain: the contract a *client* calls
   * `openChannel(address participant2, uint256 settlementTimeout)` on to open
   * the payment channel it pays this maker over. This is the address the
   * kind:10032 `tokenNetworks[chain]` entry carries, because that is the field
   * a stock client reads to open leg A (`ToonClient.negotiationFromAnnounce`
   * → `ChannelManager.ensureChannel` → `OnChainChannelClient.openChannel`).
   *
   * Fleet-wide agreement: this is the SAME `TokenNetwork` deployment the rest
   * of the fleet advertises for this chain/token (a claim resolves against one
   * deployment), so it is normally the registry entry that `registryAddress` +
   * `tokenAddress` resolve to — NOT a maker-private contract.
   *
   * Required, no default, and deliberately NOT defaulted to
   * {@link SwapNodeEvmChainProvider.channelAddress}: advertising the leg-B
   * `RollingSwapChannel` here makes every client's `ensureChannel` revert
   * (different ABI) and the swap fail before a packet is ever sent — an
   * invisible failure. Refusing to boot is the loud alternative (issue #133).
   */
  tokenNetworkAddress: string;
  /**
   * **Leg B** — the deployed `RollingSwapChannel` contract address for this
   * chain: the EIP-712 `verifyingContract` the swap node binds into its v2
   * balance-proof domain at signer construction (issue #101), i.e. the
   * contract the claims this maker hands back are signed against. Advertised
   * under the announce's own `swapVerifyingContracts` key — never under
   * `tokenNetworks`, which means leg A (above).
   *
   * Required, no default: a swap pair that targets this chain with no address
   * configured refuses to boot rather than issue claims nobody can verify.
   */
  channelAddress: string;
  /** Hex private key used to sign settlement claims. Defaulted by the swap node. */
  keyId?: string;
}

export interface SwapNodeSolanaChainProvider {
  chainType: 'solana';
  /** Namespaced chain id, e.g. `solana:devnet`. */
  chainId: string;
  /** Solana cluster RPC endpoint (HTTP). */
  rpcUrl: string;
  /** Solana WebSocket endpoint for account subscriptions (derived if absent). */
  wsUrl?: string;
  /** Payment-channel program ID (base58-encoded). */
  programId: string;
  /** SPL token mint address (base58-encoded) for the channel token. */
  tokenMint?: string;
  /** Solana cluster name for chain-id namespacing (e.g. `devnet`). */
  cluster?: string;
  /** Hex/base58 key used to sign Ed25519 settlement claims. Defaulted by the swap node. */
  keyId?: string;
}

export interface SwapNodeMinaChainProvider {
  chainType: 'mina';
  /** Namespaced chain id, e.g. `mina:devnet`. */
  chainId: string;
  /** Mina GraphQL endpoint. */
  graphqlUrl: string;
  /** zkApp address for the payment-channel contract (base58-encoded public key). */
  zkAppAddress: string;
  /** Mina token id (native MINA or a custom fungible token). */
  tokenId?: string;
  /** Mina network name for chain-id namespacing (e.g. `devnet`). */
  network?: string;
  /** Base58 key used to sign Poseidon-commitment settlement claims. Defaulted by the swap node. */
  keyId?: string;
}

/**
 * Discriminated union of all supported swap node chain-provider configs. Narrow on
 * the `chainType` field. Mirrors the connector's `ChainProviderConfigEntry`.
 */
export type SwapNodeChainProvider =
  | SwapNodeEvmChainProvider
  | SwapNodeSolanaChainProvider
  | SwapNodeMinaChainProvider;

export interface SwapNodeConfig {
  // --- Identity (exactly one required) ---
  mnemonic?: string;
  secretKey?: Uint8Array;

  // --- Connector (at most one) ---
  connector?: EmbeddableConnectorLike;
  /**
   * Parent BTP URL. When set (and `connector` is not), the swap node auto-creates
   * an embedded ConnectorNode wired to this URL as a parent peer with a
   * self-route for local delivery. The swap node becomes a child of the parent
   * connector at `parentPeerId`.
   */
  connectorUrl?: string;
  /**
   * Peer ID of the parent connector when `connectorUrl` is set. Default `'apex'`.
   * MUST equal the parent connector's **nodeId** — the embedded ConnectorNode
   * registers this peer with `relation: 'parent'`, and connector >=3.8.0 keys
   * peerRelations by the auth-declared peerId of the inbound BTP session (= the
   * parent's nodeId). A mismatch means the relation-aware inbound-claim skip
   * (toon-protocol/connector#78) never fires and parent-forwarded claimless
   * paid packets are F06-rejected.
   */
  parentPeerId?: string;
  /**
   * BTP auth token for the parent peer. Default `''` (apex accepts no-auth).
   */
  parentAuthToken?: string;
  /**
   * Override for the embedded connector `nodeId` derivation. Default
   * `toon-swap-<pubkey16>`. Useful when an operator wants a stable identifier
   * across restarts that the parent's routing table can target.
   */
  nodeId?: string;

  // --- swap-node-specific ---
  swapPairs: readonly SwapPair[];
  chains: readonly SwapNodeChainKind[];
  channels: Record<string, readonly ChannelEntry[]>;
  inventory: Record<string, bigint>;
  /**
   * Issue #49 — per-chain in-flight window ceiling for the ROLLING path
   * (rolling-swap §8: size it to `δ_max·W_max·R` plus a settlement-latency
   * buffer, NOT to notional volume). Keyed like {@link inventory}; applies
   * to every `(pair.to.assetCode, chain)` pool on that chain. Clamped to
   * live `available` at check time, so it can never advertise capital the
   * maker does not hold. Absent → the ceiling degrades to `available`.
   * Operator config ALWAYS wins over persisted snapshots for this field.
   */
  windowBudget?: Record<string, bigint>;

  /**
   * Optional live-rate hook, widened from the SDK's string-only shape:
   * return `{ rate, at }` ({@link SwapRateProvider} / `TimestampedRate`)
   * so quote age is measurable — REQUIRED for `maxRateAge` to bite. Bare
   * string returns remain valid (and are what the SDK handler ultimately
   * consumes; the swap node normalizes).
   */
  rateProvider?: SwapRateProvider;
  /**
   * Maker staleness bound(s) — toon-protocol/swap#48, rolling-swap §4.
   *
   * When set, any kind:1059 fill packet whose pair's rate feed has not
   * ticked within the resolved bound is rejected BENIGNLY before pricing
   * and claim issuance (handler-level code `T99`, `message: 'stale_rate'`,
   * base64-JSON `data` — see `rate-staleness.ts` for the full reject
   * contract). Maker-owned, per-chain/per-pair — NOT a protocol constant;
   * see `RECOMMENDED_MAX_RATE_AGE_MS` for calibrated per-chain-class
   * starting points.
   *
   * Requires {@link rateProvider} (the bound is on the maker's own feed
   * ticks; a static `pair.rate` gives it nothing to measure) — enforced at
   * boot with `INVALID_CONFIG`.
   */
  maxRateAge?: MaxRateAgeConfig;
  /**
   * Optional operator-supplied replay-protection set for the rolling engine.
   *
   * SECURITY: this `Set<string>` is unbounded by default. The swap node accepts
   * gift-wrap packets from any peer (handler-level dispatch), so a malicious
   * sender can flood the swap node with distinct packet IDs and grow this set
   * until memory is exhausted. Operators SHOULD supply a bounded / LRU-backed
   * `Set`-like impl — the SDK-default in-process bound `createSwapHandler`
   * used to fall back to does not apply here; this maker no longer wires that
   * handler (swap#154). This field is forwarded verbatim; `startSwapNode()`
   * does NOT size-cap it.
   */
  seenPacketIds?: Set<string>;

  // --- State persistence (issue #46; at most one of statePath/stateStore) ---
  /**
   * Path to the swap node's durable state snapshot (JSON). When set, `startSwapNode`
   * creates a {@link JsonFileSwapStateStore} at this path, rehydrates
   * inventory / channel watermarks / sticky bindings / replay reservations
   * from it, and persists (write-ahead) on every claim issuance. Persisted
   * values WIN over config-supplied initial values for keys present in the
   * snapshot — delete the file to intentionally reset. When neither this
   * nor `stateStore` is set, the swap node runs in-memory as before (state is
   * lost on restart).
   */
  statePath?: string;
  /**
   * Operator-supplied {@link SwapStateStore} implementation (e.g. a test
   * double or a future sqlite backend). Mutually exclusive with
   * `statePath`.
   */
  stateStore?: SwapStateStore;

  // --- Rolling coupled-leg engine (issue #47, rolling-swap §3) ---
  /**
   * Knobs for the rolling swap engine. The engine itself is ALWAYS wired
   * (a fill for an unregistered session is a benign F06); these only tune
   * its bounds. See `rolling-engine.ts` for semantics and defaults.
   */
  rolling?: {
    /** Default session lifetime (ms) when a session has no explicit expiry. */
    sessionTtlMs?: number;
    /** Bound on concurrently registered sessions. */
    maxSessions?: number;
    /** Max leg-B round-trip budget (ms) when leg A's expiry allows it. */
    legBBudgetMs?: number;
    /** Leg-B expiry margin (ms) under leg-A expiry (spec R7). */
    legBExpiryMarginMs?: number;
    /** Reject fills whose remaining leg-A budget (ms) is below this. */
    minLegBTimeMs?: number;
    /**
     * Issue #49 — grace (ms) added on top of the leg-B expiry when sizing a
     * fill's window-reservation TTL (crashed/stalled packets free their
     * slot right after they could no longer fulfill). Default 5s.
     */
    reservationGraceMs?: number;
    /**
     * RFQ intake knobs (spec §2.2). Entirely optional and defaulted. The
     * intake itself is always on and not configurable — swap#154 (toon-meta#411
     * Stage 5) removed the `enabled` switch: it is this maker's only swap
     * protocol, so disabling it would just disable swapping.
     */
    rfq?: RollingRfqConfig;
  };
  /**
   * Leg-B egress override (tests / custom connectors). When omitted, the
   * swap node wires {@link createConnectorLegBSender} over the effective
   * connector's public `sendPacket` — which must support
   * `SendPacketParams.executionCondition` (connector >= 3.30.0). Absent
   * that support, rolling fills fail closed (leg B is never sent
   * unconditioned — rolling-swap §3 R4).
   */
  rollingLegBSender?: LegBSender;

  // --- Shared infra ---
  relayUrls: readonly string[];
  knownPeers?: readonly { ilpAddress: string; btpUrl?: string }[];
  blsPort?: number;
  /**
   * Story 12.8 AC-11 — BTP server port for the auto-created embedded
   * ConnectorNode (when `config.connector` and `config.connectorUrl`
   * are both omitted). Ignored if the operator supplies a connector.
   * Defaults to `3400` (distinct from Town's `3000` default so a swap node
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
   * per-packet claim verification + signing. One entry per chain the swap node
   * plans to settle on; the shape mirrors the apex YAML `chainProviders`
   * block exactly (the connector's `ChainProviderConfigEntry =
   * ProviderConfig & { chainId }` discriminated union — EVM / Solana /
   * Mina). Ignored if `connector` is supplied (operator owns its connector
   * lifecycle and config in that mode).
   *
   * `keyId` defaults to the operator-supplied {@link settlementPrivateKey}
   * or the 0x-prefixed identity.secretKey hex when omitted — the same
   * secp256k1 key that derives the Nostr identity doubles as the signing
   * key for claim issuance. (Mina's `keyId` is optional per the connector
   * contract, but the swap node still defaults it so claim signing works out of
   * the box on every chain type.)
   */
  chainProviders?: readonly SwapNodeChainProvider[];
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
   * swap node. Only meaningful when `connectorUrl` is set; when omitted, the
   * parent peer entry has no `evmAddress` and the apex must supply
   * `peerAddress` explicitly via the `/channels` admin call.
   */
  parentEvmAddress?: string;
  passphrase?: string;
  logger?: SwapNodeLogger;

  /**
   * Issue #138 — operator token gating the `/admin/inventory/*` WRITE routes
   * on the BLS server (`SWAP_ADMIN_TOKEN`). OPTIONAL by design: a required
   * key would crash-loop every `:release`-tracking deployment on the next
   * auto-deploy (swap#134). When unset, the write routes answer 503
   * `admin_writes_disabled` — closed, never open. The read route
   * (`GET /admin/inventory`) is always available and is protected by the
   * box's nginx `^~ /admin` 404 rule, like the connector's own admin surface.
   */
  adminToken?: string;
  /**
   * Issue #138 — cadence of the chain-truth inventory reconcile, in ms.
   * Defaults to `DEFAULT_RECONCILE_INTERVAL_MS` (60s); `0` disables the
   * periodic pass (the boot pass and the admin routes still work).
   */
  reconcileIntervalMs?: number;

  /**
   * Published in kind:10032 as the swap node's ILP address. Used by peers to
   * route packets toward this node. Default: `g.toon.swap.<pubkey16>`.
   */
  ilpAddress?: string;
  /**
   * Published in kind:10032 as the swap node's BTP endpoint. Operators SHOULD
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
   * Story 50.4 — ILP destination for the kind:10032 advertisement.
   *
   * A TOON relay is pay-to-write: its WebSocket `EVENT` handler rejects
   * unpaid writes ('restricted: writes require ILP payment'), so a plain
   * Nostr publish (the `relayUrls`/SimplePool path) is NEVER stored by a
   * TOON relay. When this is set, `startSwapNode()` instead routes the
   * TOON-encoded kind:10032 to this ILP address via an ILP PREPARE through
   * the embedded connector (mirrors `startTown()`'s self-advertise via
   * `ilpClient.sendIlpPacket`). Point it at the ILP address of a relay node
   * that stores events (e.g. the apex `g.townhouse`). Requires a connector
   * (`connector` or `connectorUrl`). When unset, falls back to the legacy
   * SimplePool Nostr publish against `relayUrls` (only useful for a vanilla
   * Nostr relay).
   */
  peerInfoIlpDestination?: string;
  /**
   * Story 50.4 — price-per-byte used to compute the ILP PREPARE `amount`
   * for the kind:10032 advertisement (`amount = toonBytes * pricePerByte`).
   * Must be >= the destination relay's per-byte price or the packet is
   * rejected. Defaults to `0n` (TOON pilot relays advertise `FEE_PER_EVENT=0`).
   * Only meaningful when `peerInfoIlpDestination` is set.
   */
  peerInfoPricePerByte?: bigint;

  /**
   * NIP-40 time-to-live stamped on the kind:10032 announce, in seconds.
   *
   * Optional with a safe default of {@link DEFAULT_PEER_INFO_TTL_SECONDS}
   * (600s, the fleet-wide `[announce] ttl_secs` convention). The announce
   * carries `["expiration", created_at + ttl]`, so a NIP-40-aware relay stops
   * serving it once this node stops republishing.
   *
   * Set to `0` (or any non-positive value) to publish a NON-expiring announce.
   * That is the pre-existing behaviour and it is a footgun: the event is
   * replaceable, so once this node's signing key is gone nobody — not the
   * operator, not the relay's author, not a NIP-09 delete — can retract it.
   * Doing so logs at `warn`.
   *
   * MUST be comfortably longer than
   * {@link SwapNodeConfig.peerInfoRefreshIntervalMs}; a TTL shorter than the
   * refresh cadence expires a live node out of discovery between its own
   * announces. A violation is logged at `error` rather than thrown — see that
   * field's note on why nothing here may fail boot.
   */
  peerInfoTtlSeconds?: number;
  /**
   * Interval between kind:10032 republishes, in milliseconds.
   *
   * Optional with a safe default of
   * {@link DEFAULT_PEER_INFO_REFRESH_INTERVAL_MS} (240s, the fleet-wide
   * `REFRESH_SECS` convention). Before this existed the announce was published
   * exactly once at boot, so stamping it with a TTL alone would have made a
   * long-lived maker silently vanish from discovery one TTL after start-up.
   * The tag and the loop are one change, not two.
   *
   * Set to `0` (or any non-positive value) to publish once at boot and never
   * refresh. Only sane alongside a non-positive `peerInfoTtlSeconds`, or when
   * some OTHER publisher on the same identity owns the refresh (the devnet
   * fleet's `connector announce` sidecar is exactly that case). Doing so logs
   * at `warn`.
   *
   * Neither this nor `peerInfoTtlSeconds` is ever required, and neither can
   * fail `validateConfig`: every service on the fleet auto-deploys on green
   * main, so a newly-required key is an outage (see the swap#134 post-mortem in
   * the connector repo's `infra/linode-relay/swap.config.json`). Bad values are
   * corrected and logged, never thrown.
   */
  peerInfoRefreshIntervalMs?: number;

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
   * @internal — test hook. When supplied, called with the signed kind:10032
   * event immediately after `buildIlpPeerInfoEvent` returns — once at boot and
   * once per refresh thereafter (see
   * `SwapNodeConfig.peerInfoRefreshIntervalMs`, default 240s, so in practice
   * once for any test that does not deliberately wait). Used by AC-6 tests to
   * capture the event without reaching into implementation internals. NOT part
   * of the public contract.
   */
  __testHooks?: {
    onPeerInfoBuilt?: (event: unknown) => void;
    /**
     * @internal — overrides the ILP-advertisement retry budget so tests can
     * exercise the exhausted-retry (loud-failure) path without waiting the
     * production ~24s window. NOT part of the public contract.
     */
    peerInfoPublishRetry?: { maxAttempts?: number; delayMs?: number };
    /**
     * @internal — issue #113 test hook. Called exactly once with the
     * constructed `SwapChannelState`, immediately after it (and its
     * `chainProviders`-derived `onChainReader`, if any) is built. Lets
     * tests exercise the real wiring end-to-end without a full connector/
     * BTP round-trip. NOT part of the public contract.
     */
    onChannelStateBuilt?: (channelState: SwapChannelState) => void;
    /**
     * @internal — issue #138 test hook. Called exactly once with the
     * constructed `MultiChainClaimIssuer`, so tests can drive a REAL legacy
     * claim through the node's own inventory/channel/persistence wiring and
     * then observe the chain-truth recycle. NOT part of the public contract.
     */
    onClaimIssuerBuilt?: (claimIssuer: MultiChainClaimIssuer) => void;
  };
}

export interface SwapNodeInstance {
  readonly identity: NodeIdentity;
  readonly blsPort: number;
  readonly swapNodeKeys: SwapNodeKeys;
  /**
   * Story 12.8 AC-11 — the effective connector the swap node is wired to.
   *
   * - When `config.connector` was supplied: that value, verbatim.
   * - When neither `config.connector` nor `config.connectorUrl` were
   *   supplied: an auto-created embedded {@link ConnectorNode}.
   * - Otherwise: `undefined`.
   *
   * Ownership: lifecycle of auto-created connectors is managed by the
   * swap node (`stop()` closes them). Operator-supplied connectors are
   * owned by the caller and NOT closed on `stop()`.
   */
  readonly connector?: EmbeddableConnectorLike;
  stop(): Promise<void>;
  health(): SwapNodeHealthResponse;
  /**
   * Register a rolling-swap session (issue #47) — the RFQ intake seam.
   * Fill packets referencing an unregistered `streamNonce` are rejected
   * benignly (F06 `unknown_session`). The RFQ transport story calls this
   * when a kind:20033 quote request is answered; tests and operators may
   * call it directly.
   */
  registerRollingSession(session: RollingSession): void;
  /**
   * Issue #49 — apply an on-chain settlement confirmation: shrinks the
   * matching pool's unsettled liability by the watermark delta (monotone
   * per channel; stale/replayed confirmations are a 0n no-op) and recycles
   * the freed capacity into the in-flight window. The pool is resolved by
   * `event.channelId` against the provisioned channel state. Returns the
   * liability actually reduced. Persisted (best-effort) when persistence
   * is enabled.
   */
  recordSettlement(event: SettlementEvent): bigint;
  /**
   * Issue #138 — run one chain-truth reconcile now: read every provisioned
   * channel's LIVE on-chain `cumulativePaid` and recycle whatever it shows
   * newly redeemed back into spendable capacity (liability first, then the
   * `available` a pre-#138 permanent debit burned — capped at `total`).
   * Idempotent: per-channel watermarks are monotone, so re-running credits
   * nothing. Never throws; per-channel read failures are reported in the
   * result and leave that channel's capacity blocked.
   */
  reconcileInventory(): Promise<ReconcileResult>;
  /** @internal — issue #47 test hook (rolling-engine introspection). */
  readonly _rollingEngine?: RollingSwapEngine;
}

/**
 * Issue #49 — the three-bucket in-flight window view for one
 * `assetCode:chain` pool (rolling-swap §8). All bigints as decimal strings.
 */
export interface SwapNodeHealthWindowEntry {
  /** Effective ceiling: `min(configured windowBudget, available)`. */
  budget: string;
  /** Σ live packet reservations (reserve → commit/release/TTL). */
  inFlight: string;
  /** Committed liability awaiting on-chain settlement confirmation. */
  unsettled: string;
  /** `budget − inFlight − unsettled` — capacity for new fills. */
  free: string;
}

export interface SwapNodeHealthResponse {
  status: 'ok' | 'starting' | 'stopping' | 'stopped';
  version: string;
  nodePubkey: string;
  swapPairsCount: number;
  chains: readonly SwapNodeChainKind[];
  uptimeSec: number;
  inventory: Record<string, string>;
  /** Configured swap pairs — operator-config, no secrets. */
  swapPairs: SwapPair[];
  /** Per-asset available reserves, parallel to `inventory` (which is total). */
  inventoryAvailable: Record<string, string>;
  /**
   * Issue #49 — in-flight vs unsettled vs free per `assetCode:chain` pool:
   * the capital-exposure view that replaces total/available as the rolling
   * path's operational signal (total/available remain for the legacy pool).
   */
  inventoryWindow: Record<string, SwapNodeHealthWindowEntry>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map each distinct `pair.to.chain` to the swap node's on-chain signer address
 * for that chain. Closes the TODO(12.7) hook from
 * `packages/swap/src/claim-issuer.ts:40-43`.
 *
 * @internal — exported for unit testability (AC-5).
 */
export function buildSignerAddresses(
  pairs: readonly SwapPair[],
  keys: SwapNodeKeys
): Record<string, string> {
  const result: Record<string, string> = {};
  const distinctChains = new Set(pairs.map((p) => p.to.chain));
  for (const chain of distinctChains) {
    if (chain.startsWith('evm:')) {
      if (!keys.evm) {
        throw new SwapNodeStartError(
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
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `No Solana key derived but pair targets ${chain}`
        );
      }
      result[chain] = base58Encode(keys.solana.publicKey);
    } else if (chain.startsWith('mina:')) {
      if (!keys.mina) {
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `No Mina key derived but pair targets ${chain}`
        );
      }
      result[chain] = keys.mina.publicKey;
    } else {
      throw new SwapNodeStartError(
        'UNSUPPORTED_CHAIN_FAMILY',
        `Unknown chain family in pair.to.chain=${chain}`
      );
    }
  }
  return result;
}

/**
 * Library default: silence. An embedded swap node must not print into its
 * host's stdout uninvited.
 *
 * swap#136 — this is NOT the right default for a *process*, and the CLI
 * (`cli.ts`, the entrypoint the published image runs) used to inherit it,
 * which is why a maker that refused every swap for hours logged nothing at
 * all. `cli.ts`'s `installDefaultLogger()` now replaces it with
 * `createConsoleLogger()` (`logger.ts`). If you add another entrypoint, do
 * the same there — do not make this function print.
 */
function noopLogger(): SwapNodeLogger {
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

function chainFamily(chain: string): SwapNodeChainKind | null {
  if (chain.startsWith('evm:')) return 'evm';
  if (chain.startsWith('solana:')) return 'solana';
  if (chain.startsWith('mina:')) return 'mina';
  return null;
}

/**
 * Parse the numeric EIP-155 chainId out of an `evm:*` chain key — the last
 * colon-delimited segment, so both the two-segment (`evm:84532`) and
 * three-segment (`evm:base:8453`) shapes parse. This is the SAME chain key
 * every swap pair, channel and inventory entry is keyed by, so the signed
 * chainId can never disagree with the key a claim is filed under (issue #101).
 *
 * @internal Exported for unit testing of the chain-key parsing surface; not
 * part of the supported package API.
 */
export function parseEvmChainId(chain: string): bigint {
  const segments = chain.split(':');
  const last = segments[segments.length - 1];
  if (!last || !/^[0-9]+$/.test(last)) {
    throw new Error(
      `cannot parse a numeric chainId from the trailing segment of "${chain}"`
    );
  }
  return BigInt(last);
}

/**
 * Look up the `chainProviders` entry of a given family for one target chain,
 * narrowed to that family's variant. Absent when the operator configured no
 * entry for the chain — required for `evm:*` (see
 * {@link requireEvmChainProvider}), optional for the other families.
 */
function findChainProvider<T extends SwapNodeChainProvider['chainType']>(
  chainProviders: SwapNodeConfig['chainProviders'],
  chainType: T,
  chain: string
): Extract<SwapNodeChainProvider, { chainType: T }> | undefined {
  return chainProviders?.find(
    (p): p is Extract<SwapNodeChainProvider, { chainType: T }> =>
      p.chainType === chainType && p.chainId === chain
  );
}

/**
 * Look up the `chainProviders` entry for an `evm:*` target chain, or throw the
 * `INVALID_CONFIG` refusal naming the chain key and the missing setting.
 *
 * Shared by {@link validateConfig} (the boot-time refusal) and `startSwapNode`
 * (which re-checks defensively at signer construction, so the lookup can never
 * silently fall through to an unbound signer) — issue #101.
 */
function requireEvmChainProvider(
  chainProviders: SwapNodeConfig['chainProviders'],
  chain: string
): SwapNodeEvmChainProvider {
  const provider = findChainProvider(chainProviders, 'evm', chain);
  if (!provider) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      `SwapNodeConfig.chainProviders is missing an entry for pair.to.chain="${chain}" — a "channelAddress" (deployed RollingSwapChannel address) is required to sign v2 balance proofs on this chain, and a "tokenNetworkAddress" (deployed TokenNetwork address) is required so clients can open the leg-A payment channel they pay this maker over`
    );
  }
  return provider;
}

/**
 * Validate a {@link SwapNodeConfig} and throw {@link SwapNodeStartError} with code
 * `INVALID_CONFIG` on the first violation. Pure and synchronous — it allocates
 * no resources and boots nothing, so it is safe to call directly in tests
 * (notably without triggering the embedded connector's Mina zkApp pre-compile).
 * `startSwapNode` calls this first, before any resource allocation.
 *
 * @internal Exported for unit testing of the config-validation surface; not
 * part of the supported package API.
 */
export function validateConfig(config: SwapNodeConfig): void {
  const hasMnemonic = config.mnemonic !== undefined;
  const hasSecretKey = config.secretKey !== undefined;

  if (hasMnemonic && hasSecretKey) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig: provide either mnemonic or secretKey, not both'
    );
  }
  if (!hasMnemonic && !hasSecretKey) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig: one of mnemonic or secretKey is required'
    );
  }
  if (hasSecretKey) {
    const sk = config.secretKey as Uint8Array;
    if (!(sk instanceof Uint8Array) || sk.length !== 32) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.secretKey must be a 32-byte Uint8Array (got ${sk instanceof Uint8Array ? `${sk.length} bytes` : typeof sk})`
      );
    }
  }

  if (config.connector !== undefined && config.connectorUrl !== undefined) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig: provide either connector or connectorUrl, not both'
    );
  }

  if (config.statePath !== undefined && config.stateStore !== undefined) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig: provide either statePath or stateStore, not both'
    );
  }
  if (
    config.statePath !== undefined &&
    (typeof config.statePath !== 'string' || config.statePath.length === 0)
  ) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.statePath MUST be a non-empty string when set'
    );
  }

  if (!Array.isArray(config.swapPairs) || config.swapPairs.length === 0) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.swapPairs MUST be a non-empty array'
    );
  }

  if (!Array.isArray(config.relayUrls) || config.relayUrls.length === 0) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.relayUrls MUST be a non-empty array'
    );
  }

  const distinctTargetChains = new Set(config.swapPairs.map((p) => p.to.chain));
  for (const chain of distinctTargetChains) {
    const fam = chainFamily(chain);
    if (!fam) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig: unknown chain family in pair.to.chain=${chain}`
      );
    }
    if (!config.chains.includes(fam)) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.chains missing family "${fam}" required by pair.to.chain=${chain}`
      );
    }
    const chanList = config.channels[chain];
    if (!Array.isArray(chanList) || chanList.length === 0) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.channels["${chain}"] MUST be a non-empty array`
      );
    }
    const inv = config.inventory[chain];
    if (inv === undefined || typeof inv !== 'bigint' || inv < 0n) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.inventory["${chain}"] MUST be a non-negative bigint`
      );
    }
  }

  if (config.windowBudget !== undefined) {
    for (const [chain, budget] of Object.entries(config.windowBudget)) {
      if (typeof budget !== 'bigint' || budget < 0n) {
        throw new SwapNodeStartError(
          'INVALID_CONFIG',
          `SwapNodeConfig.windowBudget["${chain}"] MUST be a non-negative bigint`
        );
      }
      if (!distinctTargetChains.has(chain)) {
        throw new SwapNodeStartError(
          'INVALID_CONFIG',
          `SwapNodeConfig.windowBudget["${chain}"] references a chain no swap pair targets`
        );
      }
    }
  }

  if (config.maxRateAge !== undefined) {
    try {
      validateMaxRateAgeConfig(config.maxRateAge);
    } catch (err) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.maxRateAge invalid: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (typeof config.rateProvider !== 'function') {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        "SwapNodeConfig.maxRateAge requires a rateProvider: the staleness bound applies to the age of the maker's own rate-feed ticks, so a static pair.rate gives the guard nothing to measure. Supply a rateProvider that returns { rate, at } timestamped quotes."
      );
    }
  }

  if (config.rolling !== undefined) {
    const knobs: readonly (keyof NonNullable<SwapNodeConfig['rolling']>)[] = [
      'sessionTtlMs',
      'maxSessions',
      'legBBudgetMs',
      'legBExpiryMarginMs',
      'minLegBTimeMs',
      'reservationGraceMs',
    ];
    for (const k of knobs) {
      const v = config.rolling[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new SwapNodeStartError(
          'INVALID_CONFIG',
          `SwapNodeConfig.rolling.${k} MUST be a positive finite number`
        );
      }
    }
  }
  if (
    config.rollingLegBSender !== undefined &&
    typeof config.rollingLegBSender !== 'function'
  ) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.rollingLegBSender MUST be a function when set'
    );
  }

  if (config.chainProviders !== undefined) {
    if (!Array.isArray(config.chainProviders)) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        'SwapNodeConfig.chainProviders MUST be an array when set'
      );
    }
    for (const [i, p] of config.chainProviders.entries()) {
      validateChainProviderEntry(p, i);
    }
  }

  // The v2 EIP-712 domain (chainId + verifyingContract) is bound at signer
  // construction (issue #101), so every EVM chain a swap pair targets MUST
  // resolve to a chain key the connector can parse a chainId out of AND a
  // `chainProviders` entry naming the deployed RollingSwapChannel address —
  // otherwise the swap node would boot and issue claims nobody can verify.
  for (const chain of distinctTargetChains) {
    if (chainFamily(chain) !== 'evm') continue;
    try {
      parseEvmChainId(chain);
    } catch (err) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        // parseEvmChainId's own message already quotes the chain key, so
        // naming it again here would just duplicate it.
        `SwapNodeConfig: invalid pair.to.chain — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    requireEvmChainProvider(config.chainProviders, chain);
  }
}

/**
 * Default NIP-40 time-to-live stamped on this node's kind:10032 announce, in
 * seconds.
 *
 * 600s is not a fresh number: it is the fleet-wide convention the Rust
 * connector's `[announce] ttl_secs` already defaults to
 * (`crates/connector-config/src/announce.rs`'s `DEFAULT_TTL_SECS`), which is
 * what every node on the live devnet is stamped with today. An announce is a
 * liveness signal, not a permanent record — a kind:10032 with no expiration
 * outlives the node it describes and, being replaceable, can only ever be
 * retracted by the key that signed it. When that key is gone (a throwaway proof
 * rig, a rotated identity) the litter is permanent by construction and clients
 * keep dialing a dead BTP endpoint.
 *
 * @see DEFAULT_PEER_INFO_REFRESH_INTERVAL_MS — the republish cadence that keeps
 *   a LIVE node inside this window.
 */
const DEFAULT_PEER_INFO_TTL_SECONDS = 600;

/**
 * Default interval between kind:10032 republishes, in milliseconds.
 *
 * 240s, again matching the fleet: every `connector announce` loop overlay on
 * the devnet boxes (`REFRESH_SECS="${..._REFRESH_SECS:-240}"`) republishes on
 * this cadence against the same 600s TTL, leaving ~6 minutes of continuous
 * headroom — measured, not assumed (relay#137). The ratio is the point: the
 * refresh MUST comfortably beat the TTL, or a live node expires out of
 * discovery between two of its own announces, which is strictly worse than the
 * litter this TTL exists to stop.
 */
const DEFAULT_PEER_INFO_REFRESH_INTERVAL_MS = 240_000;

/**
 * Required non-empty string fields per chain type, mirroring the connector's
 * `REQUIRED_FIELDS_BY_CHAIN_TYPE` in `@toon-protocol/connector`'s
 * `config/types.ts`. `keyId` is intentionally omitted from every list because
 * the swap node defaults it before forwarding to the connector (see
 * `SwapNodeConfig.chainProviders`).
 */
const SWAP_REQUIRED_PROVIDER_FIELDS: Record<
  SwapNodeChainProvider['chainType'],
  readonly string[]
> = {
  evm: [
    'chainId',
    'rpcUrl',
    'registryAddress',
    'tokenAddress',
    // Leg A (kind:10032 `tokenNetworks`) and leg B (the EIP-712
    // `verifyingContract`) are two DIFFERENT contracts — see the field docs on
    // `SwapNodeEvmChainProvider`. Both are required; neither defaults to the
    // other (issue #133).
    'tokenNetworkAddress',
    'channelAddress',
  ],
  solana: ['chainId', 'rpcUrl', 'programId'],
  mina: ['chainId', 'graphqlUrl', 'zkAppAddress'],
};

/**
 * Validate a single `chainProviders` entry. Discriminates on `chainType` and
 * enforces the per-chain required-field set above. Unknown chain types are
 * rejected with a domain-specific error rather than silently forwarded to the
 * connector (which would reject them later with a less actionable message).
 */
function validateChainProviderEntry(p: unknown, i: number): void {
  if (typeof p !== 'object' || p === null) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      `SwapNodeConfig.chainProviders[${i}] MUST be an object`
    );
  }
  const rec = p as Record<string, unknown>;
  const chainType = rec['chainType'];
  if (chainType !== 'evm' && chainType !== 'solana' && chainType !== 'mina') {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      `SwapNodeConfig.chainProviders[${i}].chainType MUST be one of 'evm' | 'solana' | 'mina' (got ${JSON.stringify(
        chainType
      )})`
    );
  }
  const required = SWAP_REQUIRED_PROVIDER_FIELDS[chainType];
  for (const k of required) {
    const v = rec[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.chainProviders[${i}].${k} MUST be a non-empty string for chainType '${chainType}'`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// startSwapNode()
// ---------------------------------------------------------------------------

export async function startSwapNode(
  config: SwapNodeConfig
): Promise<SwapNodeInstance> {
  // 1. Validate config — fail BEFORE allocating resources.
  validateConfig(config);

  const logger = config.logger ?? noopLogger();
  const startedAt = Date.now();

  // 2/3. swap node key derivation (BIP-32) REQUIRES a mnemonic (D12-011). Check
  //      this before resolving identity so callers passing only a secretKey
  //      get a domain-specific error instead of a generic `IdentityError`.
  if (!config.mnemonic) {
    throw new SwapNodeStartError(
      'SWAP_REQUIRES_MNEMONIC',
      'swap node key derivation (BIP-32) requires a BIP-39 mnemonic; pass config.mnemonic instead of secretKey'
    );
  }

  // Cryptographic-correctness guard: `fromMnemonic()` (SDK) does NOT accept
  // a BIP-39 passphrase, but `deriveSwapNodeKeys()` below does. Silently splitting
  // the derivation across two different seeds (identity without passphrase,
  // swap node keys with) would yield a non-deterministic operator key tree that
  // cannot be recreated from the same mnemonic+passphrase pair. Reject at
  // boot so operators cannot misconfigure themselves into key-recovery hell.
  if (config.passphrase !== undefined && config.passphrase !== '') {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.passphrase is not supported: the Nostr-identity SDK derivation (fromMnemonic) does not accept a BIP-39 passphrase, so setting one would split identity and swap-node-key derivation across inconsistent seeds. Use a passphrase-less mnemonic until SDK identity derivation supports passphrases.'
    );
  }

  // The swap node's Nostr identity is derived from the SWAP_MNEMONIC (NOT from any
  // NODE_NOSTR_SECRET_KEY). This SAME `identity` is the RFQ intake's and the
  // rolling engine's gift-wrap recipient (`secretKey: identity.secretKey`,
  // below) and is published as the kind:10032 IlpPeerInfo `pubkey` (below).
  // Callers therefore gift-wrap to `identity.pubkey` and pass it as
  // `swapPubkey`. See issues #80/#88 and docs/protocol.md ("Swap recipient
  // key discovery").
  const identity: NodeIdentity = fromMnemonic(config.mnemonic);
  const swapNodeKeys: SwapNodeKeys = await deriveSwapNodeKeys({
    mnemonic: config.mnemonic,
    chains: config.chains,
    // NOTE: passphrase intentionally omitted — rejected above for consistency
    // with `fromMnemonic()`. Re-enable once SDK identity derivation supports it.
  });

  // 4. Construct payment-channel signers per configured family. EVM chains
  //    get ONE signer instance per distinct chain, each domain-bound at
  //    construction to that chain's (chainId, RollingSwapChannel address) —
  //    issue #101, so a claim signed for one EVM chain's domain can never
  //    recover as valid under another's. Key material stays shared (the same
  //    derived EVM key backs every signer); only the instances multiply.
  //    Solana and Mina are untouched: one signer instance is still shared
  //    across every chain in their respective family.
  const signers: Record<string, PaymentChannelSigner> = {};
  const distinctTargetChains = Array.from(
    new Set(config.swapPairs.map((p) => p.to.chain))
  );
  // Issue #133 — the kind:10032 `tokenNetworks` map is **leg A**: the deployed
  // `TokenNetwork` a CLIENT calls `openChannel(address,uint256)` on to open the
  // channel it pays this maker over. It is NOT the maker's own
  // `RollingSwapChannel` (whose `openChannel` takes a different signature) —
  // advertising that here reverts every client's lazy `ensureChannel` and the
  // swap dies before a packet is sent.
  const tokenNetworks: Record<string, string> = {};
  // Issue #102/#133 — **leg B**: the `verifyingContract` this node binds into
  // its v2 EIP-712 balance-proof domain, advertised under its own announce key
  // so it can never be mistaken for leg A. Filled in THIS loop from the same
  // `provider.channelAddress` (and under the same chain key) each EVM signer
  // binds, so what the node advertises can never drift from what its claims
  // are signed under.
  const swapVerifyingContracts: Record<string, string> = {};
  // Issue #114 — the kind:10032 `preferredTokens` map: the settlement-token
  // address/mint/id for each chain, sourced from the SAME chainProviders
  // entry as everything else in this loop (no second lookup to drift from).
  // Absent for a chain whose chainProviders entry (if any) names no token —
  // Solana/Mina token config is optional (native asset), unlike EVM's
  // required `tokenAddress`.
  const preferredTokens: Record<string, string> = {};
  let sharedSolanaSigner: SolanaPaymentChannelSigner | undefined;
  let sharedMinaSigner: MinaPaymentChannelSigner | undefined;
  for (const chain of distinctTargetChains) {
    if (chain.startsWith('evm:')) {
      if (!swapNodeKeys.evm) {
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `Pair targets ${chain} but no EVM key was derived`
        );
      }
      // validateConfig() has already guaranteed a chainProviders entry with
      // a non-empty channelAddress exists for every EVM chain a pair
      // targets, and that the chain key parses to a numeric chainId.
      const provider = requireEvmChainProvider(config.chainProviders, chain);
      signers[chain] = new EvmPaymentChannelSigner({
        chain,
        privateKey: swapNodeKeys.evm.privateKey,
        chainId: parseEvmChainId(chain),
        verifyingContract: provider.channelAddress,
      });
      tokenNetworks[chain] = provider.tokenNetworkAddress;
      swapVerifyingContracts[chain] = provider.channelAddress;
      preferredTokens[chain] = provider.tokenAddress;
    } else if (chain.startsWith('solana:')) {
      if (!swapNodeKeys.solana) {
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `Pair targets ${chain} but no Solana key was derived`
        );
      }
      sharedSolanaSigner ??= new SolanaPaymentChannelSigner({
        chain,
        privateKey: swapNodeKeys.solana.privateKey,
      });
      signers[chain] = sharedSolanaSigner;
      const solanaProvider = findChainProvider(
        config.chainProviders,
        'solana',
        chain
      );
      if (solanaProvider?.tokenMint) {
        preferredTokens[chain] = solanaProvider.tokenMint;
      }
    } else if (chain.startsWith('mina:')) {
      if (!swapNodeKeys.mina) {
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `Pair targets ${chain} but no Mina key was derived`
        );
      }
      sharedMinaSigner ??= new MinaPaymentChannelSigner({
        chain,
        privateKey: swapNodeKeys.mina.privateKey,
        publicKey: swapNodeKeys.mina.publicKey,
      });
      signers[chain] = sharedMinaSigner;
      const minaProvider = findChainProvider(
        config.chainProviders,
        'mina',
        chain
      );
      if (minaProvider?.tokenId) {
        preferredTokens[chain] = minaProvider.tokenId;
      }
    } else {
      throw new SwapNodeStartError(
        'UNSUPPORTED_CHAIN_FAMILY',
        `Unknown chain family in pair.to.chain=${chain}`
      );
    }
  }

  // 4b. Issue #46 — durable state store + rehydration.
  //
  // A snapshot that exists but cannot be loaded FAILS boot loudly
  // (STATE_LOAD_FAILED): silently booting from config would reset channel
  // watermarks below claims already handed out — the exact desync this
  // feature prevents. Delete the state file to intentionally reset.
  const stateStore: SwapStateStore | undefined =
    config.stateStore ??
    (config.statePath !== undefined
      ? new JsonFileSwapStateStore(config.statePath)
      : undefined);
  let persistedState: PersistedSwapState | null = null;
  if (stateStore) {
    try {
      persistedState = stateStore.load();
    } catch (err) {
      throw new SwapNodeStartError(
        'STATE_LOAD_FAILED',
        `Failed to load persisted swap-node state${config.statePath ? ` from ${config.statePath}` : ''}: ${errSummary(err).message}`,
        { cause: err }
      );
    }
    if (persistedState) {
      logger.info?.('swap.state.rehydrated', {
        inventoryKeys: Object.keys(persistedState.inventory).length,
        channelKeys: Object.keys(persistedState.channels).length,
        bindings: Object.keys(persistedState.bindings).length,
        seenPacketIds: persistedState.seenPacketIds.length,
      });
    }
  }

  // 5. Inventory — map operator-supplied `Record<chain, bigint>` into the
  //    `SwapInventory` per-asset/per-chain shape. We key off pair.to.assetCode
  //    for each referenced chain.
  //
  //    Issue #46 — persisted entries then OVERLAY the config-derived values
  //    (persisted wins): a restart must not reset spent inventory back to
  //    the notional boot value. Config seeds only keys the snapshot has
  //    never recorded.
  //    Issue #49 — `windowBudget` is operator config and ALWAYS comes from
  //    config (never the snapshot); `unsettled` + in-flight reservations +
  //    settled watermarks rehydrate from the snapshot. Rehydrated
  //    reservations recover by expire-and-release: they occupy the window
  //    until their persisted `expiresAt`, then free it (state-store crash
  //    rule 6 — no leaked capacity, and the write-ahead watermark already
  //    prevents any double-spend).
  const inventoryInit: Record<
    string,
    {
      available: bigint;
      total: bigint;
      updatedAt?: number;
      windowBudget?: bigint;
      unsettled?: bigint;
    }
  > = {};
  for (const pair of config.swapPairs) {
    const chain = pair.to.chain;
    const asset = pair.to.assetCode;
    const bal = config.inventory[chain] ?? 0n;
    const budget = config.windowBudget?.[chain];
    inventoryInit[`${asset}:${chain}`] = {
      available: bal,
      total: bal,
      ...(budget !== undefined && { windowBudget: budget }),
    };
  }
  if (persistedState) {
    for (const [k, v] of Object.entries(persistedState.inventory)) {
      const configBudget = inventoryInit[k]?.windowBudget;
      inventoryInit[k] = {
        available: BigInt(v.available),
        total: BigInt(v.total),
        unsettled: BigInt(v.unsettled ?? '0'),
        updatedAt: v.updatedAt,
        // Config wins; a snapshot-only budget (key no longer configured) is
        // dropped rather than resurrected.
        ...(configBudget !== undefined && { windowBudget: configBudget }),
      };
    }
  }
  const rehydratedReservations = persistedState
    ? Object.fromEntries(
        Object.entries(persistedState.reservations).map(([id, r]) => [
          id,
          { key: r.key, amount: BigInt(r.amount), expiresAt: r.expiresAt },
        ])
      )
    : undefined;
  const inventory = new SwapInventory({
    balances: inventoryInit,
    ...(rehydratedReservations && { reservations: rehydratedReservations }),
    ...(persistedState && {
      settledWatermarks: Object.fromEntries(
        Object.entries(persistedState.settledWatermarks).map(([k, v]) => [
          k,
          BigInt(v),
        ])
      ),
    }),
  });
  if (
    rehydratedReservations &&
    Object.keys(rehydratedReservations).length > 0
  ) {
    logger.info?.('swap.state.reservations_rehydrated', {
      count: Object.keys(rehydratedReservations).length,
      policy:
        'expire-and-release: crashed in-flight reservations free their window slot at their persisted expiresAt (state-store crash rule 6)',
    });
  }

  // 6. Channel state — flatten `Record<chain, ChannelEntry[]>` into the
  //    `SwapChannelState` key scheme (`assetCode:chain:senderPubkey`). For
  //    bootstrap we only know `chain`, not a sender — so we register each
  //    channel under `*` (wildcard) sender. The Story 12.8 E2E will replace
  //    this with per-sender provisioning as real peers connect.
  //
  //    Issue #46 — persisted watermarks OVERLAY config entries (persisted
  //    wins; nonce/cumulative never regress across a restart). Persisted
  //    keys ABSENT from config are restored too: channels provisioned
  //    dynamically at runtime (`provisionChannel`) must keep their
  //    watermarks — `provisionChannel` is a no-op for keys that already
  //    exist, which protects the restored entries from being re-zeroed.
  const channelInit: Record<string, ChannelEntry> = {};
  for (const pair of config.swapPairs) {
    const entries = config.channels[pair.to.chain] ?? [];
    for (const entry of entries) {
      const key = `${pair.to.assetCode}:${pair.to.chain}:${entry.channelId}`;
      channelInit[key] = { ...entry };
    }
  }
  if (persistedState) {
    for (const [k, v] of Object.entries(persistedState.channels)) {
      channelInit[k] = {
        channelId: v.channelId,
        cumulativeAmount: BigInt(v.cumulativeAmount),
        nonce: BigInt(v.nonce),
        updatedAt: v.updatedAt,
      };
    }
  }
  // Issue #113 — wire an on-chain reader whenever a chainProviders entry of
  // a READABLE family is configured, so a bound-but-unavailable channel can
  // be safety-checked for rebind (no separate opt-in knob: this is the
  // rebind PRECONDITION, not a policy an operator should be able to
  // disable — see `channel-state.ts`'s docblock).
  //
  // Issue #141 — this used to be EVM-only, which left a Solana maker's
  // capacity ratcheting to zero (nothing ever observed a redemption) and its
  // rebind check permanently off. `createChannelOnChainReader` dispatches per
  // family; Solana's payer side is picked from the node's OWN derived
  // address, so no new config key is involved. Mina stays unreadable by
  // construction — see `channel-reader.ts` for the evidence.
  const evmChannelReaderProviders = (config.chainProviders ?? []).filter(
    (p): p is SwapNodeEvmChainProvider => p.chainType === 'evm'
  );
  // Without our OWN Solana address there is no way to tell which of the
  // channel's two `transferred_amount` slots is ours, and reading the
  // counterparty's would over-recycle — so no key means no Solana reader.
  const solanaKeys = swapNodeKeys.solana;
  const solanaChannelReaderProviders: SolanaChannelReaderProvider[] = [];
  if (solanaKeys) {
    const payerPubkey = base58Encode(solanaKeys.publicKey);
    for (const p of config.chainProviders ?? []) {
      if (p.chainType !== 'solana') continue;
      solanaChannelReaderProviders.push({
        chainId: p.chainId,
        rpcUrl: p.rpcUrl,
        programId: p.programId,
        payerPubkey,
      });
    }
  }
  const channelOnChainReader = createChannelOnChainReader({
    evm: evmChannelReaderProviders,
    solana: solanaChannelReaderProviders,
  });
  const channelState = new SwapChannelState({
    channels: channelInit,
    logger: { warn: logger.warn },
    // Restored sticky bindings keep each sender pinned to the channel its
    // existing balance proofs were issued against (dangling ones dropped).
    ...(persistedState && { bindings: persistedState.bindings }),
    ...(channelOnChainReader && { onChainReader: channelOnChainReader }),
  });
  config.__testHooks?.onChannelStateBuilt?.(channelState);

  // 6b. Issue #46 — persister + persistent replay set.
  //
  // The replay set is swap-node-owned ONLY when the operator did not inject
  // `config.seenPacketIds`. An operator-supplied set is forwarded verbatim
  // (SDK contract) and NOT persisted — on restart the accepted replay
  // window is that set's own bound; we surface this at `warn`.
  let persistentSeen: PersistentSeenPacketIds | undefined;
  if (stateStore && config.seenPacketIds === undefined) {
    persistentSeen = new PersistentSeenPacketIds(
      persistedState?.seenPacketIds ?? []
    );
  } else if (stateStore && config.seenPacketIds !== undefined) {
    logger.warn?.('swap.state.seen_packet_ids_not_persisted', {
      reason:
        'operator-supplied seenPacketIds is used verbatim and is not included in the persisted snapshot; replay reservations reset on restart',
    });
  }
  const persister = stateStore
    ? new SwapStatePersister({
        store: stateStore,
        inventory,
        channelState,
        ...(persistentSeen && { seenPacketIds: persistentSeen }),
      })
    : undefined;
  if (persister && persistentSeen) {
    // Every replay reservation (added by the SDK handler BEFORE a claim is
    // issued) hits disk synchronously — crash rule 4 in state-store.ts.
    persistentSeen.setOnMutate(() => persister.persist());
  }
  if (persister) {
    // Boot-time snapshot: verifies writability up front (fail fast instead
    // of on the first claim) and materializes the merged config+persisted
    // state so a crash before the first claim still restores correctly.
    try {
      persister.persist();
    } catch (err) {
      throw new SwapNodeStartError(
        'STATE_PERSIST_FAILED',
        `Failed to write initial swap-node state snapshot${config.statePath ? ` to ${config.statePath}` : ''}: ${errSummary(err).message}`,
        { cause: err }
      );
    }
  }

  // 6c. Issue #138 — chain-truth inventory reconciler. Reads each provisioned
  //      channel's LIVE on-chain `cumulativePaid` and recycles the redeemed
  //      value back into spendable capacity. Runs once at boot
  //      (fire-and-forget: an unreachable RPC must never block boot) and then
  //      on an unref'd interval. Disabled — with an explanation on the
  //      operator read surface — when no on-chain reader is configured, since
  //      the node then has no way to establish chain truth and must not guess.
  const reconciler = new SwapInventoryReconciler({
    inventory,
    channelState,
    ...(channelOnChainReader && { reader: channelOnChainReader }),
    ...(persister && { persist: () => persister.persist() }),
    logger,
    ...(config.reconcileIntervalMs !== undefined && {
      intervalMs: config.reconcileIntervalMs,
    }),
  });

  // 7. signerAddresses map + claim issuer.
  const signerAddresses = buildSignerAddresses(config.swapPairs, swapNodeKeys);
  const claimIssuer = new MultiChainClaimIssuer({
    inventory,
    signers,
    channelState,
    signerAddresses,
    // Issue #46 — write-ahead persist before any claim leaves the process.
    ...(persister && { persistState: () => persister.persist() }),
    logger: {
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
      error: logger.error,
    },
  });
  config.__testHooks?.onClaimIssuerBuilt?.(claimIssuer);

  // 8. Staleness guard (rolling-swap §4, swap#48) — the rolling engine's and
  // the RFQ intake's shared `stale_rate` gate. swap#154 (toon-meta#411 Stage
  // 5) deleted the legacy `createSwapHandler` / `withMaxRateAge` wiring this
  // guard used to also feed; the guard itself stays, because the rolling
  // engine (its `stale_rate` reject) and the RFQ intake (the freshness bound
  // it advertises in the quote) both still consume it directly.
  const stalenessGuard = config.maxRateAge
    ? new RateFreshnessGuard({
        maxRateAge: config.maxRateAge,
        // validateConfig() guarantees rateProvider is present with maxRateAge.
        rateProvider: config.rateProvider as SwapRateProvider,
        logger: { warn: logger.warn, info: logger.info },
      })
    : undefined;

  // 11. Connector ownership.
  //
  // Three ownership modes — see SwapNodeConfig docblock:
  //   - `config.connector` supplied         → caller owns; never closed by stop().
  //   - `config.connectorUrl` supplied      → embedded-with-parent: auto-create
  //                                           a ConnectorNode wired to the URL as
  //                                           a parent BTP peer, plus a self-route
  //                                           so packets addressed at `ilpAddress`
  //                                           land on the local handler. swap node owns.
  //   - Neither supplied (+ btpServerPort)  → standalone embedded connector. swap node owns.
  //
  // The embedded-with-parent path makes the swap node a child of an apex connector:
  // outbound packets fall through `g.*` to the parent, inbound packets matching
  // our own ilp prefix dispatch locally (PacketHandler zeros fees on local
  // delivery — see connector packet-handler.ts:1074-1077). `connectorFeePercentage:
  // 0` is set defensively to zero fees on the child even on non-local hops.
  let ownsConnector = false;
  let autoCreatedConnector: ConnectorNode | null = null;
  let effectiveConnector: EmbeddableConnectorLike | undefined =
    config.connector;

  if (config.connector === undefined && config.connectorUrl !== undefined) {
    const nodeId = config.nodeId ?? `toon-swap-${identity.pubkey.slice(0, 16)}`;
    // `btpServerPort` is required by ConnectorNode (rejects port=0 / undefined).
    // Default to 3000 to match the parent-link assumption documented in the
    // dev infra fixtures; operators may override via config.btpServerPort.
    const btpServerPort = config.btpServerPort ?? 3000;
    const parentPeerId = config.parentPeerId ?? 'apex';
    const parentAuthToken = config.parentAuthToken ?? '';
    const ilpAddress =
      config.ilpAddress ?? `g.toon.swap.${identity.pubkey.slice(0, 16)}`;
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
    const swapNodeKeyHex =
      config.settlementPrivateKey ??
      `0x${Buffer.from(identity.secretKey).toString('hex')}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(swapNodeKeyHex)) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.settlementPrivateKey must be a 0x-prefixed 32-byte hex string`
      );
    }
    const resolvedChainProviders = config.chainProviders?.map((p) => ({
      ...p,
      keyId: p.keyId ?? swapNodeKeyHex,
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
            // Tag the upstream as our PARENT so the embedded connector's
            // relation-aware inbound claim validation (toon-protocol/connector#78)
            // skips the per-packet-claim requirement for PREPAREs forwarded by the
            // parent (which settles in aggregate and attaches no per-packet claim
            // to a child). Without this the peer defaults to 'peer' and swap node
            // F06-rejects any claimless parent-forwarded paid packet. NOTE:
            // `parentPeerId` MUST equal the parent connector's nodeId — the
            // connector keys peerRelations by the auth-declared peerId of the
            // inbound BTP session, not a local alias.
            relation: 'parent',
            // Advertise our EVM treasury to the parent so the apex's
            // PerPacketClaimService can open a settlement channel toward
            // this swap node without needing kind:10032 discovery first.
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
        // express in the swap node docker bundle.
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
      logger.debug?.('swap.connector.embedded_with_parent', {
        nodeId,
        btpServerPort,
        parentPeerId,
        parentUrl: config.connectorUrl,
        ilpAddress,
      });
    } catch (err) {
      logger.warn?.('swap.connector.auto_create_failed', {
        err: errSummary(err),
      });
    }
  } else if (
    config.connector === undefined &&
    config.connectorUrl === undefined &&
    config.btpServerPort !== undefined
  ) {
    // Standalone mode: auto-wire an embedded ConnectorNode with no parent
    // peer. `ConnectorNode` rejects port=0 (OS-assigned), so the explicit
    // `btpServerPort` opt-in is what gates this branch.
    const nodeId = config.nodeId ?? `toon-swap-${identity.pubkey.slice(0, 16)}`;
    const btpServerPort = config.btpServerPort;
    // Self-route — without it every inbound packet addressed at our own
    // `ilpAddress` (the common case: a peer streaming a swap directly to
    // us with no upstream apex) hits PacketHandler's `routingTable.
    // getNextHop()` with no matching entry and is F02-rejected as "no
    // route found" before `setPacketHandler`'s local-delivery dispatch
    // (§11a below) ever runs. Mirrors the embedded-with-parent branch's
    // self-route above.
    const ilpAddress =
      config.ilpAddress ?? `g.toon.swap.${identity.pubkey.slice(0, 16)}`;
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
    // branch — see comment above. Standalone swap nodes still benefit from
    // per-packet claim signing/verification when an operator wants it.
    const swapNodeKeyHex =
      config.settlementPrivateKey ??
      `0x${Buffer.from(identity.secretKey).toString('hex')}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(swapNodeKeyHex)) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.settlementPrivateKey must be a 0x-prefixed 32-byte hex string`
      );
    }
    const resolvedChainProviders = config.chainProviders?.map((p) => ({
      ...p,
      keyId: p.keyId ?? swapNodeKeyHex,
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connectorConfig: any = {
        nodeId,
        btpServerPort,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [],
        routes: [{ prefix: ilpAddress, nextHop: nodeId, priority: 100 }],
        localDelivery: { enabled: false },
        // Zero fees on our own egress, mirroring the embedded-with-parent
        // branch. Without it the connector's default fee shaves the ILP
        // `amount` of the ONE thing a standalone maker ever forwards — its
        // own rolling leg-B PREPARE — so the packet would understate the
        // chain-B claim it carries (3000 → 2997).
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
      logger.debug?.('swap.connector.auto_created', {
        nodeId,
        btpServerPort,
        ilpAddress,
      });
    } catch (err) {
      logger.warn?.('swap.connector.auto_create_failed', {
        err: errSummary(err),
      });
    }
  }

  // 11a-pre. Rolling coupled-leg engine (issue #47, rolling-swap §3).
  //
  // Constructed unconditionally: without registered sessions every rolling
  // fill is a benign F06, so an idle engine costs nothing. Shares the
  // staleness guard (same feed-tick state the RFQ intake's freshness bound
  // reads) and — when persistence is enabled — the persistent replay set, so
  // rolling replay reservations hit disk synchronously (state-store crash
  // rule 4) under `rolling:${streamNonce}:${seq}` keys, disjoint from
  // gift-wrap ids.
  const resolvedNodeId =
    config.nodeId ?? `toon-swap-${identity.pubkey.slice(0, 16)}`;
  const rollingLegBSender: LegBSender =
    config.rollingLegBSender ??
    (effectiveConnector
      ? createConnectorLegBSender(effectiveConnector, {
          nodeId: resolvedNodeId,
          logger: { warn: logger.warn, info: logger.info },
        })
      : async () => ({
          type: 'reject',
          code: 'T00',
          message: 'no connector available for leg-B egress',
        }));
  const rollingSessions = new RollingSessionStore({
    ...(config.rolling?.sessionTtlMs !== undefined && {
      ttlMs: config.rolling.sessionTtlMs,
    }),
    ...(config.rolling?.maxSessions !== undefined && {
      maxSessions: config.rolling.maxSessions,
    }),
  });
  const rollingSeen =
    config.seenPacketIds ?? persistentSeen ?? new PersistentSeenPacketIds();
  const rollingEngine = new RollingSwapEngine({
    sessions: rollingSessions,
    claimIssuer,
    legBSender: rollingLegBSender,
    seenPacketIds: rollingSeen,
    // Spec §7.2 / sdk 2.2.0 (toon#84): sign per-fulfill stream receipts with
    // the swap node's Nostr identity key — the sdk's default receipt key —
    // so senders verify them against the maker's advertised `swapPubkey`.
    receiptSecretKey: identity.secretKey,
    ...(config.rateProvider && { rateProvider: config.rateProvider }),
    ...(stalenessGuard && { stalenessGuard }),
    logger: { info: logger.info, warn: logger.warn, error: logger.error },
    ...(config.rolling?.legBBudgetMs !== undefined && {
      legBBudgetMs: config.rolling.legBBudgetMs,
    }),
    ...(config.rolling?.legBExpiryMarginMs !== undefined && {
      legBExpiryMarginMs: config.rolling.legBExpiryMarginMs,
    }),
    ...(config.rolling?.minLegBTimeMs !== undefined && {
      minLegBTimeMs: config.rolling.minLegBTimeMs,
    }),
    ...(config.rolling?.reservationGraceMs !== undefined && {
      reservationGraceMs: config.rolling.reservationGraceMs,
    }),
  });

  // 10c. Rolling RFQ intake (spec §2.2) — the transport that mints a session.
  //
  // Without it `rollingSessions` can only ever be populated by the in-process
  // `registerRollingSession`, which `cli.ts` (what the container runs) never
  // calls — so every rolling fill reaching a deployed maker F06s
  // `unknown_session` and the rolling protocol is unreachable on the wire.
  //
  // Quote source mirrors the engine's: the timestamped `rateProvider` when the
  // operator configured one, else the pair's static advertised rate.
  // 10b-bis. Leg-B return path (see `leg-b-return-path.ts`). A direct-dialled
  // sender is an inbound BTP session, not a routing-table entry, so without
  // this every leg B is F02'd inside the maker's own connector and the
  // rolling protocol is undeliverable. Driven purely off the connector's
  // public routing API — NO new config key, and no operator route.
  const legBReturnRoutes: LegBReturnRouteBinder = createLegBReturnRouteBinder(
    effectiveConnector,
    {
      ilpAddress:
        config.ilpAddress ?? `g.toon.swap.${identity.pubkey.slice(0, 16)}`,
      logger: { debug: logger.debug, warn: logger.warn },
    }
  );

  const rfqIntake = createRollingRfqIntake({
    swapPairs: config.swapPairs,
    bindReturnPath: (args) => legBReturnRoutes.bind(args),
    secretKey: identity.secretKey,
    signerAddresses,
    registerSession: (session) => rollingEngine.registerSession(session),
    ...(stalenessGuard && {
      maxRateAgeMs: (pair: SwapPair) =>
        stalenessGuard.resolveMaxRateAgeMs(pair),
    }),
    quote: async (pair: SwapPair) => {
      if (config.rateProvider) {
        const quoted = await config.rateProvider(pair);
        return typeof quoted === 'string'
          ? { rate: quoted, rateTimestamp: Date.now() }
          : { rate: quoted.rate, rateTimestamp: quoted.at };
      }
      return { rate: pair.rate, rateTimestamp: Date.now() };
    },
    ...(config.rolling?.rfq && { rfq: config.rolling.rfq }),
    logger: { debug: logger.debug, warn: logger.warn, info: logger.info },
  });

  // 11a. Wire `handlePacket` to the connector's local-delivery path.
  //
  // Story 50.3 (SOL settlement leg, AC#4): inbound kind:1059 (NIP-59 gift-wrap)
  // swap-request packets destined for swap node's OWN ILP address MUST be
  // dispatched to `handlePacket` so swap node returns a signed claim, a
  // quote, or a reject in the FULFILL `data`. swap node does NOT route
  // through `createToonNode()` (the SDK helper that performs this wiring for
  // town nodes), so without an explicit `setPacketHandler()` call the
  // embedded ConnectorNode has no `localDeliveryHandler` set. With
  // `localDelivery: { enabled: false }`, the connector's PacketHandler then
  // falls through to its auto-fulfill stub, returning the literal string
  // `"Local delivery - auto-fulfill stub"` as FULFILL data — which no
  // sender's decoder can JSON.parse.
  //
  // swap#154 (toon-meta#411 Stage 5) dispatch matrix (condition class ×
  // payload class) — the legacy claim-in-FULFILL row is gone. A zero/absent
  // condition that isn't a rolling fill now falls to `rfqIntake.handle()`,
  // which is TERMINAL: kind:20033 mints a session, anything else (the
  // retired legacy kind:20032, or anything unparseable) is a named reject.
  //
  // Rows are in the order the branches below test them:
  //
  //   | executionCondition | payload         | path                          |
  //   |--------------------|-----------------|-------------------------------|
  //   | any                | malformed fill  | reject F01 malformed_fill     |
  //   | non-zero (32B)     | rolling fill    | rolling engine (coupled legs) |
  //   | non-zero (32B)     | anything else   | reject F01 malformed_fill     |
  //   | absent / all-zero  | rolling fill    | reject F99 condition_required |
  //   | absent / all-zero  | kind:20033 RFQ  | rolling RFQ intake (session)  |
  //   | absent / all-zero  | anything else   | rfqIntake reject (terminal)   |
  const decodeSenderCondition = (b64?: string): Uint8Array | null => {
    if (typeof b64 !== 'string' || b64.length === 0) return null;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
    if (buf.length !== 32) return null;
    // An all-zero condition is the contract's "legacy" packet class
    // (contract §classes) — the seam the RFQ intake now owns terminally.
    if (buf.every((b) => b === 0)) return null;
    return new Uint8Array(buf);
  };

  const handlePacket = async (
    request: HandlePacketRequest,
    /**
     * The peer id the connector bound this packet's arrival under — for a BTP
     * arrival, the `peerId` the session authenticated with
     * (connector `btp/btp-server.ts` `authenticatePeer`), surfaced as
     * `LocalDeliveryRequest.sourcePeer`. Undefined when the connector does not
     * report one (legacy `setPacketHandler` wiring / test doubles), which is
     * exactly the pre-fix behaviour.
     */
    sourcePeer?: string
  ): Promise<HandlePacketResponse> => {
    const requestExt = request as HandlePacketRequest & {
      executionCondition?: string;
      expiresAt?: string;
    };
    const senderCondition = decodeSenderCondition(
      requestExt.executionCondition
    );
    const rollingFill = parseRollingFillPayload(request.data);

    // swap#152 (ADR 0003's removal gate) — one classified intake event per
    // arrival, emitted from the SAME branches that already decide dispatch,
    // so classification can never diverge from the routing decision it
    // describes. `sender` is the ILP-level identity already on hand at this
    // seam (never the gift wrap's Nostr pubkey, which would require an extra
    // unwrap and still isn't an ILP address/peer id) — a BTP arrival's peer
    // id when the connector reports one, else the packet's own
    // `sourceAccount`. Reads nothing the dispatch below does not already
    // read, and decides nothing: the wire outcome is identical whether or not
    // a logger is installed.
    const intakeSender = sourcePeer ?? request.sourceAccount;
    const emitIntake = (
      intakeClass: SwapIntakeClass,
      extra: { pair?: string; reason?: string } = {}
    ): void => {
      logger.info?.(SWAP_INTAKE_EVENT, {
        class: intakeClass,
        sender: intakeSender,
        ...extra,
      });
    };
    /** The pair a fill's session was minted for — absent once it has expired. */
    const sessionPairLabel = (streamNonce: string): string | undefined =>
      formatPairLabel(rollingSessions.get(streamNonce)?.pair);

    /** The one answer both malformed-fill branches below give, byte for byte. */
    const malformedFillReject = (): HandlePacketResponse => {
      emitIntake('refused', { reason: ROLLING_REJECT_REASONS.MALFORMED_FILL });
      return buildRollingReject({
        code: 'F01',
        semantic: 'invalid_request',
        message: 'malformed rolling fill payload',
        reason: ROLLING_REJECT_REASONS.MALFORMED_FILL,
      }) as HandlePacketResponse;
    };

    if (rollingFill === 'malformed') {
      // Self-identified rolling/1 traffic that violates the fill shape:
      // reject F01 with a precise reason rather than a generic one.
      return malformedFillReject();
    }
    if (senderCondition) {
      if (rollingFill === null) {
        // A real sender-chosen condition paired with a payload that is not
        // even rolling/1-shaped. The rolling fill protocol is the only thing
        // this maker accepts under a real condition — the retired legacy
        // claim-in-FULFILL path never set one (swap#154) — so this is
        // malformed input, not a distinct case.
        return malformedFillReject();
      }
      emitIntake('rolling-fill', {
        pair: sessionPairLabel(rollingFill.streamNonce),
      });
      return (await rollingEngine.handleFill({
        amount: request.amount,
        destination: request.destination,
        executionCondition: senderCondition,
        payload: rollingFill,
        ...(requestExt.expiresAt !== undefined && {
          expiresAt: requestExt.expiresAt,
        }),
      })) as HandlePacketResponse;
    }
    if (rollingFill !== null) {
      // A rolling fill without a sender-chosen condition has NO coupling
      // (spec R2: a zero condition is skipped by every verifier) — refuse
      // rather than fill uncoupled.
      emitIntake('refused', {
        reason: ROLLING_REJECT_REASONS.CONDITION_REQUIRED,
        pair: sessionPairLabel(rollingFill.streamNonce),
      });
      return buildRollingReject({
        code: 'F99',
        semantic: 'application_error',
        message: 'rolling fill requires a sender-chosen execution condition',
        reason: ROLLING_REJECT_REASONS.CONDITION_REQUIRED,
      }) as HandlePacketResponse;
    }

    // Rolling RFQ (spec §2.2) — a zero-condition kind:1059 gift wrap,
    // distinguished from anything else on this seam only by its inner rumor
    // kind (20033). `handle()` is TERMINAL (swap#154, toon-meta#411 Stage 5):
    // it always returns an accept or a named reject, never `null` — there is
    // no more legacy fall-through for it to defer to. It emits its own
    // `swap.intake.arrival` classification (it already pays for the unwrap
    // that identifies the class, including the refused ones).
    return (await rfqIntake.handle(request.data, {
      ...(sourcePeer !== undefined ? { sourcePeer } : {}),
    })) as HandlePacketResponse;
  };

  // Register the handler as the connector's local-delivery callback.
  //
  // PREFER `setLocalDeliveryHandler`: `setPacketHandler` is the same slot
  // wrapped in the connector's own `createPaymentHandlerAdapter`, and that
  // adapter DROPS `LocalDeliveryRequest.sourcePeer` when it narrows the
  // request to a `PaymentRequest` (connector `core/payment-handler.ts`). The
  // arrival peer is the only evidence the maker has of which BTP session to
  // return leg B on, so the swap node applies the SAME adapter itself and
  // threads `sourcePeer` through. Behaviour is otherwise byte-identical —
  // it is literally the connector's own adapter.
  //
  // Both calls stay guarded: `setPacketHandler` is optional on
  // `EmbeddableConnectorLike` (HTTP-mode connectors and test doubles may omit
  // it) and `setLocalDeliveryHandler` is not on that interface at all.
  const connectorWithLocalDelivery = effectiveConnector as
    | (EmbeddableConnectorLike & {
        setLocalDeliveryHandler?: (handler: LocalDeliveryHandler) => void;
      })
    | undefined;
  if (connectorWithLocalDelivery?.setLocalDeliveryHandler) {
    const adapterLogger = createConnectorLogger(
      'swap-local-delivery',
      (process.env['TOON_CONNECTOR_LOG_LEVEL'] as
        | 'debug'
        | 'info'
        | 'warn'
        | 'error'
        | undefined) ?? 'warn'
    );
    type ConnectorPaymentHandler = Parameters<
      typeof createPaymentHandlerAdapter
    >[0];
    const localDeliveryHandler: LocalDeliveryHandler = (
      request: LocalDeliveryRequest,
      sourcePeerId: string | undefined
    ) => {
      const arrivalPeer = sourcePeerId ?? request.sourcePeer;
      // Built per packet so the arrival peer is captured in the closure
      // rather than in shared mutable state (packets interleave).
      const adapter = createPaymentHandlerAdapter(
        ((paymentRequest: unknown) =>
          handlePacket(
            paymentRequest as HandlePacketRequest,
            arrivalPeer
          )) as unknown as ConnectorPaymentHandler,
        adapterLogger
      );
      return adapter(request, sourcePeerId as string);
    };
    connectorWithLocalDelivery.setLocalDeliveryHandler(localDeliveryHandler);
    logger.debug?.('swap.connector.packet_handler_wired', {
      via: 'setLocalDeliveryHandler',
    });
  } else if (effectiveConnector?.setPacketHandler) {
    effectiveConnector.setPacketHandler(handlePacket);
    logger.debug?.('swap.connector.packet_handler_wired', {
      via: 'setPacketHandler',
    });
  } else {
    logger.warn?.('swap.connector.packet_handler_unavailable', {
      reason:
        'connector exposes no setPacketHandler; inbound kind:1059 swap packets cannot be dispatched to the swap handler',
    });
  }

  // 11b. Start the auto-created connector.
  //
  // Story 50.4: an auto-created ConnectorNode does NOT open its BTP server or
  // dial its parent peer until `.start()` is called (ConnectorNode.sendPacket
  // throws `ConnectorNotStartedError` until then). Without this, every outbound
  // `sendPacket()` (including the kind:10032 ILP advertisement below) has no
  // live session to route through. Operator-supplied connectors
  // (`config.connector`) are the caller's responsibility to start — mirrors
  // `startTown()`, which only starts the connectors it auto-creates.
  //
  // `start()` resolves promptly even when the parent is unreachable (the BTP
  // peer dial retries in the background), so a flaky/absent parent MUST NOT
  // abort boot (R-8N2). A genuine start failure is surfaced at `error`.
  if (ownsConnector && autoCreatedConnector) {
    try {
      await autoCreatedConnector.start();
      logger.debug?.('swap.connector.started', {
        nodeId: config.nodeId ?? `toon-swap-${identity.pubkey.slice(0, 16)}`,
      });
    } catch (err) {
      logger.error?.('swap.connector.start_failed', { err: errSummary(err) });
    }
  }

  // 12. BLS server (Hono).
  let status: SwapNodeHealthResponse['status'] = 'starting';
  const getHealth = (): SwapNodeHealthResponse => {
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
    // Issue #49 — the three-bucket window view (in-flight / unsettled /
    // free) per pool: the honeypot-sized exposure signal (spec §8).
    const inventoryWindow: Record<string, SwapNodeHealthWindowEntry> = {};
    for (const w of inventory.windowSnapshot()) {
      inventoryWindow[`${w.assetCode}:${w.chain}`] = {
        budget: w.budget.toString(),
        inFlight: w.inFlight.toString(),
        unsettled: w.unsettled.toString(),
        free: w.free.toString(),
      };
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
      inventoryWindow,
    };
  };

  const app = new Hono();
  app.get('/health', (c: Context) => c.json(getHealth()));
  // Issue #138 — operator surface. Mounted under `/admin` so the fleet's
  // existing box-nginx `^~ /admin` 404 rule covers it; writes additionally
  // require `config.adminToken` and are disabled (503) when none is set.
  // See `admin-surface.ts` for the full protection rationale.
  registerAdminRoutes(app, {
    inventory,
    reconciler,
    ...(config.adminToken !== undefined && { adminToken: config.adminToken }),
  });

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
  //      fail to advertise the swap node.
  if (config.knownPeers && config.knownPeers.length > 0) {
    logger.warn?.('swap.knownPeers.ignored', {
      count: config.knownPeers.length,
      reason:
        'bootstrap-via-ILP publishing is deferred to Story 12.8 E2E; knownPeers are accepted but not currently dispatched',
    });
  }

  // Flipped by `stop()` so the ILP advertisement retry loop below bails out
  // promptly during teardown instead of retrying for ~24s against a connector
  // that is being closed.
  let stopRequested = false;
  // The kind:10032 refresh loop's handle, cleared by `stop()`. Declared out
  // here (rather than beside the loop) because the publish block below is
  // wrapped in a try/catch whose scope `stop()` cannot see into.
  let peerInfoRefreshTimer: ReturnType<typeof setInterval> | undefined;

  // 13. Publish kind:10032 with swapPairs.
  //
  // Two publish paths (Story 50.4):
  //   (a) ILP advertisement (production) — when `config.publisher` is not
  //       injected and `peerInfoIlpDestination` + a connector are present,
  //       route the TOON-encoded kind:10032 to that relay's ILP address via an
  //       ILP PREPARE through the embedded connector. This is the ONLY write
  //       path a TOON relay accepts: its WebSocket EVENT handler rejects unpaid
  //       writes, so a plain Nostr publish (path b) is silently dropped by a
  //       TOON relay. Mirrors `startTown()`'s self-advertise via
  //       `ilpClient.sendIlpPacket`.
  //   (b) Nostr WS publish (legacy) — SimplePool.publish against
  //       `config.relayUrls`. Retained for vanilla Nostr relays and as the
  //       fallback when no ILP destination is configured; a no-op against a
  //       pay-to-write TOON relay.
  //
  // Publish is fire-and-forget — a failing/absent relay MUST NOT fail boot
  // (R-8N2). The ILP path retries across a window (the parent BTP session
  // establishes asynchronously after `start()`); exhausting it logs at `error`
  // so a gate run fails LOUDLY with a reason instead of timing out 30s
  // downstream on a silently-dropped advertisement (Story 50.4 AC #2).
  let autoPool: SimplePool | undefined;

  const wsPublisher: Publisher = {
    async publish(event: unknown): Promise<void> {
      autoPool ??= new SimplePool();
      // `Promise.allSettled` ensures a single rejecting relay cannot
      // surface an aggregate rejection back to the caller.
      const promises = autoPool.publish(
        [...config.relayUrls],
        event as NostrEvent
      );
      const results = await Promise.allSettled(promises);
      const rejected = results.filter((r) => r.status === 'rejected');
      for (const r of rejected) {
        logger.warn?.('swap.peerInfo.relay_publish_failed', {
          err: errSummary((r as PromiseRejectedResult).reason),
        });
      }
      // A TOON relay ACKs the WS EVENT with OK=false rather than dropping the
      // socket, so `allSettled` resolves even though nothing was stored. Surface
      // the limitation loudly so a misconfigured (ILP-less) swap node is diagnosable
      // instead of silently never-advertising (Story 50.4 AC #2).
      logger.warn?.('swap.peerInfo.ws_publish_unverified', {
        relayUrls: config.relayUrls,
        reason:
          'Nostr WS publish cannot be confirmed stored; a TOON relay is pay-to-write. Set peerInfoIlpDestination to advertise via ILP.',
      });
    },
  };

  const ilpPublisher: Publisher | undefined =
    effectiveConnector && config.peerInfoIlpDestination
      ? (() => {
          const destination = config.peerInfoIlpDestination;
          const pricePerByte = config.peerInfoPricePerByte ?? 0n;
          const ilpClient = createDirectIlpClient(
            effectiveConnector as unknown as ConnectorNodeLike
          );
          const maxAttempts =
            config.__testHooks?.peerInfoPublishRetry?.maxAttempts ?? 12;
          const retryDelayMs =
            config.__testHooks?.peerInfoPublishRetry?.delayMs ?? 2_000;
          return {
            async publish(event: unknown): Promise<void> {
              const toonBytes = encodeEventToToon(event as NostrEvent);
              const data = Buffer.from(toonBytes).toString('base64');
              const amount = String(BigInt(toonBytes.length) * pricePerByte);
              let lastReason = 'no attempt made';
              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (stopRequested) return;
                try {
                  const res = await ilpClient.sendIlpPacket({
                    destination,
                    amount,
                    data,
                  });
                  if (res.accepted) {
                    logger.info?.('swap.peerInfo.published', {
                      destination,
                      attempt,
                      eventId: (event as NostrEvent).id,
                    });
                    return;
                  }
                  lastReason = `${res.code ?? 'reject'}: ${res.message ?? 'rejected by relay'}`;
                } catch (err) {
                  lastReason = errSummary(err).message;
                }
                logger.debug?.('swap.peerInfo.publish_retry', {
                  destination,
                  attempt,
                  maxAttempts,
                  reason: lastReason,
                });
                if (attempt < maxAttempts && !stopRequested) {
                  await new Promise((r) => setTimeout(r, retryDelayMs));
                }
              }
              if (stopRequested) return;
              // Loud, terminal failure (Story 50.4 AC #2). Logged at `error`
              // (→ stderr via the entrypoint logger) rather than thrown: the
              // call site is fire-and-forget, so a throw would only become a
              // floating rejection it already logs. Logging here keeps the
              // diagnosis attached to the per-attempt context.
              logger.error?.('swap.peerInfo.publish_failed', {
                destination,
                attempts: maxAttempts,
                reason: lastReason,
                hint: 'kind:10032 advertisement never stored — gate discovery will time out. Check the relay ILP route + price.',
              });
            },
          };
        })()
      : undefined;

  // Story 50.4: if an operator set `peerInfoIlpDestination` but supplied no
  // connector (neither `config.connector` nor `config.connectorUrl`, so no
  // connector was auto-created), `ilpPublisher` is undefined and the kind:10032
  // silently falls back to the WS path — which a pay-to-write TOON relay drops,
  // and whose warning misleadingly tells the operator to "Set
  // peerInfoIlpDestination" they already set. Surface the misconfiguration
  // loudly so the dead advertisement is diagnosable at boot (AC #2).
  if (config.peerInfoIlpDestination && !effectiveConnector) {
    logger.error?.('swap.peerInfo.ilp_destination_ignored', {
      destination: config.peerInfoIlpDestination,
      reason:
        'peerInfoIlpDestination is set but no connector is available (set config.connector or config.connectorUrl). kind:10032 will fall back to an unpaid Nostr WS publish that a TOON relay rejects.',
    });
  }

  const effectivePublisher: Publisher =
    config.publisher ?? ilpPublisher ?? wsPublisher;

  // NIP-40 TTL + refresh cadence. Resolved here (not at each republish) so the
  // one-time "you have configured a permanent advertisement" diagnostics fire
  // once, at boot, where an operator will see them.
  //
  // Neither value can fail boot: `swap:release` auto-deploys on green main and
  // the box's config file is bind-mounted, not baked, so a value this code
  // rejects becomes a crash loop on a live maker rather than a build failure.
  const peerInfoTtlSeconds =
    config.peerInfoTtlSeconds ?? DEFAULT_PEER_INFO_TTL_SECONDS;
  const peerInfoRefreshIntervalMs =
    config.peerInfoRefreshIntervalMs ?? DEFAULT_PEER_INFO_REFRESH_INTERVAL_MS;
  if (peerInfoTtlSeconds <= 0) {
    logger.warn?.('swap.peerInfo.no_expiration', {
      reason:
        'peerInfoTtlSeconds is non-positive, so the kind:10032 carries no NIP-40 expiration tag. It is a replaceable event: once this node stops, nothing but a newer event signed by this same key can retract it, and if the key is lost the advertisement is permanent.',
    });
  } else if (
    peerInfoRefreshIntervalMs > 0 &&
    peerInfoRefreshIntervalMs >= peerInfoTtlSeconds * 1000
  ) {
    // The one failure mode worse than litter: a LIVE node that expires out of
    // discovery in the gap between two of its own announces.
    logger.error?.('swap.peerInfo.refresh_slower_than_ttl', {
      peerInfoTtlSeconds,
      peerInfoRefreshIntervalMs,
      reason:
        'peerInfoRefreshIntervalMs is not shorter than peerInfoTtlSeconds, so this node will expire out of discovery between its own republishes. Lower the refresh interval (the fleet convention is 240s against a 600s TTL) or raise the TTL.',
    });
  }
  if (peerInfoRefreshIntervalMs <= 0 && peerInfoTtlSeconds > 0) {
    logger.warn?.('swap.peerInfo.refresh_disabled', {
      peerInfoTtlSeconds,
      reason:
        'peerInfoRefreshIntervalMs is non-positive, so the kind:10032 is published once at boot and never renewed. It will expire after peerInfoTtlSeconds and this node will vanish from discovery unless another publisher on this same identity refreshes it.',
    });
  }

  try {
    const ownIlpInfo: IlpPeerInfo & {
      /**
       * Issue #133 — leg-B extension key. `@toon-protocol/core`'s
       * `IlpPeerInfo` has no field for a swap maker's EIP-712
       * `verifyingContract`, and `buildIlpPeerInfoEvent` serializes the info
       * object verbatim, so the extra key rides along in the kind:10032
       * content. Named distinctly from `tokenNetworks` (leg A) precisely so
       * the two can never be confused again.
       */
      swapVerifyingContracts?: Record<string, string>;
    } = {
      // The SWAP_MNEMONIC-derived identity pubkey — the authoritative
      // `swapPubkey` streamSwap callers discover here and gift-wrap to. Signed
      // below with the matching `identity.secretKey`. (issues #80/#88)
      pubkey: identity.pubkey,
      ilpAddress:
        config.ilpAddress ?? `g.toon.swap.${identity.pubkey.slice(0, 16)}`,
      btpEndpoint: config.btpEndpoint ?? '',
      assetCode: config.advertisedAsset?.assetCode ?? 'USD',
      assetScale: config.advertisedAsset?.assetScale ?? 6,
      // Issue #102 — this node's per-chain payout address: the counterparty a
      // client's leg-A `openChannel` names, and the address a leg-B claim must
      // recover to. Keyed by `pair.to.chain`, the same key the claims
      // themselves are signed under.
      settlementAddresses: { ...signerAddresses },
      // Issue #133 — LEG A. The deployed `TokenNetwork` a client opens its
      // payment channel against (`ToonClient.negotiationFromAnnounce` reads
      // exactly this key, then `ChannelManager.ensureChannel` calls
      // `TokenNetwork.openChannel(participant2, settlementTimeout)` on it).
      tokenNetworks: { ...tokenNetworks },
      // Issue #133 — LEG B. This maker's `RollingSwapChannel` per chain: the
      // EIP-712 `verifyingContract` a received v2 balance-proof claim verifies
      // under. Deliberately a separate key from `tokenNetworks`: the two are
      // different contracts with different ABIs.
      swapVerifyingContracts: { ...swapVerifyingContracts },
      // Issue #114 — a stock client's apex `addApex` onboarding hard-refuses
      // an announce with no `supportedChains` ("announced no supportedChains
      // — cannot settle"). `distinctTargetChains` is the same chain set
      // `swapPairs`' to-legs already advertise; `preferredTokens` is built
      // in the same signer-construction loop above.
      supportedChains: [...distinctTargetChains],
      preferredTokens: { ...preferredTokens },
      swapPairs: [...config.swapPairs],
    };
    // Re-signed on every call rather than signed once and re-sent: the NIP-40
    // `expiration` tag is `created_at + ttl`, so a cached event would advertise
    // an expiry that recedes into the past no matter how often it is
    // republished. `ownIlpInfo` itself is boot-static, so only the timestamps
    // (and hence id/sig) differ between rounds.
    const publishPeerInfo = (round: number): void => {
      try {
        const ilpInfoEvent = buildIlpPeerInfoEvent(
          ownIlpInfo,
          identity.secretKey,
          // Non-positive → core omits the tag entirely, which is the documented
          // "never expires" escape hatch already warned about above.
          { ttlSeconds: peerInfoTtlSeconds }
        );
        config.__testHooks?.onPeerInfoBuilt?.(ilpInfoEvent);
        logger.debug?.('swap.peerInfo.built', {
          id: ilpInfoEvent.id,
          round,
          ttlSeconds: peerInfoTtlSeconds,
          swapPairs: config.swapPairs.length,
          via: ilpPublisher && !config.publisher ? 'ilp' : 'ws',
          destination: config.peerInfoIlpDestination,
          relayUrls: config.relayUrls,
        });

        // Fire-and-forget so boot is not blocked on relay I/O. Failures are
        // logged at error here (the publisher impls already log per-attempt
        // detail). A failed round is NOT retried out of band: the next refresh
        // is the retry, and it lands well inside the TTL.
        void effectivePublisher.publish(ilpInfoEvent).catch((err) => {
          logger.error?.('swap.peerInfo.publish_failed', {
            round,
            err: errSummary(err),
          });
        });
      } catch (err) {
        logger.error?.('swap.peerInfo.publish_failed', {
          round,
          err: errSummary(err),
        });
      }
    };

    publishPeerInfo(0);

    // The refresh loop. Without it the TTL above would be a self-inflicted
    // outage: one publish at boot, then silent disappearance from discovery
    // `peerInfoTtlSeconds` later.
    if (peerInfoRefreshIntervalMs > 0) {
      let round = 0;
      peerInfoRefreshTimer = setInterval(() => {
        if (stopRequested) return;
        round += 1;
        publishPeerInfo(round);
      }, peerInfoRefreshIntervalMs);
      // Never hold the process (or a test runner) open on account of an
      // advertisement refresh.
      peerInfoRefreshTimer.unref?.();
    }
  } catch (err) {
    logger.error?.('swap.peerInfo.publish_failed', { err: errSummary(err) });
  }

  status = 'ok';

  // 14. Build SwapNodeInstance.
  let stopped = false;
  const instance: SwapNodeInstance = {
    identity,
    blsPort: livePort,
    swapNodeKeys,
    ...(effectiveConnector !== undefined && { connector: effectiveConnector }),
    _rollingEngine: rollingEngine,
    registerRollingSession: (session: RollingSession) => {
      rollingEngine.registerSession(session);
    },
    reconcileInventory: () => reconciler.reconcile(),
    recordSettlement: (event: SettlementEvent): bigint => {
      // Resolve the (assetCode, chain) pool via the provisioned channel
      // state: stored keys are `${assetCode}:${chain}:${channelId}`.
      const { channels: liveChannels } = channelState.snapshot();
      const matches: { assetCode: string; chain: string }[] = [];
      for (const [storedKey, entry] of Object.entries(liveChannels)) {
        if (entry.channelId !== event.channelId) continue;
        const suffix = `:${event.channelId}`;
        if (!storedKey.endsWith(suffix)) continue;
        const prefix = storedKey.slice(0, -suffix.length);
        const sep = prefix.indexOf(':');
        if (sep <= 0) continue;
        matches.push({
          assetCode: prefix.slice(0, sep),
          chain: prefix.slice(sep + 1),
        });
      }
      if (matches.length === 0) {
        logger.warn?.('swap.recordSettlement.unknown_channel', {
          channelId: event.channelId,
          txHash: event.txHash,
        });
        return 0n;
      }
      if (matches.length > 1) {
        logger.warn?.('swap.recordSettlement.ambiguous_channel', {
          channelId: event.channelId,
          matches,
          note: 'applying to the first match only; provision distinct channelIds per (asset, chain) pool',
        });
      }
      const [target] = matches;
      if (!target) return 0n; // unreachable (length checked above)
      const reduced = inventory.recordSettlement({
        assetCode: target.assetCode,
        chain: target.chain,
        channelId: event.channelId,
        cumulativeAmount: BigInt(event.cumulativeAmount),
      });
      if (persister) {
        try {
          persister.persist();
        } catch (err) {
          logger.error?.('swap.recordSettlement.persist_failed', {
            err: errSummary(err),
          });
        }
      }
      logger.info?.('swap.recordSettlement.ok', {
        channelId: event.channelId,
        chain: target.chain,
        asset: target.assetCode,
        txHash: event.txHash,
        cumulativeAmount: event.cumulativeAmount,
        liabilityReduced: reduced.toString(),
      });
      return reduced;
    },
    health: getHealth,
    async stop() {
      if (stopped) return;
      stopped = true;
      stopRequested = true;
      status = 'stopping';
      if (peerInfoRefreshTimer !== undefined) {
        clearInterval(peerInfoRefreshTimer);
        peerInfoRefreshTimer = undefined;
      }
      reconciler.stop();
      // Withdraw the ephemeral leg-B return routes this node installed, so a
      // connector the caller OWNS (config.connector) is handed back with the
      // routing table it came with.
      legBReturnRoutes.release();
      try {
        await new Promise<void>((resolve) => {
          blsServer.close(() => resolve());
        });
      } catch (err) {
        logger.warn?.('swap.stop.bls_close_failed', { err: errSummary(err) });
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
          logger.warn?.('swap.stop.connector_close_failed', {
            err: errSummary(err),
          });
        }
      }
      // Issue #46 — deliberately NO persist here: `releaseAll()` zeroes the
      // in-memory reservation bookkeeping for GC, but the on-disk snapshot
      // must keep the last handed-out watermarks (they are what the next
      // boot rehydrates). Persisting the zeroed state would be the
      // watermark reset this feature exists to prevent.
      try {
        channelState.releaseAll();
      } catch (err) {
        logger.warn?.('swap.stop.release_all_failed', {
          err: errSummary(err),
        });
      }
      // Story 12.8 AC-13: close the auto-created SimplePool (if any) so the
      // swap node does not leak relay sockets on shutdown. Operator-injected
      // publishers are the caller's responsibility to close.
      if (autoPool) {
        try {
          (autoPool as unknown as { close?: (urls: string[]) => void }).close?.(
            [...config.relayUrls]
          );
        } catch (err) {
          logger.warn?.('swap.stop.pool_close_failed', {
            err: errSummary(err),
          });
        }
      }
      status = 'stopped';
    },
  };

  // 15. Issue #138 — boot reconcile + periodic cadence. Fire-and-forget: a
  //     slow or unreachable RPC must not delay (or fail) boot, and a maker
  //     that booted with capacity blocked by already-redeemed claims should
  //     start serving again on its own, without an operator or a redeploy.
  if (reconciler.enabled) {
    void reconciler.runGuarded();
    reconciler.start();
    logger.debug?.('swap.reconcile.armed', {
      intervalMs: config.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    });
  } else {
    logger.warn?.('swap.reconcile.disabled', {
      reason:
        'no EVM chainProviders entry, so no on-chain reader: redeemed claims can never be observed and the capacity they hold can never be recycled',
    });
  }

  return instance;
}
