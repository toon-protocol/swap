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
import WebSocket from 'ws';

import {
  USDC_TOKEN_ADDRESS,
  TOKEN_NETWORK_REGISTRY_ADDRESS,
  TOKEN_NETWORK_ADDRESS as ROLLING_TOKEN_NETWORK_ADDRESS,
  ROLLING_SWAP_CHANNEL_ADDRESS,
  SENDER_EVM_PRIVATE_KEY,
  SENDER_EVM_ADDRESS,
  MAKER_EVM_ADDRESS,
} from '../../integration/helpers/rolling-e2e-harness.js';
import {
  ANVIL_CHAIN_ID,
  ANVIL_RPC,
  ANVIL_B_CHAIN_ID,
  ANVIL_B_RPC,
  EVM_CHAIN_PREFIX,
  RELAY_URL,
  PEER1_BTP_URL,
  PEER1_BLS_URL,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  SOLANA_CHAIN,
  SOLANA_PROGRAM_ID as SOLANA_LOCAL_PROGRAM_ID,
  SOLANA_RPC_URL,
  SOLANA_USDC_MINT,
} from './topology.js';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export { ANVIL_RPC, ANVIL_B_RPC };
export const PEER1_RELAY_URL = RELAY_URL;
export { PEER1_BTP_URL };
export { PEER1_NOSTR_PUBKEY };
export { PEER1_ILP_ADDRESS };
export const PEER1_EVM_ADDRESS = MAKER_EVM_ADDRESS;

/**
 * Solana endpoints (swap#160).
 *
 * These now default to the harness's OWN validator — `global-setup.ts` boots a
 * real `solana-test-validator` with the vendored payment-channel program baked
 * into genesis, so there is nothing for an operator to bring up and nothing to
 * export. The env vars survive as overrides for pointing the suites at an
 * externally-managed validator; the literal defaults are asserted verbatim by
 * the Solana suites as config-drift guards.
 *
 * `SOLANA_PROGRAM_ID` used to default to the empty string (no deployment
 * existed), which is why `S-2` had to assert it was non-empty before it could
 * build a settlement bundle. It now names the address `solana-validator.ts`
 * loads the program at.
 */
export const SOLANA_RPC = process.env['SOLANA_E2E_RPC_URL'] || SOLANA_RPC_URL;
export const SOLANA_PROGRAM_ID =
  process.env['SOLANA_E2E_PROGRAM_ID'] || SOLANA_LOCAL_PROGRAM_ID;
/** The mock USDC SPL mint the seeded Solana channels settle in. */
export const SOLANA_TOKEN_MINT =
  process.env['SOLANA_E2E_TOKEN_MINT'] || SOLANA_USDC_MINT;

/**
 * Mina endpoints. Unlike Solana, still operator-supplied: this repo vendors no
 * lightnet (see `tests/e2e/README.md`).
 */
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
export const CHAIN_B_ID = ANVIL_B_CHAIN_ID;
/** Leg-B settlement contract — the same deterministic deployment on both anvils. */
export const ROLLING_CHANNEL_ADDRESS = ROLLING_SWAP_CHANNEL_ADDRESS;

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

export const SWAP_E2E_EVM_SENDER_PRIVATE_KEY =
  SENDER_EVM_PRIVATE_KEY as `0x${string}`;
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

export const DOCKER_CHAIN_EVM = `${EVM_CHAIN_PREFIX}${CHAIN_ID}` as const;
/**
 * The SECOND EVM chain (swap#153) — a distinct chain id on a distinct anvil
 * with its own `RollingSwapChannel` deployment and therefore its own EIP-712
 * domain. `DOCKER_CHAIN_EVM → DOCKER_CHAIN_EVM_B` is the only pair in this
 * harness that crosses a chain boundary without operator-supplied infra.
 */
export const DOCKER_CHAIN_EVM_B = `${EVM_CHAIN_PREFIX}${CHAIN_B_ID}` as const;
export const DOCKER_CHAIN_SOLANA = SOLANA_CHAIN;
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
// The ROLLING matrix (swap#153)
// ---------------------------------------------------------------------------

