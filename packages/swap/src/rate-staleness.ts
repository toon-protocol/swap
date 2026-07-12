/**
 * Maker-side staleness reject (`maxRateAge`) — toon-protocol/swap#48.
 *
 * Rolling-swap prototype (toon-protocol/toon-meta#145, spec
 * `toon-meta/docs/rolling-swap.md` §4): if the maker's rate source has not
 * ticked within `maxRateAge`, the maker MUST reject incoming fill packets
 * rather than fill at the stale rate — otherwise a sender who observes the
 * market moving faster than the maker's feed farms the difference packet by
 * packet.
 *
 * ## Placement (prototype)
 *
 * The spec's final placement is the connector's inbound gate
 * (`InboundClaimValidatorFn`, before leg-A claim ingestion). This prototype
 * enforces the bound at the nearest seam the swap repo owns: a decorator
 * around the SDK's kind:1059 swap handler ({@link withMaxRateAge}), which
 * runs BEFORE the handler's replay-reservation, rate application, and claim
 * issuance — so a staleness reject leaves no `seenPacketIds` entry, no
 * inventory debit, and no issued leg-B claim. What it CANNOT undo (and the
 * connector gate ultimately must) is the leg-A claim watermark already
 * ingested by the connector on the inbound hop. That gap is a placement
 * finding for the epic, not silently papered over here.
 *
 * The decorator has to unwrap the NIP-59 gift wrap itself to learn the pair
 * (the connector-visible packet is opaque by design — same problem the final
 * inbound-gate placement will face). The unwrap is only paid when
 * `maxRateAge` is configured; unguarded swap nodes are byte-identical in behavior.
 *
 * ## Reject contract (consumed by the sender-side story)
 *
 * A staleness reject is benign — "re-quote and retry", never a failure:
 *
 * - handler-level `code`: {@link STALE_RATE_REJECT_CODE} (`'T99'`, per spec —
 *   T-class = temporary, retry later)
 * - `message`: {@link STALE_RATE_REJECT_MESSAGE} (`'stale_rate'`)
 * - `data`: base64 JSON {@link StaleRateRejectData} —
 *   `{"reason":"stale_rate","maxRateAgeMs":…,"lastRateAt":…,"pair":…}`
 * - `rejectReason.code`: {@link STALE_RATE_SEMANTIC_REASON} (`'timeout'`).
 *   Since connector 3.29.0 (this package pins ^3.29.1) the connector's
 *   `REJECT_CODE_MAP` carries `stale_rate: 'T99'`, so the semantic reason
 *   re-encodes to native wire code T99 (T-class, retryable) end-to-end —
 *   the historical `'timeout'`→T00 workaround for ≤3.20.1 is retired.
 *   `message` and `data` pass through verbatim; the sender's authoritative
 *   discriminator remains `data.reason === 'stale_rate'` (fallback:
 *   `message === 'stale_rate'`), NOT the wire code.
 *
 * ## Knob semantics
 *
 * `maxRateAge` is a MAKER-owned, per-chain/per-pair config knob (like the
 * spread; advertised alongside it in the future RFQ response) — NOT a
 * protocol constant. It requires a `rateProvider` that returns TIMESTAMPED
 * quotes (`{ rate, at }`): the bound is on the maker's OWN feed tick, so a
 * static `pair.rate` (or an untimestamped provider) gives the guard nothing
 * to measure. Configuring `maxRateAge` without a `rateProvider` is rejected
 * at boot ({@link validateMaxRateAgeConfig} callers); an untimestamped
 * provider return is warned once per pair and treated as fresh.
 *
 * See `max-rate-age.calibration.test.ts` for the reject-rate vs
 * staleness-exposure calibration behind {@link RECOMMENDED_MAX_RATE_AGE_MS}.
 */

import { unwrapSwapPacketFromToon, findSwapPair } from '@toon-protocol/sdk';
import type { Handler, HandlerContext } from '@toon-protocol/sdk';
import type {
  HandlePacketRejectResponse,
  HandlePacketResponse,
  SwapPair,
} from '@toon-protocol/core';

// ---------------------------------------------------------------------------
// Reject contract constants
// ---------------------------------------------------------------------------

/**
 * Handler-level ILP reject code for a staleness reject (rolling-swap spec §4).
 * T-class: temporary, application layer — "retry later", as opposed to the
 * F-class "don't retry".
 */
