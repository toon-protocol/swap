/**
 * `SwapInventory` — per-pair reserves + in-flight window reservations.
 *
 * Single-threaded microtask atomicity: every mutator is synchronous and
 * therefore atomic w.r.t. concurrent `issueClaim` callers under `Promise.all`.
 * See Dev Notes "Microtask atomicity argument" in the story doc.
 *
 * ## ONE capital model on one surface (issue #49, unified by issue #138)
 *
 * Both claim paths — legacy gift-wrap and rolling coupled-leg — now use the
 * **in-flight window reservation lifecycle** (toon-meta#145 /
 * rolling-swap.md §8). A claim `reserve`s its leg-B amount while it is being
 * issued, then either
 *   - **commits** (claim handed to the counterparty → the amount becomes
 *     *unsettled channel liability*, shrunk later when the chain shows the
 *     claim redeemed — {@link recordChainRedemption}), or
 *   - **releases** (reject / rollback / TTL expiry → capacity returns).
 *
 * Nothing ever debits `available` permanently on either path: what was a
 * notional-sized pre-fund becomes working capital cycling through settlement
 * (spec §8 "settle-and-recycle replaces manual refill").
 *
 * ### Why the legacy permanent debit was removed (issue #138)
 *
 * {@link debit} shrinks `available` for good and the legacy path never
 * populated `unsettled`, so {@link recordSettlement} — the only recycler —
 * could never give the capital back. A legacy maker's `available` therefore
 * ratcheted monotonically toward zero over its lifetime and then refused
 * every request with T04 *no matter how faithfully its counterparties
 * redeemed on chain*, with no in-process way to restore it. `debit` /
 * {@link credit} survive as operator-facing primitives (manual write-down /
 * genuinely new capital) but are no longer on any issuance path.
 *
 * ### Healing a maker that already burned inventory
 *
 * Deployments upgrading from the permanent-debit build carry a burn:
 * `total − available` is exactly the sum of past legacy debits (config seeds
 * `available === total`, and `credit` raises both). Those debits correspond
 * one-for-one to issued claims, so {@link recordChainRedemption} recycles the
 * redeemed portion back into `available` — bounded twice over: by the
 * newly-redeemed delta the chain reports, and by `total` (a recycle can never
 * push `available` above `total`). Value that was debited but is still
 * unredeemed stays blocked, which is the same capacity block the unified
 * model expresses as `unsettled`.
 *
 * ## Capacity formula (spec §8)
 *
 * ```
 * effectiveBudget = min(windowBudget ?? available, available)
 * free            = effectiveBudget − inFlight − unsettled
 * ```
 *
 * `windowBudget` is the operator-advertised in-flight ceiling (δ_max·W_max·R
 * plus a settlement-latency buffer). It is clamped to `available` so a
 * misconfigured budget can never advertise capital the maker does not hold.
 * Both paths draw on this one formula against the same real pool (issue
 * #138), so a legacy claim and a rolling fill compete for identical capacity.
 * Without an explicit budget the ceiling degrades to `available` — which is
 * exactly the threshold the legacy `debit` used to enforce, so removing the
 * permanent debit did not loosen any refusal.
 *
 * ## Reservation TTLs
 *
 * Every reservation carries an expiry. The rolling engine sizes it to its
 * leg-B round-trip budget plus a grace margin (spec R7 alignment), so a
 * crashed or stalled packet frees its window slot once the packet could not
 * possibly fulfill anymore. Expired reservations are pruned lazily on every
 * window operation; a commit that arrives after its reservation expired is
 * still recorded as liability (`'late'`) — an already-revealed claim must
 * never be under-counted just because the clock ran out.
 */

import { SwapInventoryError } from './errors.js';

export interface SwapInventoryBalance {
  assetCode: string;
  chain: string;
  available: bigint;
  total: bigint;
  /** Committed-but-unsettled channel liability (both claim paths, issue #138). */
  unsettled: bigint;
  /** Operator-configured in-flight window ceiling (absent → `available`). */
  windowBudget?: bigint;
  updatedAt: number;
}

