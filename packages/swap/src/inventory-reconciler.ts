/**
 * `SwapInventoryReconciler` — chain truth closes the settle-and-recycle loop
 * (issue #138).
 *
 * The swap node books every issued claim as `unsettled` channel liability
 * (`claim-issuer.ts`), and liability only comes back as spendable capacity
 * when the claim is redeemed. Nothing in the released node ever observed a
 * redemption: `SwapNodeInstance.recordSettlement` is a programmatic method
 * with no CLI/HTTP caller, so `unsettled` (and, before #138, permanently
 * debited `available`) only ever grew — a maker ratcheted down to zero free
 * capacity and then refused every request with T04 forever, however
 * faithfully its counterparties redeemed on chain.
 *
 * This module makes the node observe redemptions itself:
 *
 *   for every channel the node has issued claims against
 *     read the LIVE on-chain `cumulativePaid` (`ChannelOnChainReader`)
 *     feed it to `SwapInventory.recordChainRedemption`
 *
 * ## Why this is the safe direction
 *
 * - **Chain truth only.** The watermark comes from the same
 *   `ChannelOnChainReader` the rebind precondition already trusts (a raw
 *   `eth_call`, never cached). No counterparty assertion, no settlement
 *   receipt, no operator claim of a redemption can move it.
 * - **Monotone per channel.** `recordChainRedemption` advances a per-channel
 *   watermark and only ever acts on the delta, so a replayed or out-of-order
 *   read is a no-op — polling the same value forever credits nothing.
 * - **Fails closed.** An RPC error, a chain with no configured provider, or
 *   a malformed response skips that channel entirely: capacity stays
 *   blocked. Under-recycling is safe; over-recycling is not.
 * - **Bounded by `total`.** The `available` recycle (which heals a maker
 *   that ran the pre-#138 permanent-debit build) can never push `available`
 *   above `total`, so it can never return more capital than was debited.
 *
 * ## Cadence
 *
 * `startSwapNode()` runs one reconcile at boot (fire-and-forget — a slow or
 * unreachable RPC must never block boot) and then on an unref'd interval.
 * Both are no-ops when no on-chain reader is configured (no EVM or Solana
 * `chainProviders` entry — see `channel-reader.ts`, incl. why `mina:*` has
 * no reader at all), which is the same condition that disables the on-chain
 * rebind check.
 */

import type { ChannelEntry, ChannelOnChainReader } from './channel-state.js';
import { channelFundedTotal } from './channel-state.js';
import type { SwapInventory } from './inventory.js';

/** Default reconcile cadence — chosen to be far cheaper than the RPC budget of a live maker. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export interface SwapInventoryReconcilerLogger {
  debug?: (...a: unknown[]) => void;
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

/** The `SwapChannelState` slice this module needs (keeps it unit-testable). */
export interface ChannelStateSnapshotSource {
  snapshot(): { channels: Record<string, ChannelEntry> };
}

/** One channel's issued-vs-redeemed position after a reconcile pass. */
export interface ChannelRedemptionObservation {
  /** `${assetCode}:${chain}:${channelId}` — the channel-state storage key. */
  storedKey: string;
  assetCode: string;
  chain: string;
  channelId: string;
  /** Off-chain watermark: cumulative value this node has issued claims for. */
  issued: bigint;
  /** LIVE on-chain `cumulativePaid`, or `null` when the read failed. */
  redeemed: bigint | null;
  /** `max(0, issued − redeemed)`, or `null` when the read failed. */
  unredeemed: bigint | null;
  /** Liability released by this pass. */
  liabilityReduced: bigint;
  /** `available` restored by this pass (legacy permanent-debit recycle). */
  availableRestored: bigint;
  /** ms-epoch of the chain read. */
  observedAt: number;
  /** Present when the chain read (or the apply) failed — capacity stays blocked. */
  error?: string;
}

