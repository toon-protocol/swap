/**
 * Issue #138 — chain-truth reconciliation + the operator surface.
 *
 * The defect these cover: a successful legacy claim consumed inventory that
 * nothing could ever give back (`recordSettlement` only shrank `unsettled`,
 * which the legacy path never populated), so a maker ratcheted down to
 * permanent T04 refusals. The fix books every claim as liability and lets
 * the CHAIN — never a counterparty, never an operator's word — return it.
 */

import { describe, it, expect, vi } from 'vitest';

import { SwapInventory } from './inventory.js';
import { SwapChannelState } from './channel-state.js';
import {
  SwapInventoryReconciler,
  parseChannelStoredKey,
} from './inventory-reconciler.js';
import type { ReconcileResult } from './inventory-reconciler.js';
import type { ChannelOnChainReader } from './channel-state.js';
import { buildInventoryReport } from './admin-surface.js';
import { adminTestApp } from './admin-surface.test-support.js';
import type { AdminInventoryReport } from './admin-surface.js';

const ASSET = 'USDC';
const CHAIN = 'evm:base:8453';
const CHANNEL = '0x' + '01'.repeat(32);
const POOL = `${ASSET}:${CHAIN}`;
const TOKEN = 'operator-secret';

/** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

function poolOf(inventory: SwapInventory) {
  return must(inventory.get(ASSET, CHAIN), 'pool balance');
}

function freeOf(inventory: SwapInventory): bigint {
  return must(inventory.windowSnapshot()[0], 'window snapshot').free;
}

function totalsOf(result: ReconcileResult) {
  return must(result.pools[0], 'pool totals');
}

/** Shape of every JSON body these routes return (all fields optional). */
interface AdminJsonBody {
  error?: string;
  corroborated?: string;
  credited?: string;
  pools?: { availableRestored: string; liabilityReduced: string }[];
}

async function adminJson(res: Response): Promise<AdminJsonBody> {
  return (await res.json()) as AdminJsonBody;
}

/** On-chain reader whose answer the test controls (and can make throw). */
function fakeReader(state: { redeemed: bigint; fail?: string }) {
  return {
    getCumulativePaid: vi.fn(async () => {
      if (state.fail) throw new Error(state.fail);
      return state.redeemed;
    }),
  } satisfies ChannelOnChainReader;
}

function makeInventory(p: {
  available: bigint;
  total: bigint;
  unsettled?: bigint;
}) {
  return new SwapInventory({
    balances: {
      [POOL]: {
        available: p.available,
        total: p.total,
        ...(p.unsettled !== undefined && { unsettled: p.unsettled }),
      },
    },
  });
}

function makeChannelState(issued: bigint) {
  return new SwapChannelState({
    channels: {
      [`${POOL}:${CHANNEL}`]: {
        channelId: CHANNEL,
        cumulativeAmount: issued,
        nonce: 1n,
        updatedAt: 0,
      },
    },
  });
}

describe('parseChannelStoredKey', () => {
  it('[P1] splits assetCode from a colon-bearing chain id', () => {
    expect(parseChannelStoredKey(`${POOL}:${CHANNEL}`, CHANNEL)).toEqual({
      assetCode: ASSET,
      chain: CHAIN,
    });
  });

  it('[P1] returns null for a key that is not `asset:chain:channelId`', () => {
    expect(parseChannelStoredKey('bare-key', 'bare-key')).toBeNull();
    expect(parseChannelStoredKey(`${CHANNEL}`, CHANNEL)).toBeNull();
  });
});

