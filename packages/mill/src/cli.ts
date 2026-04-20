#!/usr/bin/env node

/**
 * CLI entrypoint for `@toon-protocol/mill` (Story 12.7 AC-9).
 *
 * Thin wrapper around `startMill()`. Reads a JSON config file and overlays
 * env-var overrides. Mirrors `packages/town/src/cli.ts`'s shape.
 *
 * Usage:
 *   toon-mill --config ./mill.config.json
 *
 * Environment variables (override config file):
 *   MILL_MNEMONIC          — BIP-39 mnemonic
 *   MILL_SECRET_KEY_HEX    — 64-char hex-encoded 32-byte secret key
 *   MILL_BLS_PORT          — numeric port for /health server
 *   MILL_RELAYS            — comma-separated relay WebSocket URLs
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startMill } from './mill.js';
import type { MillConfig, MillInstance } from './mill.js';

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
  relayUrls?: string[];
  blsPort?: number;
  passphrase?: string;
  knownPeers?: { ilpAddress: string; btpUrl?: string }[];
  // Story 12.7 Review Pass #1 additions — operator-surfaced kind:10032 fields.
  ilpAddress?: string;
  btpEndpoint?: string;
  advertisedAsset?: { assetCode: string; assetScale: number };
  // Ator/SOCKS5 transport overlay (Epic 35 integration).
  transport?: { type: string; socksProxy?: string; externalUrl?: string; managed?: boolean; managedOptions?: Record<string, unknown> };
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
 * maps consumed by `startMill()`.
 */
function assertSafeKey(key: string, scope: string): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(
      `Unsafe key "${key}" rejected in ${scope} (prototype pollution guard)`
    );
  }
}

function parseRawConfig(raw: CliRawConfig): MillConfig {
  // Normalize channels: string/number → bigint. Use null-prototype accumulators
  // to defend against prototype-pollution via crafted JSON input.
  const channels: MillConfig['channels'] = Object.create(
    null
  ) as MillConfig['channels'];
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

  const cfg: MillConfig = {
    swapPairs: (raw.swapPairs as MillConfig['swapPairs']) ?? [],
    chains: (raw.chains as MillConfig['chains']) ?? [],
    channels,
    inventory,
    relayUrls: raw.relayUrls ?? [],
  };
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
  if (raw.passphrase) cfg.passphrase = raw.passphrase;
  if (raw.knownPeers) cfg.knownPeers = raw.knownPeers;
  if (raw.ilpAddress) cfg.ilpAddress = raw.ilpAddress;
  if (raw.btpEndpoint) cfg.btpEndpoint = raw.btpEndpoint;
  if (raw.advertisedAsset) cfg.advertisedAsset = raw.advertisedAsset;
  if (raw.transport) cfg.transport = raw.transport as MillConfig['transport'];
  return cfg;
}

function applyEnvOverlay(cfg: MillConfig): MillConfig {
  const out = { ...cfg };
  const env = process.env;
  if (env['MILL_MNEMONIC']) {
    out.mnemonic = env['MILL_MNEMONIC'];
    delete out.secretKey;
  } else if (env['MILL_SECRET_KEY_HEX']) {
    const hex = env['MILL_SECRET_KEY_HEX'];
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MILL_SECRET_KEY_HEX must be a 64-char hex string');
    }
    out.secretKey = Uint8Array.from(Buffer.from(hex, 'hex'));
    delete out.mnemonic;
  }
  if (env['MILL_BLS_PORT']) {
    const p = parseInt(env['MILL_BLS_PORT'], 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error('MILL_BLS_PORT must be 0..65535');
    }
    out.blsPort = p;
  }
  if (env['MILL_RELAYS']) {
    out.relayUrls = env['MILL_RELAYS']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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
    super('Usage: toon-mill --config <path>');
    this.name = 'CliHelpRequested';
  }
}

export async function main(argv: string[]): Promise<MillInstance> {
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
    console.log(`Usage: toon-mill --config <path>`);
    throw new CliHelpRequested();
  }

  const configPath = resolve(String(values.config ?? './mill.config.json'));
  const rawText = readFileSync(configPath, 'utf-8');
  const raw = JSON.parse(rawText) as CliRawConfig;
  const parsed = parseRawConfig(raw);
  const config = applyEnvOverlay(parsed);

  const instance = await startMill(config);

  console.log(`Mill listening on http://localhost:${instance.blsPort}`);
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
        console.log(`\n[Mill] Received ${signal}; shutting down...`);
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
      console.error('[Mill] Startup error:', error);
      process.exit(1);
    });
}
