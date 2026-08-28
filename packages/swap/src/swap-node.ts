/**
 * `startSwapNode()` — programmatic entrypoint for a TOON swap **maker**.
 *
 * The maker is a relay-mediated swap client (`docs/relay-swap.md`): a plain
 * toon client that publishes an order, reads its gift-wrapped inbox, verifies
 * each taker's leg-A claim itself, and answers with its leg-B claim. This
 * process:
 *
 *   - derives its Nostr identity and per-chain signing keys from one
 *     mnemonic (`nostr-keys.ts`, `deriveSwapNodeKeys`; BIP-44 account 2),
 *   - holds the leg-B capital: `SwapInventory` (the rolling window),
 *     `SwapChannelState` (per-channel nonce/cumulative watermarks) and the
 *     `MultiChainClaimIssuer` that signs leg-B balance proofs,
 *   - runs the relay loop (`swap-maker.ts`) when `relay` is configured —
 *     paid writes through the relay's connector, free reads over NIP-01,
 *   - serves `GET /health` and the admin surface on `node:http`,
 *   - persists its state (schema v3) and reconciles it against the chains.
 *
 * It embeds no connector, terminates no route, and is reachable by nobody:
 * a taker finds it by its order and talks to it through the relay.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { NostrEvent } from 'nostr-tools/pure';
import { fromMnemonic, base58Encode } from '@toon-protocol/sdk';
import type { NodeIdentity } from '@toon-protocol/sdk';
import { VERSION } from '@toon-protocol/core';
import type { SwapPair } from '@toon-protocol/core';

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
import { handleAdminRequest, isAdminPath } from './admin-surface.js';
import type { AdminRequest } from './admin-surface.js';
import { deriveNostrIdentity } from './nostr-keys.js';
import type { NostrIdentity } from './nostr-keys.js';
import { createRpcChannelSlotReader } from './received-claim.js';
import type { ChannelFacts, ChannelSlotReader } from './received-claim.js';
import { RelaySubscription } from './relay-subscription.js';
import { createRelayClient, createRelayWriter } from './relay-writer.js';
import type { RelayWriter } from './relay-writer.js';
import { SwapMakerLoop } from './swap-maker.js';
import type { RelayReader, SwapMakerLoopHealth } from './swap-maker.js';
import {
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
  TokenNetworkBalanceProofSigner,
} from './payment-channel-signer.js';
import type { PaymentChannelSigner } from './payment-channel-signer.js';
import { MultiChainClaimIssuer } from './claim-issuer.js';
import { SwapNodeStartError } from './errors.js';
import {
  JsonFileSwapStateStore,
  PersistentSeenPacketIds,
  SwapStatePersister,
} from './state-store.js';
import type { SwapStateStore, PersistedSwapState } from './state-store.js';
import {
  RateFreshnessGuard,
  validateMaxRateAgeConfig,
} from './rate-staleness.js';
import type { MaxRateAgeConfig, SwapRateProvider } from './rate-staleness.js';
import { DEFAULT_SESSION_TTL_MS, MakerEngine } from './maker-engine.js';
import type { MakerSession } from './maker-engine.js';
import { pairKey } from './rate-staleness.js';
import { deriveSolanaChannelPda } from './solana-pda.js';
import { createSolanaLegBChannelProvisioner } from './solana-leg-b-channel.js';
import type { SolanaLegBChannelProvisioner } from './solana-leg-b-channel.js';
import { createEvmLegBChannelProvisioner } from './evm-leg-b-channel.js';
import type { EvmLegBChannelProvisioner } from './evm-leg-b-channel.js';
import type { SwapLegTerms } from './wire.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SwapNodeLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface SwapNodeEvmChainProvider {
  chainType: 'evm';
  /** Exact-match chain id string the pairs use, e.g. `evm:84532`. */
  chainId: string;
  rpcUrl: string;
  /** TokenNetworkRegistry — informational; the fleet's one deployment. */
  registryAddress: string;
  /** The ERC-20 leg-B claims pay out in (advertised in every quote). */
  tokenAddress: string;
  /**
   * The deployed `TokenNetwork` — where leg-B channels live and the EIP-712
   * `verifyingContract` every leg-B claim is signed under. The same contract
   * the taker pays leg A on.
   */
  tokenNetworkAddress: string;
  /**
   * @deprecated 2.x: the `RollingSwapChannel`. Leg B no longer uses it;
   * accepted and ignored so a committed 2.x config boots.
   */
  channelAddress?: string;
  /**
   * Enables on-demand leg-B channels: at a taker's first paid fill the maker
   * opens the (maker, taker) `TokenNetwork` channel itself (if the taker has
   * not already, paying leg A) and deposits this much (base units) from its
   * index-2 key, topping up whenever a claim would exceed what it holds.
   * Without it, channels must be pre-opened and listed under `channels`.
   */
  channelDeposit?: bigint | string | number;
  /** `settlementTimeout` written into channels the maker opens (default 1 day; contract floor 1 h). */
  settlementTimeoutSeconds?: number;
}