describe('SwapInventoryReconciler — chain truth recycles capacity', () => {
  it('[P0] an on-chain redemption releases the liability a committed claim booked', async () => {
    const inventory = makeInventory({
      available: 1_000n,
      total: 1_000n,
      unsettled: 50n,
    });
    const chain = { redeemed: 50n };
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader(chain),
    });

    expect(freeOf(inventory)).toBe(950n);
    const result = await reconciler.reconcile();

    expect(totalsOf(result).liabilityReduced).toBe(50n);
    expect(poolOf(inventory).unsettled).toBe(0n);
    expect(freeOf(inventory)).toBe(1_000n);
  });

  it('[P0] re-running credits nothing: the per-channel watermark is monotone', async () => {
    const inventory = makeInventory({
      available: 1_000n,
      total: 1_000n,
      unsettled: 50n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader({ redeemed: 50n }),
    });

    await reconciler.reconcile();
    const second = await reconciler.reconcile();
    const third = await reconciler.reconcile();

    expect(second.pools[0]?.liabilityReduced ?? 0n).toBe(0n);
    expect(third.pools[0]?.availableRestored ?? 0n).toBe(0n);
    expect(poolOf(inventory).available).toBe(1_000n);
  });

  it('[P0] heals a maker that ran the permanent-debit build: redeemed value returns to `available`, capped at `total`', async () => {
    // The live symptom: `available` burned below `total` by legacy debits,
    // `unsettled` stuck at 0, counterparties redeemed anyway.
    const inventory = makeInventory({
      available: 992_000n,
      total: 1_000_000n,
      unsettled: 0n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(8_000n),
      // The chain says every one of those 8000 units was redeemed.
      reader: fakeReader({ redeemed: 8_000n }),
    });

    const result = await reconciler.reconcile();

    expect(totalsOf(result).availableRestored).toBe(8_000n);
    expect(poolOf(inventory).available).toBe(1_000_000n);
    // And it stops there — a further redemption cannot inflate the pool.
    const inv2 = makeInventory({ available: 1_000_000n, total: 1_000_000n });
    const r2 = new SwapInventoryReconciler({
      inventory: inv2,
      channelState: makeChannelState(50_000n),
      reader: fakeReader({ redeemed: 50_000n }),
    });
    await r2.reconcile();
    expect(poolOf(inv2).available).toBe(1_000_000n);
  });

  it('[P0] fails closed on an unreadable chain: nothing is recycled and the reason is reported', async () => {
    const inventory = makeInventory({
      available: 900n,
      total: 1_000n,
      unsettled: 100n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(100n),
      reader: fakeReader({ redeemed: 100n, fail: 'ECONNREFUSED' }),
    });

    const result = await reconciler.reconcile();

    expect(result.errors[0]).toContain('ECONNREFUSED');
    expect(must(result.channels[0], 'channel observation').redeemed).toBeNull();
    expect(poolOf(inventory).unsettled).toBe(100n);
    expect(poolOf(inventory).available).toBe(900n);
  });

  it('[P0] disabled without an on-chain reader — and says so instead of guessing', async () => {
    const inventory = makeInventory({
      available: 900n,
      total: 1_000n,
      unsettled: 100n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(100n),
    });

    expect(reconciler.enabled).toBe(false);
    const result = await reconciler.reconcile();
    expect(result.errors[0]).toContain('no on-chain reader configured');
    expect(poolOf(inventory).unsettled).toBe(100n);
  });

  it('[P1] a preview pass mutates nothing (so a refused credit leaves the watermark intact)', async () => {
    const inventory = makeInventory({
      available: 950n,
      total: 1_000n,
      unsettled: 0n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader({ redeemed: 50n }),
    });

    const preview = await reconciler.reconcile({ apply: false });
    expect(preview.applied).toBe(false);
    expect(totalsOf(preview).availableRestored).toBe(50n);
    expect(poolOf(inventory).available).toBe(950n);

    // The corroboration is still there for the real pass.
    const applied = await reconciler.reconcile();
    expect(totalsOf(applied).availableRestored).toBe(50n);
    expect(poolOf(inventory).available).toBe(1_000n);
  });

  it('[P0] never persists after stop(): shutdown zeroes the channel watermarks in memory', async () => {
    // `SwapNodeInstance.stop()` calls `SwapChannelState.releaseAll()` (which
    // zeroes nonce/cumulative) and deliberately does not persist. A pass that
    // outlives stop() must not write those zeros over the real watermarks —
    // that would let a counterparty replay an already-issued claim.
    const persist = vi.fn();
    const inventory = makeInventory({
      available: 1_000n,
      total: 1_000n,
      unsettled: 50n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader({ redeemed: 50n }),
      persist,
    });

    reconciler.stop();
    await reconciler.reconcile();
    await reconciler.runGuarded();

    expect(persist).not.toHaveBeenCalled();
  });

  it('[P1] persists after a pass that moved state, and not after a no-op', async () => {
    const persist = vi.fn();
    const inventory = makeInventory({
      available: 1_000n,
      total: 1_000n,
      unsettled: 50n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader({ redeemed: 50n }),
      persist,
    });

    await reconciler.reconcile();
    expect(persist).toHaveBeenCalledTimes(1);
    await reconciler.reconcile();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Operator surface
// ---------------------------------------------------------------------------

function makeAdminApp(p: {
  inventory: SwapInventory;
  reconciler: SwapInventoryReconciler;
  adminToken?: string;
}) {
  return adminTestApp({
    inventory: p.inventory,
    reconciler: p.reconciler,
    ...(p.adminToken !== undefined && { adminToken: p.adminToken }),
  });
}

describe('operator read surface — GET /admin/inventory', () => {
  it('[P0] reports WHY issuance is blocked, naming the unredeemed claim holding the capacity', async () => {
    const inventory = makeInventory({
      available: 100n,
      total: 100n,
      unsettled: 100n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(100n),
      reader: fakeReader({ redeemed: 0n }),
    });
    await reconciler.reconcile();

    const res = await makeAdminApp({ inventory, reconciler }).request(
      '/admin/inventory'
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminInventoryReport;
    const pool = must(body.pools[0], 'pool view');

    expect(pool.free).toBe('0');
    expect(pool.issuanceBlocked).toBe(true);
    expect(pool.blockedReason).toContain('unsettled liability');
    expect(pool.blockedReason).toContain(CHANNEL);
    expect(pool.channels[0]).toMatchObject({
      channelId: CHANNEL,
      issued: '100',
      redeemedOnChain: '0',
      unredeemed: '100',
    });
    expect(body.reconciler.enabled).toBe(true);
  });

  it('[P0] a healthy pool is not flagged, and the report says writes are disabled without a token', async () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(0n),
      reader: fakeReader({ redeemed: 0n }),
    });

    const body = buildInventoryReport({ inventory, reconciler });
    expect(must(body.pools[0], 'pool view').issuanceBlocked).toBe(false);
    expect(must(body.pools[0], 'pool view').blockedReason).toBeUndefined();
    expect(body.writes.enabled).toBe(false);
    expect(body.writes.reason).toContain('SWAP_ADMIN_TOKEN');
  });

  it('[P1] flags a maker that can never recycle because no on-chain reader is configured', async () => {
    const inventory = makeInventory({
      available: 100n,
      total: 100n,
      unsettled: 100n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(100n),
    });

    const body = buildInventoryReport({ inventory, reconciler });
    expect(body.reconciler.enabled).toBe(false);
    expect(must(body.pools[0], 'pool view').blockedReason).toContain(
      'NO on-chain reader is configured'
    );
  });
});

