/**
 * maxRateAge calibration harness — toon-protocol/swap#48 (epic toon-meta#145).
 *
 * The epic's highest-risk open question: too loose a bound → a slow-feed
 * maker gets farmed for stale prices; too tight → constant `stale_rate`
 * rejects on slow chains (Mina) and the swap stalls. This harness MODELS the
 * tradeoff so the recommended per-chain-class defaults
 * ({@link RECOMMENDED_MAX_RATE_AGE_MS}) are derived, not guessed — and stay
 * pinned by assertions as the code evolves.
 *
 * ## Model
 *
 * - The maker's rate feed is a renewal process: tick intervals are
 *   lognormal(medianTickMs, sigma), with probability `gapProb` an interval is
 *   instead a "gap" — a feed outage/hiccup, lognormal(gapMedianMs, gapSigma).
 *   (The rolling-swap spec's worked example is a 12.6 s Mina feed gap
 *   tripping a 10 s bound — the mina-class model reproduces that regime.)
 * - Fill packets arrive as a Poisson process, independent of the feed. At
 *   each arrival the maker evaluates `age = now − lastTick`; the packet is
 *   REJECTED (`stale_rate`) iff `age > maxRateAge`.
 * - Staleness exposure of an ACCEPTED fill ≈ |price drift| over `age` under
 *   Brownian drift: `σ·√(age)` bps, evaluated at a calm regime (~1 bps/√s ≈
 *   60%-annualized crypto vol) and a burst regime (10×). The adversary farms
 *   exactly this: it fills only when the market has moved more than the
 *   half-spread since the maker's last tick, so `σ·√(maxRateAge)` vs the
 *   half-spread is the "farmability" budget the bound caps.
 * - Stall behavior: a feed blackout longer than the bound rejects EVERY
 *   packet until the next tick, so `maxBlackoutMs = max(interval − A)` is
 *   how long a sender (backing off ≥ one maxRateAge per the spec) is stalled.
 *
 * Deterministic (seeded mulberry32) — same numbers on every run/CI box.
 *
 * Run `CALIBRATE=1 vitest run src/max-rate-age.calibration.test.ts` to print
 * the full reject-rate/exposure curves behind the recommendations.
 */

import { describe, it, expect } from 'vitest';
import { RECOMMENDED_MAX_RATE_AGE_MS } from './rate-staleness.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG + samplers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng(); // avoid log(0)
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lognormal parameterized by its MEDIAN (exp(mu)) and shape sigma. */
function lognormal(rng: () => number, median: number, sigma: number): number {
  return median * Math.exp(sigma * gaussian(rng));
}

/** Exponential inter-arrival with the given mean. */
function exponential(rng: () => number, mean: number): number {
  let u = 0;
  while (u === 0) u = rng();
  return -mean * Math.log(u);
}

function quantile(sortedAscending: readonly number[], q: number): number {
  if (sortedAscending.length === 0) return NaN;
  const idx = Math.min(
    sortedAscending.length - 1,
    Math.floor(q * sortedAscending.length)
  );
  return sortedAscending[idx]!;
}

// ---------------------------------------------------------------------------
// Feed models (assumptions — documented, maker-tunable in reality)
// ---------------------------------------------------------------------------

interface FeedModel {
  name: string;
  /** Median feed tick interval (ms). */
  medianTickMs: number;
  /** Lognormal shape of regular tick intervals. */
  sigma: number;
  /** Probability an interval is a gap (feed hiccup/outage) instead. */
  gapProb: number;
  /** Median gap length (ms). */
  gapMedianMs: number;
  /** Lognormal shape of gaps. */
  gapSigma: number;
  /** Simulated horizon (ms). */
  horizonMs: number;
  /** Poisson fill-packet arrival rate (packets/sec). */
  packetsPerSec: number;
  seed: number;
}

/**
 * Base-class EVM L2: the maker prices off a CEX websocket ticker —
 * sub-second cadence, rare short hiccups.
 */
const BASE_CLASS: FeedModel = {
  name: 'evm (Base-class)',
  medianTickMs: 250,
  sigma: 0.5,
  gapProb: 0.001,
  gapMedianMs: 2_000,
  gapSigma: 0.5,
  horizonMs: 4 * 3_600_000,
  packetsPerSec: 2,
  seed: 0xba5e,
};