export interface SwapNodeSolanaChainProvider {
  chainType: 'solana';
  chainId: string;
  rpcUrl: string;
  wsUrl?: string;
  /** The payment-channel program every leg-B claim message binds (ADR 0053). */
  programId: string;
  /** The SPL mint leg-B channels are opened for — needed to derive channel PDAs. */
  tokenMint: string;
  cluster?: string;
  /**
   * Enables on-demand leg-B channels: at a taker's first paid fill the maker
   * opens the (maker, taker, mint) channel itself and deposits this much
   * (base units) from its index-2 key's token account, topping up whenever
   * a claim would exceed what the channel holds. Without it, channels must
   * be pre-opened by the operator and listed under `channels`.
   */
  channelDeposit?: bigint | string | number;
  /** Challenge window written into channels the maker opens (default 1 day). */
  challengeDurationSeconds?: number;
}

export interface SwapNodeMinaChainProvider {
  chainType: 'mina';
  chainId: string;
  graphqlUrl: string;
  zkAppAddress: string;
  tokenId?: string;
  network?: string;
}

export type SwapNodeChainProvider =
  | SwapNodeEvmChainProvider
  | SwapNodeSolanaChainProvider
  | SwapNodeMinaChainProvider;

export interface SwapNodeConfig {
  // --- Identity (mnemonic required for key derivation) ---
  mnemonic?: string;
  secretKey?: Uint8Array;
  passphrase?: string;

  // --- Liquidity ---
  swapPairs: readonly SwapPair[];
  chains: readonly SwapNodeChainKind[];
  /** Pre-opened leg-B channels per target chain. */
  channels: Record<string, readonly ChannelEntry[]>;
  inventory: Record<string, bigint>;
  windowBudget?: Record<string, bigint>;
  chainProviders?: readonly SwapNodeChainProvider[];

  // --- Pricing ---
  rateProvider?: SwapRateProvider;
  maxRateAge?: MaxRateAgeConfig;
  quote?: {
    /** How long a quote may sit before its first fill (default 60s). */
    ttlMs?: number;
    /** How long a session lives once quoted (default 1h). */
    sessionTtlMs?: number;
    /** Bound on live sessions (default 1024). */
    maxSessions?: number;
  };

  // --- The relay ---
  /**
   * The relay this maker publishes to and reads from. Without it the maker
   * boots "offline": engine, health and admin work, nothing is published or
   * read — a unit-test and dry-run shape, warned about loudly.
   */
  relay?: SwapNodeRelayConfig;
  /** Bounds on one fill's delta (source base units) and how orders are refreshed. */
  order?: {
    fill?: { min: bigint; max: bigint };
    ttlMs?: number;
    refreshMs?: number;
  };
  /** Bound on chain reads one taker can cause per minute (default 30). */
  maxChainReadsPerMin?: number;
  /** The gas station a taker redeems through (`toon-swap redeem --via gas-station`). */
  gasStation?: { destination?: string; connectorUrl?: string };
  /** Port for `/health` and `/admin/*` (default 8080; 0 = ephemeral). */
  appPort?: number;
  /** @deprecated alias of `appPort`. */
  blsPort?: number;

  // --- State ---
  statePath?: string;
  stateStore?: SwapStateStore;
  adminToken?: string;
  reconcileIntervalMs?: number;
  logger?: SwapNodeLogger;

  __testHooks?: {
    onChannelStateBuilt?: (channelState: SwapChannelState) => void;
    onClaimIssuerBuilt?: (claimIssuer: MultiChainClaimIssuer) => void;
    onEngineBuilt?: (engine: MakerEngine) => void;
    /** Inject the relay transport (an in-memory relay) instead of dialing `relay`. */
    relayTransport?: (loopHandler: (event: NostrEvent) => void) => {
      reader: RelayReader;
      writer: RelayWriter;
      close?: () => Promise<void>;
    };
    /** Inject the chain reader the inbound verifier uses. */
    slotReader?: ChannelSlotReader;
  };
}

export interface SwapNodeRelayConfig {
  /** Free NIP-01 reads, e.g. `wss://relay-ws.devnet.toonprotocol.dev`. */
  readUrl: string;
  /** The relay connector's client edge, e.g. `https://proxy.relay.devnet.toonprotocol.dev/ilp`. */
  connectorUrl: string;
  /** The route that terminates at the relay's `POST /write` (default `g.toon.relay`). */
  destination?: string;
  /** Which chain this maker pays relay writes on (default: the first of `chains` that is evm/solana). */
  payChain?: 'evm' | 'solana';
  /** RPC for the pay chain, if not the one in `chainProviders`. */
  rpcUrl?: string;
  /** Deposit for the channel with the relay's connector, base units. */
  deposit?: bigint;
  /** Path of the client's channel-watermark file (default beside `statePath`). */
  channelStorePath?: string;
  transport?: 'http' | 'btp';
}

export const DEFAULT_RELAY_DESTINATION = 'g.toon.relay';

/** `Omit` that distributes over the `ChannelFacts` union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type LegAFacts = DistributiveOmit<ChannelFacts, 'counterparty'>;
export const DEFAULT_ORDER_FILL = {
  min: 1_000_000n,
  max: 100_000_000n,
} as const;

export interface SwapNodeInstance {
  readonly identity: NodeIdentity;
  /** The Nostr identity orders are signed with and wraps are addressed to. */
  readonly nostr: NostrIdentity;
  readonly appPort: number;
  /** @deprecated alias of `appPort`. */
  readonly blsPort: number;
  readonly swapNodeKeys: SwapNodeKeys;
  readonly engine: MakerEngine;
  /** The relay loop, when `relay` (or a test transport) is configured. */
  readonly maker: SwapMakerLoop | null;
  stop(): Promise<void>;
  health(): SwapNodeHealthResponse;
  recordSettlement(event: SettlementEvent): bigint;
  reconcileInventory(): Promise<ReconcileResult>;
}

