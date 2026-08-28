#!/usr/bin/env node
/**
 * `toon-swap` — the swap client's CLI (the runtime image runs `make`).
 *
 *   toon-swap make    --config ./swap.config.json        # run a maker (default)
 *   toon-swap orders  --config ./swap.config.json        # list live orders on the relay
 *   toon-swap take    --config ./swap.config.json --order <maker>:<orderId> --size <n> [--delta <n>]
 *   toon-swap resume  --config ./swap.config.json --stream <nonce>
 *   toon-swap redeem  --config ./swap.config.json --stream <nonce> [--via gas-station]  # claim on chain
 *   toon-swap close   --config ./swap.config.json --stream <nonce>    # Solana: start the challenge window
 *   toon-swap settle  --config ./swap.config.json --stream <nonce>    # Solana: pay out after it
 *   toon-swap sessions --config ./swap.config.json
 *
 * One config file serves both roles: `mnemonic` (or `SWAP_MNEMONIC` /
 * `SWAP_IDENTITY_FILE`), `chains`, `chainProviders`, `relay`, `statePath`.
 * A maker additionally needs `swapPairs`, `inventory`, `channels`/`order`.
 *
 * Reads a JSON config, overlays a small set of environment variables, and
 * calls {@link startSwapNode}. The maker is a relay-mediated swap client, so
 * what it needs is a relay to read (`relay.readUrl`) and the relay's
 * connector to pay writes through (`relay.connectorUrl`). A committed fleet
 * config written for 2.x/3.0 still boots: its `relayUrls[0]` is read as
 * `relay.readUrl`, its `connectorUrl` as `relay.connectorUrl`, and its
 * `fillAmount` as `order.fill.min` — keys with no successor are **accepted
 * and ignored with a warning** (`CLAUDE.md` › "Config first, code second").
 */

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  fromMnemonic,
  generateMnemonic,
  base58Encode,
} from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { createTakerRuntime } from './taker-runtime.js';
import type { TakerRuntime } from './taker-runtime.js';
import { SwapTakerError } from './swap-taker.js';
import { createHttpRateProvider } from './rate-provider.js';
import { createConsoleLogger } from './logger.js';
import { deriveSwapNodeKeys } from './wallet.js';

export interface CliRawConfig {
  mnemonic?: string;
  secretKey?: string; // hex
  swapPairs?: unknown;
  chains?: unknown;
  channels?: Record<
    string,
    {
      channelId: string;
      cumulativeAmount: string | number;
      nonce: string | number;
      updatedAt?: number;
    }[]
  >;
  inventory?: Record<string, string | number>;
  windowBudget?: Record<string, string | number>;
  chainProviders?: unknown;
  maxRateAge?: unknown;
  quote?: SwapNodeConfig['quote'];
  relay?: {
    readUrl?: string;
    connectorUrl?: string;
    destination?: string;
    payChain?: 'evm' | 'solana';
    rpcUrl?: string;
    deposit?: string | number;
    channelStorePath?: string;
    transport?: 'http' | 'btp';
  };
  order?: {
    fill?: { min: string | number; max: string | number };
    ttlMs?: number;
    refreshMs?: number;
  };
  maxChainReadsPerMin?: number;
  gasStation?: { destination?: string; connectorUrl?: string };
  /** 2.x/3.0 aliases: `relayUrls[0]` → `relay.readUrl`, `connectorUrl` → `relay.connectorUrl`, `fillAmount` → `order.fill.min`. */
  relayUrls?: string[];
  connectorUrl?: string;
  fillAmount?: string | number;
  appPort?: number;
  blsPort?: number;
  statePath?: string;
  passphrase?: string;
  identityAutogen?: boolean;
  adminToken?: string;
  reconcileIntervalMs?: number;
  /** Accepted for 2.x compatibility; ignored. */
  settlementPrivateKey?: string;
  [retired: string]: unknown;
}

/**
 * Config keys the 2.x maker consumed and this one does not. Each is named
 * in a boot-time warning so an operator sees exactly what stopped mattering.
 */
