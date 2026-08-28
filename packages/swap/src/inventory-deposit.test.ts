/**
 * swap#142 — the operator route for genuinely NEW capital.
 *
 * The gap these cover: #138/#140 gave the operator a way to recycle capital
 * the chain shows REDEEMED, and deliberately nothing else — so an operator who
 * actually funded a new channel or topped up an existing one had no route at
 * all, and editing config does not reliably take (the persisted snapshot wins
 * over config for keys it has already seen, issue #130).
 *
 * The invariant every test here defends: inventory is NEVER credited on an
 * operator's word. The only thing that can raise `total` is the chain showing
 * more capital in the pool's channels than the pool has already booked — and
 * because crediting raises `total` itself, that gap closes as it is credited,
 * which is what makes a repeated call a structural no-op rather than a double
 * credit.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

import { SwapInventory } from './inventory.js';
import { SwapChannelState, channelFundedTotal } from './channel-state.js';
import type {
  ChannelFundingPosition,
  ChannelOnChainReader,
} from './channel-state.js';
import { SwapInventoryReconciler } from './inventory-reconciler.js';
import { adminTestApp } from './admin-surface.test-support.js';
import type { AdminTestApp } from './admin-surface.test-support.js';
import { createEvmChannelOnChainReader } from './evm-channel-reader.js';
import { composeChannelOnChainReaders } from './channel-reader.js';

const ASSET = 'USDC';
const CHAIN = 'evm:base:8453';
const CHANNEL = '0x' + '01'.repeat(32);
const CHANNEL_B = '0x' + '02'.repeat(32);
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

/** Body shape shared by every response these routes return. */
interface DepositJsonBody {
  error?: string;
  reason?: string;
  applied?: boolean;
  dryRun?: boolean;
  requested?: string | null;
  total?: string;
  chainFundedTotal?: string;
  corroborated?: string;
  credited?: string;
  persisted?: boolean;
  funding?: {
    supported: boolean;
    chainFundedTotal: string;
    channels: { channelId: string; funded: string | null }[];
    errors: string[];
  };
}

async function depositJson(res: Response): Promise<DepositJsonBody> {
  return (await res.json()) as DepositJsonBody;
}

/**
 * A reader whose per-channel funding position the test controls. `fail`
 * makes the funding read throw, exactly as an RPC outage would.
 */
function fundingReader(state: {
  positions: Record<string, ChannelFundingPosition>;
  fail?: string;
}) {
  return {
    getCumulativePaid: vi.fn(async ({ channelId }: { channelId: string }) => {
      return state.positions[channelId]?.cumulativePaid ?? 0n;
    }),
    getFundingPosition: vi.fn(async ({ channelId }: { channelId: string }) => {
      if (state.fail) throw new Error(state.fail);
      const position = state.positions[channelId];
      if (!position) throw new Error(`no fixture channel ${channelId}`);
      return position;
    }),
  } satisfies ChannelOnChainReader;
}

/** swap#141's shape: a reader that can read redemptions but not funding. */
function redemptionOnlyReader(): ChannelOnChainReader {
  return { getCumulativePaid: vi.fn(async () => 0n) };
}

function makeInventory(p: { available: bigint; total: bigint }) {
  return new SwapInventory({
    balances: { [POOL]: { available: p.available, total: p.total } },
  });
}

function makeChannelState(channelIds: readonly string[]) {
  const channels: Record<
    string,
    {
      channelId: string;
      cumulativeAmount: bigint;
      nonce: bigint;
      updatedAt: number;
    }
  > = {};
  for (const channelId of channelIds) {
    channels[`${POOL}:${channelId}`] = {
      channelId,
      cumulativeAmount: 0n,
      nonce: 0n,
      updatedAt: 0,
    };
  }
  return new SwapChannelState({ channels });
}

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