/** One (assetCode, chain) row of the three-bucket window view (spec §8). */
export interface SwapWindowSnapshotEntry {
  assetCode: string;
  chain: string;
  /** Effective ceiling: `min(windowBudget ?? available, available)`. */
  budget: bigint;
  /** Σ live (unexpired) reservations. */
  inFlight: bigint;
  /** Committed liability awaiting on-chain settlement confirmation. */
  unsettled: bigint;
  /** `budget − inFlight − unsettled` (clamped at 0). */
  free: bigint;
  updatedAt: number;
}

export interface SwapInventoryReservation {
  /** `${assetCode}:${chain}` of the reserved pool. */
  key: string;
  amount: bigint;
  /** ms-epoch after which the reservation no longer occupies the window. */
  expiresAt: number;
}

export interface SwapInventoryInit {
  balances: Record<
    string,
    /** `updatedAt` — issue #46: preserved on rehydration from a persisted snapshot; defaults to `clock()` when omitted. */
    {
      available: bigint;
      total: bigint;
      updatedAt?: number;
      /** Issue #49 — in-flight window ceiling (operator config; config wins over snapshots). */
      windowBudget?: bigint;
      /** Issue #49 — rehydrated unsettled liability. Defaults to 0n. */
      unsettled?: bigint;
    }
  >;
  /**
   * Issue #49 — rehydrated in-flight reservations (keyed by reservation id).
   * Crash-recovery rule: rehydrated reservations are honored until their
   * persisted `expiresAt` and then expire-and-release — no engine survives a
   * restart to commit them, so the TTL frees the leaked capacity while the
   * write-ahead channel watermark (which never regresses) prevents any
   * double-spend. See `state-store.ts` crash rule 6.
   */
  reservations?: Record<string, SwapInventoryReservation>;
  /**
   * Issue #49 — highest settled cumulative watermark per
   * `${assetCode}:${chain}:${channelId}`, so replayed / out-of-order
   * settlement confirmations cannot double-shrink the liability.
   */
  settledWatermarks?: Record<string, bigint>;
  /** Fallback reservation TTL when `reserve()` gets no explicit `ttlMs`. */
  defaultReservationTtlMs?: number;
  clock?: () => number;
}

/**
 * Default reservation TTL: 2× the engine's default leg-B budget
 * (`DEFAULT_LEG_B_BUDGET_MS` = 30s) — generous enough that no live packet's
 * reservation can expire under it, small enough that a crashed packet frees
 * its slot within a minute.
 */
export const DEFAULT_RESERVATION_TTL_MS = 60_000;

interface InternalEntry {
  available: bigint;
  total: bigint;
  unsettled: bigint;
  windowBudget?: bigint;
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

/**
 * Issue #138 — what one on-chain redemption watermark did (or would do) to a
 * pool. All three numbers are for the newly-observed delta only.
 */
export interface ChainRedemptionResult {
  /** Newly redeemed since this channel's last recorded watermark. */
  delta: bigint;
  /** Unsettled channel liability released by `delta`. */
  liabilityReduced: bigint;
  /**
   * `available` restored: the part of `delta` that no `unsettled` liability
   * accounted for (⇒ a pre-#138 permanent legacy debit), capped so
   * `available` never exceeds `total`.
   */
  availableRestored: bigint;
}

/** Fresh zero result — never a shared instance a caller could mutate. */
function noRedemption(): ChainRedemptionResult {
  return { delta: 0n, liabilityReduced: 0n, availableRestored: 0n };
}

/** Pure delta math shared by the apply and preview paths. */
function computeRedemption(
  entry: InternalEntry,
  lastWatermark: bigint,
  redeemedCumulative: bigint
): ChainRedemptionResult {
  if (redeemedCumulative <= lastWatermark) return noRedemption();
  const delta = redeemedCumulative - lastWatermark;
  const liabilityReduced = delta < entry.unsettled ? delta : entry.unsettled;
  const unabsorbed = delta - liabilityReduced;
  const headroom =
    entry.total > entry.available ? entry.total - entry.available : 0n;
  const availableRestored = unabsorbed < headroom ? unabsorbed : headroom;
  return { delta, liabilityReduced, availableRestored };
}

function newReservationId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `rsv_${Date.now().toString(36)}_${Math.floor(
    Math.random() * 1e9
  ).toString(36)}`;
}

