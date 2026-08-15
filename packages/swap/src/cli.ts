#!/usr/bin/env node

/**
 * CLI entrypoint for `@toon-protocol/swap` (Story 12.7 AC-9).
 *
 * Thin wrapper around `startSwapNode()`. Reads a JSON config file and overlays
 * env-var overrides. Mirrors `packages/town/src/cli.ts`'s shape.
 *
 * Usage:
 *   toon-swap --config ./swap.config.json
 *
 * Environment variables (override config file):
 *   SWAP_MNEMONIC          — BIP-39 mnemonic
 *   SWAP_SECRET_KEY_HEX    — 64-char hex-encoded 32-byte secret key
 *   SWAP_BLS_PORT          — numeric port for /health server
 *   SWAP_RELAYS            — comma-separated relay WebSocket URLs
 *   SWAP_STATE_PATH        — durable state snapshot path (issue #46);
 *                            enables persistence of inventory, channel
 *                            watermarks, sticky bindings + replay
 *                            reservations across restarts
 *   TOON_CONNECTOR_URL     — parent BTP URL; activates embedded-with-parent mode
 *   TOON_PARENT_PEER_ID    — peer id for the parent (default: "apex")
 *   TOON_PARENT_AUTH_TOKEN — BTP auth token for the parent peer (default: "")
 *   TOON_ILP_ADDRESS       — advertised ILP address + self-route prefix
 *   TOON_NODE_ID           — connector nodeId override (default: toon-swap-<pk16>)
 *   SWAP_MAX_RATE_AGE_MS   — maker staleness bound default (positive integer ms;
 *                            sets/overrides maxRateAge.defaultMs)
 *   SWAP_MAX_RATE_AGE      — full per-chain/per-pair maxRateAge config as JSON,
 *                            e.g. '{"defaultMs":3000,"perChain":{"mina":15000}}'
 *                            (SWAP_MAX_RATE_AGE_MS still overrides defaultMs)
 *   SWAP_RATE_URL          — HTTP JSON rate feed (issue #47 AC-3): wires the
 *                            per-packet `rateProvider` so deployed swap nodes
 *                            price every fill at the feed's current tick
 *                            instead of the config-frozen pair.rate. Accepted
 *                            response shapes: {"rate":"0.0004","at":<unix-ms>}
 *                            or a map keyed by pairKey (optionally under
 *                            "rates"). Timestamped ("at") responses arm the
 *                            SWAP_MAX_RATE_AGE staleness guard.
 *   SWAP_RATE_TIMEOUT_MS   — per-request feed timeout (default 1500)
 *   SWAP_AUTOGEN_IDENTITY  — "1"/"true" (issue #126): when no identity is
 *                            otherwise provided (no mnemonic/secretKey in
 *                            the config file, no SWAP_MNEMONIC/
 *                            SWAP_SECRET_KEY_HEX env), generate a fresh
 *                            BIP-39 mnemonic and persist it to an identity
 *                            file (default `<dir of statePath>/identity.json`,
 *                            mode 600; override with SWAP_IDENTITY_FILE).
 *                            A later boot against the same file LOADS the
 *                            persisted mnemonic instead of regenerating —
 *                            idempotent, since funds are tied to the
 *                            identity. A no-op when an identity is already
 *                            provided. Config-file equivalent:
 *                            `identityAutogen: true`.
 *   SWAP_IDENTITY_FILE     — overrides the identity-file path used by
 *                            SWAP_AUTOGEN_IDENTITY (default: see above).
 *
 * NOTE on maxRateAge (swap#48): the staleness bound applies to the maker's
 * own rate-feed ticks, so it REQUIRES a `rateProvider` returning timestamped
 * quotes — set SWAP_RATE_URL (timestamped responses) or use a programmatic
 * `startSwapNode()` embedding. Setting it on a static-rate JSON-config swap
 * node fails boot with INVALID_CONFIG (loud by design; a static rate has no
 * age to measure).
 *
 * Config-file-only fields (no env override, matching `btpEndpoint`):
 * `peerInfoIlpDestination` + `peerInfoPricePerByte` (issue #124) — route the
 * paid kind:10032 announce over ILP through a connector (`connectorUrl`,
 * `connector`, or the auto-created standalone one) instead of the legacy
 * unpaid Nostr WS publish a TOON relay drops. See
 * `SwapNodeConfig.peerInfoIlpDestination`.
 *
 * `settlementPrivateKey` auto-derivation (issue #126): whenever the
 * resolved identity is a mnemonic AND `settlementPrivateKey` is unset (or a
 * `0xdead…`-style placeholder), the CLI derives the BIP-44 account-index-2
 * EVM key (`deriveSwapNodeKeys` / D12-011 — the same key `settlementAddresses`
 * advertises and leg-B v2 EIP-712 claims are signed with) and fills
 * `settlementPrivateKey` in. This applies regardless of whether the
 * mnemonic was auto-generated or operator-provided. The resolved index-0
 * Nostr pubkey and index-2 EVM settlement address are logged once (never
 * the secret) so an operator can fund the settlement address.
 */

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fromMnemonic, generateMnemonic } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { createHttpRateProvider } from './rate-provider.js';
import { deriveSwapNodeKeys } from './wallet.js';

