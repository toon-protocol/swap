/**
 * `SwapInventory` — per-pair reserves + in-flight window reservations.
 *
 * Single-threaded microtask atomicity: every mutator is synchronous and
 * therefore atomic w.r.t. concurrent claim-issuance callers under
 * `Promise.all`. See Dev Notes "Microtask atomicity argument" in the story
 * doc.
 *
 * ## ONE capital model on one surface (issue #49, unified by issue #138)
 *
 * The one surviving claim path — rolling coupled-leg — uses the **in-flight
 * window reservation lifecycle** (toon-meta#145 / rolling-swap.md §8). A
 * claim `reserve`s its leg-B amount while it is being issued, then either
 *   - **commits** (claim handed to the counterparty → the amount becomes
 *     *unsettled channel liability*, shrunk later when the chain shows the
 *     claim redeemed — {@link recordChainRedemption}), or
 *   - **releases** (reject / rollback / TTL expiry → capacity returns).
 *
 * Nothing ever debits `available` permanently: what was a notional-sized
 * pre-fund becomes working capital cycling through settlement
 * (spec §8 "settle-and-recycle replaces manual refill").
 *
 * ### Why the legacy permanent debit was removed (issue #138)
 *
 * A permanent debit shrinks `available` for good and the legacy path never
 * populated `unsettled`, so {@link recordSettlement} — the only recycler —
 * could never give the capital back. A legacy maker's `available` therefore
 * ratcheted monotonically toward zero over its lifetime and then refused
 * every request with T04 *no matter how faithfully its counterparties
 * redeemed on chain*, with no in-process way to restore it. toon-meta#411
 * Stage 6 removed the public `debit()` / `refundDebit()` primitives entirely
 * along with the rest of the legacy issuance path; `credit` survives only as
 * the private mechanism behind {@link creditCorroboratedFunding} (genuinely
 * new, chain-corroborated capital).
 *
 * ### Healing a maker that already burned inventory
 *
 * Deployments upgrading from the permanent-debit build carry a burn:
 * `total − available` is exactly the sum of past legacy debits (config seeds
 * `available === total`, and a credit raises both). Those debits correspond
 * one-for-one to issued claims, so {@link recordChainRedemption} recycles the
 * redeemed portion back into `available` — bounded twice over: by the
 * newly-redeemed delta the chain reports, and by `total` (a recycle can never
 * push `available` above `total`). Value that was debited but is still
 * unredeemed stays blocked, which is the same capacity block the unified
 * model expresses as `unsettled`.
 *
 * ## Adding genuinely new capital (swap#142)
 *
 * {@link recordChainRedemption} recycles capital that was already counted and
 * therefore never raises `total`. {@link creditCorroboratedFunding} is the
 * other direction — capital the pool did not have before — and is likewise
 * corroborated, against Σ `cumulativePaid + deposit` over the pool's channels
 * rather than against a redemption. See its docblock for the model and for
 * why a repeat call cannot double-credit.
 *
 * ## The historical `total` inflation, and why it is NOT corrected here
 *
 * Before swap#137, a FAILED swap unwound its permanent debit with a credit,
 * which raises `available` AND `total`. Every failure therefore left `total`
 * one swap-notional too high. #137 fixed the unwind (a dedicated refund-only
 * primitive, and since #138 the unwind is `releaseReservation` — no debit to
 * undo at all) so the error cannot grow, and #140's reconciler restored
 * `available`; the live devnet maker consequently sits at `available`
 * 15 000 000 (correct) against `total` 15 003 500 — 3 500 units, 0.023 %,
 * static.
 *
 * Nothing in this module corrects that, deliberately:
 *
 * - **What it actually costs is bounded and one-directional.** `total` is
 *   what kind:10032 advertises, so the maker over-advertises by 3 500; a
 *   counterparty that sizes a swap against the inflated figure is refused at
 *   issuance with a benign T04, never handed a claim the maker cannot honor.
 *   It also loosens the recycle cap in {@link recordChainRedemption} by the
 *   same 3 500 — but that cap only binds against an on-chain redemption delta
 *   `unsettled` does not absorb, i.e. a pre-#138 legacy burn, and by
 *   construction there is at most as much of that as was actually burned.
 * - **Every recompute is a DOWNWARD write derived from data the node does not
 *   durably own.** `total = configured inventory + Σ corroborated additions`
 *   looks exact, but the configured figure is not authoritative at runtime
 *   (the persisted snapshot wins over config for keys it has already seen —
 *   issue #130) and the additions ledger IS `total` itself, which the
 *   documented state-file reset destroys. A recompute firing after such a
 *   reset would shrink `total` below capital the maker really holds, turning
 *   a 3 500 over-advertisement into an unbounded under-capitalisation — and
 *   it would do so automatically, on a `:release` auto-deploy.
 * - **It self-heals the moment it matters.** {@link creditCorroboratedFunding}
 *   converges `total` onto chain truth from BELOW: the next genuine top-up
 *   credits `chainFundedTotal − total`, which is the top-up minus the 3 500,
 *   landing `total` exactly on the chain's figure. The residue moves into
 *   `available` being 3 500 low, which is the safe direction (under-serving).
 *
 * If an operator ever does want it exact before then, the safe procedure is a
 * deliberate one with the node DOWN — stop the maker, edit the persisted pool
 * entry, restart — not a live write path that exists to be fired by accident.
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
 * Both paths drew on this one formula against the same real pool (issue
 * #138) until the legacy path was removed (toon-meta#411 Stage 6). Without
 * an explicit budget the ceiling degrades to `available` — which is exactly
 * the threshold the legacy permanent debit used to enforce, so removing it
 * did not loosen any refusal.
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

/**
 * swap#142 — what a pool's on-chain funding position does (or would do) to
 * its `total`. See {@link SwapInventory.creditCorroboratedFunding}.
 */
