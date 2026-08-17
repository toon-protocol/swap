/**
 * swap#153 — the ROLLING sender, for the Docker cross-chain E2E harness.
 *
 * This is the replacement for `streamSwap()` in `tests/e2e/`: the four suites
 * there drove the legacy zero-condition sender, which ADR 0003 removes. What
 * they get instead is the coupled-leg protocol, driven over the same real BTP
 * socket against the same real `startSwapNode()` peer1:
 *
 * ```
 *  sender connector (peerId == its own ILP address)
 *     │  leg 0  PREPARE amount=0, kind:20033 RFQ gift wrap ──▶ peer1
 *     │  ◀──────────────── FULFILL kind:20034 quote
 *     │  leg A  PREPARE δ + sender-minted condition Cᵢ ──────▶ peer1
 *     │             (+ a REAL chain-A per-packet claim, attached
 *     │              by this connector's PerPacketClaimService)
 *     │                                     peer1 issues the chain-B claim …
 *     │  ◀── leg B  PREPARE(advance, Cᵢ)    … back down THIS session
 *     │  ────────────────── FULFILL(Pᵢ) ──▶   (verify-before-reveal, R5)
 *     │  ◀──────────────── FULFILL(Pᵢ) for leg A
 * ```
 *
 * ## Why the sender is a `ConnectorNode` and not a `BtpRuntimeClient`
 *
 * `src/swap-node.leg-b-wire.test.ts` drives the maker from a raw
 * `BtpRuntimeClient` because it only needs leg 0 (amount 0) and a synthetic
 * leg B. These suites need a leg A that is genuinely PAID: δ > 0 means the
 * maker's `InboundClaimValidator` demands a payment-channel claim it can
 * verify against a real on-chain channel. The `ConnectorNode` the legacy
 * suites already built (`build-live-sender.ts`) opens that channel on the
 * harness Anvil and signs those claims, so it is what the rolling port keeps —
 * with two additions that the legacy path never needed and that
 * `build-live-sender.ts` documents: the connector's `nodeId` IS its ILP
 * address (the maker will not mint a session it cannot answer), and a
 * local-delivery handler terminates leg B.
 *
 * ## What the daemon verifies, and what it deliberately does not
 *
 * The leg-B daemon here enforces the structural half of spec R5 —
 * recipient equality, a strictly monotone (nonce, cumulativeAmount)
 * watermark, Δcumulative covering the advance's `targetAmount`, and the
 * `swapSignerAddress` the quote promised. It does NOT re-verify the v2
 * EIP-712 balance-proof signature: `tests/integration/
 * rolling-settlement.integration.test.ts` already runs the real client
 * pipeline (`ingestReceivedClaims`) for that, against a chain it also
 * settles on. Duplicating it here would add a second copy of the digest's
 * domain wiring without covering anything the routing-shaped defects this
 * harness exists to catch (`F02`, `T00`) live in.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { UnsignedEvent } from 'nostr-tools';
import type {
  LocalDeliveryHandler,
  LocalDeliveryRequest,
  LocalDeliveryResponse,
} from '@toon-protocol/connector';
import { wrapSwapPacketToToon, unwrapSwapPacket } from '@toon-protocol/sdk';
import type { AccumulatedClaim } from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';
import {
  ROLLING_PROTOCOL,
  ROLLING_RFQ_REQUEST_KIND,
  ROLLING_RFQ_RESPONSE_KIND,
} from '@toon-protocol/swap';
import type {
  RollingAcceptRecord,
  RollingAdvancePayload,
  RollingRfqResponse,
} from '@toon-protocol/swap';

import type { LiveSender } from './build-live-sender.js';

/** ILP FULFILL / REJECT discriminants (`@toon-protocol/shared` PacketType). */
const PACKET_TYPE_FULFILL = 13;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A fresh 16-byte session id, lowercase hex (spec §2.1). */
export function randomStreamNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function decodeUtf8(data: Buffer | Uint8Array | string | undefined): string {
  if (data === undefined) return '';
  if (typeof data === 'string')
    return Buffer.from(data, 'base64').toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** `data.reason` off a rolling reject body, whatever encoding it arrived in. */
export function rejectReason(
  data: Buffer | Uint8Array | string | undefined
): string | undefined {
  const text = decodeUtf8(data);
  if (!text) return undefined;
  try {
    return (JSON.parse(text) as { reason?: string }).reason;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The leg-B daemon (the sender's half of the coupling)
// ---------------------------------------------------------------------------

export interface LegBRefusal {
  seq: number;
  reason: string;
}

export interface LegBDaemon {
  /** Hand this to `buildLiveSender({ localDeliveryHandler })`. */
  handler: LocalDeliveryHandler;
  /** Mint a fresh `(Pᵢ, Cᵢ)` pair for the next fill. */
  mint(): { preimage: Uint8Array; conditionB64: string };
  /** Every leg-B advance that crossed the socket, in arrival order. */
  advances: RollingAdvancePayload[];
  /** One `AccumulatedClaim` per advance the daemon actually revealed for. */
  claims: AccumulatedClaim[];
  /** Advances refused by the R5 checks (never revealed for). */
  refusals: LegBRefusal[];
  /** Flip to `false` to withhold the preimage (spec R5/R8 withhold case). */
  reveal: boolean;
  /** Set by `openRollingSession()` once the quote is in hand. */
  session: {
    pair: SwapPair;
    chainRecipient: string;
    swapSignerAddress?: string;
  } | null;
}

export function createLegBDaemon(): LegBDaemon {
  const preimages = new Map<string, Uint8Array>();
  /** Per-channel watermark, so a multi-fill session is checked as a stream. */
  const watermark = new Map<string, { nonce: bigint; cumulative: bigint }>();

  const daemon: LegBDaemon = {
    reveal: true,
    advances: [],
    claims: [],
    refusals: [],
    session: null,
    mint() {
      const preimage = new Uint8Array(32);
      globalThis.crypto.getRandomValues(preimage);
      const conditionB64 = Buffer.from(sha256(preimage)).toString('base64');
      preimages.set(conditionB64, preimage);
      return { preimage, conditionB64 };
    },
    handler: async (
      request: LocalDeliveryRequest
    ): Promise<LocalDeliveryResponse> => {
      let advance: RollingAdvancePayload;
      try {
        advance = JSON.parse(
          Buffer.from(request.data, 'base64').toString('utf8')
        ) as RollingAdvancePayload;
      } catch {
        return { reject: { code: 'F99', message: 'leg B was not JSON' } };
      }
      if (advance.proto !== ROLLING_PROTOCOL || advance.type !== 'advance') {
        return { reject: { code: 'F99', message: 'not a rolling advance' } };
      }
      daemon.advances.push(advance);

      const refuse = (reason: string): LocalDeliveryResponse => {
        daemon.refusals.push({ seq: advance.seq, reason });
        return { reject: { code: 'F99', message: reason } };
      };

      const expected = daemon.session;
      if (!expected) return refuse('no session armed on the daemon');
      if (advance.recipient !== expected.chainRecipient) {
        return refuse(
          `recipient mismatch: ${String(advance.recipient)} != ${expected.chainRecipient}`
        );
      }
      if (
        expected.swapSignerAddress !== undefined &&
        advance.swapSignerAddress !== expected.swapSignerAddress
      ) {
        return refuse(
          `signer mismatch: ${String(advance.swapSignerAddress)} != ${expected.swapSignerAddress}`
        );
      }
      if (!advance.claim || advance.claim.length === 0) {
        return refuse('advance carried no signed claim');
      }
      const channelId = advance.channelId;
      if (!channelId) return refuse('advance carried no channelId');
      if (
        advance.nonce === undefined ||
        advance.cumulativeAmount === undefined
      ) {
        return refuse('advance carried no balance-proof watermark');
      }

      const nonce = BigInt(advance.nonce);
      const cumulative = BigInt(advance.cumulativeAmount);
      const target = BigInt(advance.targetAmount);
      const prev = watermark.get(channelId) ?? { nonce: -1n, cumulative: 0n };
      if (nonce <= prev.nonce) {
        return refuse(`nonce not monotone: ${nonce} <= ${prev.nonce}`);
      }
      if (cumulative - prev.cumulative < target) {
        return refuse(
          `Δcumulative ${cumulative - prev.cumulative} does not cover targetAmount ${target}`
        );
      }

      if (!daemon.reveal) {
        // Withhold. Per R8 the claim is void, so the watermark is NOT
        // advanced — the maker rolls its own back and reuses the nonce.
        return { reject: { code: 'T00', message: 'reveal withheld (test)' } };
      }

      const preimage = preimages.get(request.executionCondition ?? '');
      if (!preimage) {
        return refuse('no preimage for this execution condition');
      }

      watermark.set(channelId, { nonce, cumulative });
      daemon.claims.push({
        packetIndex: advance.seq,
        sourceAmount: BigInt(advance.sourceAmount),
        targetAmount: target,
        claimBytes: new Uint8Array(Buffer.from(advance.claim, 'base64')),
        swapEphemeralPubkey: '0'.repeat(64),
        pair: expected.pair,
        receivedAt: Date.now(),
        channelId,
        nonce: advance.nonce,
        cumulativeAmount: advance.cumulativeAmount,
        ...(advance.recipient !== undefined && {
          recipient: advance.recipient,
        }),
        ...(advance.swapSignerAddress !== undefined && {
          swapSignerAddress: advance.swapSignerAddress,
        }),
        rate: advance.rate,
        rateTimestamp: advance.rateTimestamp,
      });

      return {
        fulfill: {
          fulfillment: Buffer.from(preimage).toString('base64'),
          data: Buffer.from('{}', 'utf8').toString('base64'),
        },
      };
    },
  };
  return daemon;
}

// ---------------------------------------------------------------------------
// Leg 0 — the RFQ
// ---------------------------------------------------------------------------

export interface OpenRollingSessionParams {
  sender: LiveSender;
  /** peer1's Nostr pubkey — the gift wrap's recipient. */
  makerPubkey: string;
  /** peer1's ILP address — every leg of the session is addressed here. */
  makerIlpAddress: string;
  pair: SwapPair;
  /** The sender's payout address on `pair.to.chain`. */
  chainRecipient: string;
  daemon: LegBDaemon;
  streamNonce?: string;
  sizeHint?: string;
  /**
   * Override the `senderIlpAddress` the RFQ advertises. Defaults to the
   * sender's real one; a test passes something else to prove the maker
   * refuses a session it could not answer (swap#148 `F02`).
   */
  advertiseIlpAddress?: string;
}

export type OpenRollingSessionResult =
  | { ok: true; session: RollingSession }
  | { ok: false; code: string; reason?: string; message?: string };

export interface RollingSession {
  streamNonce: string;
  quote: RollingRfqResponse;
  pair: SwapPair;
  chainRecipient: string;
  daemon: LegBDaemon;
  /** Send one coupled fill. */
  fill(params: { seq: number; amount: bigint }): Promise<FillOutcome>;
}

export type FillOutcome =
  | {
      accepted: true;
      seq: number;
      accept: RollingAcceptRecord;
      /** The preimage the maker relayed back — proof of the coupling (R6). */
      fulfillment: Uint8Array;
      preimage: Uint8Array;
    }
  | {
      accepted: false;
      seq: number;
      code: string;
      message: string;
      reason?: string;
    };

function rfqGiftWrapData(params: {
  content: string;
  senderSecretKey: Uint8Array;
  makerPubkey: string;
  makerIlpAddress: string;
}): Buffer {
  const rumor = {
    kind: ROLLING_RFQ_REQUEST_KIND,
    content: params.content,
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: '',
  } as unknown as UnsignedEvent;
  const { ilpPrepare } = wrapSwapPacketToToon({
    rumor,
    senderSecretKey: params.senderSecretKey,
    recipientPubkey: params.makerPubkey,
    destination: params.makerIlpAddress,
    amount: 1000n,
  });
  return Buffer.from(ilpPrepare.data, 'base64');
}

/**
 * Run leg 0 and, on a quote, hand back a session that can send fills.
 *
 * The RFQ is deliberately sent through the SAME connector the fills go out
 * on: the maker binds this session's leg-B return path off the BTP session
 * the RFQ arrived on, so an RFQ that took a different path would mint a
 * session whose leg B could not be delivered — the exact defect swap#148 fixed.
 */
export async function openRollingSession(
  params: OpenRollingSessionParams
): Promise<OpenRollingSessionResult> {
  const { sender, makerPubkey, makerIlpAddress, pair, chainRecipient, daemon } =
    params;
  const streamNonce = params.streamNonce ?? randomStreamNonce();
  const senderIlpAddress =
    params.advertiseIlpAddress ?? sender.senderIlpAddress;
  if (!senderIlpAddress) {
    throw new Error(
      'openRollingSession requires a sender built with `senderIlpAddress` — ' +
        'the maker refuses a session whose RFQ address is not the peer id its ' +
        'BTP session authenticated under (leg-b-return-path.ts).'
    );
  }

  const content = JSON.stringify({
    proto: ROLLING_PROTOCOL,
    type: 'rfq',
    streamNonce,
    pair: { from: pair.from, to: pair.to },
    chainRecipient,
    senderIlpAddress,
    ...(params.sizeHint !== undefined && { sizeHint: params.sizeHint }),
  });

  const result = await sender.connector.sendPacket({
    destination: makerIlpAddress,
    // Leg 0 is free: quoting must never cost the sender anything (spec §2.2),
    // and a zero-amount PREPARE also skips the maker's inbound claim gate.
    amount: 0n,
    expiresAt: new Date(Date.now() + 20_000),
    data: rfqGiftWrapData({
      content,
      senderSecretKey: sender.senderSecretKey,
      makerPubkey,
      makerIlpAddress,
    }),
  });

  if ((result.type as number) !== PACKET_TYPE_FULFILL) {
    const rejected = result as {
      code?: string;
      message?: string;
      data?: Buffer;
    };
    const reason = rejectReason(rejected.data);
    return {
      ok: false,
      code: rejected.code ?? 'F00',
      ...(reason !== undefined && { reason }),
      ...(rejected.message !== undefined && { message: rejected.message }),
    };
  }

  const fulfilled = result as { data?: Buffer };
  const giftWrap = JSON.parse(decodeUtf8(fulfilled.data));
  const { rumor } = unwrapSwapPacket({
    giftWrap,
    recipientSecretKey: sender.senderSecretKey,
  });
  if (rumor.kind !== ROLLING_RFQ_RESPONSE_KIND) {
    throw new Error(
      `RFQ answered with rumor kind ${rumor.kind}, expected ${ROLLING_RFQ_RESPONSE_KIND}`
    );
  }
  const quote = JSON.parse(rumor.content) as RollingRfqResponse;

  daemon.session = {
    pair,
    chainRecipient,
    ...(quote.swapSignerAddress !== undefined && {
      swapSignerAddress: quote.swapSignerAddress,
    }),
  };

  const session: RollingSession = {
    streamNonce,
    quote,
    pair,
    chainRecipient,
    daemon,
    async fill({ seq, amount }): Promise<FillOutcome> {
      const { preimage, conditionB64 } = daemon.mint();
      const outcome = await sender.connector.sendPacket({
        destination: makerIlpAddress,
        amount,
        expiresAt: new Date(Date.now() + 30_000),
        data: Buffer.from(
          JSON.stringify({
            proto: ROLLING_PROTOCOL,
            type: 'fill',
            streamNonce,
            seq,
          }),
          'utf8'
        ),
        executionCondition: conditionB64,
      });

      if ((outcome.type as number) !== PACKET_TYPE_FULFILL) {
        const rejected = outcome as {
          code?: string;
          message?: string;
          data?: Buffer;
        };
        const reason = rejectReason(rejected.data);
        return {
          accepted: false,
          seq,
          code: rejected.code ?? 'F00',
          message: rejected.message ?? 'fill rejected',
          ...(reason !== undefined && { reason }),
        };
      }

      const fulfill = outcome as { fulfillment?: Uint8Array; data?: Buffer };
      const accept = JSON.parse(
        decodeUtf8(fulfill.data)
      ) as RollingAcceptRecord;
      return {
        accepted: true,
        seq,
        accept,
        fulfillment: new Uint8Array(fulfill.fulfillment ?? new Uint8Array()),
        preimage,
      };
    },
  };

  return { ok: true, session };
}

// ---------------------------------------------------------------------------
// The whole swap, in one call — the `streamSwap()`-shaped convenience
// ---------------------------------------------------------------------------

export interface RollingSwapResult {
  /** `'completed'` iff every fill was accepted and every leg B was answered. */
  state: 'completed' | 'failed';
  /** Claims the daemon accepted on LEG B — where the value now travels. */
  claims: AccumulatedClaim[];
  accepts: RollingAcceptRecord[];
  advances: RollingAdvancePayload[];
  rejections: { seq: number; code: string; message: string; reason?: string }[];
  streamNonce: string;
  quote: RollingRfqResponse | null;
  /** Set when leg 0 itself was refused (no session was ever minted). */
  rfqReject?: { code: string; reason?: string; message?: string };
}

export interface RunRollingSwapParams extends Omit<
  OpenRollingSessionParams,
  'daemon'
> {
  daemon?: LegBDaemon;
  /** Total source-asset notional, split evenly across `packetCount` fills. */
  totalAmount: bigint;
  packetCount: number;
}

/**
 * RFQ + N coupled fills, shaped so a ported suite reads like the
 * `streamSwap()` one it replaces (`state`, `claims`, `rejections`).
 */
export async function runRollingSwap(
  params: RunRollingSwapParams
): Promise<RollingSwapResult> {
  const daemon = params.daemon ?? createLegBDaemon();
  const opened = await openRollingSession({ ...params, daemon });
  if (!opened.ok) {
    return {
      state: 'failed',
      claims: [],
      accepts: [],
      advances: daemon.advances,
      rejections: [],
      streamNonce: params.streamNonce ?? '',
      quote: null,
      rfqReject: {
        code: opened.code,
        ...(opened.reason !== undefined && { reason: opened.reason }),
        ...(opened.message !== undefined && { message: opened.message }),
      },
    };
  }

  const { session } = opened;
  const packetCount = Math.max(1, params.packetCount);
  const delta = params.totalAmount / BigInt(packetCount);
  const accepts: RollingAcceptRecord[] = [];
  const rejections: RollingSwapResult['rejections'] = [];

  for (let seq = 1; seq <= packetCount; seq++) {
    const outcome = await session.fill({ seq, amount: delta });
    if (outcome.accepted) {
      accepts.push(outcome.accept);
    } else {
      rejections.push({
        seq,
        code: outcome.code,
        message: outcome.message,
        ...(outcome.reason !== undefined && { reason: outcome.reason }),
      });
    }
  }

  return {
    state: rejections.length === 0 ? 'completed' : 'failed',
    claims: daemon.claims,
    accepts,
    advances: daemon.advances,
    rejections,
    streamNonce: session.streamNonce,
    quote: session.quote,
  };
}
