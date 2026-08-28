/**
 * `startSwapNode()` — programmatic entrypoint for a TOON swap **maker**.
 *
 * The maker is an app behind a Rust connector's route termination
 * (`docs/rust-connector-migration.md`). This process:
 *
 *   - derives its identity and per-chain signing keys from one mnemonic
 *     (`deriveSwapNodeKeys`, BIP-44 account index 2 per D12-011),
 *   - holds the leg-B capital: `SwapInventory` (the rolling window),
 *     `SwapChannelState` (per-channel nonce/cumulative watermarks) and the
 *     `MultiChainClaimIssuer` that signs leg-B balance proofs,
 *   - serves the `rolling/2` wire on plain HTTP (`/swap/rfq`, `/swap/fill`)
 *     for the connector in front of it to deliver to, plus `GET /health`
 *     and the admin surface,
 *   - persists its state and reconciles it against the chains.
 *
 * It does NOT embed, dial, or configure a connector, announce itself, or
 * send a single packet. Leg-A verification, channel resolution, and payment
 * attribution are the connector's (ADR 0040/0042); the maker reads three
 * headers and trusts the process it was deployed behind.
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
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
} from './state-store.js';
import type { SwapStateStore, PersistedSwapState } from './state-store.js';
import { RateFreshnessGuard, validateMaxRateAgeConfig } from './rate-staleness.js';
import type { MaxRateAgeConfig, SwapRateProvider } from './rate-staleness.js';
import { MakerEngine } from './maker-engine.js';
import { registerMakerRoutes } from './maker-app.js';
import { deriveSolanaChannelPda } from './solana-pda.js';
import type { SwapLegBTerms } from './wire.js';

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
  /** TokenNetworkRegistry — used by the chain-truth reconciler. */
  registryAddress: string;
  /** The ERC-20 leg-B claims pay out in (advertised in every quote). */
  tokenAddress: string;
  /**
   * Leg A's `TokenNetwork`. Accepted for config compatibility and echoed in
   * `/health`; the maker itself no longer verifies leg A — its connector
   * does, from the connector's own `[settlement.evm]`.
   */
  tokenNetworkAddress?: string;
  /** Leg B: the deployed `RollingSwapChannel`, the EIP-712 v2 `verifyingContract`. */
  channelAddress: string;
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

  // --- The wire in front of us ---
  /**
   * The ILP address the connector terminates at this maker's `/swap/fill`.
   * `<ilpAddress>.rfq` is the free RFQ route. Default
   * `g.toon.swap.<pubkey16>`; every quote names it.
   */
  ilpAddress?: string;
  /** The fill route's price (one fill, source base units), if known. Informational. */
  fillAmount?: bigint;
  /** Port for `/swap/*`, `/health` and `/admin/*` (default 8080; 0 = ephemeral). */
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
  };
}