/** Solana-class: ~500 ms feed cadence, slightly gappier. */
const SOLANA_CLASS: FeedModel = {
  name: 'solana',
  medianTickMs: 500,
  sigma: 0.5,
  gapProb: 0.002,
  gapMedianMs: 4_000,
  gapSigma: 0.5,
  horizonMs: 4 * 3_600_000,
  packetsPerSec: 2,
  seed: 0x50a1a,
};

/**
 * Mina-class: seconds-scale feed with a heavy gap tail — the spec's worked
 * example (§9: a 12.6 s feed gap against maxRateAge = 10 s) lives in this
 * regime.
 */
const MINA_CLASS: FeedModel = {
  name: 'mina',
  medianTickMs: 4_000,
  sigma: 0.6,
  gapProb: 0.02,
  gapMedianMs: 12_000,
  gapSigma: 0.4,
  horizonMs: 12 * 3_600_000,
  packetsPerSec: 2,
  seed: 0x314a,
};

/** Volatility regimes for the exposure proxy (bps per √second). */
const VOL_CALM_BPS_SQRT_S = 1; // ≈ 60%-annualized
const VOL_BURST_BPS_SQRT_S = 10; // 10× vol burst — when farming actually pays

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface SimData {
  /** Quote age (ms) at each packet arrival, in arrival order. */
  agesAtArrival: number[];
  /** Every feed inter-tick interval (ms). */
  intervals: number[];
}

function simulateFeed(model: FeedModel): SimData {
  const rng = mulberry32(model.seed);
  // 1. Tick times.
  const intervals: number[] = [];
  const tickTimes: number[] = [0];
  let t = 0;
  while (t < model.horizonMs) {
    const isGap = rng() < model.gapProb;
    const interval = isGap
      ? lognormal(rng, model.gapMedianMs, model.gapSigma)
      : lognormal(rng, model.medianTickMs, model.sigma);
    intervals.push(interval);
    t += interval;
    tickTimes.push(t);
  }
  // 2. Packet arrivals (independent Poisson), merged against ticks.
  const meanInterArrival = 1000 / model.packetsPerSec;
  const agesAtArrival: number[] = [];
  let arrival = exponential(rng, meanInterArrival);
  let tickIdx = 0;
  while (arrival < model.horizonMs) {
    while (
      tickIdx + 1 < tickTimes.length &&
      tickTimes[tickIdx + 1]! <= arrival
    ) {
      tickIdx++;
    }
    agesAtArrival.push(arrival - tickTimes[tickIdx]!);
    arrival += exponential(rng, meanInterArrival);
  }
  return { agesAtArrival, intervals };
}

interface CandidateMetrics {
  maxRateAgeMs: number;
  rejectRate: number;
  /** p99 quote age among ACCEPTED fills (ms). */
  p99AcceptedAgeMs: number;
  meanAcceptedAgeMs: number;
  /** Longest feed blackout beyond the bound (ms) — worst sender stall. */
  maxBlackoutMs: number;
  /** Worst-case per-fill drift bound σ·√A (bps) at calm / burst vol. */
  worstExposureCalmBps: number;
  worstExposureBurstBps: number;
  /** Expected per-fill drift E[σ√age | accepted] (bps) at burst vol. */
  meanExposureBurstBps: number;
}

function evaluate(sim: SimData, candidatesMs: number[]): CandidateMetrics[] {
  return candidatesMs.map((A) => {
    let rejects = 0;
    let acceptedSum = 0;
    let exposureSum = 0;
    const accepted: number[] = [];
    for (const age of sim.agesAtArrival) {
      if (age > A) {
        rejects++;
      } else {
        accepted.push(age);
        acceptedSum += age;
        exposureSum += Math.sqrt(age / 1000);
      }
    }
    accepted.sort((a, b) => a - b);
    let maxBlackoutMs = 0;
    for (const interval of sim.intervals) {
      const blackout = interval - A;
      if (blackout > maxBlackoutMs) maxBlackoutMs = blackout;
    }
    const nAccepted = accepted.length;
    return {
      maxRateAgeMs: A,
      rejectRate: rejects / sim.agesAtArrival.length,
      p99AcceptedAgeMs: quantile(accepted, 0.99),
      meanAcceptedAgeMs: nAccepted ? acceptedSum / nAccepted : NaN,
      maxBlackoutMs,
      worstExposureCalmBps: VOL_CALM_BPS_SQRT_S * Math.sqrt(A / 1000),
      worstExposureBurstBps: VOL_BURST_BPS_SQRT_S * Math.sqrt(A / 1000),
      meanExposureBurstBps: nAccepted
        ? (VOL_BURST_BPS_SQRT_S * exposureSum) / nAccepted
        : NaN,
    };
  });
}

