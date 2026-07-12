/**
 * Inventory tests — Story 12.4 AC-4, AC-11 (inventory block).
 *
 * T-033 / T-034 / T-037 / T-inv-1 — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect } from 'vitest';

import { SwapInventory } from './inventory.js';
import { SwapInventoryError } from './errors.js';

const USDC_EVM_BASE = { asset: 'USDC', chain: 'evm:base:8453' };

describe('SwapInventory — in-memory per-pair reserves (Story 12.4 AC-4)', () => {
  it('[P0] (T-033) debit decreases available; total is preserved', () => {
    // Arrange
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });

    // Act
    inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 30n);

    // Assert
    const bal = inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain);
    expect(bal).not.toBeNull();
    expect(bal!.available).toBe(70n);
    expect(bal!.total).toBe(100n);
  });

  it("[P0] (T-034) insufficient inventory throws SwapInventoryError('INSUFFICIENT_INVENTORY'); state unchanged (transactional)", () => {
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 50n,
          total: 50n,
        },
      },
    });

    expect(() =>
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 100n)
    ).toThrow(SwapInventoryError);

    try {
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 100n);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INSUFFICIENT_INVENTORY');
    }

    const bal = inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain);
    expect(bal!.available).toBe(50n);
    expect(bal!.total).toBe(50n);
  });

  it('[P0] (T-037) credit increases available and total', () => {
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 70n,
          total: 100n,
        },
      },
    });

    inv.credit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 40n);

    const bal = inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain);
    expect(bal!.available).toBe(110n);
    expect(bal!.total).toBe(140n);
  });

  it("[P1] debit on uninitialized pair throws SwapInventoryError('INVENTORY_NOT_INITIALIZED')", () => {
    const inv = new SwapInventory({ balances: {} });
    try {
      inv.debit('USDC', 'solana:mainnet', 10n);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SwapInventoryError);
      expect((err as { code?: string }).code).toBe('INVENTORY_NOT_INITIALIZED');
    }
  });

  it('[P0] (T-inv-1) concurrent debit race: Promise.all([debit(60), debit(60)]) with 100n → one throws, other succeeds, final available=40n', async () => {
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });

    const tryDebit = (amt: bigint): Promise<'ok' | 'err'> =>
      Promise.resolve().then(() => {
        try {
          inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, amt);
          return 'ok';
        } catch {
          return 'err';
        }
      });

    const results = await Promise.all([tryDebit(60n), tryDebit(60n)]);
    const okCount = results.filter((r) => r === 'ok').length;
    const errCount = results.filter((r) => r === 'err').length;

    expect(okCount).toBe(1);
    expect(errCount).toBe(1);
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.available).toBe(
      40n
    );
  });

  it("[P1] debit with non-positive amount throws SwapInventoryError('INSUFFICIENT_INVENTORY')", () => {
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });

    expect(() =>
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, -5n)
    ).toThrow(SwapInventoryError);
    expect(() =>
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 0n)
    ).toThrow(SwapInventoryError);
  });

  it('[P2] snapshot returns deep-copied entries; mutating the snapshot does not mutate inventory', () => {
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });

    const snap = inv.snapshot();
    (snap as unknown as { available: bigint }[])[0]!.available = 0n;

    const bal = inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain);
    expect(bal!.available).toBe(100n);
  });

  // -------------------------------------------------------------------------
  // Gap-fill tests (AC-4 contract clauses not yet covered above)
  // -------------------------------------------------------------------------

  it('[P1] credit on a missing pair CREATES the entry (AC-4 contract: "Creates the entry if missing")', () => {
    const inv = new SwapInventory({ balances: {} });
    expect(inv.get('SOL', 'solana:mainnet')).toBeNull();

    inv.credit('SOL', 'solana:mainnet', 25n);

    const bal = inv.get('SOL', 'solana:mainnet');
    expect(bal).not.toBeNull();
    expect(bal!.available).toBe(25n);
    expect(bal!.total).toBe(25n);
  });

  it("[P1] credit with non-positive amount throws SwapInventoryError('UNKNOWN_PAIR') — NOT 'INSUFFICIENT_INVENTORY' (invalid input is not a reserves shortage; must not map to ILP T04)", () => {
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });
    expect(() =>
      inv.credit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 0n)
    ).toThrow(SwapInventoryError);
    try {
      inv.credit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, -10n);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SwapInventoryError);
      // Invalid-input on credit is NOT a reserves shortage — handler must
      // NOT map this to ILP T04 Insufficient liquidity.
      expect((err as SwapInventoryError).code).toBe('UNKNOWN_PAIR');
    }
    // state unchanged
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.available).toBe(
      100n
    );
  });

  it('[P1] get() returns null for uninitialized pair', () => {
    const inv = new SwapInventory({ balances: {} });
    expect(inv.get('USDC', 'evm:arbitrum:42161')).toBeNull();
  });

  it('[P2] custom clock is used for updatedAt on both init and mutations', () => {
    let now = 1_000;
    const inv = new SwapInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
      clock: () => now,
    });
    // init timestamp is from clock
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.updatedAt).toBe(
      1_000
    );

    now = 2_500;
    inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 10n);
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.updatedAt).toBe(
      2_500
    );

    now = 4_000;
    inv.credit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 5n);
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.updatedAt).toBe(
      4_000
    );
  });

  it('[P2] snapshot round-trips asset/chain parsing even when chain contains colons (e.g. evm:base:8453)', () => {
    const inv = new SwapInventory({
      balances: {
        'USDC:evm:base:8453': { available: 1n, total: 1n },
        'SOL:solana:mainnet': { available: 2n, total: 2n },
      },
    });
    const snap = inv.snapshot();
    const usdc = snap.find((b) => b.assetCode === 'USDC');
    const sol = snap.find((b) => b.assetCode === 'SOL');
    expect(usdc?.chain).toBe('evm:base:8453');
    expect(sol?.chain).toBe('solana:mainnet');
  });
});

// ---------------------------------------------------------------------------
// Issue #49 — in-flight window reservation lifecycle
// ---------------------------------------------------------------------------

describe('SwapInventory — in-flight window (issue #49)', () => {
  const ASSET = 'ETH';
  const CHAIN = 'evm:base:8453';
  const KEY = `${ASSET}:${CHAIN}`;

  function build(opts?: {
    windowBudget?: bigint;
    available?: bigint;
    now?: () => number;
    defaultReservationTtlMs?: number;
  }) {
    return new SwapInventory({
      balances: {
        [KEY]: {
          available: opts?.available ?? 1_000n,
          total: opts?.available ?? 1_000n,
          ...(opts?.windowBudget !== undefined && {
            windowBudget: opts.windowBudget,
          }),
        },
      },
      ...(opts?.now && { clock: opts.now }),
      ...(opts?.defaultReservationTtlMs !== undefined && {
        defaultReservationTtlMs: opts.defaultReservationTtlMs,
      }),
    });
  }

  function windowOf(inv: SwapInventory) {
    return inv
      .windowSnapshot()
      .find((w) => w.assetCode === ASSET && w.chain === CHAIN)!;
  }

  it('[P0] reserve → commit lifecycle: capacity formula budget − inFlight − unsettled', () => {
    const inv = build({ windowBudget: 100n });
    const w0 = windowOf(inv);
    expect(w0).toMatchObject({
      budget: 100n,
      inFlight: 0n,
      unsettled: 0n,
      free: 100n,
    });

    const { reservationId } = inv.reserve({
      assetCode: ASSET,
      chain: CHAIN,
      amount: 60n,
    });
    expect(windowOf(inv)).toMatchObject({ inFlight: 60n, free: 40n });
    // available untouched — reservations are not debits.
    expect(inv.get(ASSET, CHAIN)!.available).toBe(1_000n);

    expect(
      inv.commitReservation({
        reservationId,
        assetCode: ASSET,
        chain: CHAIN,
        amount: 60n,
      })
    ).toBe('committed');
    expect(windowOf(inv)).toMatchObject({
      inFlight: 0n,
      unsettled: 60n,
      free: 40n,
    });
  });

  it('[P0] capacity refusal: INSUFFICIENT_INVENTORY when the window cannot fit the amount', () => {
    const inv = build({ windowBudget: 100n });
    inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 80n });
    expect(() =>
      inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 30n })
    ).toThrowError(SwapInventoryError);
    try {
      inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 30n });
    } catch (err) {
      expect((err as SwapInventoryError).code).toBe('INSUFFICIENT_INVENTORY');
      expect((err as Error).message).toMatch(/window capacity/);
    }
    // Non-positive amounts and unknown pools are rejected.
    expect(() =>
      inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 0n })
    ).toThrowError(/positive/);
    expect(() =>
      inv.reserve({ assetCode: 'BTC', chain: CHAIN, amount: 1n })
    ).toThrowError(/not initialized/);
  });

  it('[P0] the effective budget is clamped to available (a budget cannot advertise capital the maker lacks; legacy debits shrink it)', () => {
    const inv = build({ windowBudget: 5_000n, available: 1_000n });
    expect(windowOf(inv).budget).toBe(1_000n);
    // A legacy permanent debit shrinks the rolling ceiling too.
    inv.debit(ASSET, CHAIN, 400n);
    expect(windowOf(inv).budget).toBe(600n);
    expect(() =>
      inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 601n })
    ).toThrowError(/window capacity/);
    // Absent windowBudget → ceiling degrades to available.
    const noBudget = build();
    expect(windowOf(noBudget).budget).toBe(1_000n);
  });

  it('[P0] TTL expiry frees a stalled reservation slot', () => {
    let now = 0;
    const inv = build({ windowBudget: 100n, now: () => now });
    inv.reserve({
      assetCode: ASSET,
      chain: CHAIN,
      amount: 100n,
      ttlMs: 500,
      id: 'stalled',
    });
    expect(() =>
      inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 1n })
    ).toThrowError(/window capacity/);
    now = 501;
    expect(windowOf(inv).inFlight).toBe(0n);
    expect(
      inv.reserve({ assetCode: ASSET, chain: CHAIN, amount: 100n })
        .reservationId
    ).toBeTruthy();
    // The expired reservation is gone: releasing it reports false.
    expect(inv.releaseReservation('stalled')).toBe(false);
  });

  it('[P0] releaseReservation is exactly-once', () => {
    const inv = build();
    const { reservationId } = inv.reserve({
      assetCode: ASSET,
      chain: CHAIN,
      amount: 10n,
    });
    expect(inv.releaseReservation(reservationId)).toBe(true);
    expect(inv.releaseReservation(reservationId)).toBe(false);
    expect(windowOf(inv).inFlight).toBe(0n);
  });

  it('[P1] recordSettlement: monotone per channel, clamps to unsettled, recycles capacity', () => {
    const inv = build({ windowBudget: 100n });
    const { reservationId } = inv.reserve({
      assetCode: ASSET,
      chain: CHAIN,
      amount: 100n,
    });
    inv.commitReservation({
      reservationId,
      assetCode: ASSET,
      chain: CHAIN,
      amount: 100n,
    });
    expect(windowOf(inv).free).toBe(0n);

    // Partial settlement (cumulative watermark 40).
    expect(
      inv.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: 'chan-1',
        cumulativeAmount: 40n,
      })
    ).toBe(40n);
    expect(windowOf(inv)).toMatchObject({ unsettled: 60n, free: 40n });

    // Replay / stale confirmation → 0n no-op.
    expect(
      inv.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: 'chan-1',
        cumulativeAmount: 40n,
      })
    ).toBe(0n);
    expect(
      inv.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: 'chan-1',
        cumulativeAmount: 30n,
      })
    ).toBe(0n);
    expect(windowOf(inv).unsettled).toBe(60n);

    // Over-settlement (delta beyond liability) clamps at zero.
    expect(
      inv.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: 'chan-1',
        cumulativeAmount: 500n,
      })
    ).toBe(60n);
    expect(windowOf(inv)).toMatchObject({ unsettled: 0n, free: 100n });
  });

  it('[P1] reservations + watermarks + unsettled round-trip through snapshots (rehydration)', () => {
    let now = 1_000;
    const inv = build({ windowBudget: 100n, now: () => now });
    inv.reserve({
      assetCode: ASSET,
      chain: CHAIN,
      amount: 25n,
      ttlMs: 60_000,
      id: 'live-1',
    });
    const c = inv.reserve({
      assetCode: ASSET,
      chain: CHAIN,
      amount: 30n,
    });
    inv.commitReservation({
      reservationId: c.reservationId,
      assetCode: ASSET,
      chain: CHAIN,
      amount: 30n,
    });
    inv.recordSettlement({
      assetCode: ASSET,
      chain: CHAIN,
      channelId: 'chan-9',
      cumulativeAmount: 10n,
    });

    const rehydrated = new SwapInventory({
      balances: Object.fromEntries(
        inv.snapshot().map((b) => [
          `${b.assetCode}:${b.chain}`,
          {
            available: b.available,
            total: b.total,
            unsettled: b.unsettled,
            ...(b.windowBudget !== undefined && {
              windowBudget: b.windowBudget,
            }),
            updatedAt: b.updatedAt,
          },
        ])
      ),
      reservations: inv.reservationsSnapshot(),
      settledWatermarks: inv.settledWatermarksSnapshot(),
      clock: () => now,
    });
    expect(windowOf(rehydrated)).toEqual(windowOf(inv));
    // Watermark monotonicity survives: the replayed confirmation stays a no-op.
    expect(
      rehydrated.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: 'chan-9',
        cumulativeAmount: 10n,
      })
    ).toBe(0n);
    // Expire-and-release applies to rehydrated reservations too.
    now = 1_000 + 60_001;
    expect(windowOf(rehydrated).inFlight).toBe(0n);
  });
});