export interface SwapNodeInstance {
  readonly identity: NodeIdentity;
  readonly appPort: number;
  /** @deprecated alias of `appPort`. */
  readonly blsPort: number;
  readonly swapNodeKeys: SwapNodeKeys;
  readonly ilpAddress: string;
  readonly rfqDestination: string;
  readonly fillDestination: string;
  readonly engine: MakerEngine;
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
  ilpAddress: string;
  rfqDestination: string;
  fillDestination: string;
  swapPairsCount: number;
  chains: readonly SwapNodeChainKind[];
  uptimeSec: number;
  inventory: Record<string, string>;
  swapPairs: SwapPair[];
  inventoryAvailable: Record<string, string>;
  inventoryWindow: Record<string, SwapNodeHealthWindowEntry>;
  legB: Record<string, SwapLegBTerms>;
  sessions: number;
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
      `SwapNodeConfig.chainProviders is missing an entry for pair.to.chain="${chain}" — a "channelAddress" (deployed RollingSwapChannel address) is required to sign v2 balance proofs on this chain`
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
  evm: ['chainId', 'rpcUrl', 'registryAddress', 'tokenAddress', 'channelAddress'],
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

const ILP_ADDRESS_RE = /^[a-zA-Z0-9._~-]+$/;

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
  if (config.ilpAddress !== undefined && !ILP_ADDRESS_RE.test(config.ilpAddress)) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      `SwapNodeConfig.ilpAddress "${config.ilpAddress}" is not a valid ILP address`
    );
  }
  if (
    config.fillAmount !== undefined &&
    (typeof config.fillAmount !== 'bigint' || config.fillAmount <= 0n)
  ) {
    throw new SwapNodeStartError(
      'INVALID_CONFIG',
      'SwapNodeConfig.fillAmount MUST be a positive bigint when set'
    );
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
        `SwapNodeConfig: pair.from.chain=${pair.from.chain} cannot be paid at a Rust connector (leg A is evm or solana only)`
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
  const swapNodeKeys: SwapNodeKeys = await deriveSwapNodeKeys({
    mnemonic: config.mnemonic,
    chains: config.chains,
  });

  const ilpAddress =
    config.ilpAddress ?? `g.toon.swap.${identity.pubkey.slice(0, 16)}`;
  const rfqDestination = `${ilpAddress}.rfq`;
  const fillDestination = ilpAddress;

  // --- per-chain leg-B signers + the terms every quote/advance advertises ---
  const signers: Record<string, PaymentChannelSigner> = {};
  const legBTerms: Record<string, SwapLegBTerms> = {};
  const solanaLegB: Record<string, { programId: string; mint: string }> = {};
  const distinctTargetChains = Array.from(
    new Set(config.swapPairs.map((p) => p.to.chain))
  );
  const signerAddresses = buildSignerAddresses(config.swapPairs, swapNodeKeys);
  let sharedMinaSigner: MinaPaymentChannelSigner | undefined;
  for (const chain of distinctTargetChains) {
    const swapSignerAddress = signerAddresses[chain] as string;
    if (chain.startsWith('evm:')) {
      const provider = requireEvmChainProvider(config.chainProviders, chain);
      signers[chain] = new EvmPaymentChannelSigner({
        chain,
        privateKey: (swapNodeKeys.evm as NonNullable<SwapNodeKeys['evm']>)
          .privateKey,
        chainId: parseEvmChainId(chain),
        verifyingContract: provider.channelAddress,
      });
      legBTerms[chain] = {
        chain,
        swapSignerAddress,
        verifyingContract: provider.channelAddress,
        token: provider.tokenAddress,
      };
    } else if (chain.startsWith('solana:')) {
      const provider = requireSolanaChainProvider(config.chainProviders, chain);
      signers[chain] = new SolanaPaymentChannelSigner({
        chain,
        privateKey: (
          swapNodeKeys.solana as NonNullable<SwapNodeKeys['solana']>
        ).privateKey,
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
    } else if (chain.startsWith('mina:')) {
      const keys = swapNodeKeys.mina as NonNullable<SwapNodeKeys['mina']>;
      sharedMinaSigner ??= new MinaPaymentChannelSigner({
        chain,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      });
      signers[chain] = sharedMinaSigner;
      const minaProvider = findChainProvider(config.chainProviders, 'mina', chain);
      legBTerms[chain] = {
        chain,
        swapSignerAddress,
        ...(minaProvider?.tokenId && { token: minaProvider.tokenId }),
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
      channelInit[`${pair.to.assetCode}:${pair.to.chain}:${entry.channelId}`] = {
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
  const evmChannelReaderProviders = (config.chainProviders ?? []).filter(
    (p): p is SwapNodeEvmChainProvider => p.chainType === 'evm'
  );
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

  const persister = stateStore
    ? new SwapStatePersister({ store: stateStore, inventory, channelState })
    : undefined;
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
    ...(persister && { persist: () => persister.persist() }),
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
    ...(persister && { persistState: () => persister.persist() }),
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
  const engine = new MakerEngine({
    swapPairs: config.swapPairs,
    claimIssuer,
    inventory,
    legBTerms: (chain) => {
      const terms = legBTerms[chain];
      if (!terms) throw new Error(`no leg-B terms for ${chain}`);
      return terms;
    },
    fill: {
      destination: fillDestination,
      ...(config.fillAmount !== undefined && { amount: config.fillAmount }),
    },
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
    ...(config.quote?.ttlMs !== undefined && { quoteTtlMs: config.quote.ttlMs }),
    ...(config.quote?.sessionTtlMs !== undefined && {
      sessionTtlMs: config.quote.sessionTtlMs,
    }),
    ...(config.quote?.maxSessions !== undefined && {
      maxSessions: config.quote.maxSessions,
    }),
    receiptSecretKey: identity.secretKey,
    logger,
  });
  config.__testHooks?.onEngineBuilt?.(engine);

  // --- HTTP surface ---
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
      ilpAddress,
      rfqDestination,
      fillDestination,
      swapPairsCount: config.swapPairs.length,
      chains: config.chains,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      inventory: inv,
      swapPairs: [...config.swapPairs],
      inventoryAvailable: invAvailable,
      inventoryWindow,
      legB: { ...legBTerms },
      sessions: engine.sessionCount,
    };
  };

  // `strict: false`: the connector resolves an envelope target of `/` to the
  // route's own handler path, which an operator may write with or without a
  // trailing slash — both must reach the same handler.
  const app = new Hono({ strict: false });
  app.get('/health', (c: Context) => c.json(getHealth()));
  registerMakerRoutes(app, { engine, logger });
  registerAdminRoutes(app, {
    inventory,
    reconciler,
    ...(config.adminToken !== undefined && { adminToken: config.adminToken }),
  });
  const requestedPort = config.appPort ?? config.blsPort ?? 8080;
  const server: ServerType = serve({ fetch: app.fetch, port: requestedPort });
  const addrInfo = (
    server as unknown as { address?: () => { port: number } | null }
  ).address?.();
  const appPort = addrInfo?.port ?? requestedPort;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(
        new SwapNodeStartError(
          'INVALID_CONFIG',
          `swap node could not bind port ${requestedPort}: ${err.message}`,
          { cause: err }
        )
      );
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve();
    });
    if ((server as unknown as { listening?: boolean }).listening) {
      server.off('error', onError);
      resolve();
    }
  });

  logger.info?.('swap.started', {
    ilpAddress,
    rfqDestination,
    fillDestination,
    appPort,
    pairs: config.swapPairs.map(
      (p) => `${p.from.assetCode}:${p.from.chain}→${p.to.assetCode}:${p.to.chain}`
    ),
    legB: legBTerms,
    routes: {
      rfq: `[[routes]] prefix = "${rfqDestination}" handler_url = "http://<this host>:${appPort}/swap/rfq" price = 0`,
      fill: `[[routes]] prefix = "${fillDestination}" handler_url = "http://<this host>:${appPort}/swap/fill" price = ${config.fillAmount?.toString() ?? '<fill size>'}`,
    },
  });

  status = 'ok';
  let stopped = false;
  const instance: SwapNodeInstance = {
    identity,
    appPort,
    blsPort: appPort,
    swapNodeKeys,
    ilpAddress,
    rfqDestination,
    fillDestination,
    engine,
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
      status = 'stopping';
      reconciler.stop();
      try {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      } catch (err) {
        logger.warn?.('swap.stop.server_close_failed', { err: errSummary(err) });
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
