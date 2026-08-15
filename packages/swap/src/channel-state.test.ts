/**
 * Channel-state tests — Story 12.4 AC-7, AC-11 (channel-state block).
 *
 * T-cs-1 — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect } from 'vitest';

import { SwapChannelState } from './channel-state.js';
import { SwapWalletError } from './errors.js';

const KEY = {
  assetCode: 'ETH',
  chain: 'evm:base:8453',
  senderPubkey: 'a'.repeat(64),
};

function makeProvisioned() {
  return new SwapChannelState({
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

describe('SwapChannelState — per-channel nonce + cumulativeAmount (Story 12.4 AC-7)', () => {
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

  it("[P0] reserve on missing channel throws SwapWalletError('UNSUPPORTED_CHAIN')", () => {
    const cs = new SwapChannelState({ channels: {} });
    try {
      cs.reserve({ ...KEY, cumulativeDelta: 1n });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SwapWalletError);
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
    const cs = new SwapChannelState({ channels: {} });
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
    const cs = new SwapChannelState({ channels: {} });
    expect(() => cs.release({ ...KEY, cumulativeDelta: 1n })).not.toThrow();
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
    const cs = new SwapChannelState({
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
    const cs = new SwapChannelState({
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
      'swap.channelState.release.noop_would_underflow'
    );
    // State unchanged.
    expect(cs.get(KEY)!.nonce).toBe(1n);
    expect(cs.get(KEY)!.cumulativeAmount).toBe(3n);
  });

  it('[P2] release on unknown channel emits warn + no throw', () => {
    const calls: unknown[][] = [];
    const cs = new SwapChannelState({
      channels: {},
      logger: { warn: (...a: unknown[]) => calls.push(a) },
    });
    cs.release({ ...KEY, cumulativeDelta: 1n });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe('swap.channelState.release.unknown_channel');
  });

  // -------------------------------------------------------------------------
  // Gap-fill: releaseAll() — Story 12.7 AC-3 / AC-12 (bulk reservation flush)
  // Added by testarch-automate to cover the missing tests called out in the
  // story's "Modified files" section for `channel-state.test.ts`.
  // -------------------------------------------------------------------------

  it('[P1] releaseAll() resets every tracked channel to nonce=0 and cumulativeAmount=0', () => {
    const otherKey = {
      assetCode: 'USDC',
      chain: 'evm:8453',
      senderPubkey: 'b'.repeat(64),
    };
    const cs = new SwapChannelState({
      channels: {
        [`${KEY.assetCode}:${KEY.chain}:${KEY.senderPubkey}`]: {
          channelId: '0xchan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
        [`${otherKey.assetCode}:${otherKey.chain}:${otherKey.senderPubkey}`]: {
          channelId: '0xchan-2',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });

    // Build up non-zero state on both channels.
    cs.reserve({ ...KEY, cumulativeDelta: 10n });
    cs.reserve({ ...KEY, cumulativeDelta: 5n });
    cs.reserve({ ...otherKey, cumulativeDelta: 99n });

    cs.releaseAll();

    const e1 = cs.get(KEY)!;
    const e2 = cs.get(otherKey)!;
    expect(e1.nonce).toBe(0n);
    expect(e1.cumulativeAmount).toBe(0n);
    expect(e2.nonce).toBe(0n);
    expect(e2.cumulativeAmount).toBe(0n);
  });

  it('[P2] releaseAll() preserves channelId on reset entries', () => {
    const cs = makeProvisioned();
    cs.reserve({ ...KEY, cumulativeDelta: 42n });
    cs.releaseAll();
    expect(cs.get(KEY)!.channelId).toBe('0xchan');
  });

  it('[P2] releaseAll() is a no-op on an empty channel map (does not throw)', () => {
    const cs = new SwapChannelState({ channels: {} });
    expect(() => cs.releaseAll()).not.toThrow();
  });

  it('[P2] releaseAll() is idempotent — calling twice leaves zeroed state', () => {
    const cs = makeProvisioned();
    cs.reserve({ ...KEY, cumulativeDelta: 7n });
    cs.releaseAll();
    cs.releaseAll();
    const e = cs.get(KEY)!;
    expect(e.nonce).toBe(0n);
    expect(e.cumulativeAmount).toBe(0n);
  });

  it('[P2] releaseAll() stamps updatedAt from the injected clock', () => {
    let now = 100;
    const cs = new SwapChannelState({
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
    now = 7777;
    cs.releaseAll();
    expect(cs.get(KEY)!.updatedAt).toBe(7777);
  });
});

// ---------------------------------------------------------------------------
// Story 12.8 AC-12 — per-sender sticky channel binding
// ---------------------------------------------------------------------------

describe('Story 12.8 AC-12 — sender→channel sticky binding', () => {
  const SENDER_A = 'a'.repeat(64);
  const SENDER_B = 'b'.repeat(64);

  function makeTwoChannelPool() {
    return new SwapChannelState({
      channels: {
        // Provision two channels keyed by channelId for the same (asset, chain).
        'ETH:evm:31337:0xchan-1': {
          channelId: '0xchan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
        'ETH:evm:31337:0xchan-2': {
          channelId: '0xchan-2',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
  }

  it('[P0] two senders bind to distinct channels (first-available policy)', () => {
    const cs = makeTwoChannelPool();
    const rA = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 10n,
    });
    const rB = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 20n,
    });
    expect(rA.channelId).not.toBe(rB.channelId);
  });

  it('[P0] same sender repeated reserves stay bound to the same channel', () => {
    const cs = makeTwoChannelPool();
    const r1 = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    const r2 = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 2n,
    });
    const r3 = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 3n,
    });
    expect(r1.channelId).toBe(r2.channelId);
    expect(r2.channelId).toBe(r3.channelId);
    expect(r3.nonce).toBe(3n);
    expect(r3.cumulativeAmount).toBe(6n);
  });

  it('[P1] getBindings() snapshot reflects both sticky assignments after AC-7-style flow', () => {
    const cs = makeTwoChannelPool();
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 1n,
    });
    const bindings = cs.getBindings();
    expect(Object.keys(bindings)).toHaveLength(2);
    expect(bindings[`ETH:evm:31337:${SENDER_A}`]).toBeDefined();
    expect(bindings[`ETH:evm:31337:${SENDER_B}`]).toBeDefined();
    // Snapshot is defensive — mutating it does not affect internal state.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete bindings[`ETH:evm:31337:${SENDER_A}`];
    expect(Object.keys(cs.getBindings())).toHaveLength(2);
  });

  it('[P1] releaseAll() clears sticky bindings (shutdown-scoped)', () => {
    const cs = makeTwoChannelPool();
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    expect(Object.keys(cs.getBindings())).toHaveLength(1);
    cs.releaseAll();
    expect(Object.keys(cs.getBindings())).toHaveLength(0);
  });

  it('[P1] third sender with only two provisioned channels → throws UNSUPPORTED_CHAIN', () => {
    const cs = makeTwoChannelPool();
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 1n,
    });
    const SENDER_C = 'c'.repeat(64);
    expect(() =>
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_C,
        cumulativeDelta: 1n,
      })
    ).toThrow(SwapWalletError);
  });
});

// ---------------------------------------------------------------------------
// Issue #113 — idle-based sticky-binding reclaim
// ---------------------------------------------------------------------------
//
// A released client daemon mints a FRESH ephemeral sender pubkey per
// `POST /swap` — every request looks like a brand-new sender to the
// AC-12 "first UNBOUND channel" policy above. With only one channel
// provisioned (the common single-channel deployment), the second request's
// sender can never bind, and `reserve()` throws UNSUPPORTED_CHAIN forever
// (persisted bindings survive a restart too — only deleting the state file
// "fixes" it). `bindingIdleTtlMs` lets an operator opt into reclaiming a
// bound channel from whichever sender has been idle the longest, but ONLY
// once no unbound channel exists AND the oldest binding has actually gone
// idle — so an active multi-sender AC-12 deployment is unaffected.
describe('Issue #113 — idle-based sticky-binding reclaim', () => {
  const SENDER_A = 'a'.repeat(64);
  const SENDER_B = 'b'.repeat(64);

  it.each([[0], [-1], [Number.NaN], [Infinity]])(
    '[P2] constructor rejects a non-positive-finite bindingIdleTtlMs (%j)',
    (bad) => {
      expect(
        () => new SwapChannelState({ channels: {}, bindingIdleTtlMs: bad })
      ).toThrow();
    }
  );

  function makeOneChannelPool(bindingIdleTtlMs: number, clock: () => number) {
    return new SwapChannelState({
      channels: {
        'ETH:evm:31337:0xchan-1': {
          channelId: '0xchan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
      bindingIdleTtlMs,
      clock,
    });
  }

  it('[P0] a fresh sender reclaims the sole channel once the prior binding has been idle past bindingIdleTtlMs', () => {
    let now = 0;
    const cs = makeOneChannelPool(1000, () => now);

    const r1 = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });

    now = 1000; // exactly at the idle threshold
    const r2 = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 2n,
    });

    expect(r2.channelId).toBe(r1.channelId);
    // The channel's running nonce/cumulativeAmount watermark is NOT reset on
    // reclaim — it is a single on-chain channel's monotonic ledger, and the
    // balance-proof `recipient` (not the sticky-binding sender) determines
    // who a claim pays.
    expect(r2.nonce).toBe(2n);
    expect(r2.cumulativeAmount).toBe(3n);

    const bindings = cs.getBindings();
    expect(bindings['ETH:evm:31337:' + SENDER_A]).toBeUndefined();
    expect(bindings['ETH:evm:31337:' + SENDER_B]).toBe(
      'ETH:evm:31337:0xchan-1'
    );
  });

  it("[P0] a fresh sender does NOT reclaim the channel before bindingIdleTtlMs has elapsed (an active sender's binding is never stolen)", () => {
    let now = 0;
    const cs = makeOneChannelPool(1000, () => now);

    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });

    now = 999; // one ms short of the idle threshold
    expect(() =>
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).toThrow(SwapWalletError);
  });

  it('[P1] without bindingIdleTtlMs configured, behavior is unchanged (throws regardless of elapsed time)', () => {
    let now = 0;
    const cs = new SwapChannelState({
      channels: {
        'ETH:evm:31337:0xchan-1': {
          channelId: '0xchan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
      clock: () => now,
    });
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    now = 1_000_000_000;
    expect(() =>
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).toThrow(SwapWalletError);
  });

  it('[P1] reclaim picks the LEAST-recently-active bound channel among multiple idle candidates', () => {
    let now = 0;
    const cs = new SwapChannelState({
      channels: {
        'ETH:evm:31337:0xchan-1': {
          channelId: '0xchan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
        'ETH:evm:31337:0xchan-2': {
          channelId: '0xchan-2',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
      bindingIdleTtlMs: 1000,
      clock: () => now,
    });

    // SENDER_A binds first (at t=0); SENDER_B binds second (at t=500).
    const rA = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    now = 500;
    cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 1n,
    });

    // At t=1500 both are idle-eligible (>=1000ms since their last activity),
    // but SENDER_A has been idle longest — it should be reclaimed first.
    now = 1500;
    const SENDER_C = 'c'.repeat(64);
    const rC = cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_C,
      cumulativeDelta: 1n,
    });
    expect(rC.channelId).toBe(rA.channelId);

    const bindings = cs.getBindings();
    expect(bindings['ETH:evm:31337:' + SENDER_A]).toBeUndefined();
    expect(bindings['ETH:evm:31337:' + SENDER_B]).toBe(
      'ETH:evm:31337:0xchan-2'
    );
  });
});
