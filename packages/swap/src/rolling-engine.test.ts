/**
 * Rolling swap engine unit tests (swap#47).
 *
 * Covers the issue's acceptance criteria at the engine seam:
 *   - coupled happy path: condition in → SAME condition on leg B → correct
 *     preimage out → claim advance consistent (AC-1)
 *   - the coupling property at the CONTRACT level, with the connector's
 *     local-delivery enforcement mocked byte-for-byte per
 *     `connector/docs/local-delivery-fulfillment-contract.md`: a maker that
 *     cannot present the sender-revealed preimage collects NOTHING (AC-1/AC-2)
 *   - wrong/withheld preimage → benign leg-A failure, nothing stays debited
 *     (AC-2, AC-4 full unwind)
 *   - staleness reject still benign + byte-identical (swap#48 contract)
 *   - replay rejected; crash between debit and fulfill leaves the persisted
 *     safe state (state-store crash rules 2/4)
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SwapPair } from '@toon-protocol/core';

import { SwapInventory } from './inventory.js';
import { SwapChannelState } from './channel-state.js';
import { MultiChainClaimIssuer } from './claim-issuer.js';
import { EvmPaymentChannelSigner } from './payment-channel-signer.js';
import { SwapStatePersister, PersistentSeenPacketIds } from './state-store.js';
import type { PersistedSwapState, SwapStateStore } from './state-store.js';
import {
  RateFreshnessGuard,
  STALE_RATE_REJECT_CODE,
  STALE_RATE_REJECT_MESSAGE,
  STALE_RATE_REASON,
  STALE_RATE_SEMANTIC_REASON,
} from './rate-staleness.js';
import type { TimestampedRate } from './rate-staleness.js';
import {
  RollingSessionStore,
  RollingSwapEngine,
  ROLLING_PROTOCOL,
  ROLLING_REJECT_REASONS,
  parseRollingFillPayload,
} from './rolling-engine.js';
import type {
  LegBPrepare,
  LegBResult,
  LegBSender,
  RollingAdvancePayload,
  RollingAcceptRecord,
  RollingFillPayload,
  RollingFillResponse,
} from './rolling-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAIN = 'evm:31337';
const ASSET = 'ETH';
const INVENTORY_KEY = `${ASSET}:${CHAIN}`;
const CHANNEL_ID = '0x' + 'ab'.repeat(32);
const CHANNEL_KEY = `${ASSET}:${CHAIN}:${CHANNEL_ID}`;
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const SENDER_PUBKEY = 'f'.repeat(64);
const SENDER_ILP = 'g.toon.client.sender01';
const STREAM_NONCE = '9f'.repeat(16);
const INITIAL_INVENTORY = 10n ** 18n; // 1 ETH in wei

function fixturePair(): SwapPair {
  return {
    from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
    to: { assetCode: ASSET, assetScale: 18, chain: CHAIN },
    rate: '0.0004',
  };
}

/** δ = 1 USDC → ⌊δ·0.0004⌋ = 4e14 wei at the static rate. */
const DELTA = 1_000_000n;
const TARGET_PER_DELTA = 400_000_000_000_000n;

function mintPacket(): { preimage: Uint8Array; condition: Uint8Array } {
  const preimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimage);
  return { preimage, condition: sha256(preimage) };
}

function fillPayload(
  seq: number,
  streamNonce = STREAM_NONCE
): RollingFillPayload {
  return { proto: ROLLING_PROTOCOL, type: 'fill', streamNonce, seq };
}

