/**
 * Issue #141 end-to-end through `startSwapNode()`: a Solana maker recycles
 * its capacity from chain truth, exactly like the EVM maker of #138.
 *
 * This is the Solana twin of `swap-node.inventory-recycle.test.ts`. It drives
 * the real `MultiChainClaimIssuer` the node built (via `onClaimIssuerBuilt`)
 * and the real `createSolanaChannelOnChainReader` the node wired from
 * `chainProviders` — pointed at a minimal in-process JSON-RPC server standing
 * in for the cluster — so the wiring under test is the deployed one, not a
 * stand-in. Before #141 the node built NO reader for a Solana chain, so
 * `reconciler.enabled` was `false`, `unsettled` only grew, and `free` walked
 * to zero however faithfully the counterparty redeemed.
 *
 * The three safety invariants #138 established are asserted here per family:
 * only a watermark READ FROM CHAIN moves anything, the per-channel watermark
 * is monotone, and `available` never exceeds `total`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type {
  SwapNodeSolanaChainProvider,
  SwapNodeInstance,
} from './swap-node.js';
import { deriveSwapNodeKeys } from './wallet.js';
import type { MultiChainClaimIssuer } from './claim-issuer.js';
import type { AdminInventoryReport } from './admin-surface.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SOLANA_CHAIN = 'solana:devnet';
const ASSET = 'USDC';
const RAW_PROGRAM = new Uint8Array(32).fill(9);
const RAW_COUNTERPARTY = new Uint8Array(32).fill(2);
const PROGRAM_ID = base58Encode(RAW_PROGRAM);
/** A Solana channelId IS the channel PDA's base58 address. */
const CHANNEL_ID = base58Encode(new Uint8Array(32).fill(7));
const RECIPIENT = base58Encode(new Uint8Array(32).fill(3));
const SENDER = 'a'.repeat(64);
const START_INVENTORY = 1_000_000n;
const SWAP_AMOUNT = 4_000n;
const ADMIN_TOKEN = 'operator-secret';

/** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

function firstPool(report: AdminInventoryReport) {
  return must(report.pools[0], 'pool view');
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

/**
 * `getAccountInfo`-only JSON-RPC server serving a channel PDA account whose
 * MUTABLE `chain.transferredAmountOurs` slot the test moves to simulate the
 * counterparty redeeming on chain. `chain.exists === false` serves the
 * account-not-found answer a never-opened (or settled-and-closed) channel
 * gives.
 */
async function startFakeSolanaRpc(
  chain: { transferredAmountOurs: bigint; exists: boolean },
  ourPubkeyBytes: Uint8Array
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number };
      let value: unknown = null;
      if (chain.exists) {
        const data = new Uint8Array(178);
        data.set(new TextEncoder().encode('pchannel'), 0);
        data.set(ourPubkeyBytes, 8); // participant_a — that's us
        data.set(RAW_COUNTERPARTY, 40); // participant_b
        let v = chain.transferredAmountOurs;
        for (let i = 0; i < 8; i++) {
          data[120 + i] = Number(v & 0xffn); // transferred_amount_a
          v >>= 8n;
        }
        value = {
          data: [Buffer.from(data).toString('base64'), 'base64'],
          owner: PROGRAM_ID,
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: json.id,
          result: { context: { slot: 1 }, value },
        })
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** The node's own Solana address — the participant slot the reader must read. */
async function ourSolanaPubkey(): Promise<Uint8Array> {
  const keys = await deriveSwapNodeKeys({
    mnemonic: VALID_MNEMONIC,
    chains: ['solana'],
  });
  return must(keys.solana, 'a derived Solana key').publicKey;
}

