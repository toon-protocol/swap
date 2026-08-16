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
 * Both are no-ops when no on-chain reader is configured (no EVM
 * `chainProviders` entry), which is the same condition that disables the
 * on-chain rebind check.
 */

import type { ChannelEntry, ChannelOnChainReader } from './channel-state.js';
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
   * Live on-chain watermark source. Absent (no EVM `chainProviders` entry)
   * disables reconciliation entirely — the node has no way to establish
   * chain truth and must not guess.
   */
  reader?: ChannelOnChainReader;
  /** Best-effort snapshot hook (`SwapStatePersister.persist`). */
  persist?: () => void;
  logger?: SwapInventoryReconcilerLogger;
  clock?: () => number;
  /** Periodic cadence; `0` disables the timer (boot pass still runs). */
  intervalMs?: number;
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
          'no on-chain reader configured (no EVM chainProviders entry) — redemptions cannot be observed, so no capacity can be recycled',
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