/**
 * The rolling matrix adds the second EVM chain, so it is 4 chains and 16
 * ordered pairs rather than the legacy 3 and 9. That is deliberate: the extra
 * chain is the one pair in this harness that crosses a chain boundary WITHOUT
 * operator-supplied infra, so it is the one that actually executes in CI.
 */
export const ROLLING_CHAINS = [
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_EVM_B,
  DOCKER_CHAIN_SOLANA,
  DOCKER_CHAIN_MINA,
] as const;

export type RollingChain = (typeof ROLLING_CHAINS)[number];

export const ROLLING_PAIR_MATRIX: readonly {
  from: RollingChain;
  to: RollingChain;
}[] = Object.freeze(
  ROLLING_CHAINS.flatMap((from) => ROLLING_CHAINS.map((to) => ({ from, to })))
);

/**
 * The pairs peer1 actually advertises (`peer-node.ts`). A rolling RFQ for a
 * pair outside this set is REFUSED — `unsupported_pair` — which is a stronger
 * statement than "skipped": the maker is asserted to say no rather than
 * quietly quoting something it cannot deliver.
 */
export const PEER1_ADVERTISED_PAIRS: ReadonlySet<string> = new Set([
  `${DOCKER_CHAIN_EVM}->${DOCKER_CHAIN_EVM}`,
  `${DOCKER_CHAIN_EVM}->${DOCKER_CHAIN_EVM_B}`,
  // swap#160 — peer1 advertises a pair across a chain FAMILY boundary as soon
  // as `global-setup.ts` has a validator to back it. Note the ARROW: only
  // `evm → solana`.
  //
  // `solana → evm` is deliberately NOT here, and must not be added. Nothing
  // stops the maker QUOTING it, but the harness sender pays leg A through its
  // connector's `PerPacketClaimService`, which can only sign against an EVM
  // channel — so the maker would be paid in EVM for a pair whose `from.chain`
  // says Solana, and it never checks one against the other. The swap would
  // "complete" and the test would be a lie. `S-4` in
  // `docker-rolling-swap-solana-e2e.test.ts` asserts the refusal instead, and
  // records what it would take to make the direction real.
  `${DOCKER_CHAIN_EVM}->${DOCKER_CHAIN_SOLANA}`,
]);

export function peer1AdvertisesPair(from: string, to: string): boolean {
  return PEER1_ADVERTISED_PAIRS.has(`${from}->${to}`);
}

// ---------------------------------------------------------------------------
// Readiness probes
// ---------------------------------------------------------------------------

/**
 * POST a JSON body and decode the response, or `null` for any failure
 * (transport error, timeout, non-2xx, undecodable body). Every chain probe
 * below is a POST-only endpoint — a bare GET 404s regardless of health
 * (PR #106 review finding #4).
 */
async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** `getHealth` — the smallest real request solana-test-validator accepts. */
async function probeSolanaRpc(
  url: string,
  timeoutMs: number
): Promise<boolean> {
  const json = await postJson<{ result?: string }>(
    url,
    { jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] },
    timeoutMs
  );
  return json?.result === 'ok';
}

/** `{ syncStatus }` — the smallest real query a Mina lightnet accepts. */
async function probeMinaGraphql(
  url: string,
  timeoutMs: number
): Promise<boolean> {
  const json = await postJson<{ data?: { syncStatus?: string } }>(
    url,
    { query: '{ syncStatus }' },
    timeoutMs
  );
  return typeof json?.data?.syncStatus === 'string';
}

async function probeAnvilAt(
  rpcUrl: string,
  chainId: number,
  timeoutMs: number
): Promise<boolean> {
  const json = await postJson<{ result?: string }>(
    rpcUrl,
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    timeoutMs
  );
  if (!json) return false;
  return parseInt(json.result ?? '0x0', 16) === chainId;
}