describe('operator write surface — guarded, and never credits on trust', () => {
  function blockedSetup(chain: { redeemed: bigint }) {
    const inventory = makeInventory({
      available: 950n,
      total: 1_000n,
      unsettled: 0n,
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader(chain),
    });
    return { inventory, reconciler };
  }

  it('[P0] writes are DISABLED (503), not open, when no token is configured', async () => {
    const { inventory, reconciler } = blockedSetup({ redeemed: 50n });
    const app = makeAdminApp({ inventory, reconciler });

    const res = await app.request('/admin/inventory/reconcile', {
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect((await adminJson(res)).error).toBe('admin_writes_disabled');
    expect(poolOf(inventory).available).toBe(950n);
  });

  it('[P0] a wrong or missing token is rejected (401)', async () => {
    const { inventory, reconciler } = blockedSetup({ redeemed: 50n });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const noToken = await app.request('/admin/inventory/reconcile', {
      method: 'POST',
    });
    expect(noToken.status).toBe(401);
    const wrongToken = await app.request('/admin/inventory/reconcile', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrongToken.status).toBe(401);
    expect(poolOf(inventory).available).toBe(950n);
  });

  it('[P0] REFUSES an uncorroborated credit: the chain shows no redemption, so nothing is credited', async () => {
    const { inventory, reconciler } = blockedSetup({ redeemed: 0n });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const res = await app.request('/admin/inventory/credit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ assetCode: ASSET, chain: CHAIN, amount: '50' }),
    });

    expect(res.status).toBe(409);
    const body = await adminJson(res);
    expect(body.error).toBe('uncorroborated');
    expect(body.corroborated).toBe('0');
    expect(poolOf(inventory).available).toBe(950n);
  });

  it('[P0] REFUSES a credit larger than the chain corroborates, and applies nothing', async () => {
    const { inventory, reconciler } = blockedSetup({ redeemed: 50n });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const res = await app.request('/admin/inventory/credit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ assetCode: ASSET, chain: CHAIN, amount: '500' }),
    });

    expect(res.status).toBe(409);
    expect((await adminJson(res)).error).toBe('exceeds_corroborated');
    // The refusal did not consume the corroboration.
    expect(poolOf(inventory).available).toBe(950n);
    const applied = await reconciler.reconcile();
    expect(totalsOf(applied).availableRestored).toBe(50n);
  });

  it('[P0] credits exactly what the chain corroborates, once', async () => {
    const { inventory, reconciler } = blockedSetup({ redeemed: 50n });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const first = await app.request('/admin/inventory/credit', {
      method: 'POST',
      headers: {
        'x-swap-admin-token': TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ assetCode: ASSET, chain: CHAIN, amount: '50' }),
    });
    expect(first.status).toBe(200);
    expect((await adminJson(first)).credited).toBe('50');
    expect(poolOf(inventory).available).toBe(1_000n);

    // A replay of the same request is refused — the watermark already moved.
    const replay = await app.request('/admin/inventory/credit', {
      method: 'POST',
      headers: {
        'x-swap-admin-token': TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ assetCode: ASSET, chain: CHAIN, amount: '50' }),
    });
    expect(replay.status).toBe(409);
    expect(poolOf(inventory).available).toBe(1_000n);
  });

  it('[P1] refuses to credit when the chain cannot be read at all', async () => {
    const inventory = makeInventory({ available: 950n, total: 1_000n });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: makeChannelState(50n),
      reader: fakeReader({ redeemed: 50n, fail: 'rpc down' }),
    });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const res = await app.request('/admin/inventory/credit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ assetCode: ASSET, chain: CHAIN }),
    });
    expect(res.status).toBe(503);
    expect((await adminJson(res)).error).toBe('chain_unreadable');
    expect(poolOf(inventory).available).toBe(950n);
  });

  it('[P1] an authorized reconcile forces a pass and reports what it recycled', async () => {
    const { inventory, reconciler } = blockedSetup({ redeemed: 50n });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const res = await app.request('/admin/inventory/reconcile', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await adminJson(res);
    expect(must(body.pools?.[0], 'pool totals').availableRestored).toBe('50');
    expect(poolOf(inventory).available).toBe(1_000n);
  });
});