export interface FundingCreditResult {
  /** `total` BEFORE this operation — the watermark the credit is measured against. */
  total: bigint;
  /** Σ `cumulativePaid + deposit` over the pool's channels, read from chain. */
  chainFundedTotal: bigint;
  /** `max(0, chainFundedTotal − total)` — the most the chain can back. */
  corroborated: bigint;
  /** What the operator asked for (absent ⇒ "all of it"). */
  requested?: bigint;
  /** Actually applied to `available` AND `total` (0 on any refusal). */
  credited: bigint;
  /**
   * Why nothing was applied. `uncorroborated`: the chain shows no capital the
   * pool has not already booked. `exceeds_corroborated`: the request is larger
   * than the chain backs — refused whole rather than clamped, so an operator
   * never silently gets less than they asked for.
   */
  refused?: 'uncorroborated' | 'exceeds_corroborated';
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
   * Credit `amount` to `(assetCode, chain).available` and `.total`.
   * Creates the entry if missing. Synchronous — atomic under concurrent use.
   *
   * Private: the only caller is {@link creditCorroboratedFunding}, which
   * gates this on chain-corroborated new capital. There is no issuance-path
   * or operator-direct route to raise `total` (toon-meta#411 Stage 6 removed
   * the legacy `debit`/`refundDebit`/`credit` public surface along with the
   * issuance path that motivated it).
   */
  private credit(assetCode: string, chain: string, amount: bigint): void {
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
   * permanent debit (the pre-#138 legacy path), so it is restored to
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

  // -------------------------------------------------------------------------
  // swap#142 — operator route for genuinely NEW capital
  // -------------------------------------------------------------------------

  /**
   * swap#142 — credit new capital, and ONLY what the chain corroborates.
   *
   * ## The problem
   *
   * {@link recordChainRedemption} recycles capital that was already counted:
   * it can restore `available` but never raises `total`, because a redemption
   * is not new money. An operator who genuinely ADDS capital — funds a new
   * channel, tops up an existing one — therefore had no route at all
   * (`credit` has no caller), and editing config does not reliably take: the
   * persisted snapshot wins over config inventory for keys it has already
   * seen (issue #130).
   *
   * ## The corroboration, and why it cannot double-credit
   *
   * The chain-side quantity is **Σ over the pool's channels of
   * `cumulativePaid + deposit`** (`channelFundedTotal`), NOT the raw `deposit`
   * field. `deposit` is the *remaining un-paid-out* balance and falls on every
   * redemption (`deposit -= delta; cumulativePaid += delta`), so it is neither
   * monotone nor a measure of capital added. Their sum is invariant under
   * redemption and rises only when capital actually enters a channel.
   *
   * The node-side quantity it is compared against is **`total` itself** — the
   * pool's own record of the capital it holds. The credit is the excess of
   * proof over claim:
   *
   * ```
   * corroborated = max(0, chainFundedTotal − total)
   * ```
   *
   * and applying it uses {@link credit}, which raises `available` AND `total`
   * by the same amount. **`total` is therefore its own watermark**, and the
   * credit is a fixed-point step that closes exactly the gap it measured:
   *
   * - Repeated calls cannot double-credit. Crediting `c` makes `total' =
   *   total + c`, so the next read of the same `chainFundedTotal` computes
   *   `max(0, chainFundedTotal − total') = corroborated − c = 0`. There is no
   *   separate ledger that could drift, be lost, or be replayed — nothing to
   *   persist beyond `total`, which the state file already carries.
   * - Over the pool's whole life, Σ credited = `total_final − total_initial`
   *   ≤ `sup(chainFundedTotal) − total_initial`. The node can never book more
   *   capital than the chain has, at any moment, shown to be in its channels.
   * - Capital that *leaves* (a funder reclaiming an unspent remainder on
   *   close) makes `chainFundedTotal` fall below `total`; the `max(0, …)`
   *   makes that a refusal, not a negative credit, and `total` is deliberately
   *   never lowered here — this route only ever adds, so it can only ever
   *   under-serve, never over-serve. Re-funding back to a previously credited
   *   level correctly credits nothing.
   * - A channel the node cannot read, or does not know about, is simply absent
   *   from the sum, which UNDER-states `chainFundedTotal` and under-credits.
   *   Under-crediting is the safe failure; the caller additionally refuses
   *   outright when any read fails (see the admin route).
   *
   * Note what this deliberately cannot corroborate: capital sitting in the
   * payout wallet but not yet placed in a channel. The chain shows no channel
   * holding it, so the node will not book it. That is the invariant working,
   * not a gap — move it into a channel and it becomes creditable.
   *
   * ## Atomicity
   *
   * Synchronous, like every other mutator here, and it re-reads `total` at
   * the moment it credits. A caller MUST therefore do its chain read first
   * and then call this — never cache a `total` across the `await`. Two
   * concurrent operator requests that both read the same `chainFundedTotal`
   * are safe: the first credits the gap, the second finds it closed and is
   * refused as `uncorroborated`.
   *
   * @param p.chainFundedTotal Σ `cumulativePaid + deposit` over the pool's
   *   channels, from a LIVE chain read — never a cached or asserted value.
   * @param p.requested Optional operator assertion. Larger than the chain
   *   backs ⇒ refused whole (`exceeds_corroborated`), nothing applied.
   *   Smaller ⇒ exactly that much is credited and the remainder stays
   *   creditable, since `total` still trails `chainFundedTotal`.
   */
  creditCorroboratedFunding(p: {
    assetCode: string;
    chain: string;
    chainFundedTotal: bigint;
    requested?: bigint;
  }): FundingCreditResult {
    const outcome = this.previewCorroboratedFunding(p);
    if (outcome.credited > 0n) {
      this.credit(p.assetCode, p.chain, outcome.credited);
    }
    return outcome;
  }

  /**
   * What {@link creditCorroboratedFunding} WOULD do, without mutating
   * anything — the dry-run behind the operator surface's `dryRun` flag.
   */
  previewCorroboratedFunding(p: {
    assetCode: string;
    chain: string;
    chainFundedTotal: bigint;
    requested?: bigint;
  }): FundingCreditResult {
    const k = key(p.assetCode, p.chain);
    const entry = this.entries.get(k);
    if (!entry) {
      throw new SwapInventoryError(
        'INVENTORY_NOT_INITIALIZED',
        `Inventory not initialized for ${k}`
      );
    }
    const total = entry.total;
    const corroborated =
      p.chainFundedTotal > total ? p.chainFundedTotal - total : 0n;
    const base = {
      total,
      chainFundedTotal: p.chainFundedTotal,
      corroborated,
      ...(p.requested !== undefined && { requested: p.requested }),
    };
    if (corroborated === 0n) {
      return { ...base, credited: 0n, refused: 'uncorroborated' };
    }
    if (p.requested !== undefined && p.requested > corroborated) {
      return { ...base, credited: 0n, refused: 'exceeds_corroborated' };
    }
    return { ...base, credited: p.requested ?? corroborated };
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