export const RETIRED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  ilpAddress:
    'the maker is not behind a route termination; a taker finds it by its order on the relay',
  btpServerPort: 'the maker embeds no connector and listens for nothing',
  btpEndpoint: 'the maker has no endpoint to announce',
  advertisedAsset: 'the order on the relay advertises the pair',
  knownPeers: 'no embedded connector to peer',
  transport: 'set relay.transport (http | btp) for the relay connector instead',
  parentPeerId: 'no parent/child peer relation exists on the Rust connector',
  parentAuthToken: 'no parent/child peer relation exists on the Rust connector',
  parentEvmAddress:
    'no parent/child peer relation exists on the Rust connector',
  nodeId: 'no embedded connector to name',
  peerInfoIlpDestination: 'the kind:10032 announce is gone',
  peerInfoPricePerByte: 'the kind:10032 announce is gone',
  peerInfoTtlSeconds: 'the kind:10032 announce is gone',
  peerInfoRefreshIntervalMs: 'the kind:10032 announce is gone',
  rolling:
    'rolling/1 coupled legs are gone; see `quote` and `order` for the rolling/3 knobs',
  rollingLegBSender: 'leg B rides in the advance the maker writes to the relay',
  settlementPrivateKey:
    'leg-B claims are signed with the BIP-44 index-2 key derived from the mnemonic; the connector in front holds its own settlement keys',
};

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`expected an integer, got ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new Error(`expected a decimal integer, got ${JSON.stringify(v)}`);
}

function assertSafeKey(key: string, scope: string): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(
      `Unsafe key "${key}" rejected in ${scope} (prototype pollution guard)`
    );
  }
}

/**
 * Why a config boots offline, or null when the relay is fully configured.
 * Offline is a warning, not a refusal, so a fleet config written before
 * `relay.connectorUrl` existed still boots (and its health says `relay: null`).
 */
export function relayConfigWarning(raw: CliRawConfig): string | null {
  const readUrl = raw.relay?.readUrl ?? raw.relayUrls?.[0];
  const connectorUrl = raw.relay?.connectorUrl ?? raw.connectorUrl;
  const hasRead = typeof readUrl === 'string' && readUrl.length > 0;
  const hasConnector =
    typeof connectorUrl === 'string' && connectorUrl.length > 0;
  if (hasRead && hasConnector) return null;
  if (!hasRead && !hasConnector) {
    return 'no relay configured (relay.readUrl + relay.connectorUrl): booting OFFLINE — no order is published and no fill is answered';
  }
  if (!hasConnector) {
    return `relay.readUrl is set (${String(readUrl)}) but relay.connectorUrl is not: booting OFFLINE — add the relay connector's client edge (e.g. https://proxy.relay.devnet.toonprotocol.dev/ilp) to pay for writes`;
  }
  return 'relay.connectorUrl is set but relay.readUrl is not: booting OFFLINE — add the relay WebSocket URL to read orders and the inbox';
}

/** Retired keys present in `raw`, each with the reason it stopped mattering. */
export function retiredKeysIn(
  raw: CliRawConfig
): { key: string; why: string }[] {
  return Object.entries(RETIRED_CONFIG_KEYS)
    .filter(([key]) => raw[key] !== undefined)
    .map(([key, why]) => ({ key, why }));
}