function decodeRejectData(dataB64?: string): Record<string, unknown> {
  expect(dataB64).toBeTypeOf('string');
  return JSON.parse(Buffer.from(dataB64!, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function decodeAdvance(prepare: LegBPrepare): RollingAdvancePayload {
  return JSON.parse(prepare.data.toString('utf8')) as RollingAdvancePayload;
}

interface Stack {
  engine: RollingSwapEngine;
  inventory: SwapInventory;
  channelState: SwapChannelState;
  seen: PersistentSeenPacketIds;
  sessions: RollingSessionStore;
  saved: () => PersistedSwapState | null;
  legB: CapturingLegB;
}

interface CapturingLegB {
  sender: LegBSender;
  received: LegBPrepare[];
  /** Per-call behavior override; default reveals the matching preimage. */
  respond: (prepare: LegBPrepare) => Promise<LegBResult> | LegBResult;
}

/**
 * The default leg-B counterpart: a compliant sender daemon that "reveals"
 * the preimage matching the condition it received (tests hand it the mint
 * map). Overridable per test for withhold/wrong-preimage/reject behavior.
 */
function makeLegB(preimageByCondition: Map<string, Uint8Array>): CapturingLegB {
  const legB: CapturingLegB = {
    received: [],
    respond: (prepare) => {
      const key = Buffer.from(prepare.executionCondition).toString('base64');
      const preimage = preimageByCondition.get(key);
      if (!preimage) {
        return { type: 'reject', code: 'F99', message: 'unknown condition' };
      }
      return { type: 'fulfill', fulfillment: preimage };
    },
    sender: async (prepare) => {
      legB.received.push(prepare);
      return legB.respond(prepare);
    },
  };
  return legB;
}

function buildStack(options?: {
  rateProvider?: () => TimestampedRate | string;
  maxRateAgeMs?: number;
  now?: () => number;
  rehydrateFrom?: PersistedSwapState;
  minLegBTimeMs?: number;
  legBExpiryMarginMs?: number;
  legBBudgetMs?: number;
}): Stack {
  const persisted = options?.rehydrateFrom ?? null;

  const inventory = new SwapInventory({
    balances: persisted
      ? Object.fromEntries(
          Object.entries(persisted.inventory).map(([k, v]) => [
            k,
            { available: BigInt(v.available), total: BigInt(v.total) },
          ])
        )
      : {
          [INVENTORY_KEY]: {
            available: INITIAL_INVENTORY,
            total: INITIAL_INVENTORY,
          },
        },
  });
  const channelState = new SwapChannelState({
    channels: persisted
      ? Object.fromEntries(
          Object.entries(persisted.channels).map(([k, v]) => [
            k,
            {
              channelId: v.channelId,
              cumulativeAmount: BigInt(v.cumulativeAmount),
              nonce: BigInt(v.nonce),
              updatedAt: v.updatedAt,
            },
          ])
        )
      : {
          [CHANNEL_KEY]: {
            channelId: CHANNEL_ID,
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        },
    ...(persisted && { bindings: persisted.bindings }),
  });

  let savedState: PersistedSwapState | null = null;
  const store: SwapStateStore = {
    load: () => savedState,
    save: (s) => {
      savedState = s;
    },
  };
  const seen = new PersistentSeenPacketIds(persisted?.seenPacketIds ?? []);
  const persister = new SwapStatePersister({
    store,
    inventory,
    channelState,
    seenPacketIds: seen,
  });
  seen.setOnMutate(() => persister.persist());

  const claimIssuer = new MultiChainClaimIssuer({
    inventory,
    channelState,
    signers: {
      [CHAIN]: new EvmPaymentChannelSigner({
        chain: CHAIN,
        privateKey: new Uint8Array(32).fill(7),
      }),
    },
    signerAddresses: { [CHAIN]: '0x' + '22'.repeat(20) },
    persistState: () => persister.persist(),
  });

  const preimageByCondition = new Map<string, Uint8Array>();
  const legB = makeLegB(preimageByCondition);
  // Expose the mint map through the legB object for tests.
  (legB as CapturingLegB & { preimages: Map<string, Uint8Array> }).preimages =
    preimageByCondition;

  const sessions = new RollingSessionStore({ now: options?.now });
  sessions.register({
    streamNonce: STREAM_NONCE,
    pair: fixturePair(),
    chainRecipient: CHAIN_RECIPIENT,
    senderIlpAddress: SENDER_ILP,
    senderPubkey: SENDER_PUBKEY,
  });

  const guard =
    options?.maxRateAgeMs !== undefined
      ? new RateFreshnessGuard({
          maxRateAge: { defaultMs: options.maxRateAgeMs },
          rateProvider: options.rateProvider ?? (() => fixturePair().rate),
          ...(options.now && { now: options.now }),
        })
      : undefined;

  const engine = new RollingSwapEngine({
    sessions,
    claimIssuer,
    legBSender: legB.sender,
    seenPacketIds: seen,
    ...(options?.rateProvider && { rateProvider: options.rateProvider }),
    ...(guard && { stalenessGuard: guard }),
    ...(options?.now && { now: options.now }),
    ...(options?.minLegBTimeMs !== undefined && {
      minLegBTimeMs: options.minLegBTimeMs,
    }),
    ...(options?.legBExpiryMarginMs !== undefined && {
      legBExpiryMarginMs: options.legBExpiryMarginMs,
    }),
    ...(options?.legBBudgetMs !== undefined && {
      legBBudgetMs: options.legBBudgetMs,
    }),
  });

  return {
    engine,
    inventory,
    channelState,
    seen,
    sessions,
    saved: () => savedState,
    legB,
  };
}

function stackPreimages(stack: Stack): Map<string, Uint8Array> {
  return (stack.legB as CapturingLegB & { preimages: Map<string, Uint8Array> })
    .preimages;
}

async function sendFill(
  stack: Stack,
  seq: number,
  opts?: {
    condition?: Uint8Array;
    amount?: string;
    expiresAt?: string;
    streamNonce?: string;
  }
): Promise<{
  response: RollingFillResponse;
  preimage: Uint8Array;
  condition: Uint8Array;
}> {
  const { preimage, condition } = mintPacket();
  const cond = opts?.condition ?? condition;
  stackPreimages(stack).set(Buffer.from(cond).toString('base64'), preimage);
  const response = await stack.engine.handleFill({
    amount: opts?.amount ?? DELTA.toString(),
    destination: 'g.toon.swap.fixture',
    executionCondition: cond,
    payload: fillPayload(seq, opts?.streamNonce),
    ...(opts?.expiresAt !== undefined && { expiresAt: opts.expiresAt }),
  });
  return { response, preimage, condition: cond };
}

// ---------------------------------------------------------------------------
// Connector local-delivery enforcement, mocked per the contract doc
// ---------------------------------------------------------------------------

/**
 * `connector/docs/local-delivery-fulfillment-contract.md` rule 3, verbatim:
 * before FULFILLing upstream the connector enforces
 * `sha256(fulfillment) === executionCondition`; on a missing, malformed, or
 * mismatching preimage the fulfill is converted into an F99 REJECT and
 * NOTHING is recorded as delivered.
 */
function connectorEnforce(
  response: RollingFillResponse,
  condition: Uint8Array
):
  | { delivered: true; fulfillment: Uint8Array }
  | { delivered: false; code: string } {
  if (!response.accept) {
    return { delivered: false, code: response.code };
  }
  const f = response.fulfillment
    ? new Uint8Array(Buffer.from(response.fulfillment, 'base64'))
    : undefined;
  if (
    !f ||
    f.length !== 32 ||
    Buffer.compare(Buffer.from(sha256(f)), Buffer.from(condition)) !== 0
  ) {
    return { delivered: false, code: 'F99' };
  }
  return { delivered: true, fulfillment: f };
}

// ---------------------------------------------------------------------------
// Happy path (AC-1)
// ---------------------------------------------------------------------------

describe('rolling engine — coupled happy path', () => {
  it('condition in → SAME condition on leg B → correct preimage out → claim advance consistent', async () => {
    const stack = buildStack({
      rateProvider: () => ({ rate: '0.0004', at: Date.now() }),
    });

    const { response, preimage, condition } = await sendFill(stack, 1);

    // Leg B carried the SAME sender-minted condition (spec R4) to the
    // session's ILP address, priced at the fresh rate.
    expect(stack.legB.received).toHaveLength(1);
    const legB = stack.legB.received[0]!;
    expect(Buffer.from(legB.executionCondition)).toEqual(
      Buffer.from(condition)
    );
    expect(legB.destination).toBe(SENDER_ILP);
    expect(legB.amount).toBe(TARGET_PER_DELTA);

    // The leg-B advance payload carries the chain-B claim + quote tape.
    const advance = decodeAdvance(legB);
    expect(advance.proto).toBe(ROLLING_PROTOCOL);
    expect(advance.type).toBe('advance');
    expect(advance.streamNonce).toBe(STREAM_NONCE);
    expect(advance.seq).toBe(1);
    expect(advance.claim.length).toBeGreaterThan(0);
    expect(advance.channelId).toBe(CHANNEL_ID);
    expect(advance.nonce).toBe('1');
    expect(advance.cumulativeAmount).toBe(TARGET_PER_DELTA.toString());
    expect(advance.recipient).toBe(CHAIN_RECIPIENT);
    expect(advance.rate).toBe('0.0004');
    expect(advance.rateTimestamp).toBeTypeOf('number');
    expect(advance.sourceAmount).toBe(DELTA.toString());
    expect(advance.targetAmount).toBe(TARGET_PER_DELTA.toString());

    // Leg A accepted WITH the revealed preimage (spec R6) — and the mocked
    // connector enforcement (contract rule 3) verifies and delivers it.
    expect(response.accept).toBe(true);
    const enforced = connectorEnforce(response, condition);
    expect(enforced.delivered).toBe(true);
    if (response.accept) {
      expect(Buffer.from(response.fulfillment, 'base64')).toEqual(
        Buffer.from(preimage)
      );
      // The leg-A FULFILL data is the compact accept record — the claim
      // itself traveled on leg B, not here (the headline change vs legacy).
      const record = JSON.parse(
        Buffer.from(response.data, 'base64').toString('utf8')
      ) as RollingAcceptRecord;
      expect(record.type).toBe('accept');
      expect(record.rate).toBe('0.0004');
      expect(record.targetAmount).toBe(TARGET_PER_DELTA.toString());
      expect(record.nonce).toBe('1');
      expect(record.cumulativeAmount).toBe(TARGET_PER_DELTA.toString());
      expect(JSON.stringify(record)).not.toContain(advance.claim);
    }

    // State: debit + watermark advance stand.
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY - TARGET_PER_DELTA
    );
    const entry = stack.channelState.get({
      assetCode: ASSET,
      chain: CHAIN,
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(1n);
    expect(entry.cumulativeAmount).toBe(TARGET_PER_DELTA);
  });

  it('multi-packet stream: cumulative claims are monotone and per-packet priced', async () => {
    let tick = 0;
    const rates = ['0.0004', '0.0005', '0.0003'];
    const stack = buildStack({
      rateProvider: () => ({ rate: rates[tick++ % 3]!, at: Date.now() }),
    });

    // ⌊1 USDC · R_i⌋ in wei per quoted rate.
    const deltaByRate: Record<string, bigint> = {
      '0.0004': 4n * 10n ** 14n,
      '0.0005': 5n * 10n ** 14n,
      '0.0003': 3n * 10n ** 14n,
    };
    let expectedCumulative = 0n;
    for (let seq = 1; seq <= 3; seq++) {
      const { response, condition } = await sendFill(stack, seq);
      expect(connectorEnforce(response, condition).delivered).toBe(true);
      const advance = decodeAdvance(stack.legB.received[seq - 1]!);
      const rate = rates[seq - 1]!;
      expect(advance.rate).toBe(rate);
      expectedCumulative += deltaByRate[rate]!;
      expect(advance.nonce).toBe(String(seq));
      expect(advance.cumulativeAmount).toBe(expectedCumulative.toString());
    }
  });
});

// ---------------------------------------------------------------------------
// The coupling property (AC-1/AC-2), at the contract level
// ---------------------------------------------------------------------------

describe('rolling engine — maker cannot collect leg A while withholding leg B', () => {
  it('sender withholds the reveal (leg B rejected) → leg A fails benignly, full unwind', async () => {
    const stack = buildStack();
    stack.legB.respond = () => ({
      type: 'reject',
      code: 'T00',
      message: 'sender declined to reveal',
    });

    const { response, condition } = await sendFill(stack, 1);

    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('T00'); // T-class leg-B failure stays T-class
      const data = decodeRejectData(response.data);
      expect(data['reason']).toBe(ROLLING_REJECT_REASONS.LEG_B_FAILED);
    }
    // Contract: the connector records nothing for a reject.
    expect(connectorEnforce(response, condition).delivered).toBe(false);

    // AC-4: the failed packet fully unwound inventory + channel reservation.
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
    const entry = stack.channelState.get({
      assetCode: ASSET,
      chain: CHAIN,
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(0n);
    expect(entry.cumulativeAmount).toBe(0n);
  });

  it('leg B "fulfills" with a WRONG preimage → engine unwinds and rejects; even a Byzantine accept could not pass the connector check', async () => {
    const stack = buildStack();
    const wrong = new Uint8Array(32).fill(9);
    stack.legB.respond = () => ({ type: 'fulfill', fulfillment: wrong });

    const { response, condition } = await sendFill(stack, 1);

    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F99');
      expect(decodeRejectData(response.data)['reason']).toBe(
        ROLLING_REJECT_REASONS.LEG_B_FULFILLMENT_INVALID
      );
    }
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );

    // Byzantine-maker simulation: even if a maker implementation tried to
    // accept anyway (with the wrong preimage, or none), the connector's
    // enforcement — mocked per contract rule 3 — converts it to F99 and
    // records nothing. The maker structurally cannot collect leg A without
    // the sender's reveal.
    const byzantineWithWrong: RollingFillResponse = {
      accept: true,
      data: '',
      fulfillment: Buffer.from(wrong).toString('base64'),
    };
    expect(connectorEnforce(byzantineWithWrong, condition)).toEqual({
      delivered: false,
      code: 'F99',
    });
    const byzantineWithout = {
      accept: true,
      data: '',
    } as unknown as RollingFillResponse;
    expect(connectorEnforce(byzantineWithout, condition)).toEqual({
      delivered: false,
      code: 'F99',
    });
  });

  it('leg B fails F-class → leg-A reject is F-class (F99) with leg-B detail', async () => {
    const stack = buildStack();
    stack.legB.respond = () => ({
      type: 'reject',
      code: 'F02',
      message: 'no route to sender',
    });
    const { response } = await sendFill(stack, 1);
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F99');
      const data = decodeRejectData(response.data);
      expect(data['reason']).toBe(ROLLING_REJECT_REASONS.LEG_B_FAILED);
      expect((data['legB'] as Record<string, unknown>)['code']).toBe('F02');
    }
  });

  it('leg-B sender that throws → unwound + benign reject', async () => {
    const stack = buildStack();
    stack.legB.respond = () => {
      throw new Error('socket exploded');
    };
    const { response } = await sendFill(stack, 1);
    expect(response.accept).toBe(false);
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
  });
});

// ---------------------------------------------------------------------------
// Guards: session, replay, staleness, amount, expiry
// ---------------------------------------------------------------------------

describe('rolling engine — guards', () => {
  it('unknown streamNonce → benign F06 unknown_session, no state change', async () => {
    const stack = buildStack();
    const { response } = await sendFill(stack, 1, {
      streamNonce: 'aa'.repeat(16),
    });
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F06');
      expect(response.rejectReason.code).toBe('unexpected_payment');
      expect(decodeRejectData(response.data)['reason']).toBe(
        ROLLING_REJECT_REASONS.UNKNOWN_SESSION
      );
    }
    expect(stack.legB.received).toHaveLength(0);
    expect(stack.seen.size).toBe(0);
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
  });

  it('replay of a fulfilled (streamNonce, seq) → F04 duplicate; exactly one claim issued', async () => {
    const stack = buildStack();
    const first = await sendFill(stack, 1);
    expect(first.response.accept).toBe(true);

    // Same seq again — even with a FRESH condition — is a replay.
    const second = await sendFill(stack, 1);
    expect(second.response.accept).toBe(false);
    if (!second.response.accept) {
      expect(second.response.code).toBe('F04');
      expect(decodeRejectData(second.response.data)['reason']).toBe(
        ROLLING_REJECT_REASONS.DUPLICATE_PACKET
      );
    }
    expect(stack.legB.received).toHaveLength(1);
    const entry = stack.channelState.get({
      assetCode: ASSET,
      chain: CHAIN,
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(1n);
  });

  it('stale feed → byte-identical swap#48 T99 stale_rate reject BEFORE any reservation or debit', async () => {
    let feedAt = 1_000_000;
    let now = 1_000_100;
    const stack = buildStack({
      rateProvider: () => ({ rate: '0.0004', at: feedAt }),
      maxRateAgeMs: 1_500,
      now: () => now,
    });

    // Age the feed past the bound.
    now = feedAt + 5_000;
    const stale = await sendFill(stack, 1);
    expect(stale.response.accept).toBe(false);
    if (!stale.response.accept) {
      expect(stale.response.code).toBe(STALE_RATE_REJECT_CODE);
      expect(stale.response.message).toBe(STALE_RATE_REJECT_MESSAGE);
      expect(stale.response.rejectReason.code).toBe(STALE_RATE_SEMANTIC_REASON);
      const data = decodeRejectData(stale.response.data);
      expect(data['reason']).toBe(STALE_RATE_REASON);
      expect(data['maxRateAgeMs']).toBe(1_500);
    }
    // Benign: NO replay reservation, NO debit, NO leg B (spec §4 / R8).
    expect(stack.seen.size).toBe(0);
    expect(stack.legB.received).toHaveLength(0);
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );

    // Feed ticks again → the SAME seq retries fine (no reservation burned).
    feedAt = now;
    const retry = await sendFill(stack, 1);
    expect(retry.response.accept).toBe(true);
  });

  it('invalid and non-positive amounts → F03, nothing debited', async () => {
    const stack = buildStack();
    for (const amount of ['0', '-5', 'not-a-number']) {
      const { response } = await sendFill(stack, 1, { amount });
      expect(response.accept).toBe(false);
      if (!response.accept) expect(response.code).toBe('F03');
    }
    expect(stack.legB.received).toHaveLength(0);
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
  });

  it('insufficient leg-A time budget → R00 before any debit (spec R7)', async () => {
    const now = 1_000_000_000;
    const stack = buildStack({ now: () => now, minLegBTimeMs: 2_000 });
    const { response } = await sendFill(stack, 1, {
      expiresAt: new Date(now + 1_500).toISOString(),
    });
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('R00');
      expect(decodeRejectData(response.data)['reason']).toBe(
        ROLLING_REJECT_REASONS.INSUFFICIENT_TIMEOUT
      );
    }
    expect(stack.legB.received).toHaveLength(0);
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
  });

  it('leg-B expiry is capped strictly under leg-A expiry (spec R7)', async () => {
    const now = 1_000_000_000;
    const stack = buildStack({
      now: () => now,
      legBExpiryMarginMs: 1_000,
      legBBudgetMs: 60_000,
    });
    const legAExpiry = now + 10_000;
    const { response } = await sendFill(stack, 1, {
      expiresAt: new Date(legAExpiry).toISOString(),
    });
    expect(response.accept).toBe(true);
    expect(stack.legB.received[0]!.expiresAt.getTime()).toBe(
      legAExpiry - 1_000
    );
  });

  it('insufficient inventory → T04 insufficient_funds, replay seq burned', async () => {
    const stack = buildStack();
    // 1 ETH inventory; ask for a fill needing 4000 ETH (10^7 USDC * 0.0004).
    const { response } = await sendFill(stack, 1, {
      amount: (10n ** 13n).toString(),
    });
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('T04');
      expect(response.rejectReason.code).toBe('insufficient_funds');
    }
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
    // The reservation is fail-closed: same seq cannot be retried.
    expect(stack.seen.has(`rolling:${STREAM_NONCE}:1`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Crash consistency (state-store rules 1/2/4)
// ---------------------------------------------------------------------------

describe('rolling engine — crash between debit and fulfill', () => {
  it('persisted snapshot at leg-B time is the safe state; restart continues monotonically and rejects the replay', async () => {
    const stack = buildStack();
    let crashSnapshot: PersistedSwapState | null = null;
    stack.legB.respond = () => {
      // The instant leg B is in flight IS the crash window: the write-ahead
      // persist has already happened (crash rule 1). Capture disk state,
      // then die before any response/unwind.
      crashSnapshot = structuredClone(stack.saved());
      throw new Error('simulated crash');
    };
    await sendFill(stack, 1).catch(() => undefined);

    expect(crashSnapshot).not.toBeNull();
    const snap = crashSnapshot! as PersistedSwapState;
    // Watermark advanced + inventory debited + replay seq reserved — all
    // BEFORE the claim could have left the process.
    expect(snap.channels[CHANNEL_KEY]!.nonce).toBe('1');
    expect(snap.channels[CHANNEL_KEY]!.cumulativeAmount).toBe(
      TARGET_PER_DELTA.toString()
    );
    expect(BigInt(snap.inventory[INVENTORY_KEY]!.available)).toBe(
      INITIAL_INVENTORY - TARGET_PER_DELTA
    );
    expect(snap.seenPacketIds).toContain(`rolling:${STREAM_NONCE}:1`);

    // "Reboot" from the crash snapshot.
    const rebooted = buildStack({ rehydrateFrom: snap });

    // Replay of the aborted fill → F04 (crash rule 4, fail-closed).
    const replay = await sendFill(rebooted, 1);
    expect(replay.response.accept).toBe(false);
    if (!replay.response.accept) expect(replay.response.code).toBe('F04');

    // The next fill continues ABOVE the aborted reservation (crash rule 2):
    // nonce 2, cumulative stacked on the aborted watermark — never behind
    // any claim a counterparty could hold.
    const next = await sendFill(rebooted, 2);
    expect(next.response.accept).toBe(true);
    const advance = decodeAdvance(rebooted.legB.received[0]!);
    expect(advance.nonce).toBe('2');
    expect(advance.cumulativeAmount).toBe((TARGET_PER_DELTA * 2n).toString());
  });
});

// ---------------------------------------------------------------------------
// Sessions + payload parsing
// ---------------------------------------------------------------------------

describe('RollingSessionStore', () => {
  it('normalizes streamNonce case, enforces shape, TTL-expires, and bounds size', () => {
    let now = 1_000;
    const store = new RollingSessionStore({
      ttlMs: 100,
      maxSessions: 2,
      now: () => now,
    });
    const base = {
      pair: fixturePair(),
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      senderPubkey: SENDER_PUBKEY,
    };
    expect(() => store.register({ ...base, streamNonce: 'xyz' })).toThrowError(
      /32 lowercase hex/
    );

    store.register({ ...base, streamNonce: 'AB'.repeat(16) });
    expect(store.get('ab'.repeat(16))).not.toBeNull();
    expect(store.get('AB'.repeat(16))).not.toBeNull();

    store.register({ ...base, streamNonce: 'cd'.repeat(16) });
    expect(() =>
      store.register({ ...base, streamNonce: 'ef'.repeat(16) })
    ).toThrowError(/full/);

    // TTL expiry frees capacity and get() returns null.
    now += 200;
    expect(store.get('ab'.repeat(16))).toBeNull();
    store.register({ ...base, streamNonce: 'ef'.repeat(16) });
    expect(store.get('ef'.repeat(16))).not.toBeNull();
  });
});

describe('parseRollingFillPayload', () => {
  const encode = (v: unknown): string =>
    Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

  it('accepts a well-formed fill', () => {
    expect(parseRollingFillPayload(encode(fillPayload(7)))).toEqual(
      fillPayload(7)
    );
  });

  it('returns null for non-rolling traffic (TOON, JSON without the proto tag, garbage)', () => {
    expect(parseRollingFillPayload('')).toBeNull();
    expect(
      parseRollingFillPayload(Buffer.from('not json').toString('base64'))
    ).toBeNull();
    expect(parseRollingFillPayload(encode({ hello: 'world' }))).toBeNull();
  });

  it("returns 'malformed' for rolling/1 traffic violating the fill shape", () => {
    expect(
      parseRollingFillPayload(encode({ proto: ROLLING_PROTOCOL, type: 'fill' }))
    ).toBe('malformed');
    expect(
      parseRollingFillPayload(
        encode({
          proto: ROLLING_PROTOCOL,
          type: 'fill',
          streamNonce: 'Z'.repeat(32),
          seq: 1,
        })
      )
    ).toBe('malformed');
    expect(
      parseRollingFillPayload(
        encode({
          proto: ROLLING_PROTOCOL,
          type: 'fill',
          streamNonce: STREAM_NONCE,
          seq: 0,
        })
      )
    ).toBe('malformed');
    expect(
      parseRollingFillPayload(
        encode({
          proto: ROLLING_PROTOCOL,
          type: 'advance',
          streamNonce: STREAM_NONCE,
          seq: 1,
        })
      )
    ).toBe('malformed');
  });
});