function probeRelay(timeoutMs: number): Promise<boolean> {
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
  const [anvilOk, anvilBOk, relayOk, peer1Ok] = await Promise.all([
    probeAnvilAt(ANVIL_RPC, ANVIL_CHAIN_ID, 3000),
    probeAnvilAt(ANVIL_B_RPC, ANVIL_B_CHAIN_ID, 3000),
    probeRelay(3000),
    probePeer1(3000),
  ]);
  const ready = anvilOk && anvilBOk && relayOk && peer1Ok;
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
export async function waitForPeer2Bootstrap(
  _timeoutMs: number
): Promise<boolean> {
  return checkAllServicesReady();
}

let warnedSolana = false;
let warnedMina = false;

/** Last observed Solana readiness — drives `skipIfNotReady()`'s hard-fail. */
let lastSolanaReady = false;

/**
 * True once the harness's `solana-test-validator` is serving (swap#160).
 *
 * No longer gated on an env var. `global-setup.ts` boots the validator itself,
 * so the only honest question is whether the RPC answers — exactly the shape
 * of the anvil probes. Memoized like the EVM core: the validator is booted once
 * per run and shared across every suite file, and the pair-matrix suite
 * otherwise pays the probe cost again for every Solana-touching pair.
 */
let cachedSolanaReady: Promise<boolean> | null = null;

async function probeSolana(timeoutMs: number): Promise<boolean> {
  const ready = await probeSolanaRpc(SOLANA_RPC, timeoutMs);
  lastSolanaReady = ready;
  if (!ready && !warnedSolana) {
    warnedSolana = true;
    console.warn(
      `[swap e2e] No Solana validator at ${SOLANA_RPC} — solana:devnet ` +
        'suites will skip. `global-setup.ts` boots one automatically when ' +
        '`solana-test-validator` + `spl-token` are on PATH (install: ' +
        'https://release.anza.xyz/v2.1.21/install); CI does this in the ' +
        '`solana-e2e` job. See tests/e2e/README.md.'
    );
  }
  return ready;
}

export function waitForSolanaHealth(timeoutMs: number): Promise<boolean> {
  if (!cachedSolanaReady) cachedSolanaReady = probeSolana(timeoutMs);
  return cachedSolanaReady;
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
  return probeMinaGraphql(MINA_GRAPHQL, timeoutMs);
}

export async function acquireMinaAccount(): Promise<{
  pk: string;
  sk: string;
} | null> {
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
 * AC-2: skip (return `true`) when infra isn't ready, EXCEPT when the failure is
 * attributable to infra this harness owns and boots itself — then it fails
 * loud instead of masking the gap as a pass-via-skip.
 *
 * Two such cases:
 *
 * - the self-contained EVM core, under `CI` (this repo's `anvil` is
 *   devbox-pinned and CI-installed, so its absence there is a regression);
 * - Solana, under `SWAP_E2E_REQUIRE_SOLANA` (swap#160). The `solana-e2e` CI job
 *   installs the Solana CLI and `global-setup.ts` boots the validator from a
 *   vendored program, so in THAT job a skip would mean the thing the job exists
 *   to run did not run — which is precisely the pass-via-skip this harness has
 *   been bitten by twice. Every other context (a plain `devbox` job, a laptop
 *   without the CLI) still skips with the warning `probeSolana()` logs.
 *
 * Mina unreadiness never fails: nothing provisions a lightnet, so it is an
 * expected, permanent condition rather than a regression signal.
 */
export function skipIfNotReady(ready: boolean): boolean {
  if (ready) return false;
  if (process.env['CI'] && !lastCoreReady) {
    throw new Error(
      '[swap e2e] Self-contained EVM infra (Anvil + relay + peer1) did not ' +
        "come up under CI — this is this harness's own responsibility " +
        '(devbox pins `anvil`). Check the global-setup logs rather than ' +
        'silently skipping. See tests/e2e/README.md.'
    );
  }
  if (process.env['SWAP_E2E_REQUIRE_SOLANA'] && !lastSolanaReady) {
    throw new Error(
      '[swap e2e] SWAP_E2E_REQUIRE_SOLANA is set but no Solana validator is ' +
        `serving at ${SOLANA_RPC}. This harness boots its own: it needs ` +
        '`solana-test-validator` + `solana` + `spl-token` on PATH and the ' +
        'vendored program at tests/e2e/fixtures/solana/payment_channel.so. ' +
        'Check the global-setup logs for the reason it did not come up — ' +
        'skipping here would report a pass for a suite that never ran.'
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