export function parseRawConfig(raw: CliRawConfig): SwapNodeConfig {
  const channels: SwapNodeConfig['channels'] = Object.create(
    null
  ) as SwapNodeConfig['channels'];
  if (raw.channels) {
    for (const [chain, entries] of Object.entries(raw.channels)) {
      assertSafeKey(chain, 'channels');
      channels[chain] = entries.map((e) => ({
        channelId: e.channelId,
        cumulativeAmount: toBigInt(e.cumulativeAmount),
        nonce: toBigInt(e.nonce),
        updatedAt: e.updatedAt ?? 0,
      }));
    }
  }
  const inventory: Record<string, bigint> = Object.create(null) as Record<
    string,
    bigint
  >;
  if (raw.inventory) {
    for (const [chain, amt] of Object.entries(raw.inventory)) {
      assertSafeKey(chain, 'inventory');
      inventory[chain] = toBigInt(amt);
    }
  }
  let windowBudget: Record<string, bigint> | undefined;
  if (raw.windowBudget) {
    windowBudget = Object.create(null) as Record<string, bigint>;
    for (const [chain, amt] of Object.entries(raw.windowBudget)) {
      assertSafeKey(chain, 'windowBudget');
      windowBudget[chain] = toBigInt(amt);
    }
  }

  const cfg: SwapNodeConfig = {
    swapPairs: (raw.swapPairs as SwapNodeConfig['swapPairs']) ?? [],
    chains: (raw.chains as SwapNodeConfig['chains']) ?? [],
    channels,
    inventory,
  };
  if (windowBudget) cfg.windowBudget = windowBudget;
  if (raw.mnemonic) cfg.mnemonic = raw.mnemonic;
  if (raw.secretKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw.secretKey)) {
      throw new Error(
        'config.secretKey must be a 64-character hex string (32 bytes)'
      );
    }
    cfg.secretKey = Uint8Array.from(Buffer.from(raw.secretKey, 'hex'));
  }
  if (raw.appPort !== undefined) cfg.appPort = raw.appPort;
  if (raw.blsPort !== undefined) cfg.blsPort = raw.blsPort;
  if (raw.statePath) cfg.statePath = raw.statePath;
  if (raw.passphrase) cfg.passphrase = raw.passphrase;
  if (raw.quote) cfg.quote = raw.quote;
  const readUrl = raw.relay?.readUrl ?? raw.relayUrls?.[0];
  const connectorUrl = raw.relay?.connectorUrl ?? raw.connectorUrl;
  // Both URLs → the relay loop runs. One or none → the maker boots OFFLINE
  // (engine, health, admin) and `relayConfigWarning` says why, loudly. A
  // committed fleet config that predates `relay.connectorUrl` must still
  // boot (CLAUDE.md › "Config first, code second"); it just does not trade.
  if (
    typeof readUrl === 'string' &&
    readUrl.length > 0 &&
    typeof connectorUrl === 'string' &&
    connectorUrl.length > 0
  ) {
    cfg.relay = {
      readUrl,
      connectorUrl,
      ...(raw.relay?.destination !== undefined && {
        destination: raw.relay.destination,
      }),
      ...(raw.relay?.payChain !== undefined && {
        payChain: raw.relay.payChain,
      }),
      ...(raw.relay?.rpcUrl !== undefined && { rpcUrl: raw.relay.rpcUrl }),
      ...(raw.relay?.deposit !== undefined && {
        deposit: toBigInt(raw.relay.deposit),
      }),
      ...(raw.relay?.channelStorePath !== undefined && {
        channelStorePath: raw.relay.channelStorePath,
      }),
      ...(raw.relay?.transport !== undefined && {
        transport: raw.relay.transport,
      }),
    };
  }
  const fillMin = raw.order?.fill?.min ?? raw.fillAmount;
  const fillMax =
    raw.order?.fill?.max ?? raw.order?.fill?.min ?? raw.fillAmount;
  if (fillMin !== undefined || raw.order !== undefined) {
    cfg.order = {
      ...(fillMin !== undefined && {
        fill: { min: toBigInt(fillMin), max: toBigInt(fillMax ?? fillMin) },
      }),
      ...(raw.order?.ttlMs !== undefined && { ttlMs: raw.order.ttlMs }),
      ...(raw.order?.refreshMs !== undefined && {
        refreshMs: raw.order.refreshMs,
      }),
    };
  }
  if (raw.maxChainReadsPerMin !== undefined)
    cfg.maxChainReadsPerMin = raw.maxChainReadsPerMin;
  if (raw.gasStation !== undefined) cfg.gasStation = raw.gasStation;
  if (raw.chainProviders !== undefined) {
    cfg.chainProviders = raw.chainProviders as SwapNodeConfig['chainProviders'];
  }
  if (raw.maxRateAge !== undefined) {
    cfg.maxRateAge = raw.maxRateAge as SwapNodeConfig['maxRateAge'];
  }
  if (raw.adminToken) cfg.adminToken = raw.adminToken;
  if (raw.reconcileIntervalMs !== undefined) {
    cfg.reconcileIntervalMs = raw.reconcileIntervalMs;
  }
  return cfg;
}