export class SwapInventory {
  private readonly entries = new Map<string, InternalEntry>();
  /** reservation id → live reservation (pruned lazily on window ops). */
  private readonly reservations = new Map<string, SwapInventoryReservation>();
  /** `${assetCode}:${chain}:${channelId}` → highest settled cumulative. */
  private readonly settledWatermarks = new Map<string, bigint>();
  private readonly defaultReservationTtlMs: number;
  private readonly clock: () => number;

  constructor(init: SwapInventoryInit) {
    this.clock = init.clock ?? Date.now;
    this.defaultReservationTtlMs =
      init.defaultReservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    if (
      !Number.isFinite(this.defaultReservationTtlMs) ||
      this.defaultReservationTtlMs <= 0
    ) {
      throw new SwapInventoryError(
        'UNKNOWN_PAIR',
        'defaultReservationTtlMs must be a positive number'
      );
    }
    const now = this.clock();
    for (const [k, v] of Object.entries(init.balances)) {
      this.entries.set(k, {
        available: v.available,
        total: v.total,
        unsettled: v.unsettled ?? 0n,
        ...(v.windowBudget !== undefined && { windowBudget: v.windowBudget }),
        updatedAt: v.updatedAt ?? now,
      });
    }
    if (init.reservations) {
      for (const [id, r] of Object.entries(init.reservations)) {
        this.reservations.set(id, { ...r });
      }
    }
    if (init.settledWatermarks) {
      for (const [k, v] of Object.entries(init.settledWatermarks)) {
        this.settledWatermarks.set(k, v);
      }
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
      unsettled: e.unsettled,
      ...(e.windowBudget !== undefined && { windowBudget: e.windowBudget }),
      updatedAt: e.updatedAt,
    };
  }

  /**
   * Atomically debit `amount` from `(assetCode, chain).available`.
   * Synchronous — no `await` — so concurrent callers see a consistent view.
   *
   * OPERATOR PRIMITIVE ONLY (permanent write-down). **No issuance path calls
   * this** — as of issue #138 both the legacy and the rolling flow use
   * {@link reserve} / {@link commitReservation} / {@link releaseReservation},
   * so every hold is recyclable by {@link recordChainRedemption}. A permanent
   * debit is unrecoverable without an operator credit and is what made a
   * legacy maker degrade to permanently unusable.
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
   * swap#136 — exact inverse of {@link debit}: restore `amount` to
   * `available` ONLY, leaving `total` untouched.
   *
   * This is the rollback of a permanent {@link debit}, NOT an operator refill.
   * {@link credit} adds NEW capital and therefore raises `total` as well; using
   * it as the unwind ratcheted `total` upward on every failed swap (observed
   * live: a configured 15 000 000 inventory advertising 15 001 000 after one
   * failure, since `total` is what kind:10032 advertises — see
   * `swap-node.ts`'s peer-info builder). A failed swap must be a no-op on
   * BOTH buckets.
   *
   * Issue #138 took the permanent debit off the issuance path entirely, so
   * the failed-swap unwind is now `releaseReservation` and this method is —
   * like `debit` itself — an operator primitive: the way to undo a manual
   * write-down without inventing capital.
   *
   * Deliberately tolerant of a missing entry (a debit always creates/finds
   * one, so this cannot legitimately happen — but a rollback must never
   * throw over the error it is unwinding).
   */
  refundDebit(assetCode: string, chain: string, amount: bigint): void {
    if (amount <= 0n) {
      throw new SwapInventoryError(
        'UNKNOWN_PAIR',
        'Refund amount must be positive'
      );
    }
    const entry = this.entries.get(key(assetCode, chain));
    if (!entry) return;
    entry.available += amount;
    entry.updatedAt = this.clock();
  }