async function bootMaker(rpcUrl: string): Promise<{
  instance: SwapNodeInstance;
  issuer: MultiChainClaimIssuer;
}> {
  let issuer: MultiChainClaimIssuer | undefined;
  const solanaProvider: SwapNodeSolanaChainProvider = {
    chainType: 'solana',
    chainId: SOLANA_CHAIN,
    rpcUrl,
    programId: PROGRAM_ID,
    tokenMint: 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H',
  };
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    blsPort: 0,
    chains: ['solana'],
    adminToken: ADMIN_TOKEN,
    // No periodic timer: every pass in this test is explicit.
    reconcileIntervalMs: 0,
    swapPairs: [
      {
        from: { assetCode: ASSET, assetScale: 6, chain: SOLANA_CHAIN },
        to: { assetCode: ASSET, assetScale: 6, chain: SOLANA_CHAIN },
        rate: '1.0',
      },
    ],
    channels: {
      [SOLANA_CHAIN]: [
        {
          channelId: CHANNEL_ID,
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [SOLANA_CHAIN]: START_INVENTORY },
    chainProviders: [solanaProvider],
    __testHooks: {
      onClaimIssuerBuilt: (ci) => {
        issuer = ci;
      },
    },
  });
  if (!issuer) throw new Error('onClaimIssuerBuilt was never called');
  // `startSwapNode` fires a boot reconcile pass fire-and-forget (a slow RPC
  // must never block boot). Wait for it to land before the test starts moving
  // the fake chain, so a pass reading the OLD value can't arrive mid-scenario.
  await awaitBootReconcile(instance);
  return { instance, issuer };
}

/** Poll the operator surface until the boot reconcile pass has completed. */
async function awaitBootReconcile(instance: SwapNodeInstance): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const report = await readAdminReport(instance);
    if (report.reconciler.lastRunAt !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('boot reconcile pass never completed');
}

async function issueOneClaim(issuer: MultiChainClaimIssuer): Promise<void> {
  const claim = await issuer.issueClaim({
    sourceAmount: SWAP_AMOUNT,
    targetAmount: SWAP_AMOUNT,
    pair: {
      from: { assetCode: ASSET, assetScale: 6, chain: SOLANA_CHAIN },
      to: { assetCode: ASSET, assetScale: 6, chain: SOLANA_CHAIN },
      rate: '1.0',
    },
    senderPubkey: SENDER,
    chainRecipient: RECIPIENT,
    rumor: {},
  } as Parameters<MultiChainClaimIssuer['issueClaim']>[0]);
  expect(claim.claim).toBeInstanceOf(Uint8Array);
}

async function readAdminReport(
  instance: SwapNodeInstance
): Promise<AdminInventoryReport> {
  const res = await fetch(
    `http://127.0.0.1:${instance.blsPort}/admin/inventory`
  );
  expect(res.status).toBe(200);
  return (await res.json()) as AdminInventoryReport;
}