function report(model: FeedModel, metrics: CandidateMetrics[]): void {
  if (!process.env['CALIBRATE']) return;
  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${model.name} — median tick ${model.medianTickMs}ms, gapProb ${model.gapProb}, gap median ${model.gapMedianMs}ms ===`
  );
  // eslint-disable-next-line no-console
  console.table(
    metrics.map((m) => ({
      'A (ms)': m.maxRateAgeMs,
      'reject %': (m.rejectRate * 100).toFixed(2),
      'p99 fill age (ms)': Math.round(m.p99AcceptedAgeMs),
      'max stall (ms)': Math.round(m.maxBlackoutMs),
      'worst exp calm (bps)': m.worstExposureCalmBps.toFixed(1),
      'worst exp burst (bps)': m.worstExposureBurstBps.toFixed(1),
      'mean exp burst (bps)': m.meanExposureBurstBps.toFixed(1),
    }))
  );
}

// ---------------------------------------------------------------------------
// The curves
// ---------------------------------------------------------------------------

const BASE_CANDIDATES = [100, 250, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000];
const SOLANA_CANDIDATES = [250, 500, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000];
const MINA_CANDIDATES = [
  2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 15_000, 20_000, 30_000, 60_000,
];

const baseSim = simulateFeed(BASE_CLASS);
const baseMetrics = evaluate(baseSim, BASE_CANDIDATES);
const solanaSim = simulateFeed(SOLANA_CLASS);
const solanaMetrics = evaluate(solanaSim, SOLANA_CANDIDATES);
const minaSim = simulateFeed(MINA_CLASS);
const minaMetrics = evaluate(minaSim, MINA_CANDIDATES);

function at(metrics: CandidateMetrics[], A: number): CandidateMetrics {
  const m = metrics.find((x) => x.maxRateAgeMs === A);
  if (!m) throw new Error(`no candidate ${A}`);
  return m;
}

describe('maxRateAge calibration — reject-rate vs staleness-exposure curves', () => {
  it('prints the calibration tables when CALIBRATE=1', () => {
    report(BASE_CLASS, baseMetrics);
    report(SOLANA_CLASS, solanaMetrics);
    report(MINA_CLASS, minaMetrics);
    expect(true).toBe(true);
  });

  it('sanity: reject rate is non-increasing and exposure non-decreasing in the bound', () => {
    for (const metrics of [baseMetrics, solanaMetrics, minaMetrics]) {
      for (let i = 1; i < metrics.length; i++) {
        expect(metrics[i]!.rejectRate).toBeLessThanOrEqual(
          metrics[i - 1]!.rejectRate + 1e-12
        );
        expect(metrics[i]!.meanAcceptedAgeMs).toBeGreaterThanOrEqual(
          metrics[i - 1]!.meanAcceptedAgeMs - 1e-9
        );
      }
    }
  });

  it('too tight — a bound at the feed median tick is a reject storm on every class', () => {
    // This is the "constant rejects on Mina" failure mode from the epic: at
    // A ≈ the median tick interval, a third or more of all packets bounce.
    expect(at(baseMetrics, 250).rejectRate).toBeGreaterThan(0.2);
    expect(at(solanaMetrics, 500).rejectRate).toBeGreaterThan(0.2);
    expect(at(minaMetrics, 4_000).rejectRate).toBeGreaterThan(0.2);
  });

  it('spec §4 indicative "low hundreds of ms" on Base-class is TOO TIGHT for a ~250ms feed', () => {
    // Calibration finding (revises the spec's indicative starting point):
    // the bound must clear several multiples of the feed cadence, or fresh
    // traffic is rejected en masse.
    expect(at(baseMetrics, 100).rejectRate).toBeGreaterThan(0.5);
    // Even 2× the median cadence still bounces >3% of fresh traffic.
    expect(at(baseMetrics, 500).rejectRate).toBeGreaterThan(0.03);
  });

  it('recommended default (evm: 1500ms) keeps rejects under 1% with sub-25bps burst exposure', () => {
    expect(RECOMMENDED_MAX_RATE_AGE_MS['evm']).toBe(1_500);
    const m = at(baseMetrics, 1_500);
    expect(m.rejectRate).toBeLessThan(0.01);
    expect(m.worstExposureBurstBps).toBeLessThan(25);
    // No reject storm ⇒ the swap keeps rolling: worst stall ≈ the worst
    // feed blackout beyond the bound, seconds not minutes.
    expect(m.maxBlackoutMs).toBeLessThan(10_000);
  });

  it('recommended default (solana: 3000ms) keeps rejects under 1%', () => {
    expect(RECOMMENDED_MAX_RATE_AGE_MS['solana']).toBe(3_000);
    const m = at(solanaMetrics, 3_000);
    expect(m.rejectRate).toBeLessThan(0.01);
    expect(m.maxBlackoutMs).toBeLessThan(15_000);
  });

  it('recommended default (mina: 15000ms) — no reject storm under Mina-class latency (AC)', () => {
    expect(RECOMMENDED_MAX_RATE_AGE_MS['mina']).toBe(15_000);
    const m = at(minaMetrics, 15_000);
    // "no reject storm at recommended settings under Mina-class latency"
    expect(m.rejectRate).toBeLessThan(0.02);
  });

  it("the spec's worked-example bound (mina: 10s) rejects materially more than 15s — quantifying the §9 story", () => {
    const at10 = at(minaMetrics, 10_000);
    const at15 = at(minaMetrics, 15_000);
    // The §9 example (12.6s gap vs 10s bound) is a routine event in this
    // regime, not a fluke: 10s trips several times as often as 15s.
    expect(at10.rejectRate).toBeGreaterThan(at15.rejectRate * 2);
  });

  it('loosening mina past ~20s buys almost no fewer rejects but linearly more farmable exposure', () => {
    const at20 = at(minaMetrics, 20_000);
    const at60 = at(minaMetrics, 60_000);
    // Reject-rate improvement collapses past the gap tail…
    expect(at20.rejectRate - at60.rejectRate).toBeLessThan(0.01);
    // …while the worst-case staleness budget an adversary can farm keeps
    // growing with √A (77 bps at 60s burst — several half-spreads).
    expect(at60.worstExposureBurstBps).toBeGreaterThan(
      at20.worstExposureBurstBps * 1.5
    );
  });

  it('mina finding: even at the recommended bound, burst-vol exposure exceeds a typical half-spread', () => {
    // σ_burst·√15s ≈ 39 bps > a typical 10-30 bps half-spread: on slow-feed
    // chains maxRateAge alone CANNOT price away burst-regime staleness.
    // The residual must come from the advertised spread and the §6
    // controller shrinking δ on stale_rate signals — documented as a design
    // consequence, not a bug in the bound.
    const m = at(minaMetrics, 15_000);
    expect(m.worstExposureBurstBps).toBeGreaterThan(30);
  });

  it('rule of thumb: the knee sits at ~4-6× median tick (3.5-8× band), ≥ 0.8× p99 tick interval', () => {
    for (const [model, metrics, rec] of [
      [BASE_CLASS, baseMetrics, RECOMMENDED_MAX_RATE_AGE_MS['evm']!],
      [SOLANA_CLASS, solanaMetrics, RECOMMENDED_MAX_RATE_AGE_MS['solana']!],
      [MINA_CLASS, minaMetrics, RECOMMENDED_MAX_RATE_AGE_MS['mina']!],
    ] as const) {
      const sorted = [
        ...(metrics === baseMetrics
          ? baseSim.intervals
          : metrics === solanaMetrics
            ? solanaSim.intervals
            : minaSim.intervals),
      ].sort((a, b) => a - b);
      const p99Interval = quantile(sorted, 0.99);
      expect(rec).toBeGreaterThanOrEqual(3.5 * model.medianTickMs);
      expect(rec).toBeLessThanOrEqual(8 * model.medianTickMs);
      // ≥ 0.8× p99: the recommended bound sits AT the knee — just inside
      // the feed's gap tail (mina's p99 interval ≈ 17.3s vs rec 15s), which
      // is exactly why its residual reject rate (~1.5%) is higher than the
      // fast chains'. Sitting fully past the tail (20s+) trades near-zero
      // rejects for linearly more farmable exposure — see the next test.
      expect(rec).toBeGreaterThanOrEqual(p99Interval * 0.8);
    }
  });

  it('determinism: the harness is seeded — same curve on every run', () => {
    const again = evaluate(simulateFeed(MINA_CLASS), [15_000]);
    expect(again[0]!.rejectRate).toBe(at(minaMetrics, 15_000).rejectRate);
  });
});