interface CliRawConfig {
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
  /**
   * Issue #49 — per-chain in-flight window ceiling for the rolling path
   * (rolling-swap §8). Same keying as `inventory`.
   */
  windowBudget?: Record<string, string | number>;
  relayUrls?: string[];
  blsPort?: number;
  btpServerPort?: number;
  /** Durable swap-state snapshot path (issue #46). */
  statePath?: string;
  passphrase?: string;
  knownPeers?: { ilpAddress: string; btpUrl?: string }[];
  // Story 12.7 Review Pass #1 additions — operator-surfaced kind:10032 fields.
  ilpAddress?: string;
  btpEndpoint?: string;
  advertisedAsset?: { assetCode: string; assetScale: number };
  // Ator/SOCKS5 transport overlay (Epic 35 integration).
  transport?: {
    type: string;
    socksProxy?: string;
    externalUrl?: string;
    managed?: boolean;
    managedOptions?: Record<string, unknown>;
  };
  // Embedded-with-parent connector wiring.
  connectorUrl?: string;
  parentPeerId?: string;
  parentAuthToken?: string;
  nodeId?: string;
  // Embedded-connector chain providers (EVM / Solana / Mina). Forwarded
  // verbatim to startSwapNode(), which validates the discriminated-union shape and
  // defaults each entry's keyId. See SwapNodeConfig.chainProviders.
  chainProviders?: unknown;
  // Embedded-connector ClaimReceiver signer + parent treasury address.
  settlementPrivateKey?: string;
  parentEvmAddress?: string;
  // Story 50.4 — paid kind:10032 advertisement via ILP (issue #124). Requires
  // a connector (`connectorUrl`/`connector`/an auto-created standalone one);
  // see SwapNodeConfig.peerInfoIlpDestination.
  peerInfoIlpDestination?: string;
  peerInfoPricePerByte?: string | number;
  // Maker staleness bound(s) — swap#48. Forwarded verbatim; startSwapNode()'s
  // validateConfig() enforces the shape AND the rateProvider requirement
  // (see the maxRateAge NOTE in the header).
  maxRateAge?: unknown;
  // Issue #126 — config-file equivalent of SWAP_AUTOGEN_IDENTITY. Consumed
  // entirely by resolveIdentityConfig(); never forwarded to SwapNodeConfig.
  identityAutogen?: boolean;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`Cannot convert to bigint: ${String(v)}`);
}

/**
 * Reject map keys that would pollute `Object.prototype` or shadow built-ins
 * when assigned to a plain object (`__proto__`, `constructor`, `prototype`).
 * JSON.parse preserves `__proto__` as an own property, so raw config input
 * must be filtered before being fanned out into the `channels` / `inventory`
 * maps consumed by `startSwapNode()`.
 */
function assertSafeKey(key: string, scope: string): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(
      `Unsafe key "${key}" rejected in ${scope} (prototype pollution guard)`
    );
  }
}

