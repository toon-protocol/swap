/**
 * swap#104 — self-contained infra gate for the Docker cross-chain E2E suites.
 *
 * Replaces the dead cross-repo re-export (`../../../../sdk/tests/e2e/
 * helpers/docker-e2e-setup.js`, a `packages/sdk` sibling that has not
 * existed in this repo since the monorepo extraction — swap#51) with
 * constants and readiness probes for the self-contained harness booted by
 * `global-setup.ts`: a vendored-fixture Anvil, an in-process Nostr relay,
 * and an in-process peer1 `startSwapNode()` instance. See
 * `tests/e2e/README.md` for the full topology and how to extend it to
 * Solana / Mina.
 *
 * ## EVM vs Solana/Mina readiness
 *
 * `checkAllServicesReady()` gates ONLY the self-contained EVM leg (Anvil +
 * relay + peer1) — this repo owns that infra outright (it boots it
 * in-process; a devbox `anvil` install is the only external requirement),
 * so a failure there is a real regression. Solana and Mina need external
 * infra this repo does not vendor (`solana-test-validator`, Mina
 * lightnet) — `waitForSolanaHealth()` / `waitForMinaHealth()` probe
 * operator-supplied endpoints and are never treated as a harness
 * regression; see `skipIfNotReady()`.
 */

import { createPublicClient, http, type Chain } from 'viem';

import {
  USDC_TOKEN_ADDRESS,
  TOKEN_NETWORK_REGISTRY_ADDRESS,
  TOKEN_NETWORK_ADDRESS as ROLLING_TOKEN_NETWORK_ADDRESS,
  SENDER_EVM_PRIVATE_KEY,
  SENDER_EVM_ADDRESS,
  MAKER_EVM_ADDRESS,
} from '../../integration/helpers/rolling-e2e-harness.js';
import {
  ANVIL_CHAIN_ID,
  ANVIL_RPC,
  RELAY_URL,
  PEER1_BTP_URL,
  PEER1_BLS_URL,
} from './topology.js';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export { ANVIL_RPC };
export const PEER1_RELAY_URL = RELAY_URL;
export { PEER1_BTP_URL };
export const PEER1_EVM_ADDRESS = MAKER_EVM_ADDRESS;

/**
 * Solana / Mina endpoints. These literal defaults are asserted verbatim by
 * `docker-swap-flow-solana-e2e.test.ts` / `docker-swap-flow-mina-e2e.test.ts`
 * (config-drift guards) — only reached once `waitForSolanaHealth()` /
 * `waitForMinaHealth()` report ready, i.e. once an operator has actually
 * brought up the matching infra (see `tests/e2e/README.md`) and overridden
 * `SOLANA_E2E_PROGRAM_ID` / `MINA_E2E_ZKAPP_ADDRESS`.
 */
export const SOLANA_RPC =
  process.env['SOLANA_E2E_RPC_URL'] || 'http://localhost:19899';
export const SOLANA_PROGRAM_ID = process.env['SOLANA_E2E_PROGRAM_ID'] || '';
export const MINA_GRAPHQL =
  process.env['MINA_E2E_GRAPHQL_URL'] || 'http://localhost:19085/graphql';
export const MINA_ZKAPP_ADDRESS = process.env['MINA_E2E_ZKAPP_ADDRESS'] || '';
const MINA_ACCOUNTS_MANAGER =
  process.env['MINA_E2E_ACCOUNTS_MANAGER_URL'] || '';

// ---------------------------------------------------------------------------
// Contracts / chain id
// ---------------------------------------------------------------------------

export const TOKEN_ADDRESS = USDC_TOKEN_ADDRESS;
export const TOKEN_NETWORK_ADDRESS = ROLLING_TOKEN_NETWORK_ADDRESS;
export const REGISTRY_ADDRESS = TOKEN_NETWORK_REGISTRY_ADDRESS;
export const CHAIN_ID = ANVIL_CHAIN_ID;

const anvilChain: Chain = {
  id: CHAIN_ID,
  name: 'anvil-e2e',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
};

export function createViemClient() {
  return createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
}

// ---------------------------------------------------------------------------
// swap-node-E2E EVM sender key (Anvil account #1 — see rolling-e2e-harness.ts
// for the full account allocation: #0 is peer1's settlement key)
// ---------------------------------------------------------------------------

export const SWAP_E2E_EVM_SENDER_PRIVATE_KEY = SENDER_EVM_PRIVATE_KEY as `0x${string}`;
export const SWAP_E2E_EVM_SENDER_ADDRESS = SENDER_EVM_ADDRESS as `0x${string}`;

/**
 * No persistent/public-testnet mode exists in this self-contained harness
 * (local Anvil only) — pass the configured key straight through. Kept as a
 * function (rather than inlining `SWAP_E2E_EVM_SENDER_PRIVATE_KEY` at each
 * call site) so a future public-mode harness can slot in a real
 * just-in-time-funded-key implementation without changing callers.
 */
export async function publicModeSettlementKey(
  privateKey: `0x${string}`
): Promise<string> {
  return privateKey;
}

// ---------------------------------------------------------------------------
// Chain-string constants (peer1's advertised swap pairs — see peer-node.ts)
// ---------------------------------------------------------------------------

export const DOCKER_CHAIN_EVM = `evm:base:${CHAIN_ID}` as const;
export const DOCKER_CHAIN_SOLANA = 'solana:devnet' as const;
export const DOCKER_CHAIN_MINA = 'mina:devnet' as const;

export const DOCKER_CHAINS = [
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_SOLANA,
  DOCKER_CHAIN_MINA,
] as const;

export type DockerChain = (typeof DOCKER_CHAINS)[number];

