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
 *   TOON_CONNECTOR_URL     — parent BTP URL; activates embedded-with-parent mode
 *   TOON_PARENT_PEER_ID    — peer id for the parent (default: "apex")
 *   TOON_PARENT_AUTH_TOKEN — BTP auth token for the parent peer (default: "")
 *   TOON_ILP_ADDRESS       — advertised ILP address + self-route prefix
 *   TOON_NODE_ID           — connector nodeId override (default: toon-swap-<pk16>)
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';

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
  btpServerPort?: number;
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

  const cfg: SwapNodeConfig = {
    swapPairs: (raw.swapPairs as SwapNodeConfig['swapPairs']) ?? [],
    chains: (raw.chains as SwapNodeConfig['chains']) ?? [],
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
  if (raw.btpServerPort !== undefined) cfg.btpServerPort = raw.btpServerPort;
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
  const config = applyEnvOverlay(parsed);

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