export const STALE_RATE_REJECT_CODE = 'T99';

/**
 * Machine-matchable reject message. Deliberately the bare reason token (not
 * prose) so message-only surfaces can discriminate even if the reject `data`
 * field is dropped somewhere on the return path.
 */
export const STALE_RATE_REJECT_MESSAGE = 'stale_rate';

/** `data.reason` discriminator — the sender's authoritative marker. */
export const STALE_RATE_REASON = 'stale_rate';

/**
 * Semantic reject reason fed to the connector's PaymentHandlerAdapter.
 *
 * `'stale_rate'` → wire code T99 since connector 3.29.0 added the
 * `stale_rate: 'T99'` `REJECT_CODE_MAP` entry (this package pins ^3.29.1),
 * closing the swap#48 wire gotcha: the reject is now natively T-class T99
 * end-to-end. Senders' authoritative discriminator remains
 * `data.reason === 'stale_rate'` (fallback: `message === 'stale_rate'`),
 * never the wire code.
 */
export const STALE_RATE_SEMANTIC_REASON = 'stale_rate';

/**
 * Structured reject payload, base64-JSON-encoded into the ILP reject `data`
 * field. Key names are normative per rolling-swap.md §4.
 */
export interface StaleRateRejectData {
  reason: typeof STALE_RATE_REASON;
  /** The maker's freshness bound that was exceeded, in ms. */
  maxRateAgeMs: number;
  /**
   * ms-epoch of the maker's rate feed's last tick for the pair, or `null`
   * if the feed has never ticked (e.g. feed unreachable since boot).
   */
  lastRateAt: number | null;
  /** Pair key (`{@link pairKey}` format) the bound was evaluated for. */
  pair: string;
}

/**
 * Build the staleness reject response. Exported so tests and future
 * placements (connector inbound gate) emit the byte-identical contract.
 *
 * The extra `data` / `rejectReason` fields are consumed by the connector's
 * PaymentHandlerAdapter (`response.data` → ILP reject data;
 * `response.rejectReason.code` → wire code via `REJECT_CODE_MAP`). Setting
 * `rejectReason` here also prevents `startSwapNode()`'s generic
 * `ilpCodeToSemantic` reverse-map from collapsing the unknown code T99 to
 * `invalid_request` (wire F00 — a fatal class that would invert the
 * benign-retry contract).
 */
export function buildStaleRateReject(
  data: StaleRateRejectData
): HandlePacketRejectResponse & {
  data: string;
  rejectReason: { code: string; message: string };
} {
  return {
    accept: false,
    code: STALE_RATE_REJECT_CODE,
    message: STALE_RATE_REJECT_MESSAGE,
    data: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    rejectReason: {
      code: STALE_RATE_SEMANTIC_REASON,
      message: STALE_RATE_REJECT_MESSAGE,
    },
  };
}

// ---------------------------------------------------------------------------
// Timestamped quotes + config types
// ---------------------------------------------------------------------------

/** A rate quote carrying the ms-epoch timestamp of the feed tick behind it. */
export interface TimestampedRate {
  /** Decimal-string rate, `SwapPair.rate` format (`/^(0|[1-9]\d*)(\.\d+)?$/`). */
  rate: string;
  /** ms-epoch of the rate source's tick this quote was derived from. */
  at: number;
}

/** What a swap-node rate provider may return. Bare strings are untimestamped. */
export type SwapRateQuote = string | TimestampedRate;

/**
 * Swap-node-level rate provider. A widening of the SDK's
 * `CreateSwapHandlerConfig['rateProvider']` (which only accepts strings):
 * return {@link TimestampedRate} to make quote age measurable — required for
 * the `maxRateAge` staleness guard to bite.
 */
export type SwapRateProvider = (
  pair: SwapPair
) => SwapRateQuote | Promise<SwapRateQuote>;

/**
 * Maker-owned per-chain / per-pair freshness bounds, in milliseconds.
 * Resolution precedence (see {@link RateFreshnessGuard.resolveMaxRateAgeMs}):
 *
 *   1. `perPair[pairKey(pair)]` — exact pair
 *   2. `min()` of matching `perChain` entries — exact chain ids
 *      (`'mina:devnet'`) and chain families (`'mina'`) of BOTH legs; the
 *      minimum wins because a pair is only as fresh as its slowest-priced leg
 *   3. `defaultMs`
 *
 * No match → the pair is unguarded.
 */