export interface SwapNodeHealthWindowEntry {
  budget: string;
  inFlight: string;
  unsettled: string;
  free: string;
}

export interface SwapNodeHealthResponse {
  status: 'ok' | 'starting' | 'stopping' | 'stopped';
  version: string;
  nodePubkey: string;
  /** The Nostr pubkey takers address wraps to. */
  nostrPubkey: string;
  swapPairsCount: number;
  chains: readonly SwapNodeChainKind[];
  uptimeSec: number;
  inventory: Record<string, string>;
  swapPairs: SwapPair[];
  inventoryAvailable: Record<string, string>;
  inventoryWindow: Record<string, SwapNodeHealthWindowEntry>;
  legA: Record<string, SwapLegTerms>;
  legB: Record<string, SwapLegTerms>;
  sessions: number;
  relay: SwapMakerLoopHealth | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function noopLogger(): SwapNodeLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function errSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'NonError', message: String(err) };
}

function chainFamily(chain: string): SwapNodeChainKind | null {
  if (chain.startsWith('evm:')) return 'evm';
  if (chain.startsWith('solana:')) return 'solana';
  if (chain.startsWith('mina:')) return 'mina';
  return null;
}

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

function requireEvmChainProvider(
  chainProviders: SwapNodeConfig['chainProviders'],
  chain: string
): SwapNodeEvmChainProvider {
  const provider = findChainProvider(chainProviders, 'evm', chain);
  if (!provider) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      `SwapNodeConfig.chainProviders is missing an entry for pair.to.chain="${chain}" — a "tokenNetworkAddress" (the deployed TokenNetwork leg-B channels live on) is required to sign balance proofs on this chain`
    );
  }
  return provider;
}

function requireSolanaChainProvider(
  chainProviders: SwapNodeConfig['chainProviders'],
  chain: string
): SwapNodeSolanaChainProvider {
  const provider = findChainProvider(chainProviders, 'solana', chain);
  if (!provider) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      `SwapNodeConfig.chainProviders is missing an entry for pair.to.chain="${chain}" — "programId" (the payment-channel program every leg-B claim binds) and "tokenMint" (to derive leg-B channel PDAs) are required`
    );
  }
  return provider;
}

const SWAP_REQUIRED_PROVIDER_FIELDS: Record<
  SwapNodeChainProvider['chainType'],
  readonly string[]
