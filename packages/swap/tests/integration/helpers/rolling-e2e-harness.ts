/**
 * swap#50 — self-contained two-chain harness for the rolling-swap
 * settlement-batching e2e.
 *
 * Replaces (for this suite) the Docker harness that has been broken since
 * the monorepo extraction: `tests/e2e/helpers/infra-gate.ts` imports the
 * sdk repo's `tests/e2e/helpers/docker-e2e-setup.ts` from a sibling
 * checkout that does not exist here, and `scripts/sdk-e2e-infra.sh` was
 * never carried over (see swap#51's report). Rather than restoring
 * cross-repo imports, this harness is fully self-contained: it spawns its
 * own `anvil` instances (foundry is pinned in `devbox.json`, so the devbox
 * CI job has it) and rehydrates a vendored state snapshot.
 *
 * ## The vendored state snapshot
 *
 * `fixtures/rolling-e2e-anvil-state.hex` is an `anvil_dumpState` blob
 * (anvil 1.7.1, the devbox pin) captured from a fresh anvil after:
 *
 *   1. the connector repo's `packages/contracts` `DeployLocal.s.sol`
 *      broadcast (deployer = anvil account #0), which deploys at the
 *      deterministic addresses below:
 *        - MockERC20 "USD Coin"/USDC/6dp   at {@link USDC_TOKEN_ADDRESS}
 *        - TokenNetworkRegistry            at {@link TOKEN_NETWORK_REGISTRY_ADDRESS}
 *        - TokenNetwork (USDC)             at {@link TOKEN_NETWORK_ADDRESS}
 *      and funds anvil accounts #2/#3 with 10k USDC each;
 *   2. `transfer(account#1, 100_000 USDC)` from the deployer (the sender
 *      connector's settlement account);
 *   3. `forge create fixtures/RollingSwapChannel.sol` (deployer #0, nonce 4)
 *      at {@link ROLLING_SWAP_CHANNEL_ADDRESS} — the chain-B settlement
 *      surface the sdk's `buildSettlementTx()` EVM bundles target
 *      (`updateBalance(bytes32,uint256,uint256,address,bytes)`; see the
 *      .sol fixture for the byte-for-byte claim-format contract).
 *
 * To regenerate: check out toon-protocol/connector `packages/contracts`,
 * `git submodule update --init`, drop `fixtures/RollingSwapChannel.sol`
 * into its `src/`, run the three steps above against a fresh
 * `anvil --port <p> --chain-id 31337`, then `cast rpc anvil_dumpState`.
 *
 * The SAME blob is loaded into both anvils (chain ids differ per
 * instance): chain A uses the TokenNetwork/USDC surface, chain B uses the
 * RollingSwapChannel surface.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures'
);

// ---------------------------------------------------------------------------
// Deterministic deployment addresses (see module doc)
// ---------------------------------------------------------------------------

export const USDC_TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const TOKEN_NETWORK_REGISTRY_ADDRESS =
  '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const TOKEN_NETWORK_ADDRESS =
  '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
export const ROLLING_SWAP_CHANNEL_ADDRESS =
  '0x0165878A594ca255338adfa4d48449f69242Eb8F';

// ---------------------------------------------------------------------------
// Anvil deterministic accounts used by this suite
// ---------------------------------------------------------------------------

/** Account #0 — the MAKER connector's settlement/treasury key (chain A). */
export const MAKER_EVM_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const MAKER_EVM_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Account #1 — the SENDER connector's settlement key (chain A). */
export const SENDER_EVM_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const SENDER_EVM_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** Account #5 — gas payer submitting the chain-B settlement (never a party). */
export const SETTLE_SUBMITTER_PRIVATE_KEY =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

// ---------------------------------------------------------------------------
// Availability gate
// ---------------------------------------------------------------------------

/** True when the `anvil` binary is on PATH (devbox pins foundry 1.7.1). */
export function isAnvilAvailable(): boolean {
  try {
    const res = spawnSync('anvil', ['--version'], { timeout: 5_000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client
// ---------------------------------------------------------------------------

let rpcId = 1;

export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const json = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message}`);
  }
  return json.result as T;
}

// ---------------------------------------------------------------------------
// Anvil lifecycle
// ---------------------------------------------------------------------------

export interface AnvilInstance {
  rpcUrl: string;
  chainId: number;
  stop: () => Promise<void>;
}

/**
 * Spawn an anvil on `port` with `chainId` and rehydrate the vendored state
 * snapshot via `anvil_loadState` (the dump-blob format is accepted by the
 * RPC on any chain id; `--load-state` insists on its own JSON layout).
 */
export async function startAnvil(params: {
  port: number;
  chainId: number;
}): Promise<AnvilInstance> {
  const rpcUrl = `http://127.0.0.1:${params.port}`;
  const child: ChildProcess = spawn(
    'anvil',
    [
      '--port',
      String(params.port),
      '--chain-id',
      String(params.chainId),
      '--silent',
    ],
    { stdio: 'ignore' }
  );
  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode === null) child.kill('SIGKILL');
  };

  // Wait for the RPC to come up.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const id = await rpc<string>(rpcUrl, 'eth_chainId');
      if (parseInt(id, 16) === params.chainId) break;
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`anvil on :${params.port} did not come up in 15s`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const blob = readFileSync(
    join(FIXTURES_DIR, 'rolling-e2e-anvil-state.hex'),
    'utf8'
  ).trim();
  const loaded = await rpc<boolean>(rpcUrl, 'anvil_loadState', [blob]);
  if (loaded !== true) {
    await stop();
    throw new Error('anvil_loadState rejected the vendored state blob');
  }
  return { rpcUrl, chainId: params.chainId, stop };
}

// ---------------------------------------------------------------------------
// Chain helpers (no client lib — raw RPC with anvil's unlocked accounts)
// ---------------------------------------------------------------------------

/** `eth_sendTransaction` from an anvil-unlocked account + wait for receipt. */
export async function sendUnlockedTx(
  rpcUrl: string,
  tx: {
    from: string;
    to: string;
    data?: string;
    value?: bigint;
    gas?: bigint;
  }
): Promise<{ transactionHash: string; status: string }> {
  const hash = await rpc<string>(rpcUrl, 'eth_sendTransaction', [
    {
      from: tx.from,
      to: tx.to,
      ...(tx.data && { data: tx.data }),
      ...(tx.value !== undefined && { value: '0x' + tx.value.toString(16) }),
      gas: '0x' + (tx.gas ?? 1_000_000n).toString(16),
    },
  ]);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const receipt = await rpc<{ status: string } | null>(
      rpcUrl,
      'eth_getTransactionReceipt',
      [hash]
    );
    if (receipt) {
      if (receipt.status !== '0x1') {
        throw new Error(`tx ${hash} reverted (status ${receipt.status})`);
      }
      return { transactionHash: hash, status: receipt.status };
    }
    if (Date.now() > deadline) throw new Error(`tx ${hash} not mined in 15s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

export async function getLogs(
  rpcUrl: string,
  filter: { address: string; topic0?: string }
): Promise<EthLog[]> {
  return rpc<EthLog[]>(rpcUrl, 'eth_getLogs', [
    {
      fromBlock: '0x0',
      toBlock: 'latest',
      address: filter.address,
      ...(filter.topic0 && { topics: [filter.topic0] }),
    },
  ]);
}

/** Left-pad a hex quantity (no 0x) to 32 bytes. */
export function pad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, '0');
}

export function encodeCall(selector: string, words: string[]): string {
  return '0x' + selector + words.join('');
}

/** Poll until `probe` resolves truthy or the deadline passes. */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${opts.label}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
}
