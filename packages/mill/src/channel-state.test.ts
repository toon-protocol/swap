/**
 * Channel-state tests — Story 12.4 AC-7, AC-11 (channel-state block).
 *
 * T-cs-1 — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect } from 'vitest';

import { MillChannelState } from './channel-state.js';
import { MillWalletError } from './errors.js';

const KEY = {
  assetCode: 'ETH',
  chain: 'evm:base:8453',
  senderPubkey: 'a'.repeat(64),
};

function makeProvisioned() {
  return new MillChannelState({
    channels: {
      [`${KEY.assetCode}:${KEY.chain}:${KEY.senderPubkey}`]: {
        channelId: '0xchan',
        cumulativeAmount: 0n,
        nonce: 0n,
        updatedAt: 0,
      },
    },
  });
}

describe('MillChannelState — per-channel nonce + cumulativeAmount (Story 12.4 AC-7)', () => {
  it('[P0] reserve increments nonce by 1 and adds cumulativeDelta atomically', () => {
    const cs = makeProvisioned();

    const r1 = cs.reserve({ ...KEY, cumulativeDelta: 10n });
    expect(r1.channelId).toBe('0xchan');
    expect(r1.nonce).toBe(1n);
    expect(r1.cumulativeAmount).toBe(10n);

    const r2 = cs.reserve({ ...KEY, cumulativeDelta: 5n });
    expect(r2.nonce).toBe(2n);
    expect(r2.cumulativeAmount).toBe(15n);
  });

  it("[P0] reserve on missing channel throws MillWalletError('UNSUPPORTED_CHAIN')", () => {
    const cs = new MillChannelState({ channels: {} });
    try {
      cs.reserve({ ...KEY, cumulativeDelta: 1n });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MillWalletError);
      expect((err as { code?: string }).code).toBe('UNSUPPORTED_CHAIN');
    }
  });

  it('[P1] release reverses the last reservation (nonce -1, cumulativeAmount -delta)', () => {
    const cs = makeProvisioned();
    cs.reserve({ ...KEY, cumulativeDelta: 10n });
    cs.release({ ...KEY, cumulativeDelta: 10n });
    const entry = cs.get(KEY);
    expect(entry!.nonce).toBe(0n);
    expect(entry!.cumulativeAmount).toBe(0n);
  });

  it('[P0] (T-cs-1) concurrent reserve race: two concurrent reservations return distinct monotonic nonces (1 and 2); sum of deltas is final cumulativeAmount', async () => {
    const cs = makeProvisioned();

    const a = Promise.resolve().then(() =>
      cs.reserve({ ...KEY, cumulativeDelta: 7n })
    );
    const b = Promise.resolve().then(() =>
      cs.reserve({ ...KEY, cumulativeDelta: 3n })
    );

    const [r1, r2] = await Promise.all([a, b]);
    const nonces = new Set([r1.nonce, r2.nonce]);
    expect(nonces.size).toBe(2);
    expect([...nonces].sort()).toEqual([1n, 2n]);

    const entry = cs.get(KEY);
    expect(entry!.cumulativeAmount).toBe(10n);
    expect(entry!.nonce).toBe(2n);
  });

  // -------------------------------------------------------------------------
  // Gap-fill tests (AC-7 contract clauses not yet covered above)
  // -------------------------------------------------------------------------

  it('[P1] get() returns null for an unprovisioned channel', () => {
    const cs = new MillChannelState({ channels: {} });
    expect(cs.get(KEY)).toBeNull();
  });

  it('[P2] get() returns a copy — mutating it does not affect internal state', () => {
    const cs = makeProvisioned();
    cs.reserve({ ...KEY, cumulativeDelta: 10n });
    const snap = cs.get(KEY)!;
    snap.cumulativeAmount = 9999n;
    snap.nonce = 42n;
    const fresh = cs.get(KEY)!;
    expect(fresh.cumulativeAmount).toBe(10n);
    expect(fresh.nonce).toBe(1n);
  });

  it('[P1] release on an unprovisioned channel is a no-op (does not throw)', () => {
    const cs = new MillChannelState({ channels: {} });
    expect(() =>
      cs.release({ ...KEY, cumulativeDelta: 1n })
    ).not.toThrow();
  });

  it('[P1] release is a no-op when it would drive nonce negative (best-effort reversal)', () => {
    const cs = makeProvisioned();
    // No prior reserve → nonce is 0n. release must not push it negative.
    cs.release({ ...KEY, cumulativeDelta: 5n });
    const entry = cs.get(KEY)!;
    expect(entry.nonce).toBe(0n);
    expect(entry.cumulativeAmount).toBe(0n);
  });

  it('[P1] release is a no-op when cumulativeDelta exceeds accumulated cumulativeAmount', () => {
    const cs = makeProvisioned();
    cs.reserve({ ...KEY, cumulativeDelta: 3n });
    // Try to release a bigger delta than was reserved.
    cs.release({ ...KEY, cumulativeDelta: 100n });
    const entry = cs.get(KEY)!;
    // Should remain at post-reserve values (no-op).
    expect(entry.cumulativeAmount).toBe(3n);
    expect(entry.nonce).toBe(1n);
  });

  it('[P2] custom clock is used for updatedAt on reserve and release', () => {
    let now = 100;
    const cs = new MillChannelState({
      channels: {
        [`${KEY.assetCode}:${KEY.chain}:${KEY.senderPubkey}`]: {
          channelId: '0xchan',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
      clock: () => now,
    });

    now = 500;
    cs.reserve({ ...KEY, cumulativeDelta: 5n });
    expect(cs.get(KEY)!.updatedAt).toBe(500);

    now = 900;
    cs.release({ ...KEY, cumulativeDelta: 5n });
    expect(cs.get(KEY)!.updatedAt).toBe(900);
  });

  it('[P2] release logs warn when it would drive nonce/cumulative negative (AC-7 no-op + warn)', () => {
    const calls: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => calls.push(args),
    };
    const cs = new MillChannelState({
      channels: {
        [`${KEY.assetCode}:${KEY.chain}:${KEY.senderPubkey}`]: {
          channelId: '0xchan',
          cumulativeAmount: 3n,
          nonce: 1n,
          updatedAt: 0,
        },
      },
      logger,
    });
    // Delta larger than cumulativeAmount → no-op + warn.
    cs.release({ ...KEY, cumulativeDelta: 100n });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe(
      'mill.channelState.release.noop_would_underflow'
    );
    // State unchanged.
    expect(cs.get(KEY)!.nonce).toBe(1n);
    expect(cs.get(KEY)!.cumulativeAmount).toBe(3n);
  });

  it('[P2] release on unknown channel emits warn + no throw', () => {
    const calls: unknown[][] = [];
    const cs = new MillChannelState({
      channels: {},
      logger: { warn: (...a: unknown[]) => calls.push(a) },
    });
    cs.release({ ...KEY, cumulativeDelta: 1n });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe('mill.channelState.release.unknown_channel');
  });
});
