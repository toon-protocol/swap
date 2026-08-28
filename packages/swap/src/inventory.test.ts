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

  it('[P1] get() returns null for uninitialized pair', () => {
    const inv = new SwapInventory({ balances: {} });
    expect(inv.get('USDC', 'evm:arbitrum:42161')).toBeNull();
  });

  it('[P2] custom clock is used for updatedAt on both init and reservation mutations', () => {
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
    const { reservationId } = inv.reserve({
      assetCode: USDC_EVM_BASE.asset,
      chain: USDC_EVM_BASE.chain,
      amount: 10n,
    });
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.updatedAt).toBe(
      2_500
    );

    now = 4_000;
    inv.commitReservation({
      reservationId,
      assetCode: USDC_EVM_BASE.asset,
      chain: USDC_EVM_BASE.chain,
      amount: 10n,
    });
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

  it('[P0] the effective budget is clamped to available (a budget cannot advertise capital the maker lacks)', () => {
    const inv = build({ windowBudget: 5_000n, available: 600n });
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

// ---------------------------------------------------------------------------
// Issue #138 — chain-corroborated settle-and-recycle
// ---------------------------------------------------------------------------

describe('SwapInventory.recordChainRedemption (issue #138)', () => {
  const ASSET = 'ETH';
  const CHAIN = 'evm:base:8453';
  const KEY = `${ASSET}:${CHAIN}`;
  const CHANNEL = 'chan-1';

  /** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
  function poolOf(inv: SwapInventory) {
    const entry = inv.get(ASSET, CHAIN);
    if (!entry) throw new Error('expected a pool balance');
    return entry;
  }

  function build(p: { available: bigint; total: bigint; unsettled?: bigint }) {
    return new SwapInventory({
      balances: {
        [KEY]: {
          available: p.available,
          total: p.total,
          ...(p.unsettled !== undefined && { unsettled: p.unsettled }),
        },
      },
    });
  }

  it('[P0] a redemption releases liability first and leaves `available` alone', () => {
    const inv = build({ available: 1_000n, total: 1_000n, unsettled: 400n });

    const out = inv.recordChainRedemption({
      assetCode: ASSET,
      chain: CHAIN,
      channelId: CHANNEL,
      redeemedCumulative: 300n,
    });

    expect(out).toEqual({
      delta: 300n,
      liabilityReduced: 300n,
      availableRestored: 0n,
    });
    expect(poolOf(inv).unsettled).toBe(100n);
    expect(poolOf(inv).available).toBe(1_000n);
  });

  it('[P0] redeemed value with no liability behind it heals a legacy permanent debit', () => {
    // The live symptom: `available` burned by pre-#138 legacy debits while
    // `unsettled` stayed at 0.
    const inv = build({
      available: 992_000n,
      total: 1_000_000n,
      unsettled: 0n,
    });

    const out = inv.recordChainRedemption({
      assetCode: ASSET,
      chain: CHAIN,
      channelId: CHANNEL,
      redeemedCumulative: 8_000n,
    });

    expect(out.availableRestored).toBe(8_000n);
    expect(poolOf(inv).available).toBe(1_000_000n);
  });

  it('[P0] the recycle can NEVER push `available` past `total`', () => {
    const inv = build({ available: 1_000n, total: 1_000n, unsettled: 0n });

    const out = inv.recordChainRedemption({
      assetCode: ASSET,
      chain: CHAIN,
      channelId: CHANNEL,
      redeemedCumulative: 999_999n,
    });

    expect(out.availableRestored).toBe(0n);
    expect(poolOf(inv).available).toBe(1_000n);
    expect(poolOf(inv).total).toBe(1_000n);
  });

  it('[P0] monotone per channel: a replayed or regressing watermark credits nothing', () => {
    const inv = build({ available: 900n, total: 1_000n, unsettled: 0n });

    expect(
      inv.recordChainRedemption({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: CHANNEL,
        redeemedCumulative: 100n,
      }).availableRestored
    ).toBe(100n);
    expect(
      inv.recordChainRedemption({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: CHANNEL,
        redeemedCumulative: 100n,
      })
    ).toEqual({ delta: 0n, liabilityReduced: 0n, availableRestored: 0n });
    expect(
      inv.recordChainRedemption({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: CHANNEL,
        redeemedCumulative: 40n,
      }).delta
    ).toBe(0n);
    expect(poolOf(inv).available).toBe(1_000n);
  });

  it('[P0] an unverified SettlementEvent (recordSettlement) never restores `available`', () => {
    const inv = build({ available: 900n, total: 1_000n, unsettled: 0n });

    // A counterparty-asserted settlement: liability-only, so a lie cannot
    // manufacture capital.
    expect(
      inv.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: CHANNEL,
        cumulativeAmount: 100n,
      })
    ).toBe(0n);
    expect(poolOf(inv).available).toBe(900n);
  });

  it('[P1] preview mutates nothing but reports the same numbers', () => {
    const inv = build({ available: 950n, total: 1_000n, unsettled: 0n });
    const args = {
      assetCode: ASSET,
      chain: CHAIN,
      channelId: CHANNEL,
      redeemedCumulative: 50n,
    };

    const preview = inv.previewChainRedemption(args);
    expect(preview.availableRestored).toBe(50n);
    expect(poolOf(inv).available).toBe(950n);
    expect(inv.recordChainRedemption(args)).toEqual(preview);
  });

  it('[P1] an unknown pool throws INVENTORY_NOT_INITIALIZED (fails closed)', () => {
    const inv = build({ available: 100n, total: 100n });
    expect(() =>
      inv.recordChainRedemption({
        assetCode: 'NOPE',
        chain: CHAIN,
        channelId: CHANNEL,
        redeemedCumulative: 1n,
      })
    ).toThrow(SwapInventoryError);
  });
});