export interface MaxRateAgeConfig {
  /** Fallback bound applied to every pair without a more specific entry. */
  defaultMs?: number;
  /** Keyed by exact chain id (`'evm:8453'`) or chain family (`'evm'`). */
  perChain?: Record<string, number>;
  /** Keyed by {@link pairKey} output. */
  perPair?: Record<string, number>;
}

/**
 * Calibrated per-chain-class starting points (NOT protocol constants — a
 * maker SHOULD tune these to its own feed cadence; the operative rule of
 * thumb from the calibration harness is `maxRateAge ≈ 4-6 × the feed's
 * median tick interval, >= its p99 gap`). Derived in
 * `max-rate-age.calibration.test.ts`, which asserts each value keeps the
 * simulated reject rate under its target for the modeled feed class.
 */
export const RECOMMENDED_MAX_RATE_AGE_MS: Readonly<Record<string, number>> = {
  /** Base-class EVM: sub-second CEX feed (median tick ~250 ms). */
  evm: 1_500,
  /** Solana-class: ~500 ms feed cadence. */
  solana: 3_000,
  /** Mina-class: seconds-scale feed with heavy gap tail (spec §9 example). */
  mina: 15_000,
};

/** Canonical pair key: `FROMASSET:fromChain->TOASSET:toChain`. */
export function pairKey(pair: SwapPair): string {
  return `${pair.from.assetCode}:${pair.from.chain}->${pair.to.assetCode}:${pair.to.chain}`;
}

function chainFamily(chain: string): string {
  const idx = chain.indexOf(':');
  return idx === -1 ? chain : chain.slice(0, idx);
}

/**
 * Thrown by the guard-wrapped SDK rate provider when the quote backing a
 * fill is already past the bound at pricing time (the race backstop behind
 * the gate check — see {@link RateFreshnessGuard.toSdkRateProvider}).
 */
export class StaleRateError extends Error {
  public readonly code = 'STALE_RATE';
  public readonly data: StaleRateRejectData;

  constructor(data: StaleRateRejectData) {
    super(
      `stale_rate: quote for ${data.pair} is older than maxRateAge=${data.maxRateAgeMs}ms (lastRateAt=${String(data.lastRateAt)})`
    );
    this.name = 'StaleRateError';
    this.data = data;
  }
}

/**
 * Validate a {@link MaxRateAgeConfig} shape. Throws `Error` with an
 * actionable message on the first violation; callers (`validateConfig` in
 * swap-node.ts) wrap it in their domain error.
 */
export function validateMaxRateAgeConfig(cfg: MaxRateAgeConfig): void {
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
    throw new Error('maxRateAge MUST be an object');
  }
  const checkMs = (v: unknown, label: string): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`${label} MUST be a positive finite number of ms`);
    }
  };
  if (cfg.defaultMs !== undefined)
    checkMs(cfg.defaultMs, 'maxRateAge.defaultMs');
  for (const [k, v] of Object.entries(cfg.perChain ?? {})) {
    checkMs(v, `maxRateAge.perChain["${k}"]`);
  }
  for (const [k, v] of Object.entries(cfg.perPair ?? {})) {
    checkMs(v, `maxRateAge.perPair["${k}"]`);
  }
}

// ---------------------------------------------------------------------------
// RateFreshnessGuard
// ---------------------------------------------------------------------------

/** Minimal logger surface the guard needs (subset of SwapNodeLogger). */
export interface RateStalenessLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface RateFreshnessGuardConfig {
  maxRateAge: MaxRateAgeConfig;
  /** The maker's own feed. REQUIRED — the bound is on this feed's ticks. */
  rateProvider: SwapRateProvider;
  logger?: RateStalenessLogger;
  /** Injectable clock (ms epoch). Tests pin this; defaults to `Date.now`. */
  now?: () => number;
}

/** Verdict returned by {@link RateFreshnessGuard.check}. */
export type FreshnessVerdict =
  | { stale: false }
  | { stale: true; data: StaleRateRejectData };

