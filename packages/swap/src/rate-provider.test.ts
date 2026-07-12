/**
 * `createHttpRateProvider` tests (issue #47 AC-3 — CLI rateProvider wiring).
 */
import { describe, it, expect, vi } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';

import { createHttpRateProvider } from './rate-provider.js';
import { pairKey } from './rate-staleness.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
  to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:8453' },
  rate: '0.0004',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('createHttpRateProvider', () => {
  it('rejects non-http URLs, bad timeouts, and missing fetch up front', () => {
    expect(() => createHttpRateProvider('ftp://feed')).toThrowError(/http/);
    expect(() =>
      createHttpRateProvider('http://feed', { timeoutMs: 0 })
    ).toThrowError(/positive/);
  });

  it('shape 1: single timestamped quote → {rate, at}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ rate: '0.0004', at: 1_783_936_201_437 })
    );
    const provider = createHttpRateProvider('http://feed.local/rate', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider(PAIR)).resolves.toEqual({
      rate: '0.0004',
      at: 1_783_936_201_437,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('shape 1 untimestamped: bare {rate} → string (guard stays inert)', async () => {
    const provider = createHttpRateProvider('http://feed.local/rate', {
      fetchImpl: (async () =>
        jsonResponse({ rate: '0.0004' })) as unknown as typeof fetch,
    });
    await expect(provider(PAIR)).resolves.toBe('0.0004');
  });

  it('shape 2: map keyed by pairKey; shape 3: nested under rates', async () => {
    const key = pairKey(PAIR);
    const mapProvider = createHttpRateProvider('http://feed.local/rates', {
      fetchImpl: (async () =>
        jsonResponse({
          [key]: { rate: '0.0005', at: 42 },
        })) as unknown as typeof fetch,
    });
    await expect(mapProvider(PAIR)).resolves.toEqual({
      rate: '0.0005',
      at: 42,
    });

    const nestedProvider = createHttpRateProvider('http://feed.local/rates', {
      fetchImpl: (async () =>
        jsonResponse({
          rates: { [key]: { rate: '0.0006', at: 43 } },
        })) as unknown as typeof fetch,
    });
    await expect(nestedProvider(PAIR)).resolves.toEqual({
      rate: '0.0006',
      at: 43,
    });
  });

  it('throws on HTTP errors, malformed rates, and missing pairs (feed-down = guard-visible)', async () => {
    const err500 = createHttpRateProvider('http://feed.local/rate', {
      fetchImpl: (async () =>
        jsonResponse({}, false, 500)) as unknown as typeof fetch,
    });
    await expect(err500(PAIR)).rejects.toThrowError(/HTTP 500/);

    const badRate = createHttpRateProvider('http://feed.local/rate', {
      fetchImpl: (async () =>
        jsonResponse({ rate: 'not-a-rate', at: 1 })) as unknown as typeof fetch,
    });
    await expect(badRate(PAIR)).rejects.toThrowError(/no quote/);

    const missingPair = createHttpRateProvider('http://feed.local/rates', {
      fetchImpl: (async () =>
        jsonResponse({
          'X:1->Y:2': { rate: '1', at: 1 },
        })) as unknown as typeof fetch,
    });
    await expect(missingPair(PAIR)).rejects.toThrowError(
      new RegExp(pairKey(PAIR).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  it('aborts a hung feed after timeoutMs', async () => {
    const provider = createHttpRateProvider('http://feed.local/rate', {
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })) as unknown as typeof fetch,
    });
    await expect(provider(PAIR)).rejects.toThrowError(/aborted/);
  });
});