export function applyEnvOverlay(cfg: SwapNodeConfig): SwapNodeConfig {
  const out = { ...cfg };
  const env = process.env;
  if (env['SWAP_MNEMONIC']) {
    out.mnemonic = env['SWAP_MNEMONIC'];
    delete out.secretKey;
  } else if (env['SWAP_SECRET_KEY_HEX']) {
    const hex = env['SWAP_SECRET_KEY_HEX'];
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('SWAP_SECRET_KEY_HEX must be a 64-char hex string');
    }
    out.secretKey = Uint8Array.from(Buffer.from(hex, 'hex'));
    delete out.mnemonic;
  }
  const portVar = env['SWAP_APP_PORT'] ? 'SWAP_APP_PORT' : 'SWAP_BLS_PORT';
  const portEnv = env[portVar];
  if (portEnv) {
    const p = parseInt(portEnv, 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error(`${portVar} must be 0..65535`);
    }
    out.appPort = p;
    delete out.blsPort;
  }
  if (env['SWAP_STATE_PATH']) out.statePath = env['SWAP_STATE_PATH'];
  if (env['SWAP_RELAY_READ_URL'] || env['SWAP_RELAY_CONNECTOR_URL']) {
    const readUrl = env['SWAP_RELAY_READ_URL'] ?? out.relay?.readUrl;
    const connectorUrl =
      env['SWAP_RELAY_CONNECTOR_URL'] ?? out.relay?.connectorUrl;
    if (!readUrl || !connectorUrl) {
      throw new Error(
        'SWAP_RELAY_READ_URL and SWAP_RELAY_CONNECTOR_URL must both be resolvable (env or config)'
      );
    }
    out.relay = { ...(out.relay ?? {}), readUrl, connectorUrl };
  }
  if (env['SWAP_RELAY_DESTINATION']) {
    if (!out.relay)
      throw new Error(
        'SWAP_RELAY_DESTINATION needs a relay (config.relay or SWAP_RELAY_*_URL)'
      );
    out.relay = { ...out.relay, destination: env['SWAP_RELAY_DESTINATION'] };
  }
  if (env['SWAP_RELAY_PAY_CHAIN']) {
    const c = env['SWAP_RELAY_PAY_CHAIN'];
    if (c !== 'evm' && c !== 'solana')
      throw new Error('SWAP_RELAY_PAY_CHAIN must be evm or solana');
    if (!out.relay)
      throw new Error(
        'SWAP_RELAY_PAY_CHAIN needs a relay (config.relay or SWAP_RELAY_*_URL)'
      );
    out.relay = { ...out.relay, payChain: c };
  }
  const fillMinEnv = env['SWAP_FILL_MIN'] ?? env['SWAP_FILL_AMOUNT'];
  const fillMaxEnv = env['SWAP_FILL_MAX'];
  if (fillMinEnv || fillMaxEnv) {
    const min = fillMinEnv ? toBigInt(fillMinEnv) : out.order?.fill?.min;
    const max = fillMaxEnv
      ? toBigInt(fillMaxEnv)
      : (out.order?.fill?.max ?? min);
    if (min === undefined || max === undefined) {
      throw new Error(
        'SWAP_FILL_MIN (or SWAP_FILL_AMOUNT) is required when SWAP_FILL_MAX is set'
      );
    }
    out.order = { ...(out.order ?? {}), fill: { min, max } };
  }
  if (env['SWAP_MAX_RATE_AGE']) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env['SWAP_MAX_RATE_AGE']);
    } catch {
      throw new Error(
        'SWAP_MAX_RATE_AGE must be valid JSON, e.g. {"defaultMs":3000,"perChain":{"mina":15000}}'
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('SWAP_MAX_RATE_AGE must be a JSON object');
    }
    out.maxRateAge = parsed as SwapNodeConfig['maxRateAge'];
  }
  if (env['SWAP_MAX_RATE_AGE_MS']) {
    const ms = Number(env['SWAP_MAX_RATE_AGE_MS']);
    if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms <= 0) {
      throw new Error('SWAP_MAX_RATE_AGE_MS must be a positive integer (ms)');
    }
    out.maxRateAge = { ...(out.maxRateAge ?? {}), defaultMs: ms };
  }
  if (env['SWAP_RATE_URL']) {
    let timeoutMs: number | undefined;
    if (env['SWAP_RATE_TIMEOUT_MS']) {
      timeoutMs = Number(env['SWAP_RATE_TIMEOUT_MS']);
      if (
        !Number.isFinite(timeoutMs) ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs <= 0
      ) {
        throw new Error('SWAP_RATE_TIMEOUT_MS must be a positive integer (ms)');
      }
    }
    out.rateProvider = createHttpRateProvider(env['SWAP_RATE_URL'], {
      ...(timeoutMs !== undefined && { timeoutMs }),
    });
  }
  if (env['SWAP_ADMIN_TOKEN']) out.adminToken = env['SWAP_ADMIN_TOKEN'];
  if (env['SWAP_RECONCILE_INTERVAL_MS']) {
    const ms = Number(env['SWAP_RECONCILE_INTERVAL_MS']);
    if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0) {
      throw new Error(
        'SWAP_RECONCILE_INTERVAL_MS must be a non-negative integer (ms; 0 disables the periodic pass)'
      );
    }
    out.reconcileIntervalMs = ms;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity — self-generated on first boot when asked (swap#126)
// ---------------------------------------------------------------------------

function isAutogenEnabled(raw: CliRawConfig): boolean {
  const env = process.env['SWAP_AUTOGEN_IDENTITY'];
  if (env === '1' || env === 'true') return true;
  return raw.identityAutogen === true;
}

function resolveIdentityFilePath(cfg: SwapNodeConfig): string {
  const override = process.env['SWAP_IDENTITY_FILE'];
  if (override) return resolve(override);
  const base = cfg.statePath ? dirname(cfg.statePath) : process.cwd();
  return resolve(base, 'identity.json');
}

function loadOrCreatePersistedMnemonic(identityFilePath: string): string {
  if (existsSync(identityFilePath)) {
    const persisted = JSON.parse(readFileSync(identityFilePath, 'utf-8')) as {
      mnemonic?: unknown;
    };
    if (
      typeof persisted.mnemonic !== 'string' ||
      persisted.mnemonic.length === 0
    ) {
      throw new Error(
        `Identity file ${identityFilePath} does not contain a valid "mnemonic" string`
      );
    }
    return persisted.mnemonic;
  }
  const mnemonic = generateMnemonic();
  mkdirSync(dirname(identityFilePath), { recursive: true });
  writeFileSync(identityFilePath, JSON.stringify({ mnemonic }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return mnemonic;
}

/**
 * Resolve the identity: load/create the persisted mnemonic when autogen is
 * on, then print the addresses an operator has to fund — the index-0 Nostr
 * pubkey, and the index-2 EVM / Solana leg-B signers.
 */
export async function resolveIdentityConfig(
  config: SwapNodeConfig,
  raw: CliRawConfig
): Promise<SwapNodeConfig> {
  const out = { ...config };
  if (
    isAutogenEnabled(raw) &&
    out.mnemonic === undefined &&
    out.secretKey === undefined
  ) {
    out.mnemonic = loadOrCreatePersistedMnemonic(resolveIdentityFilePath(out));
  }
  if (out.mnemonic === undefined) return out;

  const chains = out.chains.length > 0 ? out.chains : (['evm'] as const);
  const swapNodeKeys = await deriveSwapNodeKeys({
    mnemonic: out.mnemonic,
    chains: [...chains],
  });
  const identity = fromMnemonic(out.mnemonic);
  console.log(
    `[swap-node] identity pubkey (Nostr, index-0): ${identity.pubkey}`
  );
  if (swapNodeKeys.evm) {
    console.log(
      `[swap-node] settlement address (EVM, index-2): ${swapNodeKeys.evm.address} — the leg-B signer`
    );
  }
  if (swapNodeKeys.solana) {
    console.log(
      `[swap-node] settlement address (Solana, index-2): ${base58Encode(swapNodeKeys.solana.publicKey)} — the leg-B signer`
    );
  }
  return out;
}

export const CLI_USAGE = `Usage:
  toon-swap [make]  --config <path>
  toon-swap orders  --config <path> [--json]
  toon-swap take    --config <path> --order <makerPubkey>:<orderId> --size <units> [--delta <units>] [--recipient <addr>] [--json]
  toon-swap resume  --config <path> --stream <streamNonce> [--json]
  toon-swap redeem  --config <path> --stream <streamNonce> [--via own|gas-station] [--no-fallback]
  toon-swap close   --config <path> --stream <streamNonce>   (Solana)
  toon-swap settle  --config <path> --stream <streamNonce>   (Solana)
  toon-swap sessions --config <path> [--json]`;

export class CliHelpRequested extends Error {
  constructor() {
    super(CLI_USAGE);
    this.name = 'CliHelpRequested';
  }
}

export const TAKER_COMMANDS = [
  'orders',
  'take',
  'resume',
  'redeem',
  'close',
  'settle',
  'sessions',
] as const;
export type TakerCommand = (typeof TAKER_COMMANDS)[number];

/** Load, overlay and resolve a config the way `make` does, without booting. */
async function loadConfig(
  configPath: string
): Promise<{ config: SwapNodeConfig; raw: CliRawConfig }> {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as CliRawConfig;
  const parsed = parseRawConfig(raw);
  const overlaid = applyEnvOverlay(parsed);
  const config = installDefaultLogger(
    await resolveIdentityConfig(overlaid, raw)
  );
  return { config, raw };
}

function requireTakerRuntimeConfig(config: SwapNodeConfig, readOnly: boolean) {
  if (!config.mnemonic)
    throw new Error(
      'a mnemonic is required (config.mnemonic, SWAP_MNEMONIC, or SWAP_IDENTITY_FILE)'
    );
  if (!config.relay) {
    throw new Error(
      'config.relay.readUrl and config.relay.connectorUrl are required for taker commands'
    );
  }
  if (!config.statePath)
    throw new Error(
      'config.statePath is required for taker commands (sessions and watermarks live there)'
    );
  return {
    mnemonic: config.mnemonic,
    chains: config.chains,
    chainProviders: config.chainProviders ?? [],
    relay: config.relay,
    statePath: config.statePath.replace(/\.json$/, '') + '.taker.json',
    readOnly,
    ...(config.gasStation && { gasStation: config.gasStation }),
    ...(config.logger && { logger: config.logger }),
  };
}

function printJson(value: unknown): void {
  console.log(
    JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    )
  );
}

/** Run a taker subcommand to completion. Returns the process exit code. */
export async function runTakerCommand(
  command: TakerCommand,
  argv: string[]
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      order: { type: 'string' },
      size: { type: 'string' },
      delta: { type: 'string' },
      recipient: { type: 'string' },
      stream: { type: 'string' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
      via: { type: 'string' },
      'no-fallback': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });
  const configPath = resolve(String(values.config ?? './swap.config.json'));
  const { config } = await loadConfig(configPath);
  const readOnly = command === 'orders' || command === 'sessions';
  const rt: TakerRuntime = await createTakerRuntime(
    requireTakerRuntimeConfig(config, readOnly)
  );
  const json = values.json === true;
  const waitMs = values.timeout ? Number(values.timeout) : 10_000;
  try {
    switch (command) {
      case 'orders': {
        rt.taker.listOrders();
        const deadline = Date.now() + waitMs;
        while (!rt.taker.ordersReady() && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 100));
        const orders = rt.taker.listOrders();
        if (json) {
          printJson(
            orders.map((o) => ({
              maker: o.makerPubkey,
              ...o.order,
              eventId: o.eventId,
            }))
          );
        } else if (orders.length === 0) {
          console.log(`No live orders on ${config.relay?.readUrl}`);
        } else {
          for (const { order, makerPubkey } of orders) {
            console.log(
              `${makerPubkey}:${order.orderId}\n  ${order.pair.from.assetCode}@${order.pair.from.chain} → ${order.pair.to.assetCode}@${order.pair.to.chain}` +
                `  rate ${order.rate}  fill [${order.fill.min}, ${order.fill.max}]  max ${order.maxAmount ?? '?'}  expires ${new Date(order.expiresAt).toISOString()}`
            );
          }
        }
        return 0;
      }
      case 'sessions': {
        const sessions = Object.values(rt.taker.sessions());
        if (json) printJson({ sessions, channels: rt.taker.channels() });
        else if (sessions.length === 0) console.log('No sessions.');
        else {
          for (const s of sessions) {
            console.log(
              `${s.streamNonce}  ${s.status}  ${s.orderId}  sent ${s.legA.cumulative}/${s.size}  lastSeq ${s.lastAdvance?.seq ?? 0}` +
                `  received ${s.received?.cumulative ?? '0'} on ${s.received?.channelId ?? '-'}${s.redeemed ? `  redeemed ${s.redeemed.txId}` : ''}`
            );
          }
        }
        return 0;
      }
      case 'take': {
        const orderRef = String(values.order ?? '');
        const sep = orderRef.indexOf(':');
        if (sep <= 0)
          throw new Error('--order must be <makerPubkey>:<orderId>');
        const makerPubkey = orderRef.slice(0, sep);
        const orderId = orderRef.slice(sep + 1);
        if (!values.size)
          throw new Error('--size <source base units> is required');
        rt.taker.listOrders();
        const deadline = Date.now() + waitMs;
        let listing = rt.taker
          .listOrders()
          .find(
            (o) => o.makerPubkey === makerPubkey && o.order.orderId === orderId
          );
        while (!listing && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          listing = rt.taker
            .listOrders()
            .find(
              (o) =>
                o.makerPubkey === makerPubkey && o.order.orderId === orderId
            );
        }
        if (!listing)
          throw new Error(`order ${orderRef} is not live on the relay`);
        const session = await rt.taker.accept(listing, {
          size: toBigInt(values.size),
          ...(values.delta !== undefined && { delta: toBigInt(values.delta) }),
          ...(values.recipient !== undefined && {
            chainRecipient: String(values.recipient),
          }),
        });
        const fills = Number(
          (BigInt(session.size) + BigInt(session.delta) - 1n) /
            BigInt(session.delta)
        );
        const writes = 2 * fills + 3;
        const carriagePct = ((writes / Number(session.size)) * 100).toFixed(3);
        console.log(
          `session ${session.streamNonce}: quoted at ${session.quote?.rate}; ${fills} fills of ${session.delta} — ` +
            `exposure ${session.delta} base units per fill, ~${writes} relay writes (~${carriagePct}% of notional at 1 µUSDC each), ETA ~${Math.ceil(fills * 0.4)} s`
        );
        const done = await rt.taker.run(session.streamNonce, {
          onFill: (a) =>
            console.log(
              `  fill ${a.seq}: +${a.targetAmount} → cumulative ${a.claim.cumulativeAmount} on ${a.claim.channelId}`
            ),
        });
        if (json) printJson(done);
        else
          console.log(
            `done: received ${done.received?.cumulative} on ${done.received?.channelId}; run 'toon-swap redeem --stream ${done.streamNonce}' to claim on chain`
          );
        return 0;
      }
      case 'resume': {
        const stream = String(values.stream ?? '');
        if (!stream) throw new Error('--stream <streamNonce> is required');
        const done = await rt.taker.resume(stream, {
          onFill: (a) =>
            console.log(
              `  fill ${a.seq}: +${a.targetAmount} → cumulative ${a.claim.cumulativeAmount}`
            ),
        });
        if (json) printJson(done);
        else
          console.log(
            `${done.status}: received ${done.received?.cumulative ?? '0'} on ${done.received?.channelId ?? '-'}`
          );
        return 0;
      }
      case 'redeem': {
        const stream = String(values.stream ?? '');
        if (!stream) throw new Error('--stream <streamNonce> is required');
        const via = values.via === 'gas-station' ? 'gas-station' : 'own';
        const { txId, via: usedVia } = await rt.taker.redeem(stream, {
          via,
          fallback: values['no-fallback'] !== true,
        });
        console.log(`redeemed via ${usedVia}: ${txId}`);
        return 0;
      }
      case 'close':
      case 'settle': {
        const stream = String(values.stream ?? '');
        if (!stream) throw new Error('--stream <streamNonce> is required');
        const session = rt.taker.session(stream);
        if (!session) throw new Error(`unknown session ${stream}`);
        const { txId } =
          command === 'close'
            ? await rt.settler.close(session)
            : await rt.settler.settle(session);
        console.log(`${command}: ${txId}`);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof SwapTakerError) {
      console.error(`[toon-swap] ${err.message}`);
      if (err.detail !== undefined) console.error(JSON.stringify(err.detail));
      return 2;
    }
    throw err;
  } finally {
    await rt.stop();
  }
  return 0;
}

export function installDefaultLogger(config: SwapNodeConfig): SwapNodeConfig {
  if (config.logger) return config;
  return { ...config, logger: createConsoleLogger() };
}

export async function main(argv: string[]): Promise<SwapNodeInstance> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });
  if (values.help) {
    console.log(CLI_USAGE);
    throw new CliHelpRequested();
  }

  const configPath = resolve(String(values.config ?? './swap.config.json'));
  const { config, raw } = await loadConfig(configPath);

  for (const { key, why } of retiredKeysIn(raw)) {
    config.logger?.warn?.('swap.config.retired_key_ignored', { key, why });
  }
  const offline = relayConfigWarning(raw);
  if (offline && !config.relay)
    config.logger?.warn?.('swap.config.relay_offline', { why: offline });

  const instance = await startSwapNode(config);
  console.log(
    `Swap maker health on http://localhost:${instance.appPort}/health`
  );
  console.log(
    `Maker Nostr pubkey (takers address wraps to it): ${instance.nostr.pubkey}`
  );
  if (config.relay) {
    console.log(
      `Orders on ${config.relay.readUrl}; writes paid through ${config.relay.connectorUrl}`
    );
  } else {
    console.log('No relay configured: offline (engine, health and admin only)');
  }
  console.log(`Quoting ${config.swapPairs.length} swap pair(s)`);
  return instance;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'make';
  if ((TAKER_COMMANDS as readonly string[]).includes(command)) {
    runTakerCommand(command as TakerCommand, args.slice(1))
      .then((code) => process.exit(code))
      .catch((error: unknown) => {
        console.error(
          `[toon-swap ${command}] error:`,
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      });
  } else if (command !== 'make') {
    console.error(`[toon-swap] unknown command "${command}"\n${CLI_USAGE}`);
    process.exit(1);
  } else {
    main(args[0] === 'make' ? args.slice(1) : args)
      .then((instance) => {
        const shutdown = async (signal: string): Promise<void> => {
          console.log(`\n[swap-node] Received ${signal}; shutting down...`);
          await instance.stop();
          process.exit(0);
        };
        process.on('SIGINT', () => {
          void shutdown('SIGINT');
        });
        process.on('SIGTERM', () => {
          void shutdown('SIGTERM');
        });
      })
      .catch((error: unknown) => {
        if (error instanceof CliHelpRequested) process.exit(0);
        console.error('[swap-node] Startup error:', error);
        process.exit(1);
      });
  }
}
