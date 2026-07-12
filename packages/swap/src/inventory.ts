/**
 * `SwapInventory` — in-memory per-pair reserves (Story 12.4 AC-4).
 *
 * Single-threaded microtask atomicity: `debit` / `credit` are synchronous and
 * therefore atomic w.r.t. concurrent `issueClaim` callers under `Promise.all`.
 * See Dev Notes "Microtask atomicity argument" in the story doc.
 */

import { SwapInventoryError } from './errors.js';

export interface SwapInventoryBalance {
  assetCode: string;
  chain: string;
  available: bigint;
  total: bigint;
  updatedAt: number;
}

export interface SwapInventoryInit {
  balances: Record<string, { available: bigint; total: bigint }>;
  clock?: () => number;
}

interface InternalEntry {
  available: bigint;
  total: bigint;
  updatedAt: number;
}

function key(assetCode: string, chain: string): string {
  return `${assetCode}:${chain}`;
}

function parseKey(k: string): { assetCode: string; chain: string } {
  // assetCode:chain — chain may itself contain colons (e.g. evm:base:8453).
  const i = k.indexOf(':');
  if (i < 0) {
    return { assetCode: k, chain: '' };
  }
  return { assetCode: k.slice(0, i), chain: k.slice(i + 1) };
}

export class SwapInventory {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly clock: () => number;

  constructor(init: SwapInventoryInit) {
    this.clock = init.clock ?? Date.now;
    const now = this.clock();
    for (const [k, v] of Object.entries(init.balances)) {
      this.entries.set(k, {
        available: v.available,
        total: v.total,
        updatedAt: now,
      });
    }
  }

  get(assetCode: string, chain: string): SwapInventoryBalance | null {
    const e = this.entries.get(key(assetCode, chain));
    if (!e) return null;
    return {
      assetCode,
      chain,
      available: e.available,
      total: e.total,
      updatedAt: e.updatedAt,
    };
  }

  /**
   * Atomically debit `amount` from `(assetCode, chain).available`.
   * Synchronous — no `await` — so concurrent callers see a consistent view.
   */
  debit(assetCode: string, chain: string, amount: bigint): void {
    if (amount <= 0n) {
      throw new SwapInventoryError(
        'INSUFFICIENT_INVENTORY',
        'Debit amount must be positive'
      );
    }
    const k = key(assetCode, chain);
    const entry = this.entries.get(k);
    if (!entry) {
      throw new SwapInventoryError(
        'INVENTORY_NOT_INITIALIZED',
        `Inventory not initialized for ${k}`
      );
    }
    if (entry.available < amount) {
      throw new SwapInventoryError(
        'INSUFFICIENT_INVENTORY',
        `Insufficient inventory for ${k}: have ${entry.available}, need ${amount}`
      );
    }
    entry.available -= amount;
    entry.updatedAt = this.clock();
  }

  /**
   * Credit `amount` to `(assetCode, chain).available` and `.total`.
   * Creates the entry if missing. Synchronous — atomic under concurrent use.
   */
  credit(assetCode: string, chain: string, amount: bigint): void {
    if (amount <= 0n) {
      // Invalid-input guard for credit. Uses UNKNOWN_PAIR (the non-
      // "insufficient" code in SwapInventoryErrorCode) so the handler's
      // /insufficient/i.test(err.message) and `err.code === 'INSUFFICIENT_INVENTORY'`
      // branches do NOT fire — a negative-credit is an operator bug, not a
      // reserves shortage, and should NOT be mapped to ILP T04.
      throw new SwapInventoryError(
        'UNKNOWN_PAIR',
        'Credit amount must be positive'
      );
    }
    const k = key(assetCode, chain);
    const entry = this.entries.get(k);
    const now = this.clock();
    if (!entry) {
      this.entries.set(k, {
        available: amount,
        total: amount,
        updatedAt: now,
      });
      return;
    }
    entry.available += amount;
    entry.total += amount;
    entry.updatedAt = now;
  }

  snapshot(): readonly SwapInventoryBalance[] {
    const out: SwapInventoryBalance[] = [];
    for (const [k, e] of this.entries.entries()) {
      const { assetCode, chain } = parseKey(k);
      out.push({
        assetCode,
        chain,
        available: e.available,
        total: e.total,
        updatedAt: e.updatedAt,
      });
    }
    return out;
  }
}