/** Per-pool roll-up of one reconcile pass. */
export interface PoolReconcileTotals {
  /** `${assetCode}:${chain}`. */
  pool: string;
  assetCode: string;
  chain: string;
  liabilityReduced: bigint;
  availableRestored: bigint;
}

export interface ReconcileResult {
  ranAt: number;
  /** `false` for a preview (dry-run) pass — nothing was mutated. */
  applied: boolean;
  channels: readonly ChannelRedemptionObservation[];
  pools: readonly PoolReconcileTotals[];
  /** Human-readable read/apply failures (one per skipped channel). */
  errors: readonly string[];
}

export interface SwapInventoryReconcilerConfig {
  inventory: SwapInventory;
  channelState: ChannelStateSnapshotSource;
  /**
   * Live on-chain watermark source. Absent (no `chainProviders` entry of a
   * readable family) disables reconciliation entirely — the node has no way
   * to establish chain truth and must not guess.
   */
  reader?: ChannelOnChainReader;
  /** Best-effort snapshot hook (`SwapStatePersister.persist`). */
  persist?: () => void;
  logger?: SwapInventoryReconcilerLogger;
  clock?: () => number;
  /** Periodic cadence; `0` disables the timer (boot pass still runs). */
  intervalMs?: number;
}

/** swap#142 — one channel's on-chain capital position, or why it is unknown. */
export interface ChannelFundingObservation {
  /** `${assetCode}:${chain}:${channelId}` — the channel-state storage key. */
  storedKey: string;
  channelId: string;
  /** Cumulative paid out, or `null` when the read failed. */
  cumulativePaid: bigint | null;
  /** Remaining un-paid-out deposit, or `null` when the read failed. */
  deposit: bigint | null;
  /** `cumulativePaid + deposit` — capital in this channel; `null` on failure. */
  funded: bigint | null;
  observedAt: number;
  error?: string;
}

/**
 * swap#142 — a pool's on-chain capital position: the sum the operator credit
 * surface corroborates against.
 *
 * `chainFundedTotal` counts ONLY channels that read successfully, so a failed
 * read always makes it smaller — under-crediting, the safe direction. Callers
 * that are about to move value must still refuse outright when `errors` is
 * non-empty (an operator asking "did my top-up land?" deserves a complete
 * answer, not a partial one), and MUST refuse when `supported` is false.
 */
export interface PoolFundingReading {
  /** `${assetCode}:${chain}`. */
  pool: string;
  assetCode: string;
  chain: string;
  /** `false` when no reader, or one with no `getFundingPosition` capability. */
  supported: boolean;
  /** Σ `funded` over the channels that read successfully. */
  chainFundedTotal: bigint;
  channels: readonly ChannelFundingObservation[];
  /** Read failures — non-empty ⇒ `chainFundedTotal` is incomplete. */
  errors: readonly string[];
  readAt: number;
}

export interface ReconcileOptions {
  /** `false` computes what WOULD be applied without moving any watermark. */
  apply?: boolean;
  /** Restrict the pass to one `(assetCode, chain)` pool. */
  assetCode?: string;
  chain?: string;
}

/**
 * Split a `SwapChannelState` storage key into its pool coordinates.
 * The key is `${assetCode}:${chain}:${channelId}` and `chain` itself
 * contains colons (`evm:base:8453`), so the channelId — known from the entry
 * — is stripped as a suffix and the assetCode taken up to the first colon.
 * Returns `null` for a key that does not have that shape (fixtures/legacy
 * callers may key by anything; such entries are skipped, not guessed at).
 */
export function parseChannelStoredKey(
  storedKey: string,
  channelId: string
): { assetCode: string; chain: string } | null {
  const suffix = `:${channelId}`;
  if (!storedKey.endsWith(suffix)) return null;
  const prefix = storedKey.slice(0, -suffix.length);
  const sep = prefix.indexOf(':');
  if (sep <= 0 || sep === prefix.length - 1) return null;
  return { assetCode: prefix.slice(0, sep), chain: prefix.slice(sep + 1) };
}

