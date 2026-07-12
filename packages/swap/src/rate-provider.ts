/**
 * HTTP rate provider — the CLI's `rateProvider` wiring (swap#47 AC-3).
 *
 * Deployed swap nodes have always priced at the config-frozen `pair.rate`
 * because the SDK's per-packet `rateProvider` hook was wired by nothing. This
 * factory turns an operator-supplied HTTP feed URL (`SWAP_RATE_URL`) into a
 * {@link SwapRateProvider}: ONE GET per invocation — the engine/handler calls
 * it per packet, so every fill re-prices at the feed's current tick ("fresh
 * rate per packet"). No caching here by design; the feed endpoint is the
 * place to cache.
 *
 * ## Accepted response shapes (Content-Type: application/json)
 *
 * 1. Single-pair feed: `{"rate":"0.0004","at":1783936201437}`
 *    (`at` = unix-ms tick time of the rate SOURCE — this is what arms the
 *    swap#48 `maxRateAge` staleness guard; a bare `{"rate":"0.0004"}` is
 *    accepted but leaves the guard inert for the pair, warned once).
 * 2. Multi-pair map keyed by {@link pairKey}:
 *    `{"USDC:evm:8453->ETH:evm:8453":{"rate":"0.0004","at":…}, …}`
 * 3. The same map nested under `"rates"`.
 *
 * Failures (non-2xx, timeout, malformed body, missing pair) THROW — the
 * staleness guard treats a throwing feed that is past its bound as the
 * farmable condition and rejects `stale_rate` (see `rate-staleness.ts`).
 */

import type { SwapPair } from '@toon-protocol/core';

import { pairKey } from './rate-staleness.js';
import type { SwapRateProvider, SwapRateQuote } from './rate-staleness.js';

/** `SwapPair.rate` format (same regex the SDK's applyRate enforces). */
const RATE_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/;

export interface HttpRateProviderOptions {
  /** Per-request timeout. Default 1500 ms — a slow feed IS a stale feed. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_RATE_FETCH_TIMEOUT_MS = 1_500;

function parseQuote(entry: unknown): SwapRateQuote | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  const rate = rec['rate'];
  if (typeof rate !== 'string' || !RATE_REGEX.test(rate)) return null;
  const at = rec['at'];
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) {
    return { rate, at };
  }
  // Untimestamped: valid, but the maxRateAge guard cannot measure it.
  return rate;
}

/**
 * Build a per-call HTTP {@link SwapRateProvider} for `url`.
 */
export function createHttpRateProvider(
  url: string,
  options: HttpRateProviderOptions = {}
): SwapRateProvider {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error(
      `createHttpRateProvider requires an http(s) URL (got ${JSON.stringify(url)})`
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RATE_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('createHttpRateProvider timeoutMs must be positive');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createHttpRateProvider requires a fetch implementation');
  }

  return async (pair: SwapPair): Promise<SwapRateQuote> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let body: unknown;
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`rate feed responded HTTP ${res.status}`);
      }
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // Shape 1: single quote object.
    const direct = parseQuote(body);
    if (direct !== null) return direct;

    // Shapes 2/3: map keyed by pairKey (optionally nested under `rates`).
    const key = pairKey(pair);
    if (typeof body === 'object' && body !== null) {
      const rec = body as Record<string, unknown>;
      const fromMap = parseQuote(rec[key]);
      if (fromMap !== null) return fromMap;
      const rates = rec['rates'];
      if (typeof rates === 'object' && rates !== null) {
        const nested = parseQuote((rates as Record<string, unknown>)[key]);
        if (nested !== null) return nested;
      }
    }
    throw new Error(`rate feed has no quote for pair ${key}`);
  };
}
