/**
 * Unit tests for the maker staleness reject (`maxRateAge`) — swap#48.
 *
 * Covers:
 *   - bound resolution precedence (perPair > perChain exact/family min > default)
 *   - fresh/stale boundary semantics (strictly-greater-than the bound)
 *   - provider-failure fallback (age against last good tick)
 *   - untimestamped-quote inertness (warn once, treat as fresh)
 *   - the reject contract shape (T99 / 'stale_rate' / base64-JSON data /
 *     rejectReason NOT left to the generic ilpCodeToSemantic collapse)
 *   - the withMaxRateAge gate: stale reject BEFORE the inner handler runs,
 *     fresh/malformed/unsupported-pair pass-through, non-1059 pass-through
 *   - toSdkRateProvider: normalization + pricing-time staleness backstop
 *   - validateMaxRateAgeConfig / SwapNodeConfig.maxRateAge validation
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import { wrapSwapPacket, createHandlerContext } from '@toon-protocol/sdk';
import type { Handler, HandlerContext } from '@toon-protocol/sdk';
import { encodeEventToToon } from '@toon-protocol/core';
import type { SwapPair } from '@toon-protocol/core';

import {
  RateFreshnessGuard,
  withMaxRateAge,
  buildStaleRateReject,
  normalizeRateProvider,
  validateMaxRateAgeConfig,
  pairKey,
  StaleRateError,
  STALE_RATE_REJECT_CODE,
  STALE_RATE_REJECT_MESSAGE,
  STALE_RATE_REASON,
  STALE_RATE_SEMANTIC_REASON,
  RECOMMENDED_MAX_RATE_AGE_MS,
} from './rate-staleness.js';
import type { StaleRateRejectData } from './rate-staleness.js';
import { validateConfig } from './swap-node.js';
import type { SwapNodeConfig } from './swap-node.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAIR_EVM: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:31337' },
  to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:31337' },
  rate: '0.0004',
};

const PAIR_MINA: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:31337' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
  rate: '2.5',
};

function guardWith(opts: {
  maxRateAge: ConstructorParameters<typeof RateFreshnessGuard>[0]['maxRateAge'];
  provider?: ConstructorParameters<
    typeof RateFreshnessGuard
  >[0]['rateProvider'];
  now?: () => number;
  warn?: (...args: unknown[]) => void;
}): RateFreshnessGuard {
  return new RateFreshnessGuard({
    maxRateAge: opts.maxRateAge,
    rateProvider:
      opts.provider ?? (() => ({ rate: '1', at: opts.now?.() ?? 0 })),
    ...(opts.now && { now: opts.now }),
    ...(opts.warn && { logger: { warn: opts.warn } }),
  });
}

function decodeRejectData(dataB64: string): StaleRateRejectData {
  return JSON.parse(
    Buffer.from(dataB64, 'base64').toString('utf8')
  ) as StaleRateRejectData;
}

// ---------------------------------------------------------------------------
// pairKey + bound resolution
// ---------------------------------------------------------------------------

describe('pairKey', () => {
  it('formats FROMASSET:fromChain->TOASSET:toChain', () => {
    expect(pairKey(PAIR_MINA)).toBe('USDC:evm:31337->MINA:mina:devnet');
  });
});

describe('RateFreshnessGuard.resolveMaxRateAgeMs', () => {
  it('perPair beats perChain and default', () => {
    const guard = guardWith({
      maxRateAge: {
        defaultMs: 1000,
        perChain: { 'mina:devnet': 2000 },
        perPair: { [pairKey(PAIR_MINA)]: 42 },
      },
    });
    expect(guard.resolveMaxRateAgeMs(PAIR_MINA)).toBe(42);
  });

  it('perChain matches exact chain ids AND families across both legs, minimum wins', () => {
    const guard = guardWith({
      maxRateAge: {
        defaultMs: 60_000,
        perChain: { evm: 5000, 'mina:devnet': 2000 },
      },
    });
    // PAIR_MINA touches evm:31337 (family evm → 5000) and mina:devnet (2000).
    expect(guard.resolveMaxRateAgeMs(PAIR_MINA)).toBe(2000);
    // PAIR_EVM only matches the evm family entry.
    expect(guard.resolveMaxRateAgeMs(PAIR_EVM)).toBe(5000);
  });

  it('falls back to defaultMs, then undefined (unguarded)', () => {
    const withDefault = guardWith({ maxRateAge: { defaultMs: 750 } });
    expect(withDefault.resolveMaxRateAgeMs(PAIR_EVM)).toBe(750);
    const empty = guardWith({ maxRateAge: {} });
    expect(empty.resolveMaxRateAgeMs(PAIR_EVM)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// check() — freshness verdicts
// ---------------------------------------------------------------------------

describe('RateFreshnessGuard.check', () => {
  it('fresh timestamped quote passes; age strictly greater than the bound rejects', async () => {
    let t = 100_000;
    let quoteAt = 100_000;
    const guard = guardWith({
      maxRateAge: { defaultMs: 1000 },
      provider: () => ({ rate: '1', at: quoteAt }),
      now: () => t,
    });

    // age == bound → NOT stale (spec: now − lastRateUpdate > maxRateAge)
    t = 101_000;
    expect(await guard.check(PAIR_EVM)).toEqual({ stale: false });

    // age == bound + 1 → stale
    t = 101_001;
    const verdict = await guard.check(PAIR_EVM);
    expect(verdict.stale).toBe(true);
    if (verdict.stale) {
      expect(verdict.data).toEqual({
        reason: STALE_RATE_REASON,
        maxRateAgeMs: 1000,
        lastRateAt: 100_000,
        pair: pairKey(PAIR_EVM),
      });
    }

    // feed ticks again → fresh again ("sender re-requests and continues")
    quoteAt = 101_000;
    expect(await guard.check(PAIR_EVM)).toEqual({ stale: false });
  });

  it('unguarded pair (no bound resolves) never consults the provider', async () => {
    const provider = vi.fn(() => ({ rate: '1', at: 0 }));
    const guard = guardWith({
      maxRateAge: { perChain: { 'solana:devnet': 100 } },
      provider,
    });
    expect(await guard.check(PAIR_EVM)).toEqual({ stale: false });
    expect(provider).not.toHaveBeenCalled();
  });

  it('provider failure ages against the last good tick; never-ticked → stale with lastRateAt null', async () => {
    let t = 50_000;
    let fail = true;
    const guard = guardWith({
      maxRateAge: { defaultMs: 1000 },
      provider: () => {
        if (fail) throw new Error('feed down');
        return { rate: '1', at: t };
      },
      now: () => t,
    });

    // Feed down and never ticked → stale, lastRateAt: null.
    const neverTicked = await guard.check(PAIR_EVM);
    expect(neverTicked.stale).toBe(true);
    if (neverTicked.stale) expect(neverTicked.data.lastRateAt).toBeNull();

    // Tick once, then feed goes down: within the bound → pass.
    fail = false;
    await guard.check(PAIR_EVM);
    fail = true;
    t = 50_500;
    expect(await guard.check(PAIR_EVM)).toEqual({ stale: false });

    // Past the bound while the feed is down → stale against the last tick.
    t = 51_001;
    const staleDown = await guard.check(PAIR_EVM);
    expect(staleDown.stale).toBe(true);
    if (staleDown.stale) expect(staleDown.data.lastRateAt).toBe(50_000);
  });

  it('untimestamped (bare string) quotes are inert: treated as fresh, warned once per pair', async () => {
    const warn = vi.fn();
    let t = 0;
    const guard = guardWith({
      maxRateAge: { defaultMs: 10 },
      provider: () => '0.5',
      now: () => t,
      warn,
    });
    t = 1_000_000; // any age — unmeasurable
    expect(await guard.check(PAIR_EVM)).toEqual({ stale: false });
    expect(await guard.check(PAIR_EVM)).toEqual({ stale: false });
    const untimestampedWarns = warn.mock.calls.filter(
      (c) => c[0] === 'swap.rate_staleness.untimestamped_quote'
    );
    expect(untimestampedWarns.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reject contract
// ---------------------------------------------------------------------------

describe('buildStaleRateReject — the reject contract', () => {
  const data: StaleRateRejectData = {
    reason: STALE_RATE_REASON,
    maxRateAgeMs: 10_000,
    lastRateAt: 123_456,
    pair: pairKey(PAIR_MINA),
  };

  it('emits T99 / stale_rate / base64-JSON data per rolling-swap §4', () => {
    const reject = buildStaleRateReject(data);
    expect(reject.accept).toBe(false);
    expect(reject.code).toBe(STALE_RATE_REJECT_CODE);
    expect(STALE_RATE_REJECT_CODE).toBe('T99');
    expect(reject.message).toBe(STALE_RATE_REJECT_MESSAGE);
    expect(STALE_RATE_REJECT_MESSAGE).toBe('stale_rate');
    expect(decodeRejectData(reject.data)).toEqual(data);
  });

  it('pins rejectReason so the connector adapter does NOT collapse T99 to a fatal class', () => {
    // startSwapNode()'s generic reverse-map only fills rejectReason when absent;
    // ilpCodeToSemantic('T99') would collapse to 'invalid_request' → wire
    // F00 (fatal). The contract pins a T-class semantic instead.
    const reject = buildStaleRateReject(data);
    expect(reject.rejectReason).toEqual({
      code: STALE_RATE_SEMANTIC_REASON,
      message: STALE_RATE_REJECT_MESSAGE,
    });
    // 'timeout' → T00 in connector <=3.20.1 REJECT_CODE_MAP (T-class,
    // retryable). Flip to 'stale_rate' when the connector maps it to T99.
    expect(STALE_RATE_SEMANTIC_REASON).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// toSdkRateProvider — pricing-time backstop
// ---------------------------------------------------------------------------

describe('RateFreshnessGuard.toSdkRateProvider', () => {
  it('returns the plain rate for fresh timestamped quotes and bare strings', async () => {
    const t = 1_000;
    const guard = guardWith({
      maxRateAge: { defaultMs: 500 },
      provider: () => ({ rate: '0.25', at: t }),
      now: () => t,
    });
    await expect(guard.toSdkRateProvider()(PAIR_EVM)).resolves.toBe('0.25');

    const bare = guardWith({
      maxRateAge: { defaultMs: 500 },
      provider: () => '0.75',
      now: () => t,
    });
    await expect(bare.toSdkRateProvider()(PAIR_EVM)).resolves.toBe('0.75');
  });

  it('throws StaleRateError when the pricing-time quote is already past the bound', async () => {
    const t = 10_000;
    const guard = guardWith({
      maxRateAge: { defaultMs: 500 },
      provider: () => ({ rate: '0.25', at: 9_000 }),
      now: () => t,
    });
    const err = await guard
      .toSdkRateProvider()(PAIR_EVM)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleRateError);
    expect((err as StaleRateError).code).toBe('STALE_RATE');
    expect((err as StaleRateError).data.lastRateAt).toBe(9_000);
  });
});

describe('normalizeRateProvider', () => {
  it('strips timestamps without any staleness enforcement', async () => {
    const normalized = normalizeRateProvider(() => ({ rate: '3.14', at: 0 }));
    await expect(normalized(PAIR_EVM)).resolves.toBe('3.14');
    const passthrough = normalizeRateProvider(() => '2.71');
    await expect(passthrough(PAIR_EVM)).resolves.toBe('2.71');
  });
});

// ---------------------------------------------------------------------------
// withMaxRateAge — the gate decorator
// ---------------------------------------------------------------------------

function buildWrappedSwapCtx(opts: {
  recipientSecretKey: Uint8Array;
  pair?: SwapPair;
  tags?: string[][];
  kind?: number;
  toonOverride?: string;
}): HandlerContext {
  const senderSecretKey = generateSecretKey();
  const senderPubkey = getPublicKey(senderSecretKey);
  let toonBase64 = opts.toonOverride;
  if (toonBase64 === undefined) {
    const pair = opts.pair ?? PAIR_EVM;
    const rumor: UnsignedEvent = {
      kind: 30_078,
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: opts.tags ?? [
        ['swap-from', `${pair.from.assetCode}:${pair.from.chain}`],
        ['swap-to', `${pair.to.assetCode}:${pair.to.chain}`],
        ['chain-recipient', '0x' + '11'.repeat(20)],
      ],
    };
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey: getPublicKey(opts.recipientSecretKey),
    });
    toonBase64 = Buffer.from(encodeEventToToon(giftWrap)).toString('base64');
  }
  return createHandlerContext({
    toon: toonBase64,
    meta: { kind: opts.kind ?? 1059, pubkey: '0'.repeat(64) },
    amount: 1_000_000n,
    destination: 'g.toon.swap.test',
    toonDecoder: () => {
      throw new Error('not used');
    },
  });
}

describe('withMaxRateAge gate', () => {
  const recipientSecretKey = generateSecretKey();

  function innerSpy(): { handler: Handler; calls: HandlerContext[] } {
    const calls: HandlerContext[] = [];
    const handler: Handler = async (ctx) => {
      calls.push(ctx);
      return ctx.accept({ inner: true });
    };
    return { handler, calls };
  }

  it('stale pair → T99 stale_rate reject; the inner handler NEVER runs', async () => {
    const t = 100_000;
    const guard = guardWith({
      maxRateAge: { defaultMs: 1000 },
      provider: () => ({ rate: '0.0004', at: 90_000 }),
      now: () => t,
    });
    const { handler, calls } = innerSpy();
    const gated = withMaxRateAge(handler, {
      guard,
      recipientSecretKey,
      swapPairs: [PAIR_EVM],
    });

    const res = await gated(buildWrappedSwapCtx({ recipientSecretKey }));
    expect(res.accept).toBe(false);
    if (!res.accept) {
      expect(res.code).toBe(STALE_RATE_REJECT_CODE);
      expect(res.message).toBe(STALE_RATE_REJECT_MESSAGE);
      const data = decodeRejectData((res as { data?: string }).data as string);
      expect(data.reason).toBe(STALE_RATE_REASON);
      expect(data.maxRateAgeMs).toBe(1000);
      expect(data.lastRateAt).toBe(90_000);
      expect(data.pair).toBe(pairKey(PAIR_EVM));
    }
    expect(calls.length).toBe(0);
  });

  it('fresh pair → delegates to the inner handler untouched', async () => {
    const t = 100_000;
    const guard = guardWith({
      maxRateAge: { defaultMs: 1000 },
      provider: () => ({ rate: '0.0004', at: t - 100 }),
      now: () => t,
    });
    const { handler, calls } = innerSpy();
    const gated = withMaxRateAge(handler, {
      guard,
      recipientSecretKey,
      swapPairs: [PAIR_EVM],
    });
    const res = await gated(buildWrappedSwapCtx({ recipientSecretKey }));
    expect(res.accept).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('non-1059 / malformed wrap / unsupported pair all fall through to the inner handler', async () => {
    const guard = guardWith({
      maxRateAge: { defaultMs: 1 },
      provider: () => ({ rate: '1', at: 0 }),
      now: () => 1_000_000, // everything would be stale IF the gate applied
    });
    const { handler, calls } = innerSpy();
    const gated = withMaxRateAge(handler, {
      guard,
      recipientSecretKey,
      swapPairs: [PAIR_EVM],
    });

    // non-1059 kind
    await gated(buildWrappedSwapCtx({ recipientSecretKey, kind: 1 }));
    // malformed gift wrap (garbage TOON)
    await gated(
      buildWrappedSwapCtx({
        recipientSecretKey,
        toonOverride: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'),
      })
    );
    // valid wrap, pair not advertised → inner's canonical F06 territory
    await gated(buildWrappedSwapCtx({ recipientSecretKey, pair: PAIR_MINA }));

    expect(calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('validateMaxRateAgeConfig / SwapNodeConfig.maxRateAge validation', () => {
  it('accepts well-formed configs', () => {
    expect(() =>
      validateMaxRateAgeConfig({
        defaultMs: 3000,
        perChain: { mina: 15_000 },
        perPair: { [pairKey(PAIR_MINA)]: 10_000 },
      })
    ).not.toThrow();
  });

  it.each([
    [{ defaultMs: 0 }],
    [{ defaultMs: -5 }],
    [{ defaultMs: Number.NaN }],
    [{ perChain: { mina: Infinity } }],
    [{ perPair: { x: '10' as unknown as number } }],
  ])('rejects malformed bounds %j', (cfg) => {
    expect(() => validateMaxRateAgeConfig(cfg)).toThrow();
  });

  it('SwapNodeConfig.maxRateAge without a rateProvider fails validateConfig with INVALID_CONFIG', () => {
    const config = {
      mnemonic: 'test test test test test test test test test test test junk',
      swapPairs: [PAIR_EVM],
      chains: ['evm'],
      channels: {
        'evm:31337': [
          {
            channelId: '0x' + '01'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { 'evm:31337': 10n ** 18n },
      relayUrls: ['ws://localhost:0'],
      maxRateAge: { defaultMs: 1000 },
    } as unknown as SwapNodeConfig;
    expect(() => validateConfig(config)).toThrow(/rateProvider/);
    expect(() =>
      validateConfig({
        ...config,
        rateProvider: () => ({ rate: '1', at: Date.now() }),
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Recommended defaults sanity (full derivation in the calibration harness)
// ---------------------------------------------------------------------------

describe('RECOMMENDED_MAX_RATE_AGE_MS', () => {
  it('covers the three chain families with maker-tunable (non-protocol) bounds', () => {
    expect(Object.keys(RECOMMENDED_MAX_RATE_AGE_MS).sort()).toEqual([
      'evm',
      'mina',
      'solana',
    ]);
    // Slow-feed classes need looser bounds: evm < solana < mina.
    expect(RECOMMENDED_MAX_RATE_AGE_MS['evm']!).toBeLessThan(
      RECOMMENDED_MAX_RATE_AGE_MS['solana']!
    );
    expect(RECOMMENDED_MAX_RATE_AGE_MS['solana']!).toBeLessThan(
      RECOMMENDED_MAX_RATE_AGE_MS['mina']!
    );
  });
});