describe('issue #141 — a Solana maker recycles capacity from chain truth', () => {
  it('[P0] the redeemed value comes back, exactly once; before the fix nothing observed the redemption', async () => {
    const chain = { transferredAmountOurs: 0n, exists: true };
    const rpcUrl = await startFakeSolanaRpc(chain, await ourSolanaPubkey());
    const { instance, issuer } = await bootMaker(rpcUrl);
    try {
      await issueOneClaim(issuer);

      // Held as liability; `available` (the real capital) is untouched.
      const held = firstPool(await readAdminReport(instance));
      expect(held.available).toBe(START_INVENTORY.toString());
      expect(held.unsettled).toBe(SWAP_AMOUNT.toString());
      expect(held.free).toBe((START_INVENTORY - SWAP_AMOUNT).toString());

      // The counterparty redeems on chain.
      chain.transferredAmountOurs = SWAP_AMOUNT;
      const result = await instance.reconcileInventory();
      expect(result.errors).toEqual([]);
      // EXACTLY the redeemed amount, not a rounded or doubled figure.
      expect(must(result.pools[0], 'pool totals').liabilityReduced).toBe(
        SWAP_AMOUNT
      );

      const after = firstPool(await readAdminReport(instance));
      expect(after.unsettled).toBe('0');
      expect(after.free).toBe(START_INVENTORY.toString());
      expect(after.issuanceBlocked).toBe(false);
      expect(after.channels[0]).toMatchObject({
        channelId: CHANNEL_ID,
        issued: SWAP_AMOUNT.toString(),
        redeemedOnChain: SWAP_AMOUNT.toString(),
        unredeemed: '0',
      });
    } finally {
      await instance.stop();
    }
  });

  it('[P0] the per-channel watermark is MONOTONE — re-reading the same chain value credits nothing', async () => {
    const chain = { transferredAmountOurs: 0n, exists: true };
    const rpcUrl = await startFakeSolanaRpc(chain, await ourSolanaPubkey());
    const { instance, issuer } = await bootMaker(rpcUrl);
    try {
      await issueOneClaim(issuer);
      chain.transferredAmountOurs = SWAP_AMOUNT;

      const first = await instance.reconcileInventory();
      expect(must(first.pools[0], 'pool totals').liabilityReduced).toBe(
        SWAP_AMOUNT
      );

      // Poll the same value forever: nothing further is credited, and
      // `available` never climbs above `total`.
      for (let i = 0; i < 3; i++) {
        const again = await instance.reconcileInventory();
        const totals = must(again.pools[0], 'pool totals');
        expect(totals.liabilityReduced).toBe(0n);
        expect(totals.availableRestored).toBe(0n);
      }
      const after = firstPool(await readAdminReport(instance));
      expect(after.available).toBe(START_INVENTORY.toString());
      expect(after.total).toBe(START_INVENTORY.toString());
      expect(BigInt(after.available)).toBeLessThanOrEqual(BigInt(after.total));
      expect(after.free).toBe(START_INVENTORY.toString());
    } finally {
      await instance.stop();
    }
  });

  it('[P0] an unreadable chain (account absent) changes NOTHING — capacity stays blocked', async () => {
    const chain = { transferredAmountOurs: 0n, exists: false };
    const rpcUrl = await startFakeSolanaRpc(chain, await ourSolanaPubkey());
    const { instance, issuer } = await bootMaker(rpcUrl);
    try {
      await issueOneClaim(issuer);

      const result = await instance.reconcileInventory();
      expect(result.errors.length).toBe(1);
      expect(must(result.errors[0], 'a read error')).toMatch(/does not exist/);
      expect(result.pools).toEqual([]);

      const after = firstPool(await readAdminReport(instance));
      expect(after.unsettled).toBe(SWAP_AMOUNT.toString());
      expect(after.available).toBe(START_INVENTORY.toString());
      expect(after.free).toBe((START_INVENTORY - SWAP_AMOUNT).toString());
      expect(must(after.channels[0], 'channel view').unredeemed).toBeNull();
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a STALE read (chain behind the issued watermark) recycles only what the chain confirms', async () => {
    const chain = { transferredAmountOurs: 0n, exists: true };
    const rpcUrl = await startFakeSolanaRpc(chain, await ourSolanaPubkey());
    const { instance, issuer } = await bootMaker(rpcUrl);
    try {
      await issueOneClaim(issuer);
      await issueOneClaim(issuer); // issued = 2 × SWAP_AMOUNT

      // Only the first claim has been redeemed on chain.
      chain.transferredAmountOurs = SWAP_AMOUNT;
      const result = await instance.reconcileInventory();
      expect(must(result.pools[0], 'pool totals').liabilityReduced).toBe(
        SWAP_AMOUNT
      );

      const after = firstPool(await readAdminReport(instance));
      expect(after.unsettled).toBe(SWAP_AMOUNT.toString());
      expect(after.available).toBe(START_INVENTORY.toString());
      expect(after.channels[0]).toMatchObject({
        issued: (SWAP_AMOUNT * 2n).toString(),
        redeemedOnChain: SWAP_AMOUNT.toString(),
        unredeemed: SWAP_AMOUNT.toString(),
      });
    } finally {
      await instance.stop();
    }
  });

  it('[P0] the reconciler reports itself ENABLED on a Solana-only maker (it was off before #141)', async () => {
    const chain = { transferredAmountOurs: 0n, exists: true };
    const rpcUrl = await startFakeSolanaRpc(chain, await ourSolanaPubkey());
    const { instance } = await bootMaker(rpcUrl);
    try {
      const report = await readAdminReport(instance);
      expect(report.reconciler.enabled).toBe(true);
    } finally {
      await instance.stop();
    }
  });
});
