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

import { describe, it, expect, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  ReceiptChainTracker,
  serializeReceiptChain,
  verifyStreamReceipt,
} from '@toon-protocol/sdk';
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
  createConnectorLegBSender,
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
  reservationGraceMs?: number;
  /** Issue #49 — in-flight window ceiling for the fixture pool. */
  windowBudget?: bigint;
  /** Issue #50 — maker receipt key (spec §7.2 receipts on accept records). */
  receiptSecretKey?: Uint8Array;
}): Stack {
  const persisted = options?.rehydrateFrom ?? null;

  const inventory = new SwapInventory({
    balances: persisted
      ? Object.fromEntries(
          Object.entries(persisted.inventory).map(([k, v]) => [
            k,
            {
              available: BigInt(v.available),
              total: BigInt(v.total),
              unsettled: BigInt(v.unsettled ?? '0'),
              ...(options?.windowBudget !== undefined && {
                windowBudget: options.windowBudget,
              }),
            },
          ])
        )
      : {
          [INVENTORY_KEY]: {
            available: INITIAL_INVENTORY,
            total: INITIAL_INVENTORY,
            ...(options?.windowBudget !== undefined && {
              windowBudget: options.windowBudget,
            }),
          },
        },
    // Issue #49 — rehydrate in-flight reservations + settled watermarks
    // exactly as startSwapNode does (expire-and-release recovery).
    ...(persisted && {
      reservations: Object.fromEntries(
        Object.entries(persisted.reservations).map(([id, r]) => [
          id,
          { key: r.key, amount: BigInt(r.amount), expiresAt: r.expiresAt },
        ])
      ),
      settledWatermarks: Object.fromEntries(
        Object.entries(persisted.settledWatermarks).map(([k, v]) => [
          k,
          BigInt(v),
        ])
      ),
    }),
    ...(options?.now && { clock: options.now }),
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
    // v2 EIP-712 domain (connector#324 finding #1): the real EVM signer now
    // requires the per-chain RollingSwapChannel `verifyingContract`. chainId is
    // parsed from CHAIN ('evm:31337' → 31337n).
    settlementContracts: {
      [CHAIN]: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    },
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
    ...(options?.reservationGraceMs !== undefined && {
      reservationGraceMs: options.reservationGraceMs,
    }),
    ...(options?.receiptSecretKey && {
      receiptSecretKey: options.receiptSecretKey,
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

function windowOf(stack: Stack) {
  const w = stack.inventory
    .windowSnapshot()
    .find((e) => e.assetCode === ASSET && e.chain === CHAIN);
  expect(w).toBeDefined();
  return w!;
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

    // State (issue #49): NO permanent debit — the fulfilled fill's amount
    // moved reservation → unsettled liability; available is untouched.
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
    const w = windowOf(stack);
    expect(w.inFlight).toBe(0n);
    expect(w.unsettled).toBe(TARGET_PER_DELTA);
    expect(w.free).toBe(INITIAL_INVENTORY - TARGET_PER_DELTA);
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

    // AC-4: the failed packet fully unwound the window reservation +
    // channel reservation — released, not converted (issue #49).
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
    const wUnwound = windowOf(stack);
    expect(wUnwound.inFlight).toBe(0n);
    expect(wUnwound.unsettled).toBe(0n);
    expect(wUnwound.free).toBe(INITIAL_INVENTORY);
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
    expect(windowOf(stack).free).toBe(INITIAL_INVENTORY);

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

  it('insufficient window capacity → T04 insufficient_funds, replay seq burned', async () => {
    const stack = buildStack();
    // 1 ETH window (no explicit budget → ceiling degrades to available);
    // ask for a fill needing 4000 ETH (10^7 USDC * 0.0004).
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

describe('rolling engine — crash between reservation and fulfill', () => {
  it('persisted snapshot at leg-B time is the safe state; recovery expires-and-releases the reservation with no leaked capacity and no double-spend', async () => {
    let now = 1_700_000_000_000;
    const stack = buildStack({ now: () => now });
    let crashSnapshot: PersistedSwapState | null = null;
    stack.legB.respond = () => {
      // The instant leg B is in flight IS the crash window: the write-ahead
      // persist has already happened (crash rule 1 — the reservation is
      // durable BEFORE the leg-B advance is externalized). Capture disk
      // state, then die before any response/unwind.
      crashSnapshot = structuredClone(stack.saved());
      throw new Error('simulated crash');
    };
    await sendFill(stack, 1).catch(() => undefined);

    expect(crashSnapshot).not.toBeNull();
    const snap = crashSnapshot! as PersistedSwapState;
    // Watermark advanced + window RESERVED (not debited — issue #49) +
    // replay seq reserved — all BEFORE the claim could have left the process.
    expect(snap.channels[CHANNEL_KEY]!.nonce).toBe('1');
    expect(snap.channels[CHANNEL_KEY]!.cumulativeAmount).toBe(
      TARGET_PER_DELTA.toString()
    );
    expect(BigInt(snap.inventory[INVENTORY_KEY]!.available)).toBe(
      INITIAL_INVENTORY
    );
    expect(snap.inventory[INVENTORY_KEY]!.unsettled).toBe('0');
    const persistedReservations = Object.values(snap.reservations);
    expect(persistedReservations).toHaveLength(1);
    expect(persistedReservations[0]!.key).toBe(INVENTORY_KEY);
    expect(persistedReservations[0]!.amount).toBe(TARGET_PER_DELTA.toString());
    expect(snap.seenPacketIds).toContain(`rolling:${STREAM_NONCE}:1`);

    // "Reboot" from the crash snapshot.
    const rebooted = buildStack({ rehydrateFrom: snap, now: () => now });

    // Until its TTL, the rehydrated reservation still occupies the window
    // (conservative: the crashed packet is treated as possibly live).
    const before = windowOf(rebooted);
    expect(before.inFlight).toBe(TARGET_PER_DELTA);
    expect(before.free).toBe(INITIAL_INVENTORY - TARGET_PER_DELTA);

    // Replay of the aborted fill → F04 (crash rule 4, fail-closed) — the
    // no-double-spend half of recovery.
    const replay = await sendFill(rebooted, 1);
    expect(replay.response.accept).toBe(false);
    if (!replay.response.accept) expect(replay.response.code).toBe('F04');

    // Past the persisted expiry, the reservation expires-and-releases
    // (crash rule 6) — the no-leaked-capacity half of recovery.
    now = persistedReservations[0]!.expiresAt + 1;
    const after = windowOf(rebooted);
    expect(after.inFlight).toBe(0n);
    expect(after.unsettled).toBe(0n);
    expect(after.free).toBe(INITIAL_INVENTORY);

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
// Issue #49 — in-flight window: capacity, TTL alignment, settle-and-recycle
// ---------------------------------------------------------------------------

describe('rolling engine — in-flight window (issue #49)', () => {
  it('window budget exhausted by in-flight packets → benign T04 insufficient_liquidity; releases restore capacity', async () => {
    // Budget = exactly 2 packets. Hold two fills in flight (leg B pending).
    const stack = buildStack({
      windowBudget: TARGET_PER_DELTA * 2n,
      rateProvider: () => ({ rate: '0.0004', at: Date.now() }),
    });
    const preimages = stackPreimages(stack);
    const resolvers: (() => void)[] = [];
    stack.legB.respond = (prepare) =>
      new Promise<LegBResult>((resolve) => {
        resolvers.push(() => {
          const key = Buffer.from(prepare.executionCondition).toString(
            'base64'
          );
          resolve({ type: 'fulfill', fulfillment: preimages.get(key)! });
        });
      });

    const fill1 = sendFill(stack, 1);
    const fill2 = sendFill(stack, 2);
    // Let both fills reach the leg-B await (claim signing is async).
    await vi.waitFor(() =>
      expect(windowOf(stack).inFlight).toBe(TARGET_PER_DELTA * 2n)
    );
    expect(windowOf(stack).free).toBe(0n);

    // Third fill exceeds the window → benign capacity refusal (same T04
    // vocabulary as a reserves shortage), nothing new in flight.
    stack.legB.respond = () => {
      throw new Error('leg B must not be attempted for a refused fill');
    };
    const refused = await sendFill(stack, 3);
    expect(refused.response.accept).toBe(false);
    if (!refused.response.accept) {
      expect(refused.response.code).toBe('T04');
      expect(refused.response.rejectReason.code).toBe('insufficient_funds');
      expect(decodeRejectData(refused.response.data)['reason']).toBe(
        ROLLING_REJECT_REASONS.INSUFFICIENT_LIQUIDITY
      );
    }
    expect(windowOf(stack).inFlight).toBe(TARGET_PER_DELTA * 2n);

    // Resolve the held packets → reservations convert to unsettled.
    for (const r of resolvers) r();
    const [r1, r2] = await Promise.all([fill1, fill2]);
    expect(r1.response.accept).toBe(true);
    expect(r2.response.accept).toBe(true);
    const w = windowOf(stack);
    expect(w.inFlight).toBe(0n);
    expect(w.unsettled).toBe(TARGET_PER_DELTA * 2n);
    expect(w.free).toBe(0n);

    // Settlement confirmation recycles the capacity (settle-and-recycle).
    const reduced = stack.inventory.recordSettlement({
      assetCode: ASSET,
      chain: CHAIN,
      channelId: CHANNEL_ID,
      cumulativeAmount: TARGET_PER_DELTA * 2n,
    });
    expect(reduced).toBe(TARGET_PER_DELTA * 2n);
    const settled = windowOf(stack);
    expect(settled.unsettled).toBe(0n);
    expect(settled.free).toBe(TARGET_PER_DELTA * 2n);
    stack.legB.respond = (prepare) => {
      const key = Buffer.from(prepare.executionCondition).toString('base64');
      return { type: 'fulfill', fulfillment: preimages.get(key)! };
    };
    const retry = await sendFill(stack, 4);
    expect(retry.response.accept).toBe(true);
  });

  it('reservation TTL is aligned with the leg-B expiry budget + grace (spec R7)', async () => {
    const now = 1_700_000_000_000;
    const stack = buildStack({
      now: () => now,
      legBBudgetMs: 10_000,
      reservationGraceMs: 2_000,
    });
    let observedExpiry: number | undefined;
    stack.legB.respond = (prepare) => {
      const reservations = Object.values(
        stack.inventory.reservationsSnapshot()
      );
      expect(reservations).toHaveLength(1);
      observedExpiry = reservations[0]!.expiresAt;
      const key = Buffer.from(prepare.executionCondition).toString('base64');
      return {
        type: 'fulfill',
        fulfillment: stackPreimages(stack).get(key)!,
      };
    };
    const { response } = await sendFill(stack, 1);
    expect(response.accept).toBe(true);
    // legBExpiry = now + budget (no leg-A expiry cap here); TTL adds grace.
    expect(observedExpiry).toBe(now + 10_000 + 2_000);
  });

  it('AC-1: a long stream settles through a window budget ≪ notional volume; no permanent debit anywhere', async () => {
    const FILLS = 60;
    const BUDGET = TARGET_PER_DELTA * 5n; // 5-packet window
    const SETTLE_EVERY = 4;
    const stack = buildStack({
      windowBudget: BUDGET,
      rateProvider: () => ({ rate: '0.0004', at: Date.now() }),
    });

    let maxExposure = 0n;
    let settledCumulative = 0n;
    for (let seq = 1; seq <= FILLS; seq++) {
      const { response } = await sendFill(stack, seq);
      expect(response.accept).toBe(true);
      const w = windowOf(stack);
      const exposure = w.inFlight + w.unsettled;
      if (exposure > maxExposure) maxExposure = exposure;
      // Steady-state float: exposure never exceeds the window budget.
      expect(exposure <= BUDGET).toBe(true);
      if (seq % SETTLE_EVERY === 0) {
        // Batched on-chain settlement confirms the latest cumulative
        // watermark → liability shrinks, capacity recycles.
        settledCumulative = TARGET_PER_DELTA * BigInt(seq);
        stack.inventory.recordSettlement({
          assetCode: ASSET,
          chain: CHAIN,
          channelId: CHANNEL_ID,
          cumulativeAmount: settledCumulative,
        });
      }
    }

    const notionalDelivered = TARGET_PER_DELTA * BigInt(FILLS);
    // The whole stream flowed through a float 12× smaller than notional.
    expect(notionalDelivered).toBe(BUDGET * 12n);
    expect(maxExposure <= BUDGET).toBe(true);
    // AC-4: no permanent-debit path — available never moved.
    expect(stack.inventory.get(ASSET, CHAIN)!.available).toBe(
      INITIAL_INVENTORY
    );
    // Watermark integrity across the stream.
    const entry = stack.channelState.get({
      assetCode: ASSET,
      chain: CHAIN,
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(BigInt(FILLS));
    expect(entry.cumulativeAmount).toBe(notionalDelivered);
    // Stale/replayed settlement confirmations are no-ops (monotone).
    expect(
      stack.inventory.recordSettlement({
        assetCode: ASSET,
        chain: CHAIN,
        channelId: CHANNEL_ID,
        cumulativeAmount: settledCumulative,
      })
    ).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Receipts on the rolling path (issue #50, spec §7.2, sdk 2.2.0 toon#84)
// ---------------------------------------------------------------------------

describe('rolling engine — per-fulfill stream receipts', () => {
  const RECEIPT_SECRET = new Uint8Array(32).fill(41);

  function decodeAccept(response: RollingFillResponse): RollingAcceptRecord {
    expect(response.accept).toBe(true);
    const accepted = response as Extract<RollingFillResponse, { accept: true }>;
    return JSON.parse(
      Buffer.from(accepted.data, 'base64').toString('utf8')
    ) as RollingAcceptRecord;
  }

  it('every ACCEPTED fill carries a verifiable receipt; the chain accumulates gapless and matches the watermark across a mid-stream failure', async () => {
    const receiptPubkey = Buffer.from(
      secp256k1.getPublicKey(RECEIPT_SECRET, true).slice(1)
    ).toString('hex');
    const stack = buildStack({ receiptSecretKey: RECEIPT_SECRET });
    const tracker = new ReceiptChainTracker({
      streamNonce: STREAM_NONCE,
      makerPubkey: receiptPubkey,
    });

    // Fills 1-2 fulfill.
    for (const seq of [1, 2]) {
      const { response } = await sendFill(stack, seq);
      const record = decodeAccept(response);
      expect(record.receipt).toBeDefined();
      expect(verifyStreamReceipt(record.receipt!, receiptPubkey)).toBe(true);
      expect(tracker.add(record.receipt!)).toEqual({ ok: true });
    }

    // Fill 3: sender withholds — REJECTED packets get NO receipt and do not
    // advance the receipt session (no seq hole, no cumulative gap).
    stack.legB.respond = () => ({
      type: 'reject',
      code: 'T00',
      message: 'withheld',
    });
    const { response: rejected } = await sendFill(stack, 3);
    expect(rejected.accept).toBe(false);

    // Fill 4 (new sender seq, per spec §4) fulfills; the maker's receipt seq
    // continues gapless at 3.
    stack.legB.respond = (prepare) => {
      const key = Buffer.from(prepare.executionCondition).toString('base64');
      const preimage = stackPreimages(stack).get(key);
      return preimage
        ? { type: 'fulfill', fulfillment: preimage }
        : { type: 'reject', code: 'F99', message: 'unknown condition' };
    };
    const { response: last } = await sendFill(stack, 4);
    const lastRecord = decodeAccept(last);
    expect(tracker.add(lastRecord.receipt!)).toEqual({ ok: true });
    expect(lastRecord.receipt!.seq).toBe(3);

    const chain = tracker.chain();
    expect(chain.receipts).toHaveLength(3);
    expect(chain.holes).toEqual([]);
    // The signed cumulativeDelivered equals the channel watermark the maker
    // handed out — the audit artifact matches the claim stream (spec §7.2).
    expect(chain.totalDelivered).toBe((TARGET_PER_DELTA * 3n).toString());
    expect(chain.totalDelivered).toBe(lastRecord.cumulativeAmount);
    // And the serialized artifact round-trips.
    const artifact = JSON.parse(serializeReceiptChain(chain)) as {
      receipts: unknown[];
    };
    expect(artifact.receipts).toHaveLength(3);
  });

  it('no receipt key wired → accept records carry no receipt (behavior unchanged)', async () => {
    const stack = buildStack();
    const { response } = await sendFill(stack, 1);
    expect(decodeAccept(response).receipt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createConnectorLegBSender — public sendPacket egress (issue #50 pre-step)
// ---------------------------------------------------------------------------

describe('createConnectorLegBSender — public SendPacketParams.executionCondition egress', () => {
  function prepareFixture(): {
    prepare: LegBPrepare;
    preimage: Uint8Array;
  } {
    const { preimage, condition } = mintPacket();
    return {
      preimage,
      prepare: {
        destination: SENDER_ILP,
        amount: TARGET_PER_DELTA,
        expiresAt: new Date(Date.now() + 30_000),
        executionCondition: condition,
        data: Buffer.from('{"proto":"rolling/1","type":"advance"}', 'utf8'),
      },
    };
  }

  it('passes the condition to connector.sendPacket verbatim and surfaces the revealed preimage', async () => {
    const { prepare, preimage } = prepareFixture();
    const calls: Record<string, unknown>[] = [];
    const connector = {
      sendPacket: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          type: 13,
          fulfillment: preimage,
          data: Buffer.from('ok'),
        };
      },
    };
    const send = createConnectorLegBSender(connector, { nodeId: 'maker' });
    const result = await send(prepare);

    expect(calls).toHaveLength(1);
    expect(calls[0]!['destination']).toBe(SENDER_ILP);
    expect(calls[0]!['amount']).toBe(TARGET_PER_DELTA);
    expect(calls[0]!['executionCondition']).toBe(prepare.executionCondition);
    expect(result.type).toBe('fulfill');
    expect(
      Buffer.compare(
        Buffer.from((result as { fulfillment: Uint8Array }).fulfillment),
        Buffer.from(preimage)
      )
    ).toBe(0);
  });

  it('fail-closed: a FULFILL without the correct preimage (e.g. a connector that dropped the condition) is rejected at the seam', async () => {
    const { prepare } = prepareFixture();
    for (const fulfillment of [
      undefined,
      new Uint8Array(16),
      new Uint8Array(32).fill(9), // wrong preimage
    ]) {
      const send = createConnectorLegBSender(
        { sendPacket: async () => ({ type: 13, fulfillment }) },
        { nodeId: 'maker' }
      );
      const result = await send(prepare);
      expect(result.type).toBe('reject');
      expect((result as { code: string }).code).toBe('F99');
      expect((result as { message: string }).message).toMatch(/preimage/);
    }
  });

  it('fail-closed: no sendPacket seam → reject, nothing sent; sendPacket throwing (3.30.0 condition validation) → benign T00', async () => {
    const { prepare } = prepareFixture();

    const noSeam = createConnectorLegBSender({}, { nodeId: 'maker' });
    const noSeamResult = await noSeam(prepare);
    expect(noSeamResult.type).toBe('reject');
    expect((noSeamResult as { code: string }).code).toBe('T00');

    const throwing = createConnectorLegBSender(
      {
        sendPacket: async () => {
          throw new Error('executionCondition must be exactly 32 bytes');
        },
      },
      { nodeId: 'maker' }
    );
    const thrownResult = await throwing(prepare);
    expect(thrownResult.type).toBe('reject');
    expect((thrownResult as { code: string }).code).toBe('T00');
    expect((thrownResult as { message: string }).message).toMatch(
      /leg-B send failed/
    );
  });

  it('REJECT results pass through code/message', async () => {
    const { prepare } = prepareFixture();
    const send = createConnectorLegBSender(
      {
        sendPacket: async () => ({
          type: 14,
          code: 'F02',
          message: 'no route to destination',
        }),
      },
      { nodeId: 'maker' }
    );
    const result = await send(prepare);
    expect(result).toMatchObject({
      type: 'reject',
      code: 'F02',
      message: 'no route to destination',
    });
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
