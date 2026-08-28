#!/usr/bin/env node
/**
 * `toon-swap` — the maker's CLI entrypoint (the runtime image runs this).
 *
 *   toon-swap --config ./swap.config.json
 *
 * Reads a JSON config, overlays a small set of environment variables, and
 * calls {@link startSwapNode}. The maker is an app behind a Rust connector's
 * route termination, so there is nothing connector-shaped left to configure
 * here: keys that configured the retired embedded `ConnectorNode`, the
 * kind:10032 announce or the BTP listener are **accepted and ignored with a
 * warning** rather than refused, so a committed fleet config written for
 * 2.x still boots (`CLAUDE.md` › "Config first, code second").
 */

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fromMnemonic, generateMnemonic, base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
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
  ilpAddress?: string;
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
  relayUrls: 'the maker no longer publishes a kind:10032 (connector ADR 0046)',
  btpServerPort: 'the maker no longer embeds a connector; its Rust connector listens',
  btpEndpoint: 'announced by the connector self-description, not the maker',
  advertisedAsset: 'the kind:10032 announce is gone',
  knownPeers: 'no embedded connector to peer',
  transport: 'no embedded connector to configure a transport for',
  connectorUrl: 'the maker does not dial a parent; a connector delivers to it',
  parentPeerId: 'no parent/child peer relation exists on the Rust connector',
  parentAuthToken: 'no parent/child peer relation exists on the Rust connector',
  parentEvmAddress: 'no parent/child peer relation exists on the Rust connector',
  nodeId: 'no embedded connector to name',
  peerInfoIlpDestination: 'the kind:10032 announce is gone',
  peerInfoPricePerByte: 'the kind:10032 announce is gone',
  peerInfoTtlSeconds: 'the kind:10032 announce is gone',
  peerInfoRefreshIntervalMs: 'the kind:10032 announce is gone',
  rolling: 'rolling/1 coupled legs are gone; see `quote` for the rolling/2 knobs',
  rollingLegBSender: 'leg B rides in the paid response, nothing is sent',
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

/** Retired keys present in `raw`, each with the reason it stopped mattering. */
export function retiredKeysIn(raw: CliRawConfig): { key: string; why: string }[] {
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
  if (raw.ilpAddress) cfg.ilpAddress = raw.ilpAddress;
  if (raw.fillAmount !== undefined) cfg.fillAmount = toBigInt(raw.fillAmount);
  if (raw.quote) cfg.quote = raw.quote;
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
  if (env['SWAP_ILP_ADDRESS']) out.ilpAddress = env['SWAP_ILP_ADDRESS'];
  if (env['SWAP_FILL_AMOUNT']) out.fillAmount = toBigInt(env['SWAP_FILL_AMOUNT']);
  if (env['SWAP_MAX_RATE_AGE']) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env['SWAP_MAX_RATE_AGE']);
    } catch {
      throw new Error(
        'SWAP_MAX_RATE_AGE must be valid JSON, e.g. {"defaultMs":3000,"perChain":{"mina":15000}}'
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
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
      if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
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
    if (typeof persisted.mnemonic !== 'string' || persisted.mnemonic.length === 0) {
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
  if (isAutogenEnabled(raw) && out.mnemonic === undefined && out.secretKey === undefined) {
    out.mnemonic = loadOrCreatePersistedMnemonic(resolveIdentityFilePath(out));
  }
  if (out.mnemonic === undefined) return out;

  const chains = out.chains.length > 0 ? out.chains : (['evm'] as const);
  const swapNodeKeys = await deriveSwapNodeKeys({
    mnemonic: out.mnemonic,
    chains: [...chains],
  });
  const identity = fromMnemonic(out.mnemonic);
  console.log(`[swap-node] identity pubkey (Nostr, index-0): ${identity.pubkey}`);
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

export class CliHelpRequested extends Error {
  constructor() {
    super('Usage: toon-swap --config <path>');
    this.name = 'CliHelpRequested';
  }
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
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: toon-swap --config <path>`);
    throw new CliHelpRequested();
  }

  const configPath = resolve(String(values.config ?? './swap.config.json'));
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as CliRawConfig;
  const parsed = parseRawConfig(raw);
  const overlaid = applyEnvOverlay(parsed);
  const config = installDefaultLogger(await resolveIdentityConfig(overlaid, raw));

  for (const { key, why } of retiredKeysIn(raw)) {
    config.logger?.warn?.('swap.config.retired_key_ignored', { key, why });
  }

  const instance = await startSwapNode(config);
  console.log(`Swap maker listening on http://localhost:${instance.appPort}`);
  console.log(
    `Route this maker behind your Rust connector: ` +
      `[[routes]] prefix="${instance.rfqDestination}" handler_url="http://<maker>:${instance.appPort}/swap/rfq" price=0 ; ` +
      `[[routes]] prefix="${instance.fillDestination}" handler_url="http://<maker>:${instance.appPort}/swap/fill" price=<fill size>`
  );
  console.log(`Quoting ${config.swapPairs.length} swap pair(s)`);
  return instance;
}

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
      if (error instanceof CliHelpRequested) process.exit(0);
      console.error('[swap-node] Startup error:', error);
      process.exit(1);
    });
}