> = {
  evm: [
    'chainId',
    'rpcUrl',
    'registryAddress',
    'tokenAddress',
    'tokenNetworkAddress',
  ],
  solana: ['chainId', 'rpcUrl', 'programId', 'tokenMint'],
  mina: ['chainId', 'graphqlUrl', 'zkAppAddress'],
};

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
      `SwapNodeConfig.chainProviders[${i}].chainType MUST be one of 'evm' | 'solana' | 'mina' (got ${JSON.stringify(chainType)})`
    );
  }
  if (
    (chainType === 'solana' || chainType === 'evm') &&
    rec['channelDeposit'] !== undefined
  ) {
    const v = rec['channelDeposit'];
    const ok =
      (typeof v === 'bigint' && v > 0n) ||
      (typeof v === 'number' && Number.isInteger(v) && v > 0) ||
      (typeof v === 'string' && /^[1-9][0-9]*$/.test(v));
    if (!ok) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.chainProviders[${i}].channelDeposit MUST be a positive integer (base units)`
      );
    }
  }
  for (const k of SWAP_REQUIRED_PROVIDER_FIELDS[chainType]) {
    const v = rec[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.chainProviders[${i}].${k} MUST be a non-empty string for chainType '${chainType}'`
      );
    }
  }
}

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
  if (config.order?.fill !== undefined) {
    const { min, max } = config.order.fill;
    if (
      typeof min !== 'bigint' ||
      typeof max !== 'bigint' ||
      min <= 0n ||
      max < min
    ) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        'SwapNodeConfig.order.fill MUST satisfy 0 < min <= max (bigints, source base units)'
      );
    }
  }
  if (config.relay !== undefined) {
    for (const k of ['readUrl', 'connectorUrl'] as const) {
      if (typeof config.relay[k] !== 'string' || config.relay[k].length === 0) {
        throw new SwapNodeStartError(
          'INVALID_CONFIG',
          `SwapNodeConfig.relay.${k} MUST be a non-empty string`
        );
      }
    }
  }
  for (const port of [config.appPort, config.blsPort]) {
    if (port === undefined) continue;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        'SwapNodeConfig.appPort MUST be an integer in 0..65535'
      );
    }
  }
  if (
    config.appPort !== undefined &&
    config.blsPort !== undefined &&
    config.appPort !== config.blsPort
  ) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig: appPort and its alias blsPort disagree'
    );
  }

  const distinctTargetChains = new Set(config.swapPairs.map((p) => p.to.chain));
  for (const pair of config.swapPairs) {
    const fromFam = chainFamily(pair.from.chain);
    if (fromFam !== 'evm' && fromFam !== 'solana') {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig: pair.from.chain=${pair.from.chain} cannot carry leg A (evm or solana only)`
      );
    }
    if (!config.chains.includes(fromFam)) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.chains missing family "${fromFam}" required by pair.from.chain=${pair.from.chain}`
      );
    }
  }
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
    const onDemand =
      (fam === 'evm' &&
        findChainProvider(config.chainProviders, 'evm', chain)
          ?.channelDeposit !== undefined) ||
      (fam === 'solana' &&
        findChainProvider(config.chainProviders, 'solana', chain)
          ?.channelDeposit !== undefined);
    if (!Array.isArray(chanList) || (chanList.length === 0 && !onDemand)) {
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `SwapNodeConfig.channels["${chain}"] MUST be a non-empty array, or chainProviders[].channelDeposit must be set so the maker opens leg-B channels on demand`
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
  if (config.quote !== undefined) {
    for (const k of ['ttlMs', 'sessionTtlMs', 'maxSessions'] as const) {
      const v = config.quote[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new SwapNodeStartError(
          'INVALID_CONFIG',
          `SwapNodeConfig.quote.${k} MUST be a positive finite number`
        );
      }
    }
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
  for (const chain of distinctTargetChains) {
    const fam = chainFamily(chain);
    if (fam === 'evm') {
      try {
        parseEvmChainId(chain);
      } catch (err) {
        throw new SwapNodeStartError(
          'INVALID_CONFIG',
          `SwapNodeConfig: invalid pair.to.chain — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      requireEvmChainProvider(config.chainProviders, chain);
    } else if (fam === 'solana') {
      requireSolanaChainProvider(config.chainProviders, chain);
    }
  }
}

// ---------------------------------------------------------------------------
// startSwapNode
// ---------------------------------------------------------------------------

export async function startSwapNode(
  config: SwapNodeConfig
): Promise<SwapNodeInstance> {
  validateConfig(config);

  const logger = config.logger ?? noopLogger();
  const startedAt = Date.now();
  let status: SwapNodeHealthResponse['status'] = 'starting';

  if (!config.mnemonic) {
    throw new SwapNodeStartError(
      'SWAP_REQUIRES_MNEMONIC',
      'swap node key derivation (BIP-32) requires a BIP-39 mnemonic; pass config.mnemonic instead of secretKey'
    );
  }
  if (config.passphrase !== undefined && config.passphrase !== '') {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.passphrase is not supported: the Nostr-identity SDK derivation (fromMnemonic) does not accept a BIP-39 passphrase, so setting one would split identity and swap-node-key derivation across inconsistent seeds. Use a passphrase-less mnemonic until SDK identity derivation supports passphrases.'
    );
  }

  const identity: NodeIdentity = fromMnemonic(config.mnemonic);
  const nostr = deriveNostrIdentity({ mnemonic: config.mnemonic });
  const swapNodeKeys: SwapNodeKeys = await deriveSwapNodeKeys({
    mnemonic: config.mnemonic,
    chains: config.chains,
  });

  // --- per-chain leg-B signers + the terms every order/quote/advance advertises ---
  const signers: Record<string, PaymentChannelSigner> = {};
  const legBTerms: Record<string, SwapLegTerms> = {};
  const solanaLegB: Record<string, { programId: string; mint: string }> = {};
  const solanaProvisioners: Record<string, SolanaLegBChannelProvisioner> = {};
  const evmProvisioners: Record<string, EvmLegBChannelProvisioner> = {};
  const distinctTargetChains = Array.from(
    new Set(config.swapPairs.map((p) => p.to.chain))
  );
  const signerAddresses = buildSignerAddresses(config.swapPairs, swapNodeKeys);
  let sharedMinaSigner: MinaPaymentChannelSigner | undefined;
  for (const chain of distinctTargetChains) {
    const swapSignerAddress = signerAddresses[chain] as string;
    if (chain.startsWith('evm:')) {
      const provider = requireEvmChainProvider(config.chainProviders, chain);
      const evmKeys = swapNodeKeys.evm as NonNullable<SwapNodeKeys['evm']>;
      signers[chain] = new TokenNetworkBalanceProofSigner({
        chain,
        privateKey: evmKeys.privateKey,
        chainId: parseEvmChainId(chain),
        tokenNetworkAddress: provider.tokenNetworkAddress,
      });
      legBTerms[chain] = {
        chain,
        swapSignerAddress,
        verifyingContract: provider.tokenNetworkAddress,
        token: provider.tokenAddress,
      };
      if (provider.channelAddress !== undefined) {
        logger.warn?.('swap.config.retired_key_ignored', {
          key: `chainProviders[${chain}].channelAddress`,
          why: 'leg B rides the TokenNetwork (tokenNetworkAddress), not the RollingSwapChannel',
        });
      }
      if (provider.channelDeposit !== undefined) {
        evmProvisioners[chain] = createEvmLegBChannelProvisioner({
          rpcUrl: provider.rpcUrl,
          tokenNetworkAddress: provider.tokenNetworkAddress,
          tokenAddress: provider.tokenAddress,
          makerPrivateKey: evmKeys.privateKey,
          channelDeposit: BigInt(provider.channelDeposit),
          ...(provider.settlementTimeoutSeconds !== undefined && {
            settlementTimeoutSeconds: BigInt(provider.settlementTimeoutSeconds),
          }),
          logger: { info: logger.info, warn: logger.warn },
        });
      }
    } else if (chain.startsWith('solana:')) {
      const provider = requireSolanaChainProvider(config.chainProviders, chain);
      signers[chain] = new SolanaPaymentChannelSigner({
        chain,
        privateKey: (swapNodeKeys.solana as NonNullable<SwapNodeKeys['solana']>)
          .privateKey,
        programId: provider.programId,
      });
      legBTerms[chain] = {
        chain,
        swapSignerAddress,
        programId: provider.programId,
        token: provider.tokenMint,
      };
      solanaLegB[chain] = {
        programId: provider.programId,
        mint: provider.tokenMint,
      };
      if (provider.channelDeposit !== undefined) {
        solanaProvisioners[chain] = createSolanaLegBChannelProvisioner({
          rpcUrl: provider.rpcUrl,
          programId: provider.programId,
          tokenMint: provider.tokenMint,
          makerSeed: (
            swapNodeKeys.solana as NonNullable<SwapNodeKeys['solana']>
          ).privateKey,
          channelDeposit: BigInt(provider.channelDeposit),
          ...(provider.challengeDurationSeconds !== undefined && {
            challengeDurationSeconds: provider.challengeDurationSeconds,
          }),
          logger: { info: logger.info, warn: logger.warn },
        });
      }
    } else if (chain.startsWith('mina:')) {
      const keys = swapNodeKeys.mina as NonNullable<SwapNodeKeys['mina']>;
      sharedMinaSigner ??= new MinaPaymentChannelSigner({
        chain,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      });
      signers[chain] = sharedMinaSigner;
      const minaProvider = findChainProvider(
        config.chainProviders,
        'mina',
        chain
      );
      legBTerms[chain] = {
        chain,
        swapSignerAddress,
        ...(minaProvider?.tokenId && { token: minaProvider.tokenId }),
      };
    }
  }

  // --- per-source-chain leg-A terms: where a taker pays this maker, and the
  //     facts the maker verifies a taker's claim against ---
  const legATerms: Record<string, SwapLegTerms> = {};
  const legAFacts: Record<string, LegAFacts> = {};
  const rpcUrls: Record<string, string> = {};
  for (const p of config.chainProviders ?? []) {
    if (p.chainType === 'evm' || p.chainType === 'solana')
      rpcUrls[p.chainId] = p.rpcUrl;
  }
  for (const chain of new Set(config.swapPairs.map((p) => p.from.chain))) {
    if (chain.startsWith('evm:')) {
      const provider = requireEvmChainProvider(config.chainProviders, chain);
      const evmKeys = swapNodeKeys.evm;
      if (!evmKeys)
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `No EVM key derived but pair pays on ${chain}`
        );
      legATerms[chain] = {
        chain,
        swapSignerAddress: evmKeys.address.toLowerCase(),
        verifyingContract: provider.tokenNetworkAddress,
        token: provider.tokenAddress,
      };
      legAFacts[chain] = {
        family: 'evm',
        chain,
        chainId: parseEvmChainId(chain),
        tokenNetwork: provider.tokenNetworkAddress,
        self: evmKeys.address,
      };
    } else {
      const provider = requireSolanaChainProvider(config.chainProviders, chain);
      const solKeys = swapNodeKeys.solana;
      if (!solKeys)
        throw new SwapNodeStartError(
          'MISSING_KEY',
          `No Solana key derived but pair pays on ${chain}`
        );
      const self = base58Encode(solKeys.publicKey);
      legATerms[chain] = {
        chain,
        swapSignerAddress: self,
        programId: provider.programId,
        token: provider.tokenMint,
      };
      legAFacts[chain] = {
        family: 'solana',
        chain,
        programId: provider.programId,
        mint: provider.tokenMint,
        self,
      };
    }
  }

  // --- persisted state ---
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
        sessions: Object.keys(persistedState.sessions).length,
        inbound: Object.keys(persistedState.inbound).length,
        relayCursor: persistedState.relayCursor,
      });
    }
  }

  // --- inventory ---
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
      const configured = inventoryInit[k];
      const persistedTotal = BigInt(v.total);
      const persistedAvailable = BigInt(v.available);
      // swap#130: a snapshot taken at a placeholder inventory of 0 used to
      // win over config forever. A configured total ABOVE the persisted one
      // is new capital the operator wrote down; honour it, keeping whatever
      // the persisted pool already has committed.
      if (configured && configured.total > persistedTotal) {
        const raise = configured.total - persistedTotal;
        logger.warn?.('swap.state.inventory_raised_from_config', {
          pool: k,
          persistedTotal: persistedTotal.toString(),
          configuredTotal: configured.total.toString(),
          raisedBy: raise.toString(),
        });
        inventoryInit[k] = {
          available: persistedAvailable + raise,
          total: configured.total,
          unsettled: BigInt(v.unsettled ?? '0'),
          updatedAt: v.updatedAt,
          ...(configured.windowBudget !== undefined && {
            windowBudget: configured.windowBudget,
          }),
        };
        continue;
      }
      inventoryInit[k] = {
        available: persistedAvailable,
        total: persistedTotal,
        unsettled: BigInt(v.unsettled ?? '0'),
        updatedAt: v.updatedAt,
        ...(configured?.windowBudget !== undefined && {
          windowBudget: configured.windowBudget,
        }),
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

  // --- channels ---
  const channelInit: Record<string, ChannelEntry> = {};
  for (const pair of config.swapPairs) {
    const entries = config.channels[pair.to.chain] ?? [];
    for (const entry of entries) {
      channelInit[`${pair.to.assetCode}:${pair.to.chain}:${entry.channelId}`] =
        {
          ...entry,
        };
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
  const evmChannelReaderProviders = swapNodeKeys.evm
    ? (config.chainProviders ?? [])
        .filter((p): p is SwapNodeEvmChainProvider => p.chainType === 'evm')
        .map((p) => ({
          chainId: p.chainId,
          rpcUrl: p.rpcUrl,
          tokenNetworkAddress: p.tokenNetworkAddress,
          makerAddress: (swapNodeKeys.evm as NonNullable<SwapNodeKeys['evm']>)
            .address,
        }))
    : [];
  const solanaChannelReaderProviders: SolanaChannelReaderProvider[] = [];
  if (swapNodeKeys.solana) {
    const payerPubkey = base58Encode(swapNodeKeys.solana.publicKey);
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
    ...(persistedState && { bindings: persistedState.bindings }),
    ...(channelOnChainReader && { onChainReader: channelOnChainReader }),
  });
  config.__testHooks?.onChannelStateBuilt?.(channelState);

  // The relay loop and the engine own the v3 extras; the persister asks
  // them at snapshot time (late-bound: both are built below).
  const seen = new PersistentSeenPacketIds(persistedState?.seenEventIds);
  const refs: { engine?: MakerEngine; loop?: SwapMakerLoop } = {};
  const persister = stateStore
    ? new SwapStatePersister({
        store: stateStore,
        inventory,
        channelState,
        seenPacketIds: seen,
        extras: () => ({
          ...(refs.loop?.extras() ?? {
            inbound: persistedState?.inbound ?? {},
            relayCursor: persistedState?.relayCursor ?? 0,
            orders: persistedState?.orders ?? {},
          }),
          sessions:
            refs.engine?.exportSessions() ?? persistedState?.sessions ?? {},
        }),
      })
    : undefined;
  const persist = (): void => {
    if (persister) persister.persist();
  };
  seen.setOnMutate(persist);
  if (persister) {
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

  const reconciler = new SwapInventoryReconciler({
    inventory,
    channelState,
    ...(channelOnChainReader && { reader: channelOnChainReader }),
    ...(persister && { persist }),
    logger,
    ...(config.reconcileIntervalMs !== undefined && {
      intervalMs: config.reconcileIntervalMs,
    }),
  });

  const claimIssuer = new MultiChainClaimIssuer({
    inventory,
    signers,
    channelState,
    signerAddresses,
    ...(persister && { persistState: persist }),
    logger: {
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
      error: logger.error,
    },
  });
  config.__testHooks?.onClaimIssuerBuilt?.(claimIssuer);

  const stalenessGuard = config.maxRateAge
    ? new RateFreshnessGuard({
        maxRateAge: config.maxRateAge,
        rateProvider: config.rateProvider as SwapRateProvider,
        logger: { warn: logger.warn, info: logger.info },
      })
    : undefined;

  const makerSolanaPubkey = swapNodeKeys.solana
    ? base58Encode(swapNodeKeys.solana.publicKey)
    : undefined;
  const fill = config.order?.fill ?? { ...DEFAULT_ORDER_FILL };
  const engine = new MakerEngine({
    swapPairs: config.swapPairs,
    claimIssuer,
    inventory,
    legATerms: (chain) => {
      const terms = legATerms[chain];
      if (!terms) throw new Error(`no leg-A terms for ${chain}`);
      return terms;
    },
    legBTerms: (chain) => {
      const terms = legBTerms[chain];
      if (!terms) throw new Error(`no leg-B terms for ${chain}`);
      return terms;
    },
    fill,
    orderIdFor: (pair) => pairKey(pair),
    ...(config.rateProvider && { rateProvider: config.rateProvider }),
    ...(stalenessGuard && { stalenessGuard }),
    preferredChannelFor: (chain, recipient) => {
      const sol = solanaLegB[chain];
      if (!sol || !makerSolanaPubkey) return undefined;
      try {
        return deriveSolanaChannelPda({
          participantA: makerSolanaPubkey,
          participantB: recipient,
          mint: sol.mint,
          programId: sol.programId,
        });
      } catch (err) {
        logger.warn?.('swap.legB.pda_derivation_failed', {
          chain,
          recipient,
          err: errSummary(err).message,
        });
        return undefined;
      }
    },
    ...((Object.keys(solanaProvisioners).length > 0 ||
      Object.keys(evmProvisioners).length > 0) && {
      ensureChannel: async (pair, recipient, targetAmount) => {
        const chain = pair.to.chain;
        const asset = pair.to.assetCode;
        const outstanding = (channelId: string): bigint =>
          channelState.snapshot().channels[`${asset}:${chain}:${channelId}`]
            ?.cumulativeAmount ?? 0n;
        const provisionKnown = (
          channelId: string,
          seed: { nonce: bigint; cumulativeAmount: bigint }
        ): void => {
          if (
            channelState.snapshot().channels[`${asset}:${chain}:${channelId}`]
          )
            return;
          // A channel this maker has already been redeemed on (state lost, or
          // opened by the taker when it paid leg A) starts from its on-chain
          // watermark, never from zero: a claim below it is `InvalidNonce`.
          channelState.provisionChannel({
            assetCode: asset,
            chain,
            channelId,
            nonce: seed.nonce,
            cumulativeAmount: seed.cumulativeAmount,
          });
          persist();
        };

        const sol = solanaProvisioners[chain];
        if (sol) {
          const channelId = sol.channelFor(recipient);
          const ensured = await sol.ensure(
            recipient,
            outstanding(channelId) + targetAmount
          );
          const acct = await sol.read(recipient);
          const makerIsA = acct?.participantA === sol.makerPubkey;
          provisionKnown(ensured.channelId, {
            nonce: acct ? (makerIsA ? acct.nonceA : acct.nonceB) : 0n,
            cumulativeAmount: acct
              ? makerIsA
                ? acct.transferredAmountA
                : acct.transferredAmountB
              : 0n,
          });
          return ensured.channelId;
        }
        const evm = evmProvisioners[chain];
        if (evm) {
          const channelId = await evm.channelFor(recipient);
          const ensured = await evm.ensure(
            recipient,
            outstanding(channelId) + targetAmount
          );
          provisionKnown(ensured.channelId, {
            nonce: ensured.nonce,
            cumulativeAmount: ensured.transferredAmount,
          });
          return ensured.channelId;
        }
        return undefined;
      },
    }),
    ...(config.quote?.ttlMs !== undefined && {
      quoteTtlMs: config.quote.ttlMs,
    }),
    ...(config.quote?.sessionTtlMs !== undefined && {
      sessionTtlMs: config.quote.sessionTtlMs,
    }),
    ...(config.quote?.maxSessions !== undefined && {
      maxSessions: config.quote.maxSessions,
    }),
    ...(persistedState && { sessions: Object.values(persistedState.sessions) }),
    receiptSecretKey: identity.secretKey,
    logger,
  });
  refs.engine = engine;
  config.__testHooks?.onEngineBuilt?.(engine);

  // --- the relay loop ---
  const sessionTtlMs = config.quote?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  let maker: SwapMakerLoop | null = null;
  let relayClose: (() => Promise<void>) | undefined;
  const slotReader: ChannelSlotReader =
    config.__testHooks?.slotReader ?? createRpcChannelSlotReader({ rpcUrls });
  const factsFor = (session: Readonly<MakerSession>): ChannelFacts => {
    const base = legAFacts[session.pair.from.chain];
    if (!base) throw new Error(`no leg-A facts for ${session.pair.from.chain}`);
    return { ...base, counterparty: session.payerAddress } as ChannelFacts;
  };
  const buildLoop = (reader: RelayReader, writer: RelayWriter): SwapMakerLoop =>
    new SwapMakerLoop({
      engine,
      nostr,
      reader,
      writer,
      slotReader,
      factsFor,
      legATerms: (chain) => legATerms[chain] as SwapLegTerms,
      legBTerms: (chain) => legBTerms[chain] as SwapLegTerms,
      swapPairs: config.swapPairs,
      seen,
      persist,
      ...(persistedState && {
        initial: {
          inbound: persistedState.inbound,
          relayCursor: persistedState.relayCursor,
          orders: persistedState.orders,
        },
      }),
      sessionTtlMs,
      ...(config.order?.ttlMs !== undefined && {
        orderTtlMs: config.order.ttlMs,
      }),
      ...(config.order?.refreshMs !== undefined && {
        orderRefreshMs: config.order.refreshMs,
      }),
      ...(config.maxChainReadsPerMin !== undefined && {
        maxChainReadsPerMin: config.maxChainReadsPerMin,
      }),
      logger,
    });

  if (config.__testHooks?.relayTransport) {
    // A test's in-memory relay: events are pushed straight at the loop.
    let handler: (event: NostrEvent) => void = () => undefined;
    const transport = config.__testHooks.relayTransport((event) =>
      handler(event)
    );
    maker = buildLoop(transport.reader, transport.writer);
    const loop = maker;
    handler = (event) => void loop.handleWrap(event);
    relayClose = transport.close;
  } else if (config.relay) {
    const relay = config.relay;
    const payChain =
      relay.payChain ??
      config.chains.find(
        (c): c is 'evm' | 'solana' => c === 'evm' || c === 'solana'
      ) ??
      'evm';
    const payRpc =
      relay.rpcUrl ??
      (config.chainProviders ?? []).find((p) => p.chainType === payChain)?.[
        'rpcUrl' as never
      ];
    const client = await createRelayClient({
      connectorUrl: relay.connectorUrl,
      chain: payChain,
      ...(payChain === 'evm' &&
        swapNodeKeys.evm && { evmPrivateKey: swapNodeKeys.evm.privateKey }),
      ...(payChain === 'solana' &&
        swapNodeKeys.solana && {
          solanaSecretKey: swapNodeKeys.solana.privateKey,
        }),
      ...(payRpc !== undefined && { rpcUrl: payRpc as string }),
      ...(relay.channelStorePath !== undefined && {
        channelStore: relay.channelStorePath,
      }),
      ...(relay.deposit !== undefined && { deposit: relay.deposit }),
      ...(relay.transport !== undefined && { transport: relay.transport }),
      autoOpenChannel: true,
      logger,
    });
    const writer = createRelayWriter({
      sender: client.sender,
      destination: relay.destination ?? DEFAULT_RELAY_DESTINATION,
      logger,
    });
    const pending: { loop?: SwapMakerLoop } = {};
    const subscription = new RelaySubscription({
      relayUrl: relay.readUrl,
      onEvent: (_subId, event) => void pending.loop?.handleWrap(event),
      logger: (msg) => logger.debug?.('swap.relay', { msg }),
    });
    pending.loop = buildLoop(subscription, writer);
    maker = pending.loop;
    relayClose = client.close;
  } else {
    logger.warn?.('swap.relay.offline', {
      reason:
        'no `relay` configured: the maker publishes no order and reads no inbox — engine, health and admin only',
    });
  }
  if (maker) refs.loop = maker;

  // --- HTTP surface: /health + /admin/* on node:http ---
  const getHealth = (): SwapNodeHealthResponse => {
    const snapshot = inventory.snapshot();
    const inv: Record<string, string> = {};
    const invAvailable: Record<string, string> = {};
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
      if ((assetsPerChain.get(b.chain)?.size ?? 0) === 1) {
        inv[b.chain] = b.total.toString();
        invAvailable[b.chain] = b.available.toString();
      }
    }
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
      nostrPubkey: nostr.pubkey,
      swapPairsCount: config.swapPairs.length,
      chains: config.chains,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      inventory: inv,
      swapPairs: [...config.swapPairs],
      inventoryAvailable: invAvailable,
      inventoryWindow,
      legA: { ...legATerms },
      legB: { ...legBTerms },
      sessions: engine.sessionCount,
      relay: maker?.health() ?? null,
    };
  };

  const adminDeps = {
    inventory,
    reconciler,
    ...(config.adminToken !== undefined && { adminToken: config.adminToken }),
  };
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        const send = (statusCode: number, body: unknown): void => {
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (path === '/health' && req.method === 'GET') {
          send(200, getHealth());
          return;
        }
        if (isAdminPath(path)) {
          const request: AdminRequest = {
            method: req.method ?? 'GET',
            path,
            header: (name) => {
              const v = req.headers[name.toLowerCase()];
              return Array.isArray(v) ? v[0] : v;
            },
            json: async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of req)
                chunks.push(Buffer.from(chunk as Uint8Array));
              return JSON.parse(
                Buffer.concat(chunks).toString('utf8')
              ) as unknown;
            },
          };
          try {
            const answer = await handleAdminRequest(request, adminDeps);
            if (answer) {
              send(answer.status, answer.body);
              return;
            }
            send(405, { error: 'method_not_allowed' });
          } catch (err) {
            logger.error?.('swap.admin.failed', { path, err: errSummary(err) });
            send(500, {
              error: 'internal_error',
              reason: errSummary(err).message,
            });
          }
          return;
        }
        send(404, { error: 'not_found' });
      })();
    }
  );
  const requestedPort = config.appPort ?? config.blsPort ?? 8080;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: Error) => {
      reject(
        new SwapNodeStartError(
          'INVALID_CONFIG',
          `swap node could not bind port ${requestedPort}: ${err.message}`,
          { cause: err }
        )
      );
    });
    server.listen(requestedPort, () => resolve());
  });
  const addr = server.address();
  const appPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  if (maker) {
    try {
      await maker.start();
    } catch (err) {
      logger.error?.('swap.relay.start_failed', { err: errSummary(err) });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new SwapNodeStartError(
        'INVALID_CONFIG',
        `the relay loop could not start: ${errSummary(err).message}`,
        { cause: err }
      );
    }
  }

  logger.info?.('swap.started', {
    nostrPubkey: nostr.pubkey,
    appPort,
    relay: config.relay
      ? {
          readUrl: config.relay.readUrl,
          connectorUrl: config.relay.connectorUrl,
        }
      : null,
    pairs: config.swapPairs.map(
      (p) =>
        `${p.from.assetCode}:${p.from.chain}→${p.to.assetCode}:${p.to.chain}`
    ),
    fill: { min: fill.min.toString(), max: fill.max.toString() },
    legA: legATerms,
    legB: legBTerms,
  });

  status = 'ok';
  let stopped = false;
  const instance: SwapNodeInstance = {
    identity,
    nostr,
    appPort,
    blsPort: appPort,
    swapNodeKeys,
    engine,
    maker,
    reconcileInventory: () => reconciler.reconcile(),
    recordSettlement: (event: SettlementEvent): bigint => {
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
      if (!target) return 0n;
      const reduced = inventory.recordSettlement({
        assetCode: target.assetCode,
        chain: target.chain,
        channelId: event.channelId,
        cumulativeAmount: BigInt(event.cumulativeAmount),
      });
      try {
        persist();
      } catch (err) {
        logger.error?.('swap.recordSettlement.persist_failed', {
          err: errSummary(err),
        });
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
      status = 'stopping';
      reconciler.stop();
      if (maker) {
        try {
          await maker.stop();
        } catch (err) {
          logger.warn?.('swap.stop.relay_loop_failed', {
            err: errSummary(err),
          });
        }
      }
      if (relayClose) {
        try {
          await relayClose();
        } catch (err) {
          logger.warn?.('swap.stop.relay_client_close_failed', {
            err: errSummary(err),
          });
        }
      }
      try {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      } catch (err) {
        logger.warn?.('swap.stop.server_close_failed', {
          err: errSummary(err),
        });
      }
      try {
        channelState.releaseAll();
      } catch (err) {
        logger.warn?.('swap.stop.release_all_failed', { err: errSummary(err) });
      }
      status = 'stopped';
    },
  };
  if (reconciler.enabled) {
    void reconciler.runGuarded();
    reconciler.start();
    logger.debug?.('swap.reconcile.armed', {
      intervalMs: config.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    });
  } else {
    logger.warn?.('swap.reconcile.disabled', {
      reason:
        'no EVM/Solana chainProviders entry, so no on-chain reader: redeemed claims can never be observed and the capacity they hold can never be recycled',
    });
  }
  return instance;
}