function parseRawConfig(raw: CliRawConfig): SwapNodeConfig {
  // Normalize channels: string/number → bigint. Use null-prototype accumulators
  // to defend against prototype-pollution via crafted JSON input.
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

  // Normalize inventory.
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

  // Normalize windowBudget (issue #49) — same shape/guards as inventory.
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
    relayUrls: raw.relayUrls ?? [],
  };
  if (windowBudget) cfg.windowBudget = windowBudget;
  if (raw.mnemonic) cfg.mnemonic = raw.mnemonic;
  if (raw.secretKey) {
    // Strict 64-char hex validation — `Buffer.from(str, 'hex')` silently
    // truncates on invalid chars, yielding a confusing downstream error.
    if (!/^[0-9a-fA-F]{64}$/.test(raw.secretKey)) {
      throw new Error(
        'config.secretKey must be a 64-character hex string (32 bytes)'
      );
    }
    cfg.secretKey = Uint8Array.from(Buffer.from(raw.secretKey, 'hex'));
  }
  if (raw.blsPort !== undefined) cfg.blsPort = raw.blsPort;
  if (raw.btpServerPort !== undefined) cfg.btpServerPort = raw.btpServerPort;
  if (raw.statePath) cfg.statePath = raw.statePath;
  if (raw.passphrase) cfg.passphrase = raw.passphrase;
  if (raw.knownPeers) cfg.knownPeers = raw.knownPeers;
  if (raw.ilpAddress) cfg.ilpAddress = raw.ilpAddress;
  if (raw.btpEndpoint) cfg.btpEndpoint = raw.btpEndpoint;
  if (raw.advertisedAsset) cfg.advertisedAsset = raw.advertisedAsset;
  if (raw.transport)
    cfg.transport = raw.transport as SwapNodeConfig['transport'];
  if (raw.connectorUrl) cfg.connectorUrl = raw.connectorUrl;
  if (raw.parentPeerId) cfg.parentPeerId = raw.parentPeerId;
  if (raw.parentAuthToken !== undefined) {
    cfg.parentAuthToken = raw.parentAuthToken;
  }
  if (raw.nodeId) cfg.nodeId = raw.nodeId;
  if (raw.chainProviders !== undefined) {
    // Forward verbatim; startSwapNode()'s validateConfig() enforces the
    // discriminated-union shape (EVM / Solana / Mina) and defaults keyId.
    cfg.chainProviders = raw.chainProviders as SwapNodeConfig['chainProviders'];
  }
  if (raw.settlementPrivateKey) {
    cfg.settlementPrivateKey = raw.settlementPrivateKey;
  }
  if (raw.parentEvmAddress) cfg.parentEvmAddress = raw.parentEvmAddress;
  if (raw.peerInfoIlpDestination) {
    cfg.peerInfoIlpDestination = raw.peerInfoIlpDestination;
  }
  if (raw.peerInfoPricePerByte !== undefined) {
    cfg.peerInfoPricePerByte = toBigInt(raw.peerInfoPricePerByte);
  }
  if (raw.maxRateAge !== undefined) {
    cfg.maxRateAge = raw.maxRateAge as SwapNodeConfig['maxRateAge'];
  }
  return cfg;
}