/**
 * Tracks the maker's feed ticks per pair and evaluates the `maxRateAge`
 * bound: `now − lastRateUpdate > maxRateAge` → stale (rolling-swap §4).
 * The bound is on the maker's OWN feed; nothing the sender claims is
 * consulted.
 */
export class RateFreshnessGuard {
  readonly #cfg: MaxRateAgeConfig;
  readonly #provider: SwapRateProvider;
  readonly #logger: RateStalenessLogger;
  readonly #now: () => number;
  /** pairKey → ms-epoch of the last observed feed tick. */
  readonly #lastTickAt = new Map<string, number>();
  /** pairs already warned for untimestamped quotes (warn once per pair). */
  readonly #warnedUntimestamped = new Set<string>();

  constructor(config: RateFreshnessGuardConfig) {
    validateMaxRateAgeConfig(config.maxRateAge);
    if (typeof config.rateProvider !== 'function') {
      throw new Error(
        "RateFreshnessGuard requires a rateProvider: maxRateAge bounds the age of the maker's own feed ticks, so a static pair.rate gives it nothing to measure"
      );
    }
    this.#cfg = config.maxRateAge;
    this.#provider = config.rateProvider;
    this.#logger = config.logger ?? {};
    this.#now = config.now ?? Date.now;
  }

  /**
   * Resolve the effective bound for a pair, or `undefined` (unguarded).
   * Precedence: perPair, then the MINIMUM matching perChain entry across
   * both legs' exact chain ids and families, then defaultMs.
   */
  resolveMaxRateAgeMs(pair: SwapPair): number | undefined {
    const byPair = this.#cfg.perPair?.[pairKey(pair)];
    if (byPair !== undefined) return byPair;
    const perChain = this.#cfg.perChain;
    if (perChain) {
      const candidates = [
        perChain[pair.to.chain],
        perChain[pair.from.chain],
        perChain[chainFamily(pair.to.chain)],
        perChain[chainFamily(pair.from.chain)],
      ].filter((v): v is number => v !== undefined);
      if (candidates.length > 0) return Math.min(...candidates);
    }
    return this.#cfg.defaultMs;
  }

  /** ms-epoch of the last observed tick for a pair (test/ops introspection). */
  lastRateAt(pair: SwapPair): number | null {
    return this.#lastTickAt.get(pairKey(pair)) ?? null;
  }

  /**
   * Gate check: consult the feed and evaluate the bound for this pair.
   *
   * - Timestamped quote → tick recorded; stale iff `now − at > bound`.
   * - Untimestamped (bare string) quote → age unmeasurable; warned once per
   *   pair and treated as fresh (guard is inert for that provider shape).
   * - Provider THROWS → aged against the last recorded good tick: a feed
   *   that is down AND past the bound is exactly the farmable condition, so
   *   it rejects `stale_rate` (with `lastRateAt: null` if it never ticked);
   *   within the bound the packet proceeds and the pricing path decides.
   */
  async check(pair: SwapPair): Promise<FreshnessVerdict> {
    const bound = this.resolveMaxRateAgeMs(pair);
    if (bound === undefined) return { stale: false };
    const key = pairKey(pair);

    let quote: SwapRateQuote;
    try {
      quote = await this.#provider(pair);
    } catch (err) {
      const lastRateAt = this.#lastTickAt.get(key) ?? null;
      const now = this.#now();
      if (lastRateAt === null || now - lastRateAt > bound) {
        this.#logger.warn?.('swap.rate_staleness.feed_unreachable_stale', {
          pair: key,
          maxRateAgeMs: bound,
          lastRateAt,
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          stale: true,
          data: {
            reason: STALE_RATE_REASON,
            maxRateAgeMs: bound,
            lastRateAt,
            pair: key,
          },
        };
      }
      // Last tick still within the bound — let the pricing path decide
      // (a second provider failure there surfaces as the SDK's T00).
      return { stale: false };
    }

