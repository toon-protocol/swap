/**
 * Channel-state tests — Story 12.4 AC-7, AC-11 (channel-state block).
 *
 * T-cs-1 — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect } from 'vitest';

import { SwapChannelState } from './channel-state.js';
import type { ChannelOnChainReader } from './channel-state.js';
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
  it('[P0] reserve increments nonce by 1 and adds cumulativeDelta atomically', async () => {
    const cs = makeProvisioned();

    const r1 = await cs.reserve({ ...KEY, cumulativeDelta: 10n });
    expect(r1.channelId).toBe('0xchan');
    expect(r1.nonce).toBe(1n);
    expect(r1.cumulativeAmount).toBe(10n);

    const r2 = await cs.reserve({ ...KEY, cumulativeDelta: 5n });
    expect(r2.nonce).toBe(2n);
    expect(r2.cumulativeAmount).toBe(15n);
  });

  it("[P0] reserve on missing channel throws SwapWalletError('UNSUPPORTED_CHAIN')", async () => {
    const cs = new SwapChannelState({ channels: {} });
    const rejected = cs.reserve({ ...KEY, cumulativeDelta: 1n });
    await expect(rejected).rejects.toBeInstanceOf(SwapWalletError);
    await expect(rejected).rejects.toMatchObject({
      code: 'UNSUPPORTED_CHAIN',
    });
  });

  it('[P1] release reverses the last reservation (nonce -1, cumulativeAmount -delta)', async () => {
    const cs = makeProvisioned();
    await cs.reserve({ ...KEY, cumulativeDelta: 10n });
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

  it('[P2] get() returns a copy — mutating it does not affect internal state', async () => {
    const cs = makeProvisioned();
    await cs.reserve({ ...KEY, cumulativeDelta: 10n });
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

  it('[P1] release is a no-op when cumulativeDelta exceeds accumulated cumulativeAmount', async () => {
    const cs = makeProvisioned();
    await cs.reserve({ ...KEY, cumulativeDelta: 3n });
    // Try to release a bigger delta than was reserved.
    cs.release({ ...KEY, cumulativeDelta: 100n });
    const entry = cs.get(KEY)!;
    // Should remain at post-reserve values (no-op).
    expect(entry.cumulativeAmount).toBe(3n);
    expect(entry.nonce).toBe(1n);
  });

  it('[P2] custom clock is used for updatedAt on reserve and release', async () => {
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
    await cs.reserve({ ...KEY, cumulativeDelta: 5n });
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

  it('[P1] releaseAll() resets every tracked channel to nonce=0 and cumulativeAmount=0', async () => {
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
    await cs.reserve({ ...KEY, cumulativeDelta: 10n });
    await cs.reserve({ ...KEY, cumulativeDelta: 5n });
    await cs.reserve({ ...otherKey, cumulativeDelta: 99n });

    cs.releaseAll();

    const e1 = cs.get(KEY)!;
    const e2 = cs.get(otherKey)!;
    expect(e1.nonce).toBe(0n);
    expect(e1.cumulativeAmount).toBe(0n);
    expect(e2.nonce).toBe(0n);
    expect(e2.cumulativeAmount).toBe(0n);
  });

  it('[P2] releaseAll() preserves channelId on reset entries', async () => {
    const cs = makeProvisioned();
    await cs.reserve({ ...KEY, cumulativeDelta: 42n });
    cs.releaseAll();
    expect(cs.get(KEY)!.channelId).toBe('0xchan');
  });

  it('[P2] releaseAll() is a no-op on an empty channel map (does not throw)', () => {
    const cs = new SwapChannelState({ channels: {} });
    expect(() => cs.releaseAll()).not.toThrow();
  });

  it('[P2] releaseAll() is idempotent — calling twice leaves zeroed state', async () => {
    const cs = makeProvisioned();
    await cs.reserve({ ...KEY, cumulativeDelta: 7n });
    cs.releaseAll();
    cs.releaseAll();
    const e = cs.get(KEY)!;
    expect(e.nonce).toBe(0n);
    expect(e.cumulativeAmount).toBe(0n);
  });

  it('[P2] releaseAll() stamps updatedAt from the injected clock', async () => {
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
    await cs.reserve({ ...KEY, cumulativeDelta: 5n });
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

  it('[P0] two senders bind to distinct channels (first-available policy)', async () => {
    const cs = makeTwoChannelPool();
    const rA = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 10n,
    });
    const rB = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 20n,
    });
    expect(rA.channelId).not.toBe(rB.channelId);
  });

  it('[P0] same sender repeated reserves stay bound to the same channel', async () => {
    const cs = makeTwoChannelPool();
    const r1 = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    const r2 = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 2n,
    });
    const r3 = await cs.reserve({
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

  it('[P1] getBindings() snapshot reflects both sticky assignments after AC-7-style flow', async () => {
    const cs = makeTwoChannelPool();
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    await cs.reserve({
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

  it('[P1] releaseAll() clears sticky bindings (shutdown-scoped)', async () => {
    const cs = makeTwoChannelPool();
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    expect(Object.keys(cs.getBindings())).toHaveLength(1);
    cs.releaseAll();
    expect(Object.keys(cs.getBindings())).toHaveLength(0);
  });

  it('[P1] third sender with only two provisioned channels → throws UNSUPPORTED_CHAIN', async () => {
    const cs = makeTwoChannelPool();
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 1n,
    });
    const SENDER_C = 'c'.repeat(64);
    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_C,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(SwapWalletError);
  });
});

// ---------------------------------------------------------------------------
// Issue #113 — on-chain-safety-checked sticky-binding rebind
// ---------------------------------------------------------------------------
//
// A released client daemon mints a FRESH ephemeral sender pubkey per
// `POST /swap` — every request looks like a brand-new sender to the
// AC-12 "first UNBOUND channel" policy above. With only one channel
// provisioned (the common single-channel deployment), the second request's
// sender could never bind, and `reserve()` threw UNSUPPORTED_CHAIN forever.
//
// The FIRST fix attempt (an idle-timeout reclaim) was rejected on review:
// `RollingSwapChannel`'s `cumulativePaid`/`nonce` are per-CHANNEL, so
// stealing a channel from an idle-but-unredeemed sender lets the new
// sender's redeem sweep the old sender's unclaimed delta and StaleNonce-void
// the old claim — idleness does not imply redemption. The safety condition
// is on-chain: a bound channel may be rebound only when the chain's live
// `cumulativePaid` is >= this state's own off-chain `cumulativeAmount`
// watermark for it (i.e. every issued claim has already been redeemed or
// superseded).
describe('Issue #113 — on-chain-safety-checked sticky-binding rebind', () => {
  const SENDER_A = 'a'.repeat(64);
  const SENDER_B = 'b'.repeat(64);
  const SENDER_C = 'c'.repeat(64);

  /** A reader whose answers are supplied per-channelId by the test. */
  function makeReader(
    answers: Record<string, bigint | Error>
  ): ChannelOnChainReader {
    return {
      async getCumulativePaid({ channelId }) {
        const answer = answers[channelId];
        if (answer === undefined) {
          throw new Error(`no canned answer for ${channelId}`);
        }
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  function makeOneChannelPool(onChainReader?: ChannelOnChainReader) {
    return new SwapChannelState({
      channels: {
        'ETH:evm:31337:0xchan-1': {
          channelId: '0xchan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
      ...(onChainReader && { onChainReader }),
    });
  }

  it('[P0] a fresh sender rebinds the sole channel once its prior claim is fully redeemed on-chain', async () => {
    const cs = makeOneChannelPool(makeReader({ '0xchan-1': 1n }));

    const r1 = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });

    const r2 = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 2n,
    });

    expect(r2.channelId).toBe(r1.channelId);
    // The channel's running nonce/cumulativeAmount watermark is NOT reset on
    // rebind — it is a single on-chain channel's monotonic ledger, and the
    // rebind precondition guarantees no unredeemed value belongs to A.
    expect(r2.nonce).toBe(2n);
    expect(r2.cumulativeAmount).toBe(3n);

    const bindings = cs.getBindings();
    expect(bindings['ETH:evm:31337:' + SENDER_A]).toBeUndefined();
    expect(bindings['ETH:evm:31337:' + SENDER_B]).toBe(
      'ETH:evm:31337:0xchan-1'
    );
  });

  it('[P0] REGRESSION (PR #119 finding #1): an unredeemed claim refuses the rebind — A does not lose funds to B', async () => {
    // A holds an unredeemed (cumulativeAmount=1) claim; on-chain shows 0
    // paid out so far (A has not yet, or only partially, redeemed).
    const cs = makeOneChannelPool(makeReader({ '0xchan-1': 0n }));

    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });

    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(SwapWalletError);

    // A's binding — and its unredeemed watermark — is untouched.
    const bindings = cs.getBindings();
    expect(bindings['ETH:evm:31337:' + SENDER_A]).toBe(
      'ETH:evm:31337:0xchan-1'
    );
    expect(bindings['ETH:evm:31337:' + SENDER_B]).toBeUndefined();
  });

  it('[P0] a partially-redeemed claim (on-chain < off-chain watermark) also refuses the rebind', async () => {
    const cs = makeOneChannelPool(makeReader({ '0xchan-1': 6n }));
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 10n, // off-chain watermark now 10n; on-chain only 6n paid
    });
    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(SwapWalletError);
  });

  it('[P1] the UNSUPPORTED_CHAIN error names the channel and its unredeemed delta', async () => {
    const cs = makeOneChannelPool(makeReader({ '0xchan-1': 4n }));
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 10n,
    });
    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(/0xchan-1.*6 unredeemed/);
  });

  it('[P1] without an onChainReader configured, behavior is unchanged (always throws — the pre-#113 default)', async () => {
    const cs = makeOneChannelPool();
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(SwapWalletError);
  });

  it('[P1] an on-chain read failure fails closed for that candidate (no rebind, actionable error)', async () => {
    const cs = makeOneChannelPool(
      makeReader({ '0xchan-1': new Error('rpc timeout') })
    );
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(/on-chain read failed/);
  });

  it('[P1] among two bound candidates, only the fully-redeemed one is rebound', async () => {
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
      onChainReader: makeReader({
        '0xchan-1': 0n, // A: unredeemed — unsafe
        '0xchan-2': 5n, // B: fully redeemed — safe
      }),
    });

    const rA = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 1n,
    });
    const rB = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 5n,
    });
    expect(rA.channelId).not.toBe(rB.channelId);

    const rC = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_C,
      cumulativeDelta: 1n,
    });
    // Only chan-2 (B's, fully redeemed) is safe to steal.
    expect(rC.channelId).toBe(rB.channelId);
    const bindings = cs.getBindings();
    expect(bindings['ETH:evm:31337:' + SENDER_A]).toBe(
      'ETH:evm:31337:0xchan-1'
    );
    expect(bindings['ETH:evm:31337:' + SENDER_B]).toBeUndefined();
    expect(bindings['ETH:evm:31337:' + SENDER_C]).toBe(
      'ETH:evm:31337:0xchan-2'
    );
  });

  it('[P1] the RPC read is never cached — a stale-favorable answer on retry is honored (fresh read every attempt)', async () => {
    let call = 0;
    const cs = makeOneChannelPool({
      async getCumulativePaid() {
        call += 1;
        // Answer flips between reads: unredeemed on the first rebind attempt,
        // fully redeemed afterwards. A cached answer would keep refusing.
        return call === 1 ? 0n : 5n;
      },
    });
    await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_A,
      cumulativeDelta: 5n,
    });
    // First rebind attempt reads 0n (unsafe) → refused.
    await expect(
      cs.reserve({
        assetCode: 'ETH',
        chain: 'evm:31337',
        senderPubkey: SENDER_B,
        cumulativeDelta: 1n,
      })
    ).rejects.toThrow(SwapWalletError);
    expect(call).toBe(1);
    // Second attempt re-reads fresh (now 5n, safe) → succeeds.
    const r = await cs.reserve({
      assetCode: 'ETH',
      chain: 'evm:31337',
      senderPubkey: SENDER_B,
      cumulativeDelta: 1n,
    });
    expect(call).toBe(2);
    expect(r.channelId).toBe('0xchan-1');
  });
});
