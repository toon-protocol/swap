/**
 * Issue #138 end-to-end through `startSwapNode()`: a successful LEGACY swap
 * followed by an on-chain redemption gives the capacity back.
 *
 * Drives the real `MultiChainClaimIssuer` the node built (via the
 * `onClaimIssuerBuilt` hook) against the real
 * `createEvmChannelOnChainReader` pointed at a minimal in-process JSON-RPC
 * server — the same fixture shape `swap-node.channel-rebind.test.ts` uses —
 * so the wiring under test is the deployed one, not a stand-in.
 *
 * Before the fix, the claim below permanently debited `available` and NOTHING
 * in the process could restore it: `recordSettlement` only shrank `unsettled`,
 * which the legacy path never populated, and the container exposed no route
 * to credit it back.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

import { startSwapNode } from './swap-node.js';
import type {
  SwapNodeEvmChainProvider,
  SwapNodeInstance,
} from './swap-node.js';
import type { MultiChainClaimIssuer } from './claim-issuer.js';
import type { AdminInventoryReport } from './admin-surface.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EVM_CHAIN = 'evm:8453';
const ASSET = 'USDC';
const CHANNEL_ADDRESS = '0x' + 'aa'.repeat(20);
const CHANNEL_ID = '0x' + '01'.repeat(32);
const SENDER = 'a'.repeat(64);
const RECIPIENT = '0x' + 'cd'.repeat(20);
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

function word(hex: string): string {
  return hex.toLowerCase().padStart(64, '0');
}

/**
 * `eth_call`-only JSON-RPC server whose `channels()` answer reports the
 * MUTABLE `chain.cumulativePaid` — the test moves it to simulate the
 * counterparty redeeming on chain.
 */
async function startFakeChainRpc(chain: {
  cumulativePaid: bigint;
}): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number };
      const result =
        '0x' +
        [
          word('11'.repeat(20)),
          word('22'.repeat(20)),
          word(3n.toString(16)),
          word(chain.cumulativePaid.toString(16)),
          word(1_000_000n.toString(16)),
          word(0n.toString(16)),
          word((1).toString(16)),
        ].join('');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result }));
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

async function bootMaker(rpcUrl: string): Promise<{
  instance: SwapNodeInstance;
  issuer: MultiChainClaimIssuer;
}> {
  let issuer: MultiChainClaimIssuer | undefined;
  const evmProvider: SwapNodeEvmChainProvider = {
    chainType: 'evm',
    chainId: EVM_CHAIN,
    rpcUrl,
    registryAddress: '0x' + '33'.repeat(20),
    tokenAddress: '0x' + '44'.repeat(20),
    tokenNetworkAddress: '0x' + '55'.repeat(20),
    channelAddress: CHANNEL_ADDRESS,
  };
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    blsPort: 0,
    chains: ['evm'],
    adminToken: ADMIN_TOKEN,
    // No periodic timer: every pass in this test is explicit.
    reconcileIntervalMs: 0,
    swapPairs: [
      {
        from: { assetCode: ASSET, assetScale: 6, chain: EVM_CHAIN },
        to: { assetCode: ASSET, assetScale: 6, chain: EVM_CHAIN },
        rate: '1.0',
      },
    ],
    channels: {
      [EVM_CHAIN]: [
        {
          channelId: CHANNEL_ID,
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [EVM_CHAIN]: START_INVENTORY },
    chainProviders: [evmProvider],
    __testHooks: {
      onClaimIssuerBuilt: (ci) => {
        issuer = ci;
      },
    },
  });
  if (!issuer) throw new Error('onClaimIssuerBuilt was never called');
  return { instance, issuer };
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

describe('issue #138 — a legacy swap plus an on-chain redemption restores capacity', () => {
  it('[P0] the redeemed value comes back; before the fix it was burned forever', async () => {
    const chain = { cumulativePaid: 0n };
    const rpcUrl = await startFakeChainRpc(chain);
    const { instance, issuer } = await bootMaker(rpcUrl);
    try {
      // 1. A successful LEGACY swap.
      const claim = await issuer.issueClaim({
        sourceAmount: SWAP_AMOUNT,
        targetAmount: SWAP_AMOUNT,
        pair: {
          from: { assetCode: ASSET, assetScale: 6, chain: EVM_CHAIN },
          to: { assetCode: ASSET, assetScale: 6, chain: EVM_CHAIN },
          rate: '1.0',
        },
        senderPubkey: SENDER,
        chainRecipient: RECIPIENT,
        rumor: {},
      } as Parameters<MultiChainClaimIssuer['issueClaim']>[0]);
      expect(claim.claim).toBeInstanceOf(Uint8Array);

      // Capacity is held as liability, and `available` — the real capital —
      // is untouched (pre-#138 it was permanently debited here).
      const held = firstPool(await readAdminReport(instance));
      expect(held.available).toBe(START_INVENTORY.toString());
      expect(held.unsettled).toBe(SWAP_AMOUNT.toString());
      expect(held.free).toBe((START_INVENTORY - SWAP_AMOUNT).toString());

      // 2. The counterparty redeems on chain.
      chain.cumulativePaid = SWAP_AMOUNT;
      const result = await instance.reconcileInventory();
      expect(must(result.pools[0], 'pool totals').liabilityReduced).toBe(
        SWAP_AMOUNT
      );

      // 3. Full capacity is back, with zero operator involvement.
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

  it('[P0] an UNredeemed claim keeps its capacity blocked, and the read surface says why', async () => {
    const chain = { cumulativePaid: 0n };
    const rpcUrl = await startFakeChainRpc(chain);
    const { instance, issuer } = await bootMaker(rpcUrl);
    try {
      await issuer.issueClaim({
        sourceAmount: SWAP_AMOUNT,
        targetAmount: SWAP_AMOUNT,
        pair: {
          from: { assetCode: ASSET, assetScale: 6, chain: EVM_CHAIN },
          to: { assetCode: ASSET, assetScale: 6, chain: EVM_CHAIN },
          rate: '1.0',
        },
        senderPubkey: SENDER,
        chainRecipient: RECIPIENT,
        rumor: {},
      } as Parameters<MultiChainClaimIssuer['issueClaim']>[0]);

      const totals = must(
        (await instance.reconcileInventory()).pools[0],
        'pool totals'
      );
      expect(totals.liabilityReduced).toBe(0n);
      expect(totals.availableRestored).toBe(0n);

      const pool = firstPool(await readAdminReport(instance));
      expect(pool.unsettled).toBe(SWAP_AMOUNT.toString());
      expect(must(pool.channels[0], 'channel view').unredeemed).toBe(
        SWAP_AMOUNT.toString()
      );
    } finally {
      await instance.stop();
    }
  });

  it('[P0] the credit route refuses an uncorroborated credit over HTTP, and requires the token', async () => {
    const chain = { cumulativePaid: 0n };
    const rpcUrl = await startFakeChainRpc(chain);
    const { instance } = await bootMaker(rpcUrl);
    try {
      const base = `http://127.0.0.1:${instance.blsPort}/admin/inventory/credit`;
      const body = JSON.stringify({
        assetCode: ASSET,
        chain: EVM_CHAIN,
        amount: '4000',
      });

      const unauthorized = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(unauthorized.status).toBe(401);

      const refused = await fetch(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body,
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe(
        'uncorroborated'
      );

      const report = await readAdminReport(instance);
      expect(firstPool(report).available).toBe(START_INVENTORY.toString());
      expect(report.writes.enabled).toBe(true);
    } finally {
      await instance.stop();
    }
  });
});