export class SwapInventoryReconciler {
  private readonly inventory: SwapInventory;
  private readonly channelState: ChannelStateSnapshotSource;
  private readonly reader?: ChannelOnChainReader;
  private readonly persist?: () => void;
  private readonly logger?: SwapInventoryReconcilerLogger;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  /**
   * Set by {@link stop}. Load-bearing beyond tidiness: `SwapNodeInstance.stop()`
   * calls `SwapChannelState.releaseAll()`, which ZEROES the in-memory
   * nonce/cumulative watermarks, and deliberately does NOT persist (state-store
   * crash rule 5). A reconcile pass still in flight across its RPC await must
   * therefore never persist afterwards — that would write the zeroed watermarks
   * over the real ones and let a counterparty replay an old claim.
   */
  private stopped = false;
  private lastResult?: ReconcileResult;
  /** Latest per-channel chain observations, for the operator read surface. */
  private readonly observations = new Map<
    string,
    ChannelRedemptionObservation
  >();

  constructor(config: SwapInventoryReconcilerConfig) {
    this.inventory = config.inventory;
    this.channelState = config.channelState;
    if (config.reader) this.reader = config.reader;
    if (config.persist) this.persist = config.persist;
    if (config.logger) this.logger = config.logger;
    this.clock = config.clock ?? Date.now;
    this.intervalMs = config.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  }

  /** `false` when no on-chain reader is configured — nothing can be reconciled. */
  get enabled(): boolean {
    return this.reader !== undefined;
  }

  get lastRun(): ReconcileResult | undefined {
    return this.lastResult;
  }

  /** Latest chain observation per channel (empty until the first pass). */
  latestObservations(): readonly ChannelRedemptionObservation[] {
    return [...this.observations.values()];
  }