    const now = this.#now();
    if (typeof quote === 'string') {
      if (!this.#warnedUntimestamped.has(key)) {
        this.#warnedUntimestamped.add(key);
        this.#logger.warn?.('swap.rate_staleness.untimestamped_quote', {
          pair: key,
          hint: 'rateProvider returned a bare string; maxRateAge cannot measure quote age. Return { rate, at } to arm the staleness guard for this pair.',
        });
      }
      this.#lastTickAt.set(key, now);
      return { stale: false };
    }

    this.#lastTickAt.set(key, quote.at);
    if (now - quote.at > bound) {
      return {
        stale: true,
        data: {
          reason: STALE_RATE_REASON,
          maxRateAgeMs: bound,
          lastRateAt: quote.at,
          pair: key,
        },
      };
    }
    return { stale: false };
  }

  /**
   * SDK-shaped rate provider (`(pair) => Promise<string>`) for
   * `createSwapHandler`, normalizing {@link TimestampedRate} returns and
   * re-checking freshness at PRICING time. This is the invariant's last
   * line: the gate check and the fill are separate provider calls, so a feed
   * that goes stale in between still cannot price a fill. A violation throws
   * {@link StaleRateError}, which the SDK handler surfaces as its generic
   * T00 "Rate provider error" — acceptable for the rare race window; the
   * distinct T99 contract is the gate's job.
   */
  toSdkRateProvider(): (pair: SwapPair) => Promise<string> {
    return async (pair: SwapPair): Promise<string> => {
      const quote = await this.#provider(pair);
      if (typeof quote === 'string') return quote;
      const key = pairKey(pair);
      this.#lastTickAt.set(key, quote.at);
      const bound = this.resolveMaxRateAgeMs(pair);
      if (bound !== undefined && this.#now() - quote.at > bound) {
        throw new StaleRateError({
          reason: STALE_RATE_REASON,
          maxRateAgeMs: bound,
          lastRateAt: quote.at,
          pair: key,
        });
      }
      return quote.rate;
    };
  }
}

/**
 * Normalize a {@link SwapRateProvider} to the SDK's string-only shape,
 * for swap nodes with timestamped providers but no `maxRateAge` configured.
 */
export function normalizeRateProvider(
  provider: SwapRateProvider
): (pair: SwapPair) => Promise<string> {
  return async (pair: SwapPair): Promise<string> => {
    const quote = await provider(pair);
    return typeof quote === 'string' ? quote : quote.rate;
  };
}

// ---------------------------------------------------------------------------
// withMaxRateAge — the staleness gate (handler decorator)
// ---------------------------------------------------------------------------

export interface WithMaxRateAgeOptions {
  guard: RateFreshnessGuard;
  /** Swap-node identity secret key — same key the SDK swap handler unwraps with. */
  recipientSecretKey: Uint8Array;
  swapPairs: readonly SwapPair[];
  logger?: RateStalenessLogger;
}

/**
 * Wrap the SDK swap handler with the maker staleness gate.
 *
 * For kind:1059 packets the gate unwraps the gift wrap (the packet is
 * opaque without it — the same pair-resolution problem the final
 * connector-inbound-gate placement will face), resolves the pair, and
 * rejects `stale_rate` BEFORE the inner handler runs — i.e. before the
 * replay reservation is taken, the rate is applied, and any leg-B claim or
 * inventory debit happens. Malformed wraps and unknown pairs fall through
 * to the inner handler so its canonical F01/F06 ladder is preserved
 * byte-for-byte.
 */
export function withMaxRateAge(
  inner: Handler,
  options: WithMaxRateAgeOptions
): Handler {
  const { guard, recipientSecretKey, swapPairs } = options;
  const logger = options.logger ?? {};
  const pairs = [...swapPairs];

  return async (ctx: HandlerContext): Promise<HandlePacketResponse> => {
    if (ctx.kind !== 1059) return inner(ctx);
    if (typeof ctx.toon !== 'string' || ctx.toon.length === 0) {
      return inner(ctx); // inner emits its canonical F01
    }

    let pair: SwapPair | null = null;
    try {
      const toonData = new Uint8Array(Buffer.from(ctx.toon, 'base64'));
      const { rumor } = unwrapSwapPacketFromToon({
        toonData,
        recipientSecretKey,
      });
      pair = findSwapPair(rumor, pairs);
    } catch {
      return inner(ctx); // malformed gift wrap → inner's canonical F01
    }
    if (!pair) return inner(ctx); // unsupported pair → inner's canonical F06

    const verdict = await guard.check(pair);
    if (verdict.stale) {
      logger.info?.('swap.rate_staleness.reject', verdict.data);
      return buildStaleRateReject(verdict.data);
    }
    return inner(ctx);
  };
}