function applyEnvOverlay(cfg: SwapNodeConfig): SwapNodeConfig {
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
  if (env['SWAP_BLS_PORT']) {
    const p = parseInt(env['SWAP_BLS_PORT'], 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error('SWAP_BLS_PORT must be 0..65535');
    }
    out.blsPort = p;
  }
  if (env['SWAP_RELAYS']) {
    out.relayUrls = env['SWAP_RELAYS']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (env['SWAP_STATE_PATH']) out.statePath = env['SWAP_STATE_PATH'];
  // Embedded-with-parent connector wiring (TOON_* env vars). Setting
  // TOON_CONNECTOR_URL activates the embedded-with-parent path; the
  // remaining TOON_* vars are optional refinements.
  if (env['TOON_CONNECTOR_URL']) out.connectorUrl = env['TOON_CONNECTOR_URL'];
  if (env['TOON_PARENT_PEER_ID']) out.parentPeerId = env['TOON_PARENT_PEER_ID'];
  if (env['TOON_PARENT_AUTH_TOKEN'] !== undefined) {
    out.parentAuthToken = env['TOON_PARENT_AUTH_TOKEN'];
  }
  if (env['TOON_ILP_ADDRESS']) out.ilpAddress = env['TOON_ILP_ADDRESS'];
  if (env['TOON_NODE_ID']) out.nodeId = env['TOON_NODE_ID'];
  // Maker staleness bound(s) — swap#48. SWAP_MAX_RATE_AGE replaces the whole
  // structure; SWAP_MAX_RATE_AGE_MS then overrides just defaultMs (so the two
  // compose: JSON for per-chain/per-pair shape, _MS for a quick default).
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
  // Fresh per-packet rate feed (issue #47 AC-3). Deployed swap nodes have
  // always priced at the config-frozen pair.rate because nothing wired the
  // SDK's per-packet rateProvider hook; SWAP_RATE_URL closes that gap.
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
  return out;
}

// ---------------------------------------------------------------------------
// Issue #126 — self-generate + persist maker identity on boot, auto-derive
// the index-2 settlement key.
// ---------------------------------------------------------------------------

/**
 * A `0xdead…`-style placeholder settlementPrivateKey: a syntactically valid
 * 32-byte hex key made up entirely of repeated `dead` nibbles, the shape a
 * committed config skeleton ships so it passes format validation while
 * still being an obvious non-key. Detected case-insensitively.
 */
const PLACEHOLDER_SETTLEMENT_KEY_RE = /^0x(?:dead)+$/i;

/**
 * @internal — exported for unit testability (issue #126). True when
 * `settlementPrivateKey` needs to be (re-)derived from the mnemonic: unset,
 * or a `0xdead…`-style placeholder.
 */
export function needsSettlementKeyDerivation(value: string | undefined): boolean {
  return value === undefined || PLACEHOLDER_SETTLEMENT_KEY_RE.test(value);
}

function isAutogenEnabled(raw: CliRawConfig): boolean {
  const env = process.env['SWAP_AUTOGEN_IDENTITY'];
  if (env === '1' || env === 'true') return true;
  return raw.identityAutogen === true;
}

/** Default: beside `statePath` (or the cwd when unset); overridable. */
function resolveIdentityFilePath(cfg: SwapNodeConfig): string {
  const override = process.env['SWAP_IDENTITY_FILE'];
  if (override) return resolve(override);
  const base = cfg.statePath ? dirname(cfg.statePath) : process.cwd();
  return resolve(base, 'identity.json');
}

/**
 * Load the mnemonic persisted at `identityFilePath`, or generate + persist a
 * fresh one (mode 600) when no identity file exists yet. Idempotent across
 * restarts — a persisted identity is NEVER regenerated, since funds are
 * tied to it.
 */
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
 * @internal — exported for unit testability (issue #126). Resolves the
 * swap node's identity for boot:
 *  1. Self-generates + persists a mnemonic (idempotent) when autogen is
 *     enabled and no identity was otherwise provided.
 *  2. Auto-derives the BIP-44 account-index-2 EVM key into
 *     `settlementPrivateKey` whenever the resolved identity is a mnemonic
 *     and `settlementPrivateKey` is unset/a placeholder — this is the same
 *     key `buildSignerAddresses()` advertises via `settlementAddresses` and
 *     signs leg-B v2 EIP-712 claims with, so this applies regardless of
 *     whether the mnemonic came from step 1 or was operator-provided.
 *  3. Logs the resolved index-0 Nostr pubkey + index-2 EVM settlement
 *     address once (never the secret).
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

  if (out.mnemonic === undefined) {
    return out;
  }

  const swapNodeKeys = await deriveSwapNodeKeys({
    mnemonic: out.mnemonic,
    chains: ['evm'],
  });

  if (
    needsSettlementKeyDerivation(out.settlementPrivateKey) &&
    swapNodeKeys.evm
  ) {
    out.settlementPrivateKey = `0x${Buffer.from(
      swapNodeKeys.evm.privateKey
    ).toString('hex')}`;
  }

  const identity = fromMnemonic(out.mnemonic);
  console.log(
    `[swap-node] identity pubkey (Nostr, index-0): ${identity.pubkey}`
  );
  if (swapNodeKeys.evm) {
    console.log(
      `[swap-node] settlement address (EVM, index-2): ${swapNodeKeys.evm.address}`
    );
  }

  return out;
}

/**
 * Error thrown when `main()` is invoked with `--help`. Callers (tests) can
 * distinguish this from genuine failures; the top-level entrypoint catches
 * it and exits 0.
 */
export class CliHelpRequested extends Error {
  constructor() {
    super('Usage: toon-swap --config <path>');
    this.name = 'CliHelpRequested';
  }
}

export async function main(argv: string[]): Promise<SwapNodeInstance> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
    allowPositionals: false,
  });

  if (values.help) {
    // Library-safe: do NOT call process.exit() here — the CLI entrypoint
    // below handles exit codes. Tests can catch this to assert --help path.
    console.log(`Usage: toon-swap --config <path>`);
    throw new CliHelpRequested();
  }

  const configPath = resolve(String(values.config ?? './swap.config.json'));
  const rawText = readFileSync(configPath, 'utf-8');
  const raw = JSON.parse(rawText) as CliRawConfig;
  const parsed = parseRawConfig(raw);
  const overlaid = applyEnvOverlay(parsed);
  const config = await resolveIdentityConfig(overlaid, raw);

  const instance = await startSwapNode(config);

  console.log(`Swap node listening on http://localhost:${instance.blsPort}`);
  console.log(`Advertising ${config.swapPairs.length} swap pairs`);

  return instance;
}

// Self-invoke when run as entrypoint (mirrors Town's pattern).
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
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
      if (error instanceof CliHelpRequested) {
        process.exit(0);
      }
      console.error('[swap-node] Startup error:', error);
      process.exit(1);
    });
}