  /**
   * One reconcile pass. Never throws: a failed read is recorded against the
   * channel it belongs to and the remaining channels still reconcile.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const apply = options.apply !== false && !this.stopped;
    const ranAt = this.clock();
    const channels: ChannelRedemptionObservation[] = [];
    const errors: string[] = [];
    const poolTotals = new Map<string, PoolReconcileTotals>();

    if (!this.reader) {
      const result: ReconcileResult = {
        ranAt,
        applied: false,
        channels: [],
        pools: [],
        errors: [
          'no on-chain reader configured (no EVM or Solana chainProviders entry) — redemptions cannot be observed, so no capacity can be recycled',
        ],
      };
      if (apply) this.lastResult = result;
      return result;
    }

    const { channels: live } = this.channelState.snapshot();
    let mutated = false;

    for (const [storedKey, entry] of Object.entries(live)) {
      const parsed = parseChannelStoredKey(storedKey, entry.channelId);
      if (!parsed) continue;
      if (
        options.assetCode !== undefined &&
        parsed.assetCode !== options.assetCode
      ) {
        continue;
      }
      if (options.chain !== undefined && parsed.chain !== options.chain) {
        continue;
      }
      const base = {
        storedKey,
        assetCode: parsed.assetCode,
        chain: parsed.chain,
        channelId: entry.channelId,
        issued: entry.cumulativeAmount,
        liabilityReduced: 0n,
        availableRestored: 0n,
        observedAt: this.clock(),
      };

      let redeemed: bigint;
      try {
        redeemed = await this.reader.getCumulativePaid({
          assetCode: parsed.assetCode,
          chain: parsed.chain,
          channelId: entry.channelId,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const message = `${storedKey}: on-chain read failed (${detail})`;
        errors.push(message);
        const observation: ChannelRedemptionObservation = {
          ...base,
          redeemed: null,
          unredeemed: null,
          observedAt: this.clock(),
          error: message,
        };
        channels.push(observation);
        this.observations.set(storedKey, observation);
        this.logger?.warn?.('swap.reconcile.read_failed', {
          storedKey,
          channelId: entry.channelId,
          chain: parsed.chain,
          err: detail,
        });
        continue;
      }

      const unredeemed =
        entry.cumulativeAmount > redeemed
          ? entry.cumulativeAmount - redeemed
          : 0n;
      let liabilityReduced = 0n;
      let availableRestored = 0n;
      let applyError: string | undefined;
      try {
        const outcome = apply
          ? this.inventory.recordChainRedemption({
              assetCode: parsed.assetCode,
              chain: parsed.chain,
              channelId: entry.channelId,
              redeemedCumulative: redeemed,
            })
          : this.inventory.previewChainRedemption({
              assetCode: parsed.assetCode,
              chain: parsed.chain,
              channelId: entry.channelId,
              redeemedCumulative: redeemed,
            });
        liabilityReduced = outcome.liabilityReduced;
        availableRestored = outcome.availableRestored;
        if (apply && outcome.delta > 0n) mutated = true;
      } catch (err) {
        // e.g. INVENTORY_NOT_INITIALIZED for a channel whose pool has no
        // configured inventory entry. Nothing to recycle; keep going.
        const detail = err instanceof Error ? err.message : String(err);
        applyError = `${storedKey}: ${detail}`;
        errors.push(applyError);
      }

      const observation: ChannelRedemptionObservation = {
        ...base,
        redeemed,
        unredeemed,
        liabilityReduced,
        availableRestored,
        observedAt: this.clock(),
        ...(applyError !== undefined && { error: applyError }),
      };
      channels.push(observation);
      this.observations.set(storedKey, observation);

      const poolKey = `${parsed.assetCode}:${parsed.chain}`;
      const totals = poolTotals.get(poolKey) ?? {
        pool: poolKey,
        assetCode: parsed.assetCode,
        chain: parsed.chain,
        liabilityReduced: 0n,
        availableRestored: 0n,
      };
      totals.liabilityReduced += liabilityReduced;
      totals.availableRestored += availableRestored;
      poolTotals.set(poolKey, totals);

      if (apply && (liabilityReduced > 0n || availableRestored > 0n)) {
        this.logger?.info?.('swap.reconcile.recycled', {
          channelId: entry.channelId,
          chain: parsed.chain,
          asset: parsed.assetCode,
          issued: entry.cumulativeAmount.toString(),
          redeemedOnChain: redeemed.toString(),
          liabilityReduced: liabilityReduced.toString(),
          availableRestored: availableRestored.toString(),
        });
      }
    }

    if (mutated && this.persist && !this.stopped) {
      try {
        this.persist();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        errors.push(`persist failed: ${detail}`);
        this.logger?.error?.('swap.reconcile.persist_failed', { err: detail });
      }
    }

    const result: ReconcileResult = {
      ranAt,
      applied: apply,
      channels,
      pools: [...poolTotals.values()],
      errors,
    };
    if (apply) this.lastResult = result;
    return result;
  }

  /**
   * swap#142 — read one pool's on-chain capital position: Σ over its channels
   * of `cumulativePaid + deposit`, each pair from ONE atomic chain read.
   *
   * Deliberately read-only and deliberately NOT wired into {@link reconcile}'s
   * periodic pass: the recycle loop's job is redemptions, and adding a second
   * RPC per channel per minute to it would double a live maker's read budget
   * for a number only an operator action consumes. This is called on demand,
   * by the operator surface.
   *
   * Channels are de-duplicated by `channelId`: `(chain, channelId)` names one
   * on-chain object, and counting it twice — were the same id ever to appear
   * under two channel-state keys — would corroborate capital that does not
   * exist.
   *
   * Never throws: a per-channel failure is recorded and excluded from the sum
   * (making it smaller, never larger).
   */
  async readPoolFunding(p: {
    assetCode: string;
    chain: string;
  }): Promise<PoolFundingReading> {
    const readAt = this.clock();
    const pool = `${p.assetCode}:${p.chain}`;
    const getFundingPosition = this.reader?.getFundingPosition;
    if (!this.reader || !getFundingPosition) {
      return {
        pool,
        assetCode: p.assetCode,
        chain: p.chain,
        supported: false,
        chainFundedTotal: 0n,
        channels: [],
        errors: [
          this.reader
            ? `the on-chain reader for chain '${p.chain}' cannot read channel funding positions, so new capital cannot be corroborated`
            : 'no on-chain reader configured (no EVM chainProviders entry) — channel funding cannot be read, so no capital can be corroborated',
        ],
        readAt,
      };
    }

    const { channels: live } = this.channelState.snapshot();
    const channels: ChannelFundingObservation[] = [];
    const errors: string[] = [];
    const seenChannelIds = new Set<string>();
    let chainFundedTotal = 0n;

    for (const [storedKey, entry] of Object.entries(live)) {
      const parsed = parseChannelStoredKey(storedKey, entry.channelId);
      if (!parsed) continue;
      if (parsed.assetCode !== p.assetCode || parsed.chain !== p.chain) {
        continue;
      }
      if (seenChannelIds.has(entry.channelId)) continue;
      seenChannelIds.add(entry.channelId);

      try {
        const position = await getFundingPosition.call(this.reader, {
          assetCode: parsed.assetCode,
          chain: parsed.chain,
          channelId: entry.channelId,
        });
        const funded = channelFundedTotal(position);
        chainFundedTotal += funded;
        channels.push({
          storedKey,
          channelId: entry.channelId,
          cumulativePaid: position.cumulativePaid,
          deposit: position.deposit,
          funded,
          observedAt: this.clock(),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const message = `${storedKey}: on-chain funding read failed (${detail})`;
        errors.push(message);
        channels.push({
          storedKey,
          channelId: entry.channelId,
          cumulativePaid: null,
          deposit: null,
          funded: null,
          observedAt: this.clock(),
          error: message,
        });
        this.logger?.warn?.('swap.funding.read_failed', {
          storedKey,
          channelId: entry.channelId,
          chain: parsed.chain,
          err: detail,
        });
      }
    }

    return {
      pool,
      assetCode: p.assetCode,
      chain: p.chain,
      supported: true,
      chainFundedTotal,
      channels,
      errors,
      readAt,
    };
  }

  /**
   * Start the periodic pass. No-op when no reader is configured or the
   * interval is non-positive. The timer is unref'd so it can never hold the
   * process open, and overlapping passes are suppressed (a slow RPC must not
   * queue up reconciles).
   */
  start(): void {
    if (!this.reader || this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.runGuarded();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Best-effort snapshot of node state (`SwapStatePersister.persist`), for
   * callers that mutated inventory outside a reconcile pass — swap#142's
   * operator credit raises `total`, which IS the anti-double-credit watermark
   * and so must survive a restart.
   *
   * Honors the same {@link stopped} guard as {@link reconcile}: after
   * `SwapNodeInstance.stop()` has zeroed the in-memory channel watermarks
   * (`releaseAll()`, state-store crash rule 5), persisting would write those
   * zeros over the real ones and invite a claim replay. Returns the failure
   * rather than throwing — a persist problem must not turn a successful
   * in-memory credit into a 500.
   */
  persistState(): { persisted: boolean; error?: string } {
    if (this.stopped || !this.persist) {
      return {
        persisted: false,
        ...(this.stopped && {
          error: 'node is stopping — state not persisted',
        }),
      };
    }
    try {
      this.persist();
      return { persisted: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger?.error?.('swap.persist_failed', { err: detail });
      return { persisted: false, error: detail };
    }
  }

  stop(): void {
    this.stopped = true;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fire a pass, swallowing everything — used by the boot pass and the timer. */
  async runGuarded(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.reconcile();
    } catch (err) {
      this.logger?.warn?.('swap.reconcile.failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }
}