/** The live devnet maker's shape: one channel, 15 000 000 of configured capital. */
function setup(p: {
  available?: bigint;
  total?: bigint;
  positions: Record<string, ChannelFundingPosition>;
  channels?: readonly string[];
  fail?: string;
  adminToken?: string | undefined;
  reader?: ChannelOnChainReader;
  persist?: () => void;
}) {
  const inventory = makeInventory({
    available: p.available ?? 15_000_000n,
    total: p.total ?? 15_000_000n,
  });
  const reconciler = new SwapInventoryReconciler({
    inventory,
    channelState: makeChannelState(p.channels ?? [CHANNEL]),
    reader:
      p.reader ??
      fundingReader({
        positions: p.positions,
        ...(p.fail !== undefined && { fail: p.fail }),
      }),
    ...(p.persist !== undefined && { persist: p.persist }),
  });
  const app = makeAdminApp({
    inventory,
    reconciler,
    ...(p.adminToken !== undefined && { adminToken: p.adminToken }),
  });
  // `positions` is live: a test can mutate it to simulate an on-chain top-up
  // happening between two operator calls against the SAME node.
  return { inventory, reconciler, app, positions: p.positions };
}

async function post(
  app: AdminTestApp,
  body: unknown,
  token: string | null = TOKEN
): Promise<Response> {
  return app.request('/admin/inventory/deposit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// The corroboration quantity
// ---------------------------------------------------------------------------

describe('channelFundedTotal — why not the raw `deposit` field', () => {
  it('[P0] is invariant under a redemption, which the `deposit` word alone is not', () => {
    // RollingSwapChannel.updateBalance: `deposit -= delta; cumulativePaid += delta`.
    const before = { cumulativePaid: 0n, deposit: 1_000n };
    const afterRedeeming400 = { cumulativePaid: 400n, deposit: 600n };

    expect(afterRedeeming400.deposit).toBeLessThan(before.deposit);
    expect(channelFundedTotal(afterRedeeming400)).toBe(
      channelFundedTotal(before)
    );
  });

  it('[P0] rises by exactly the amount a top-up puts into the channel', () => {
    const busy = { cumulativePaid: 400n, deposit: 600n };
    const toppedUp = { cumulativePaid: 400n, deposit: 600n + 5_000n };
    expect(channelFundedTotal(toppedUp) - channelFundedTotal(busy)).toBe(
      5_000n
    );
  });
});

// ---------------------------------------------------------------------------
// The primitive — SwapInventory.creditCorroboratedFunding
// ---------------------------------------------------------------------------

describe('SwapInventory.creditCorroboratedFunding — bounds', () => {
  it('[P0] credits the excess of chain proof over booked total, once', () => {
    const inventory = makeInventory({
      available: 15_000_000n,
      total: 15_000_000n,
    });

    const first = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 20_000_000n,
    });
    expect(first.credited).toBe(5_000_000n);
    expect(poolOf(inventory).total).toBe(20_000_000n);
    expect(poolOf(inventory).available).toBe(20_000_000n);

    // The same chain reading again: the gap it measured is now closed.
    const replay = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 20_000_000n,
    });
    expect(replay.credited).toBe(0n);
    expect(replay.refused).toBe('uncorroborated');
    expect(poolOf(inventory).total).toBe(20_000_000n);
  });

  it('[P0] `total` is its own watermark: N replays credit exactly what one does', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    for (let i = 0; i < 25; i += 1) {
      inventory.creditCorroboratedFunding({
        assetCode: ASSET,
        chain: CHAIN,
        chainFundedTotal: 1_600n,
      });
    }
    expect(poolOf(inventory).total).toBe(1_600n);
    expect(poolOf(inventory).available).toBe(1_600n);
  });

  it('[P0] refuses when the chain shows no more than the pool already booked', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    for (const chainFundedTotal of [0n, 999n, 1_000n]) {
      const outcome = inventory.creditCorroboratedFunding({
        assetCode: ASSET,
        chain: CHAIN,
        chainFundedTotal,
      });
      expect(outcome.refused).toBe('uncorroborated');
      expect(outcome.credited).toBe(0n);
    }
    expect(poolOf(inventory).total).toBe(1_000n);
    expect(poolOf(inventory).available).toBe(1_000n);
  });

  it('[P0] capital LEAVING (a funder reclaiming a remainder) never lowers total, and never credits', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    const outcome = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 0n, // channel closed, remainder returned to the funder
    });
    expect(outcome.refused).toBe('uncorroborated');
    expect(poolOf(inventory).total).toBe(1_000n);

    // Re-funding back to a level already credited must credit nothing.
    const refund = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 1_000n,
    });
    expect(refund.credited).toBe(0n);
    expect(poolOf(inventory).total).toBe(1_000n);
  });

  it('[P0] refuses a request larger than the chain backs, WHOLE — nothing applied', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    const outcome = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 1_400n,
      requested: 5_000n,
    });
    expect(outcome.refused).toBe('exceeds_corroborated');
    expect(outcome.corroborated).toBe(400n);
    expect(outcome.credited).toBe(0n);
    expect(poolOf(inventory).total).toBe(1_000n);
  });

  it('[P1] a partial request credits exactly that, and leaves the remainder creditable', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 1_400n,
      requested: 100n,
    });
    expect(poolOf(inventory).total).toBe(1_100n);

    const rest = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 1_400n,
    });
    expect(rest.credited).toBe(300n);
    expect(poolOf(inventory).total).toBe(1_400n);
  });

  it('[P0] over a whole life, Σ credited never exceeds the highest funding ever seen', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    const readings = [1_000n, 1_500n, 1_500n, 1_200n, 1_800n, 0n, 1_800n];
    let credited = 0n;
    for (const chainFundedTotal of readings) {
      credited += inventory.creditCorroboratedFunding({
        assetCode: ASSET,
        chain: CHAIN,
        chainFundedTotal,
      }).credited;
    }
    const highestEverSeen = 1_800n;
    expect(credited).toBe(highestEverSeen - 1_000n);
    expect(poolOf(inventory).total).toBe(highestEverSeen);
  });

  it('[P1] the historical swap#137 `total` inflation converges onto chain truth from below', () => {
    // The live devnet maker: `available` correct after #140's reconciler,
    // `total` carrying 3 500 of inflation from failed swaps that unwound with
    // `credit()` before #137. Nothing corrects this directly (see the module
    // docblock — every recompute is a downward write on data the node does
    // not durably own); it resolves the next time real capital arrives.
    const inventory = new SwapInventory({
      balances: { [POOL]: { available: 15_000_000n, total: 15_003_500n } },
    });

    const outcome = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 20_000_000n, // operator really added 5 000 000
    });

    // The credit is the top-up MINUS the inflation, so `total` lands exactly
    // on the chain's figure — never above it.
    expect(outcome.credited).toBe(4_996_500n);
    expect(poolOf(inventory).total).toBe(20_000_000n);
    // The residue moves into `available` being 3 500 low: under-serving, the
    // safe direction, and never above `total`.
    expect(poolOf(inventory).available).toBe(19_996_500n);
    expect(poolOf(inventory).available).toBeLessThanOrEqual(
      poolOf(inventory).total
    );
  });

  it('[P0] preview mutates nothing while predicting the same numbers', () => {
    const inventory = makeInventory({ available: 1_000n, total: 1_000n });
    const preview = inventory.previewCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 1_400n,
    });
    expect(preview.credited).toBe(400n);
    expect(poolOf(inventory).total).toBe(1_000n);

    const applied = inventory.creditCorroboratedFunding({
      assetCode: ASSET,
      chain: CHAIN,
      chainFundedTotal: 1_400n,
    });
    expect(applied.credited).toBe(preview.credited);
  });
});