  /**
   * Credit `amount` to `(assetCode, chain).available` and `.total`.
   * Creates the entry if missing. Synchronous — atomic under concurrent use.
   *
   * Operator refill / new capital only. To unwind a failed issuance use
   * {@link refundDebit} — `credit` would inflate `total` (swap#136).
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
        unsettled: 0n,
        updatedAt: now,
      });
      return;
    }
    entry.available += amount;
    entry.total += amount;
    entry.updatedAt = now;
  }

  // -------------------------------------------------------------------------
  // Issue #49 — in-flight window reservation lifecycle
  // -------------------------------------------------------------------------

  /**
   * Reserve `amount` of the (assetCode, chain) in-flight window for one
   * packet. Throws `SwapInventoryError('INSUFFICIENT_INVENTORY')` when the
   * window has no free capacity (`free = effectiveBudget − inFlight −
   * unsettled`) — callers map this to the same benign T04 refusal as a
   * notional shortage.
   *
   * Synchronous → microtask atomic; expired reservations are pruned first,
   * so a stalled packet's slot is reusable the instant its TTL lapses.
   */
  reserve(p: {
    assetCode: string;
    chain: string;
    amount: bigint;
    /** Reservation lifetime; defaults to `defaultReservationTtlMs`. */
    ttlMs?: number;
    /** Caller-supplied id (tests); defaults to a random UUID. */
    id?: string;
  }): { reservationId: string; expiresAt: number } {
    if (p.amount <= 0n) {
      throw new SwapInventoryError(
        'INSUFFICIENT_INVENTORY',
        'Reservation amount must be positive'
      );
    }
    const k = key(p.assetCode, p.chain);
    const entry = this.entries.get(k);
    if (!entry) {
      throw new SwapInventoryError(
        'INVENTORY_NOT_INITIALIZED',
        `Inventory not initialized for ${k}`
      );
    }
    const now = this.clock();
    this.pruneExpired(now);
    const free = this.freeCapacity(k, entry);
    if (free < p.amount) {
      throw new SwapInventoryError(
        'INSUFFICIENT_INVENTORY',
        `Insufficient in-flight window capacity for ${k}: free ${free}, need ${p.amount}`
      );
    }
    const ttlMs = p.ttlMs ?? this.defaultReservationTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new SwapInventoryError(
        'UNKNOWN_PAIR',
        'Reservation ttlMs must be a positive number'
      );
    }
    const reservationId = p.id ?? newReservationId();
    if (this.reservations.has(reservationId)) {
      throw new SwapInventoryError(
        'UNKNOWN_PAIR',
        `Duplicate reservation id ${reservationId}`
      );
    }
    this.reservations.set(reservationId, {
      key: k,
      amount: p.amount,
      expiresAt: now + ttlMs,
    });
    entry.updatedAt = now;
    return { reservationId, expiresAt: now + ttlMs };
  }

  /**
   * Convert a reservation into unsettled channel liability (leg B fulfilled;
   * the counterparty now holds a redeemable claim). Returns `'committed'`
   * normally, or `'late'` when the reservation had already TTL-expired —
   * the liability is recorded anyway (transiently exceeding the window
   * budget) because a revealed claim exists regardless of the local clock.
   */
  commitReservation(p: {
    reservationId: string;
    assetCode: string;
    chain: string;
    amount: bigint;
  }): 'committed' | 'late' {
    const k = key(p.assetCode, p.chain);
    const entry = this.entries.get(k);
    if (!entry) {
      throw new SwapInventoryError(
        'INVENTORY_NOT_INITIALIZED',
        `Inventory not initialized for ${k}`
      );
    }
    const now = this.clock();
    const r = this.reservations.get(p.reservationId);
    if (r) {
      this.reservations.delete(p.reservationId);
      entry.unsettled += r.amount;
      entry.updatedAt = now;
      return 'committed';
    }
    entry.unsettled += p.amount;
    entry.updatedAt = now;
    return 'late';
  }

  /**
   * Release a reservation (reject / rollback / recovery). Exactly-once:
   * returns `true` only for the call that actually removed it; subsequent
   * calls (or a release racing a TTL prune) return `false` and change
   * nothing.
   */
  releaseReservation(reservationId: string): boolean {
    const r = this.reservations.get(reservationId);
    if (!r) return false;
    this.reservations.delete(reservationId);
    const entry = this.entries.get(r.key);
    if (entry) entry.updatedAt = this.clock();
    return true;
  }

  /**
   * Apply a *reported* settlement confirmation: liability shrinks by the
   * watermark delta (`cumulativeAmount − lastSettled(channel)`), clamped to
   * the current unsettled bucket. Monotone per channel — a stale or replayed
   * confirmation (cumulative ≤ last settled) is a no-op returning 0n.
   *
   * Freed liability recycles into window capacity automatically
   * (`free = budget − inFlight − unsettled`): spec §8 settle-and-recycle.
   *
   * This entrypoint does NOT restore `available` (issue #138): its input is a
   * `SettlementEvent` the node did not verify against the chain, so it may
   * only free capacity the node itself booked as liability. Use
   * {@link recordChainRedemption} for watermarks read from the chain.
   */
  recordSettlement(p: {
    assetCode: string;
    chain: string;
    channelId: string;
    cumulativeAmount: bigint;
  }): bigint {
    return this.applyRedemption(p, false).liabilityReduced;
  }

  /**
   * Issue #138 — apply a settlement watermark the node read from the CHAIN
   * ITSELF. Same monotone per-channel delta as {@link recordSettlement}, plus
   * the legacy-burn recycle: any part of the newly-redeemed delta that is NOT
   * absorbed by `unsettled` must have been taken out of `available` by a
   * permanent {@link debit} (the pre-#138 legacy path), so it is restored to
   * `available` — capped at `total`, which a recycle can never exceed.
   *
   * The two caps make over-crediting structurally impossible:
   *   1. only value the chain reports as newly redeemed is ever recycled
   *      (monotone per-channel watermark ⇒ no replay, no double count);
   *   2. `available` can never rise above `total`, so the recycle can never
   *      return more than was actually debited.
   *
   * SAFETY: pass ONLY a `redeemedCumulative` obtained by reading the chain
   * (`ChannelOnChainReader`). A counterparty-asserted settlement must go
   * through {@link recordSettlement}, which releases liability but never
   * restores `available`.
   */
  recordChainRedemption(p: {
    assetCode: string;
    chain: string;
    channelId: string;
    /** LIVE on-chain `cumulativePaid` for this channel. */
    redeemedCumulative: bigint;
  }): ChainRedemptionResult {
    return this.applyRedemption(
      {
        assetCode: p.assetCode,
        chain: p.chain,
        channelId: p.channelId,
        cumulativeAmount: p.redeemedCumulative,
      },
      true
    );
  }

  /**
   * What {@link recordChainRedemption} WOULD do, without mutating anything —
   * the corroboration check behind the operator credit surface (a credit the
   * chain does not corroborate must be refused, not clamped to zero after
   * the watermark has already moved).
   */
  previewChainRedemption(p: {
    assetCode: string;
    chain: string;
    channelId: string;
    redeemedCumulative: bigint;
  }): ChainRedemptionResult {
    const k = key(p.assetCode, p.chain);
    const entry = this.entries.get(k);
    if (!entry) {
      throw new SwapInventoryError(
        'INVENTORY_NOT_INITIALIZED',
        `Inventory not initialized for ${k}`
      );
    }
    return computeRedemption(
      entry,
      this.settledWatermarks.get(`${k}:${p.channelId}`) ?? 0n,
      p.redeemedCumulative
    );
  }

  private applyRedemption(
    p: {
      assetCode: string;
      chain: string;
      channelId: string;
      cumulativeAmount: bigint;
    },
    restoreAvailable: boolean
  ): ChainRedemptionResult {
    const k = key(p.assetCode, p.chain);
    const entry = this.entries.get(k);
    if (!entry) {
      throw new SwapInventoryError(
        'INVENTORY_NOT_INITIALIZED',
        `Inventory not initialized for ${k}`
      );
    }
    const wmKey = `${k}:${p.channelId}`;
    const last = this.settledWatermarks.get(wmKey) ?? 0n;
    const outcome = computeRedemption(entry, last, p.cumulativeAmount);
    if (outcome.delta === 0n) return outcome;
    this.settledWatermarks.set(wmKey, p.cumulativeAmount);
    entry.unsettled -= outcome.liabilityReduced;
    if (restoreAvailable) {
      entry.available += outcome.availableRestored;
    }
    entry.updatedAt = this.clock();
    return restoreAvailable ? outcome : { ...outcome, availableRestored: 0n };
  }

  /** Three-bucket window view per (assetCode, chain) — spec §8 / health. */
  windowSnapshot(): readonly SwapWindowSnapshotEntry[] {
    this.pruneExpired(this.clock());
    const out: SwapWindowSnapshotEntry[] = [];
    for (const [k, e] of this.entries.entries()) {
      const { assetCode, chain } = parseKey(k);
      const budget = this.effectiveBudget(e);
      const inFlight = this.inFlight(k);
      const spoken = inFlight + e.unsettled;
      out.push({
        assetCode,
        chain,
        budget,
        inFlight,
        unsettled: e.unsettled,
        free: spoken >= budget ? 0n : budget - spoken,
        updatedAt: e.updatedAt,
      });
    }
    return out;
  }

  /** Live (unexpired) reservations, for persistence. */
  reservationsSnapshot(): Record<string, SwapInventoryReservation> {
    this.pruneExpired(this.clock());
    const out: Record<string, SwapInventoryReservation> = Object.create(
      null
    ) as Record<string, SwapInventoryReservation>;
    for (const [id, r] of this.reservations) {
      out[id] = { ...r };
    }
    return out;
  }

  /** Per-channel settled cumulative watermarks, for persistence. */
  settledWatermarksSnapshot(): Record<string, bigint> {
    const out: Record<string, bigint> = Object.create(null) as Record<
      string,
      bigint
    >;
    for (const [k, v] of this.settledWatermarks) {
      out[k] = v;
    }
    return out;
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
        unsettled: e.unsettled,
        ...(e.windowBudget !== undefined && { windowBudget: e.windowBudget }),
        updatedAt: e.updatedAt,
      });
    }
    return out;
  }

  private effectiveBudget(e: InternalEntry): bigint {
    if (e.windowBudget === undefined) return e.available;
    return e.windowBudget < e.available ? e.windowBudget : e.available;
  }

  private freeCapacity(k: string, e: InternalEntry): bigint {
    const budget = this.effectiveBudget(e);
    const spoken = this.inFlight(k) + e.unsettled;
    return spoken >= budget ? 0n : budget - spoken;
  }

  private inFlight(k: string): bigint {
    let sum = 0n;
    for (const r of this.reservations.values()) {
      if (r.key === k) sum += r.amount;
    }
    return sum;
  }

  private pruneExpired(now: number): void {
    for (const [id, r] of this.reservations) {
      if (r.expiresAt <= now) this.reservations.delete(id);
    }
  }
}