/** All 9 ordered (source, target) pairs. AC-9 coverage target. */
export const DOCKER_PAIR_MATRIX: readonly {
  from: DockerChain;
  to: DockerChain;
}[] = Object.freeze(
  DOCKER_CHAINS.flatMap((from) => DOCKER_CHAINS.map((to) => ({ from, to })))
);

// ---------------------------------------------------------------------------
// Readiness probes
// ---------------------------------------------------------------------------

async function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeAnvil(timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(ANVIL_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string };
    return parseInt(json.result ?? '0x0', 16) === ANVIL_CHAIN_ID;
  } catch {
    return false;
  }
}

async function probeRelay(timeoutMs: number): Promise<boolean> {
  const { default: WebSocket } = await import('ws');
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const ws = new WebSocket(PEER1_RELAY_URL);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, timeoutMs);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
    ws.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function probePeer1(timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${PEER1_BLS_URL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string };
    return json.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * True once the self-contained EVM core (Anvil + relay + peer1) is up.
 * Memoized for the lifetime of the test process — `vitest.e2e.config.ts`
 * sets `isolate: false` specifically so this cache (and the underlying
 * booted infra from `global-setup.ts`) is shared across all four suite
 * files instead of being re-probed per file.
 */
let cachedCoreReady: Promise<boolean> | null = null;
/** Last observed core-readiness — drives `skipIfNotReady()`'s CI-fail path. */
let lastCoreReady = true;

async function probeCore(): Promise<boolean> {
  const [anvilOk, relayOk, peer1Ok] = await Promise.all([
    probeAnvil(3000),
    probeRelay(3000),
    probePeer1(3000),
  ]);
  const ready = anvilOk && relayOk && peer1Ok;
  lastCoreReady = ready;
  return ready;
}

export function checkAllServicesReady(): Promise<boolean> {
  if (!cachedCoreReady) cachedCoreReady = probeCore();
  return cachedCoreReady;
}

/**
 * The original two-peer Docker topology (peer1 + peer2) used peer2 purely
 * as a readiness signal — none of the four suites assert anything about a
 * distinct peer2 identity or behavior (grep confirms `waitForPeer2Bootstrap`
 * is only ever used as a boolean gate). This self-contained harness has one
 * peer, so this is an alias for the same core-readiness check rather than a
 * second boot.
 */
export async function waitForPeer2Bootstrap(_timeoutMs: number): Promise<boolean> {
  return checkAllServicesReady();
}

let warnedSolana = false;
let warnedMina = false;

export async function waitForSolanaHealth(timeoutMs: number): Promise<boolean> {
  if (!process.env['SOLANA_E2E_RPC_URL']) {
    if (!warnedSolana) {
      warnedSolana = true;
      console.warn(
        '[swap e2e] Solana infra not configured — set SOLANA_E2E_RPC_URL ' +
          '(and SOLANA_E2E_PROGRAM_ID) to a running solana-test-validator ' +
          'to exercise solana:devnet suites. See tests/e2e/README.md.'
      );
    }
    return false;
  }
  return probeHttp(SOLANA_RPC, timeoutMs);
}

export async function waitForMinaHealth(timeoutMs: number): Promise<boolean> {
  if (!process.env['MINA_E2E_GRAPHQL_URL']) {
    if (!warnedMina) {
      warnedMina = true;
      console.warn(
        '[swap e2e] Mina infra not configured — set MINA_E2E_GRAPHQL_URL ' +
          '(and MINA_E2E_ZKAPP_ADDRESS, MINA_E2E_ACCOUNTS_MANAGER_URL) to a ' +
          'running Mina lightnet to exercise mina:devnet suites. See ' +
          'tests/e2e/README.md.'
      );
    }
    return false;
  }
  return probeHttp(MINA_GRAPHQL, timeoutMs);
}

export async function acquireMinaAccount(): Promise<{ pk: string; sk: string } | null> {
  if (!MINA_ACCOUNTS_MANAGER) return null;
  try {
    const res = await fetch(`${MINA_ACCOUNTS_MANAGER}/acquire-account`, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { pk: string; sk: string };
  } catch {
    return null;
  }
}

export async function releaseMinaAccount(pk: string): Promise<void> {
  if (!MINA_ACCOUNTS_MANAGER) return;
  try {
    await fetch(`${MINA_ACCOUNTS_MANAGER}/release-account`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pk }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    /* best-effort release */
  }
}

let warnedSkip = false;

/**
 * AC-2: skip (return `true`) when infra isn't ready, EXCEPT under CI when
 * the failure is attributable to the self-contained EVM core this harness
 * owns and boots itself — that's a real regression (this repo's `anvil` is
 * devbox-pinned and CI-installed), so it fails loud instead of masking the
 * gap as a pass-via-skip. Solana/Mina unreadiness never fails CI: nothing
 * in this repo's CI provisions those chains today, so it is an expected,
 * permanent condition rather than a regression signal.
 */
export function skipIfNotReady(ready: boolean): boolean {
  if (ready) return false;
  if (process.env['CI'] && !lastCoreReady) {
    throw new Error(
      '[swap e2e] Self-contained EVM infra (Anvil + relay + peer1) did not ' +
        'come up under CI — this is this harness\'s own responsibility ' +
        '(devbox pins `anvil`). Check the global-setup logs rather than ' +
        'silently skipping. See tests/e2e/README.md.'
    );
  }
  if (!warnedSkip) {
    warnedSkip = true;
    console.warn(
      '[swap e2e] Infra not ready — skipping. Run with `anvil` on PATH ' +
        '(`devbox run -- pnpm --filter @toon-protocol/swap test:e2e:docker`) ' +
        'for the self-contained EVM suites, or see tests/e2e/README.md to ' +
        'bring up Solana/Mina infra too.'
    );
  }
  return true;
}