// ---------------------------------------------------------------------------
// Reading the pool's on-chain position
// ---------------------------------------------------------------------------

describe('SwapInventoryReconciler.readPoolFunding', () => {
  it('[P0] sums cumulativePaid + deposit across the pool channels', async () => {
    const { reconciler } = setup({
      channels: [CHANNEL, CHANNEL_B],
      positions: {
        [CHANNEL]: { cumulativePaid: 8_000n, deposit: 2_000n },
        [CHANNEL_B]: { cumulativePaid: 0n, deposit: 5_000n },
      },
    });

    const reading = await reconciler.readPoolFunding({
      assetCode: ASSET,
      chain: CHAIN,
    });
    expect(reading.supported).toBe(true);
    expect(reading.chainFundedTotal).toBe(15_000n);
    expect(reading.errors).toEqual([]);
  });

  it('[P0] a reader with no funding capability reports unsupported, never a guess', async () => {
    const { reconciler } = setup({
      positions: {},
      reader: redemptionOnlyReader(),
    });

    const reading = await reconciler.readPoolFunding({
      assetCode: ASSET,
      chain: CHAIN,
    });
    expect(reading.supported).toBe(false);
    expect(reading.chainFundedTotal).toBe(0n);
    expect(must(reading.errors[0], 'reason')).toContain('cannot read');
  });

  it('[P1] a failed read is excluded from the sum and reported', async () => {
    const { reconciler } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 1_000n } },
      fail: 'rpc down',
    });

    const reading = await reconciler.readPoolFunding({
      assetCode: ASSET,
      chain: CHAIN,
    });
    expect(reading.chainFundedTotal).toBe(0n);
    expect(reading.errors).toHaveLength(1);
    expect(must(reading.errors[0], 'error')).toContain('rpc down');
  });
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

