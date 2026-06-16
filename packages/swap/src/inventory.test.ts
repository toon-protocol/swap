/**
 * Inventory tests — Story 12.4 AC-4, AC-11 (inventory block).
 *
 * T-033 / T-034 / T-037 / T-inv-1 — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect } from 'vitest';

import { MillInventory } from './inventory.js';
import { MillInventoryError } from './errors.js';

const USDC_EVM_BASE = { asset: 'USDC', chain: 'evm:base:8453' };

describe('MillInventory — in-memory per-pair reserves (Story 12.4 AC-4)', () => {
  it('[P0] (T-033) debit decreases available; total is preserved', () => {
    // Arrange
    const inv = new MillInventory({
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

  it("[P0] (T-034) insufficient inventory throws MillInventoryError('INSUFFICIENT_INVENTORY'); state unchanged (transactional)", () => {
    const inv = new MillInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 50n,
          total: 50n,
        },
      },
    });

    expect(() =>
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 100n)
    ).toThrow(MillInventoryError);

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
    const inv = new MillInventory({
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

  it("[P1] debit on uninitialized pair throws MillInventoryError('INVENTORY_NOT_INITIALIZED')", () => {
    const inv = new MillInventory({ balances: {} });
    try {
      inv.debit('USDC', 'solana:mainnet', 10n);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MillInventoryError);
      expect((err as { code?: string }).code).toBe('INVENTORY_NOT_INITIALIZED');
    }
  });

  it('[P0] (T-inv-1) concurrent debit race: Promise.all([debit(60), debit(60)]) with 100n → one throws, other succeeds, final available=40n', async () => {
    const inv = new MillInventory({
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

  it("[P1] debit with non-positive amount throws MillInventoryError('INSUFFICIENT_INVENTORY')", () => {
    const inv = new MillInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });

    expect(() =>
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, -5n)
    ).toThrow(MillInventoryError);
    expect(() =>
      inv.debit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 0n)
    ).toThrow(MillInventoryError);
  });

  it('[P2] snapshot returns deep-copied entries; mutating the snapshot does not mutate inventory', () => {
    const inv = new MillInventory({
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
    const inv = new MillInventory({ balances: {} });
    expect(inv.get('SOL', 'solana:mainnet')).toBeNull();

    inv.credit('SOL', 'solana:mainnet', 25n);

    const bal = inv.get('SOL', 'solana:mainnet');
    expect(bal).not.toBeNull();
    expect(bal!.available).toBe(25n);
    expect(bal!.total).toBe(25n);
  });

  it("[P1] credit with non-positive amount throws MillInventoryError('UNKNOWN_PAIR') — NOT 'INSUFFICIENT_INVENTORY' (invalid input is not a reserves shortage; must not map to ILP T04)", () => {
    const inv = new MillInventory({
      balances: {
        [`${USDC_EVM_BASE.asset}:${USDC_EVM_BASE.chain}`]: {
          available: 100n,
          total: 100n,
        },
      },
    });
    expect(() =>
      inv.credit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, 0n)
    ).toThrow(MillInventoryError);
    try {
      inv.credit(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain, -10n);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MillInventoryError);
      // Invalid-input on credit is NOT a reserves shortage — handler must
      // NOT map this to ILP T04 Insufficient liquidity.
      expect((err as MillInventoryError).code).toBe('UNKNOWN_PAIR');
    }
    // state unchanged
    expect(inv.get(USDC_EVM_BASE.asset, USDC_EVM_BASE.chain)!.available).toBe(
      100n
    );
  });

  it('[P1] get() returns null for uninitialized pair', () => {
    const inv = new MillInventory({ balances: {} });
    expect(inv.get('USDC', 'evm:arbitrum:42161')).toBeNull();
  });

  it('[P2] custom clock is used for updatedAt on both init and mutations', () => {
    let now = 1_000;
    const inv = new MillInventory({
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
    const inv = new MillInventory({
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