describe('POST /admin/inventory/deposit — protection', () => {
  it('[P0] with NO token configured the write is DISABLED (503), never open', async () => {
    const { app, inventory } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 20_000_000n } },
      adminToken: undefined,
    });

    const noHeader = await post(app, { assetCode: ASSET, chain: CHAIN }, null);
    expect(noHeader.status).toBe(503);
    expect((await depositJson(noHeader)).error).toBe('admin_writes_disabled');

    // ...and presenting a token cannot enable it either.
    const withHeader = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(withHeader.status).toBe(503);

    expect(poolOf(inventory).total).toBe(15_000_000n);
  });

  it('[P0] a wrong or missing token is rejected once a token IS configured', async () => {
    const { app, inventory } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 20_000_000n } },
      adminToken: TOKEN,
    });

    expect(
      (await post(app, { assetCode: ASSET, chain: CHAIN }, null)).status
    ).toBe(401);
    expect(
      (await post(app, { assetCode: ASSET, chain: CHAIN }, 'guess')).status
    ).toBe(401);
    expect(poolOf(inventory).total).toBe(15_000_000n);
  });
});

describe('POST /admin/inventory/deposit — never credits on trust', () => {
  it('[P0] a corroborated top-up credits exactly once, and the repeat does not double-credit', async () => {
    const persist = vi.fn();
    const { app, inventory, positions } = setup({
      // The live devnet shape: 15 000 000 configured, one channel holding it —
      // partly already paid out, which is exactly the case a raw `deposit`
      // read would get wrong.
      positions: {
        [CHANNEL]: { cumulativePaid: 1_000n, deposit: 14_999_000n },
      },
      adminToken: TOKEN,
      persist,
    });

    // Nothing to credit yet: the chain holds exactly what the pool booked.
    const before = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(before.status).toBe(409);
    const beforeBody = await depositJson(before);
    expect(beforeBody.error).toBe('uncorroborated');
    // The corroborating quantity is cumulativePaid + deposit, so the 1 000
    // already paid out still counts as capital the maker placed. Reading the
    // `deposit` word alone would report 14 999 000 here and then hand the
    // operator a phantom 1 000 of "new" capital on the next top-up.
    expect(beforeBody.chainFundedTotal).toBe('15000000');

    // The operator tops the SAME channel up by 5 000 000 on chain.
    positions[CHANNEL] = {
      cumulativePaid: 1_000n,
      deposit: 14_999_000n + 5_000_000n,
    };

    const first = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(first.status).toBe(200);
    const firstBody = await depositJson(first);
    expect(firstBody.applied).toBe(true);
    expect(firstBody.credited).toBe('5000000');
    expect(firstBody.chainFundedTotal).toBe('20000000');
    expect(poolOf(inventory).total).toBe(20_000_000n);
    expect(poolOf(inventory).available).toBe(20_000_000n);
    expect(persist).toHaveBeenCalled();

    // The exact same call again, against the exact same chain state.
    const replay = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(replay.status).toBe(409);
    const replayBody = await depositJson(replay);
    expect(replayBody.error).toBe('uncorroborated');
    expect(replayBody.credited).toBe('0');
    expect(poolOf(inventory).total).toBe(20_000_000n);
    expect(poolOf(inventory).available).toBe(20_000_000n);

    // ...and a redemption of the new capital must not make it creditable
    // again: `cumulativePaid + deposit` is invariant under redemption.
    positions[CHANNEL] = {
      cumulativePaid: 3_000_000n,
      deposit: 17_000_000n,
    };
    const afterRedemption = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(afterRedemption.status).toBe(409);
    expect(poolOf(inventory).total).toBe(20_000_000n);
  });

  it('[P0] an UNCORROBORATED top-up is refused — the operator asserting it changes nothing', async () => {
    const { app, inventory } = setup({
      // The chain shows exactly the configured capital: no top-up landed.
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 15_000_000n } },
      adminToken: TOKEN,
    });

    const res = await post(app, {
      assetCode: ASSET,
      chain: CHAIN,
      amount: '5000000',
    });
    expect(res.status).toBe(409);
    const body = await depositJson(res);
    expect(body.error).toBe('uncorroborated');
    expect(body.credited).toBe('0');
    expect(must(body.reason, 'reason')).toContain('no new capital');
    expect(poolOf(inventory).total).toBe(15_000_000n);
    expect(poolOf(inventory).available).toBe(15_000_000n);
  });

  it('[P0] a top-up larger than the chain backs is refused whole, nothing applied', async () => {
    const { app, inventory } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 15_400_000n } },
      adminToken: TOKEN,
    });

    const res = await post(app, {
      assetCode: ASSET,
      chain: CHAIN,
      amount: '5000000',
    });
    expect(res.status).toBe(409);
    const body = await depositJson(res);
    expect(body.error).toBe('exceeds_corroborated');
    expect(body.corroborated).toBe('400000');
    expect(body.credited).toBe('0');
    expect(poolOf(inventory).total).toBe(15_000_000n);
  });

  it('[P0] an unreadable chain refuses (503) rather than crediting', async () => {
    const { app, inventory } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 20_000_000n } },
      fail: 'connect ECONNREFUSED',
      adminToken: TOKEN,
    });

    const res = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(res.status).toBe(503);
    expect((await depositJson(res)).error).toBe('chain_unreadable');
    expect(poolOf(inventory).total).toBe(15_000_000n);
  });

  it('[P0] a reader that cannot read funding refuses (503) rather than guessing', async () => {
    const { app, inventory } = setup({
      positions: {},
      reader: redemptionOnlyReader(),
      adminToken: TOKEN,
    });

    const res = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(res.status).toBe(503);
    expect((await depositJson(res)).error).toBe('funding_unreadable');
    expect(poolOf(inventory).total).toBe(15_000_000n);
  });

  it('[P1] a pool with no provisioned channel is a 404, not a credit', async () => {
    const { app, inventory } = setup({
      channels: [],
      positions: {},
      adminToken: TOKEN,
    });

    const res = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(res.status).toBe(404);
    expect((await depositJson(res)).error).toBe('unknown_pool');
    expect(poolOf(inventory).total).toBe(15_000_000n);
  });

  it('[P0] dryRun predicts the real call exactly and mutates nothing', async () => {
    const { app, inventory } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 20_000_000n } },
      adminToken: TOKEN,
    });

    const dry = await post(app, {
      assetCode: ASSET,
      chain: CHAIN,
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    const dryBody = await depositJson(dry);
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.applied).toBe(false);
    expect(dryBody.credited).toBe('5000000');
    expect(poolOf(inventory).total).toBe(15_000_000n);

    const real = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(real.status).toBe(dry.status);
    expect((await depositJson(real)).credited).toBe(dryBody.credited);
    expect(poolOf(inventory).total).toBe(20_000_000n);
  });

  it('[P1] a refusal predicted by dryRun carries the same status as the real call', async () => {
    const { app } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 15_000_000n } },
      adminToken: TOKEN,
    });

    const dry = await post(app, {
      assetCode: ASSET,
      chain: CHAIN,
      dryRun: true,
    });
    const real = await post(app, { assetCode: ASSET, chain: CHAIN });
    expect(dry.status).toBe(409);
    expect(real.status).toBe(409);
  });

  it('[P1] rejects a malformed body before touching the chain', async () => {
    const { app } = setup({
      positions: { [CHANNEL]: { cumulativePaid: 0n, deposit: 20_000_000n } },
      adminToken: TOKEN,
    });

    expect((await post(app, { chain: CHAIN })).status).toBe(400);
    expect((await post(app, { assetCode: ASSET })).status).toBe(400);
    expect(
      (await post(app, { assetCode: ASSET, chain: CHAIN, amount: '0' })).status
    ).toBe(400);
    expect(
      (await post(app, { assetCode: ASSET, chain: CHAIN, amount: 'many' }))
        .status
    ).toBe(400);
    expect(
      (await post(app, { assetCode: ASSET, chain: CHAIN, dryRun: 'yes' }))
        .status
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The production wiring, end to end
// ---------------------------------------------------------------------------

describe('the route against the REAL reader behind the REAL dispatcher', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    );
  });

  /** Serves a `channels()` struct whose capital words the test mutates live. */
  async function startChannelRpc(position: ChannelFundingPosition) {
    const w = (hex: string) => hex.toLowerCase().padStart(64, '0');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        // TokenNetwork.participants(): (deposit, nonce, transferredAmount) —
        // `deposit` is the TOTAL ever placed, so funded = cumulativePaid + remaining.
        const words = [
          w((position.cumulativePaid + position.deposit).toString(16)),
          w('3'),
          w(position.cumulativePaid.toString(16)),
        ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + words.join('') })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a bound TCP address');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it('[P0] the funding capability survives composition, so the route is not silently dead', async () => {
    // swap#141 composes per-family readers into one dispatching reader. A
    // dispatcher that forwarded only the capabilities it happened to NAME
    // would drop `getFundingPosition` and make this route answer 503 on every
    // chain — fail-closed, but dead with nothing explaining why. #141's
    // dispatcher forwards by capability union; #141's own tests pin that with
    // STUB readers, which would still pass if the real EVM reader lost the
    // method. This pins the real one, through the real dispatcher.
    const chain = 'evm:31337';
    const rpcUrl = await startChannelRpc({
      cumulativePaid: 1_000n,
      deposit: 14_999_000n,
    });
    const composed = composeChannelOnChainReaders({
      evm: createEvmChannelOnChainReader([
        {
          chainId: chain,
          rpcUrl,
          tokenNetworkAddress: '0x' + '33'.repeat(20),
          makerAddress: '0x' + '55'.repeat(20),
        },
      ]),
    });
    expect(typeof composed?.getFundingPosition).toBe('function');

    const inventory = new SwapInventory({
      balances: {
        [`${ASSET}:${chain}`]: { available: 15_000_000n, total: 15_000_000n },
      },
    });
    const reconciler = new SwapInventoryReconciler({
      inventory,
      channelState: new SwapChannelState({
        channels: {
          [`${ASSET}:${chain}:${CHANNEL}`]: {
            channelId: CHANNEL,
            cumulativeAmount: 1_000n,
            nonce: 1n,
            updatedAt: 0,
          },
        },
      }),
      ...(composed && { reader: composed }),
    });
    const app = makeAdminApp({ inventory, reconciler, adminToken: TOKEN });

    const res = await app.request('/admin/inventory/deposit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ assetCode: ASSET, chain }),
    });

    // Reaching a corroboration verdict at all is the point: a dropped
    // capability would have produced 503 `funding_unreadable` instead.
    expect(res.status).toBe(409);
    const body = (await res.json()) as DepositJsonBody;
    expect(body.error).toBe('uncorroborated');
    // ...and the sum is cumulativePaid + deposit, decoded off a real eth_call.
    expect(body.chainFundedTotal).toBe('15000000');
  });
});
