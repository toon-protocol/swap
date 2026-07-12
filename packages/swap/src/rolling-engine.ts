/**
 * Rolling swap engine — coupled shared-condition packet legs (swap#47).
 *
 * Implements the maker side of toon-meta `docs/rolling-swap.md` §3: each fill
 * packet's two legs — sender→maker on chain A, maker→sender chain-B channel
 * advance — share ONE sender-minted execution condition `C_i = sha256(P_i)`,
 * so the legs commit or fail together, packet by packet. This replaces the
 * legacy `issueClaim`-in-FULFILL response shape ON THE ROLLING PATH ONLY (the
 * legacy gift-wrap path is preserved byte-for-byte for zero-condition
 * packets — see the dispatch matrix in `swap-node.ts`).
 *
 * ## The coupling, as implemented (spec §3 R1–R8)
 *
 *   sender ─ PREPARE(δ, condition C_i, fill {streamNonce, seq}) ─▶ maker connector
 *   maker connector ─ LocalDeliveryRequest{executionCondition: b64(C_i)} ─▶ THIS ENGINE
 *   engine: staleness gate → replay reservation → fresh rate R_i →
 *           issueClaim (debit + watermark advance + WRITE-AHEAD PERSIST) →
 *           leg-B PREPARE(⌊δ·R_i⌋, SAME C_i, advance payload w/ chain-B claim) → sender
 *   sender (toon-client#352): verifies the leg-B claim BEFORE revealing —
 *           FULFILLs leg B with P_i iff the claim checks out (spec R5)
 *   engine: learns P_i from the leg-B FULFILL, verifies sha256(P_i) == C_i,
 *           returns { accept, fulfillment: b64(P_i) } (spec R6)
 *   maker connector: enforces sha256(fulfillment) == C_i before FULFILLing
 *           leg A upstream; mismatch/missing → F99, nothing recorded
 *           (connector `docs/local-delivery-fulfillment-contract.md` rule 3)
 *
 * The engine can therefore only collect leg A by relaying the preimage the
 * sender revealed on leg B — and the sender only reveals after verifying the
 * chain-B claim. That inversion (verify-before-reveal) is the value-atomicity
 * core; a stalling/withholding maker fails the packet and collects nothing.
 *
 * ## Failure unwinding (issue #47 AC-4)
 *
 * `issueClaim` debits inventory, advances the channel watermark, and persists
 * write-ahead BEFORE the leg-B PREPARE is sent (state-store crash rule 1: no
 * claim a counterparty can hold is ever ahead of the stored watermark). If
 * leg B then rejects, times out, or fulfills without the correct preimage,
 * the engine fully unwinds via `MultiChainClaimIssuer.rollbackClaim` (the
 * same credit+release+re-persist pattern as the signer-failure rollback) and
 * rejects leg A benignly. Per spec R8 the sender MUST NOT treat a claim from
 * a REJECTed packet as redeemable; the residual Byzantine exposure is the
 * designed `δ·W` in-flight bound (spec §3.1/§8), not a new gap.
 *
 * A crash between the write-ahead persist and the leg-A response leaves the
 * safe state on disk: watermark advanced, inventory debited, replay seq
 * reserved — the restart continues monotonically above the aborted
 * reservation and replays of the fill are rejected F04 (crash rules 2 and 4).
 *
 * ## Sessions (spec §2.2)
 *
 * Fill packets are deliberately tiny — `{streamNonce, seq}` plus the ILP
 * amount and condition. Session-scoped fields (pair, chainRecipient, the
 * sender's leg-B ILP address, sender pubkey) arrive once via the RFQ round
 * trip (kind:20033/20034 — its transport story registers sessions through
 * {@link RollingSessionStore.register} / `SwapNodeInstance.registerRollingSession`).
 * An unknown `streamNonce` is a benign F06 reject.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import type { UnsignedEvent } from 'nostr-tools/pure';

import { applyRate } from '@toon-protocol/sdk';
import type { IssueClaimResult } from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import type { MultiChainClaimIssuer } from './claim-issuer.js';
import {
  buildStaleRateReject,
  StaleRateError,
  pairKey,
} from './rate-staleness.js';
import type {
  RateFreshnessGuard,
  RateStalenessLogger,
  SwapRateProvider,
} from './rate-staleness.js';

// ---------------------------------------------------------------------------
// Wire payloads (consumed by toon-client#352 sender-side and swap#49/#50)
// ---------------------------------------------------------------------------

/**
 * Protocol tag for the rolling coupled-leg wire format (spec §10.3 step 2 —
 * the RFQ advertises this; every rolling payload carries it).
 */
export const ROLLING_PROTOCOL = 'rolling/1';

/** `streamNonce` — 16 random bytes, lowercase hex (spec §2.1). */
const STREAM_NONCE_REGEX = /^[0-9a-f]{32}$/;

/**
 * Leg-A fill payload: the ILP PREPARE `data` of a rolling fill packet,
 * UTF-8 JSON (base64 on the local-delivery wire). Everything else rides the
 * packet itself: amount δ = ILP `amount`, `C_i` = `executionCondition`, the
 * leg-A channel claim = `ILP-Payment-Channel-Claim` protocolData as today.
 */
export interface RollingFillPayload {
  proto: typeof ROLLING_PROTOCOL;
  type: 'fill';
  /** Session id minted at RFQ — 16 bytes, lowercase hex. */
  streamNonce: string;
  /** Per-session fill sequence, starting at 1. Never reused (spec §4). */
  seq: number;
}

/**
 * Leg-B advance payload: the `data` of the maker→sender PREPARE that carries
 * the chain-B cumulative claim for this fill, priced at the maker's fresh
 * quote. UTF-8 JSON. The sender verifies this (spec R5: signature over the
 * canonical hash layout, recipient equality, monotone nonce/cumulative,
 * effective rate ≥ its floor) BEFORE revealing the preimage.
 *
 * All bigints are decimal strings. `claim` is the base64 of the signed
 * balance-proof bytes (chain-specific format, same bytes the legacy FULFILL
 * metadata carried).
 */
export interface RollingAdvancePayload {
  proto: typeof ROLLING_PROTOCOL;
  type: 'advance';
  streamNonce: string;
  seq: number;
  /** Base64 signed chain-B balance proof. */
  claim: string;
  claimId?: string;
  channelId?: string;
  /** Balance-proof nonce (decimal string). */
  nonce?: string;
  /** Cumulative transferred amount on the chain-B channel (decimal string). */
  cumulativeAmount?: string;
  /** The session `chainRecipient` the proof was signed for. */
  recipient?: string;
  /** The maker's on-chain signer address for `pair.to.chain`. */
  swapSignerAddress?: string;
  /** Quote tape (spec §7.1): the rate actually applied to this fill. */
  rate: string;
  /** Unix-ms tick time of the maker's rate source for `rate`. */
  rateTimestamp: number;
  /** Leg-A source amount δ (decimal string). */
  sourceAmount: string;
  /** ⌊δ·R_i⌋ in chain-B units (decimal string) — this fill's claim delta. */
  targetAmount: string;
}

/**
 * Leg-A FULFILL `data` on the rolling path: a compact accept record. The
 * chain-B claim itself travels on LEG B (this is the headline change vs the
 * legacy path, whose FULFILL data carried the signed claim); the leg-A
 * FULFILL carries only the quote-tape record and watermark echo so the
 * sender's controller can cross-check without re-parsing leg B.
 */
export interface RollingAcceptRecord {
  proto: typeof ROLLING_PROTOCOL;
  type: 'accept';
  streamNonce: string;
  seq: number;
  rate: string;
  rateTimestamp: number;
  targetAmount: string;
  channelId?: string;
  nonce?: string;
  cumulativeAmount?: string;
}

/**
 * Parse an ILP `data` field (base64) as a rolling fill payload.
 *
 * Returns the payload when it is a well-formed rolling fill, `'malformed'`
 * when it self-identifies as `rolling/1` but violates the shape (so the
 * dispatcher can reject F01 instead of letting it fall through to the legacy
 * TOON parser), and `null` when it is not rolling traffic at all.
 */
export function parseRollingFillPayload(
  dataB64: string
): RollingFillPayload | 'malformed' | null {
  if (typeof dataB64 !== 'string' || dataB64.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(dataB64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.includes(ROLLING_PROTOCOL)) return null; // cheap pre-filter
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['proto'] !== ROLLING_PROTOCOL) return null;
  if (rec['type'] !== 'fill') return 'malformed';
  const streamNonce = rec['streamNonce'];
  const seq = rec['seq'];
  if (typeof streamNonce !== 'string' || !STREAM_NONCE_REGEX.test(streamNonce))
    return 'malformed';
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1)
    return 'malformed';
  return {
    proto: ROLLING_PROTOCOL,
    type: 'fill',
    streamNonce,
    seq,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * One rolling-swap session, established by the RFQ round trip (spec §2.2).
 * Everything the engine needs that is NOT on the per-fill wire.
 */
export interface RollingSession {
  /** Session id — 16 bytes, lowercase hex (normalized on register). */
  streamNonce: string;
  /** The pair every fill in this session is priced against. */
  pair: SwapPair;
  /**
   * The sender's chain-specific payout address on `pair.to.chain` — the
   * balance-proof `recipient` for every leg-B claim in the session.
   */
  chainRecipient: string;
  /** ILP address the leg-B PREPAREs are sent to (the sender's daemon). */
  senderIlpAddress: string;
  /** Sender Nostr pubkey — inventory/channel sticky-binding key. */
  senderPubkey: string;
  /** ms-epoch after which fills for this session are rejected. */
  expiresAt?: number;
}

export interface RollingSessionStoreConfig {
  /** Default session lifetime when `RollingSession.expiresAt` is unset. */
  ttlMs?: number;
  /** Bound on concurrently registered sessions (expired ones are pruned first). */
  maxSessions?: number;
  now?: () => number;
}

export const DEFAULT_ROLLING_SESSION_TTL_MS = 3_600_000;
export const DEFAULT_ROLLING_MAX_SESSIONS = 1_024;

/** Bounded, TTL'd registry of active rolling sessions, keyed by streamNonce. */
export class RollingSessionStore {
  readonly #sessions = new Map<string, RollingSession>();
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;

  constructor(config: RollingSessionStoreConfig = {}) {
    this.#ttlMs = config.ttlMs ?? DEFAULT_ROLLING_SESSION_TTL_MS;
    this.#maxSessions = config.maxSessions ?? DEFAULT_ROLLING_MAX_SESSIONS;
    this.#now = config.now ?? Date.now;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error('RollingSessionStore ttlMs must be a positive number');
    }
    if (!Number.isInteger(this.#maxSessions) || this.#maxSessions <= 0) {
      throw new Error(
        'RollingSessionStore maxSessions must be a positive integer'
      );
    }
  }

  /**
   * Register (or refresh) a session. Throws on a malformed streamNonce or
   * when the store is full after pruning expired sessions.
   */
  register(session: RollingSession): void {
    const nonce = session.streamNonce.toLowerCase();
    if (!STREAM_NONCE_REGEX.test(nonce)) {
      throw new Error(
        'RollingSession.streamNonce must be 16 bytes as 32 lowercase hex chars'
      );
    }
    this.prune();
    if (
      !this.#sessions.has(nonce) &&
      this.#sessions.size >= this.#maxSessions
    ) {
      throw new Error(
        `RollingSessionStore is full (${this.#maxSessions} sessions)`
      );
    }
    this.#sessions.set(nonce, {
      ...session,
      streamNonce: nonce,
      expiresAt: session.expiresAt ?? this.#now() + this.#ttlMs,
    });
  }

  /** Live session for a streamNonce, or `null` (unknown or expired). */
  get(streamNonce: string): RollingSession | null {
    const s = this.#sessions.get(streamNonce.toLowerCase());
    if (!s) return null;
    if (s.expiresAt !== undefined && s.expiresAt <= this.#now()) {
      this.#sessions.delete(s.streamNonce);
      return null;
    }
    return s;
  }

  delete(streamNonce: string): boolean {
    return this.#sessions.delete(streamNonce.toLowerCase());
  }

  get size(): number {
    return this.#sessions.size;
  }

  private prune(): void {
    const now = this.#now();
    for (const [k, s] of this.#sessions) {
      if (s.expiresAt !== undefined && s.expiresAt <= now) {
        this.#sessions.delete(k);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Leg-B egress seam
// ---------------------------------------------------------------------------

/** Outbound leg-B PREPARE the engine asks the connector to originate. */
export interface LegBPrepare {
  destination: string;
  amount: bigint;
  expiresAt: Date;
  /** The SAME `C_i` the leg-A PREPARE carried (spec R4 — never re-minted). */
  executionCondition: Uint8Array;
  /** UTF-8 JSON {@link RollingAdvancePayload}. */
  data: Buffer;
}

/** Normalized leg-B outcome. */
export type LegBResult =
  | { type: 'fulfill'; fulfillment?: Uint8Array; data?: Uint8Array }
  | { type: 'reject'; code: string; message: string; data?: Uint8Array };

/**
 * Sends one leg-B PREPARE and resolves with its FULFILL/REJECT. Production
 * wiring is {@link createConnectorLegBSender}; tests inject fakes that model
 * the sender-side verify-before-reveal contract.
 */
export type LegBSender = (prepare: LegBPrepare) => Promise<LegBResult>;

/** Numeric ILP packet-type discriminants (`@toon-protocol/shared` PacketType). */
const PACKET_TYPE_PREPARE = 12;
const PACKET_TYPE_FULFILL = 13;

/**
 * Minimal slice of the connector's internal packet handler the leg-B egress
 * needs. `ConnectorNode.sendPacket` (connector 3.29.1) strips
 * `executionCondition` when building the PREPARE, so the engine calls the
 * SAME underlying entrypoint `sendPacket` wraps — `handlePreparePacket` —
 * with the condition attached. The connector's forward path passes a non-zero
 * condition through unchanged (spec R3) and verifies the returned fulfillment
 * hop-side. Runtime-guarded and fail-closed: when the seam is absent the leg
 * B is NOT sent unconditioned (that would sever the coupling, R4) — the fill
 * is rejected instead. Follow-up: add `executionCondition` to the connector's
 * public `SendPacketParams` and drop this reach-in.
 */
interface ConditionCapablePacketHandler {
  handlePreparePacket(
    packet: {
      type: number;
      destination: string;
      amount: bigint;
      expiresAt: Date;
      executionCondition: Uint8Array;
      data: Buffer;
    },
    sourcePeerId: string
  ): Promise<{
    type: number;
    fulfillment?: Uint8Array;
    data?: Buffer | Uint8Array;
    code?: string;
    message?: string;
  }>;
}

export interface ConnectorLegBSenderOptions {
  /** sourcePeerId for the origination hop — the connector's own nodeId. */
  nodeId: string;
  logger?: RateStalenessLogger;
}

/**
 * Build the production {@link LegBSender} over an embedded ConnectorNode.
 * See {@link ConditionCapablePacketHandler} for why this reaches one level
 * below `sendPacket` (and why it fails closed when it cannot).
 */
export function createConnectorLegBSender(
  connector: unknown,
  options: ConnectorLegBSenderOptions
): LegBSender {
  const logger = options.logger ?? {};
  return async (prepare: LegBPrepare): Promise<LegBResult> => {
    const c = connector as {
      _packetHandler?: Partial<ConditionCapablePacketHandler>;
      _config?: { nodeId?: string };
    };
    const handler = c._packetHandler;
    if (!handler || typeof handler.handlePreparePacket !== 'function') {
      logger.warn?.('swap.rolling.leg_b_egress_unavailable', {
        reason:
          'connector exposes no conditioned-PREPARE origination seam (handlePreparePacket); leg B NOT sent — sending it without the shared condition would sever the coupling (rolling-swap §3 R4)',
      });
      return {
        type: 'reject',
        code: 'T00',
        message:
          'leg-B egress unavailable: cannot originate conditioned PREPARE',
      };
    }
    const sourcePeerId = c._config?.nodeId ?? options.nodeId;
    let response: Awaited<
      ReturnType<ConditionCapablePacketHandler['handlePreparePacket']>
    >;
    try {
      response = await (
        handler as ConditionCapablePacketHandler
      ).handlePreparePacket(
        {
          type: PACKET_TYPE_PREPARE,
          destination: prepare.destination,
          amount: prepare.amount,
          expiresAt: prepare.expiresAt,
          executionCondition: prepare.executionCondition,
          data: prepare.data,
        },
        sourcePeerId
      );
    } catch (err) {
      return {
        type: 'reject',
        code: 'T00',
        message: `leg-B send failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (response.type === PACKET_TYPE_FULFILL) {
      const result: LegBResult = { type: 'fulfill' };
      if (response.fulfillment) {
        result.fulfillment = new Uint8Array(response.fulfillment);
      }
      if (response.data) result.data = new Uint8Array(response.data);
      return result;
    }
    return {
      type: 'reject',
      code: typeof response.code === 'string' ? response.code : 'F99',
      message:
        typeof response.message === 'string'
          ? response.message
          : 'leg B rejected',
    };
  };
}

// ---------------------------------------------------------------------------
// Engine request/response shapes
// ---------------------------------------------------------------------------

/** What the swap node's dispatcher hands the engine per rolling fill. */
export interface RollingFillRequest {
  /** ILP amount δ (decimal string, source-chain units). */
  amount: string;
  /** ILP destination (the swap node's own address — informational). */
  destination: string;
  /** Sender-minted non-zero 32-byte condition `C_i` (decoded from base64). */
  executionCondition: Uint8Array;
  /** Parsed leg-A fill payload. */
  payload: RollingFillPayload;
  /** Leg-A PREPARE expiry (ISO 8601) when the delivery surface provides it. */
  expiresAt?: string;
}

export interface RollingRejectReason {
  code: string;
  message: string;
}

/**
 * Engine response, shaped for the connector's PaymentHandler bridge:
 * `fulfillment` (accept) is the base64 preimage the connector verifies via
 * `sha256(fulfillment) === executionCondition`; `rejectReason.code` is the
 * SEMANTIC reason its `REJECT_CODE_MAP` re-encodes to the wire code.
 */
export type RollingFillResponse =
  | {
      accept: true;
      /** Base64 JSON {@link RollingAcceptRecord}. */
      data: string;
      /** Base64 32-byte preimage `P_i` learned from the leg-B FULFILL. */
      fulfillment: string;
    }
  | {
      accept: false;
      code: string;
      message: string;
      /** Base64 JSON structured reject payload (`data.reason` discriminator). */
      data?: string;
      rejectReason: RollingRejectReason;
    };

/** `data.reason` discriminators emitted by the engine's rejects. */
export const ROLLING_REJECT_REASONS = {
  UNKNOWN_SESSION: 'unknown_session',
  DUPLICATE_PACKET: 'duplicate_packet',
  INVALID_AMOUNT: 'invalid_amount',
  FILL_TOO_SMALL: 'fill_too_small',
  INSUFFICIENT_TIMEOUT: 'insufficient_timeout',
  RATE_UNAVAILABLE: 'rate_unavailable',
  INSUFFICIENT_LIQUIDITY: 'insufficient_liquidity',
  CLAIM_ISSUE_FAILED: 'claim_issue_failed',
  LEG_B_FAILED: 'leg_b_failed',
  LEG_B_FULFILLMENT_INVALID: 'leg_b_fulfillment_invalid',
  /** Dispatcher-level: payload self-identifies as rolling/1 but is malformed. */
  MALFORMED_FILL: 'malformed_fill',
  /** Dispatcher-level: rolling fill arrived without a sender-chosen condition. */
  CONDITION_REQUIRED: 'condition_required',
  /** Dispatcher-level: sender-chosen condition on a non-rolling (legacy) payload. */
  CONDITION_UNSUPPORTED_LEGACY: 'condition_unsupported_legacy',
} as const;

/** Build a structured engine reject (rejectReason set explicitly — see type). */
export function buildRollingReject(params: {
  code: string;
  semantic: string;
  message: string;
  reason: string;
  detail?: Record<string, unknown>;
}): Extract<RollingFillResponse, { accept: false }> {
  return {
    accept: false,
    code: params.code,
    message: params.message,
    data: Buffer.from(
      JSON.stringify({ reason: params.reason, ...params.detail }),
      'utf8'
    ).toString('base64'),
    rejectReason: { code: params.semantic, message: params.message },
  };
}

// ---------------------------------------------------------------------------
// RollingSwapEngine
// ---------------------------------------------------------------------------

/** Minimal replay-set contract (structural subset of the SDK's SeenPacketIdsLike). */
export interface RollingSeenPacketIds {
  has(value: string): boolean;
  add(value: string): unknown;
}

export interface RollingSwapEngineConfig {
  sessions: RollingSessionStore;
  claimIssuer: MultiChainClaimIssuer;
  legBSender: LegBSender;
  /**
   * Replay reservations, keyed `rolling:${streamNonce}:${seq}`. Shared with
   * the persistent replay set when persistence is enabled so reservations
   * hit disk BEFORE any claim is issued (state-store crash rule 4).
   */
  seenPacketIds: RollingSeenPacketIds;
  /**
   * The maker's live feed. Optional: without it fills price at the frozen
   * `pair.rate` (stamped with resolution time), same as the legacy handler.
   */
  rateProvider?: SwapRateProvider;
  /** The swap#48 staleness gate — runs BEFORE the replay reservation. */
  stalenessGuard?: RateFreshnessGuard;
  logger?: RateStalenessLogger;
  now?: () => number;
  /** Max leg-B round-trip budget when leg A's expiry allows it. Default 30s. */
  legBBudgetMs?: number;
  /** Leg-B expiry margin under leg-A expiry (spec R7). Default 1s. */
  legBExpiryMarginMs?: number;
  /** Reject (before any debit) when the remaining leg-A budget is below this. */
  minLegBTimeMs?: number;
}

export const DEFAULT_LEG_B_BUDGET_MS = 30_000;
export const DEFAULT_LEG_B_EXPIRY_MARGIN_MS = 1_000;
export const DEFAULT_MIN_LEG_B_TIME_MS = 2_000;

/**
 * Synthetic inner-rumor kind attached to `issueClaim` calls on the rolling
 * path (the issuer's `rumor` param is context-only). No gift wrap exists on
 * rolling fills, so the engine synthesizes an unsigned event carrying the
 * session context for logging/audit parity with the legacy path.
 */
export const ROLLING_FILL_CONTEXT_KIND = 20_035;

export class RollingSwapEngine {
  readonly #sessions: RollingSessionStore;
  readonly #claimIssuer: MultiChainClaimIssuer;
  readonly #legBSender: LegBSender;
  readonly #seen: RollingSeenPacketIds;
  readonly #rateProvider?: SwapRateProvider;
  readonly #guard?: RateFreshnessGuard;
  readonly #logger: RateStalenessLogger;
  readonly #now: () => number;
  readonly #legBBudgetMs: number;
  readonly #legBExpiryMarginMs: number;
  readonly #minLegBTimeMs: number;

  constructor(config: RollingSwapEngineConfig) {
    this.#sessions = config.sessions;
    this.#claimIssuer = config.claimIssuer;
    this.#legBSender = config.legBSender;
    this.#seen = config.seenPacketIds;
    if (config.rateProvider) this.#rateProvider = config.rateProvider;
    if (config.stalenessGuard) this.#guard = config.stalenessGuard;
    this.#logger = config.logger ?? {};
    this.#now = config.now ?? Date.now;
    this.#legBBudgetMs = config.legBBudgetMs ?? DEFAULT_LEG_B_BUDGET_MS;
    this.#legBExpiryMarginMs =
      config.legBExpiryMarginMs ?? DEFAULT_LEG_B_EXPIRY_MARGIN_MS;
    this.#minLegBTimeMs = config.minLegBTimeMs ?? DEFAULT_MIN_LEG_B_TIME_MS;
  }

  /** Register a session (RFQ intake seam). See {@link RollingSessionStore}. */
  registerSession(session: RollingSession): void {
    this.#sessions.register(session);
  }

  /**
   * Handle one coupled fill packet. See the module docblock for the flow;
   * ordering is load-bearing:
   *
   *   1. session lookup            (no state change)
   *   2. staleness gate            (no state change — spec R8/§4)
   *   3. replay reservation        (persisted synchronously; never released)
   *   4. leg-A expiry budget check (no debit yet)
   *   5. fresh rate + pricing      (no debit yet)
   *   6. issueClaim                (debit + watermark + WRITE-AHEAD persist)
   *   7. leg-B send, SAME condition
   *   8a. preimage verified → accept { fulfillment }
   *   8b. anything else → rollbackClaim (full unwind) + benign reject
   */
  async handleFill(request: RollingFillRequest): Promise<RollingFillResponse> {
    const { payload } = request;
    const condition = request.executionCondition;
    if (
      !(condition instanceof Uint8Array) ||
      condition.length !== 32 ||
      condition.every((b) => b === 0)
    ) {
      // The dispatcher guarantees a non-zero 32-byte condition; re-assert so
      // direct callers cannot run the coupled path uncoupled (spec R2).
      return buildRollingReject({
        code: 'F99',
        semantic: 'application_error',
        message: 'rolling fill requires a sender-chosen execution condition',
        reason: ROLLING_REJECT_REASONS.CONDITION_REQUIRED,
      });
    }

    // 1. Session.
    const session = this.#sessions.get(payload.streamNonce);
    if (!session) {
      return buildRollingReject({
        code: 'F06',
        semantic: 'unexpected_payment',
        message: 'unknown rolling-swap session',
        reason: ROLLING_REJECT_REASONS.UNKNOWN_SESSION,
        detail: { streamNonce: payload.streamNonce },
      });
    }
    const pair = session.pair;

    // Amount sanity before anything else.
    let sourceAmount: bigint;
    try {
      sourceAmount = BigInt(request.amount);
    } catch {
      sourceAmount = -1n;
    }
    if (sourceAmount <= 0n) {
      return buildRollingReject({
        code: 'F03',
        semantic: 'invalid_amount',
        message: 'invalid fill amount',
        reason: ROLLING_REJECT_REASONS.INVALID_AMOUNT,
      });
    }

    // 2. Staleness gate (swap#48 contract, byte-identical reject) — BEFORE
    //    the replay reservation so a stale_rate reject leaves no state.
    if (this.#guard) {
      const verdict = await this.#guard.check(pair);
      if (verdict.stale) {
        this.#logger.info?.('swap.rolling.stale_rate_reject', verdict.data);
        const reject = buildStaleRateReject(verdict.data);
        return reject as Extract<RollingFillResponse, { accept: false }>;
      }
    }

    // 3. Replay reservation. Added BEFORE pricing/claim issuance and never
    //    released — a (streamNonce, seq) is burned once seen (fail-closed,
    //    state-store crash rule 4; the sender never reuses a seq, spec §4).
    const replayKey = `rolling:${payload.streamNonce}:${payload.seq}`;
    if (this.#seen.has(replayKey)) {
      return buildRollingReject({
        code: 'F04',
        semantic: 'insufficient_destination_amount',
        message: 'duplicate fill packet',
        reason: ROLLING_REJECT_REASONS.DUPLICATE_PACKET,
        detail: { streamNonce: payload.streamNonce, seq: payload.seq },
      });
    }
    this.#seen.add(replayKey);

    // 4. Leg-A expiry budget (spec R7): leg B MUST resolve before leg A
    //    expires. Reject fills whose remaining budget cannot cover it —
    //    BEFORE any debit.
    const now = this.#now();
    let legAExpiryMs: number | undefined;
    if (request.expiresAt !== undefined) {
      const parsed = Date.parse(request.expiresAt);
      if (Number.isFinite(parsed)) legAExpiryMs = parsed;
    }
    if (
      legAExpiryMs !== undefined &&
      legAExpiryMs - this.#legBExpiryMarginMs - now < this.#minLegBTimeMs
    ) {
      return buildRollingReject({
        code: 'R00',
        semantic: 'expired',
        message: 'insufficient leg-A time budget for the leg-B round trip',
        reason: ROLLING_REJECT_REASONS.INSUFFICIENT_TIMEOUT,
        detail: { expiresAt: request.expiresAt ?? null },
      });
    }
    const legBExpiryMs = Math.min(
      now + this.#legBBudgetMs,
      legAExpiryMs !== undefined
        ? legAExpiryMs - this.#legBExpiryMarginMs
        : Number.POSITIVE_INFINITY
    );

    // 5. Fresh rate (spec §2.3 "finally wired") + pricing.
    let rate: string;
    let rateTimestamp: number;
    try {
      const quote = this.#rateProvider
        ? await this.#rateProvider(pair)
        : pair.rate;
      if (typeof quote === 'string') {
        rate = quote;
        rateTimestamp = now;
      } else {
        rate = quote.rate;
        rateTimestamp = quote.at;
      }
      // Race backstop (same invariant as RateFreshnessGuard.toSdkRateProvider):
      // the gate check and this provider call are separate; a feed that went
      // stale in between must still not price a fill.
      if (this.#guard) {
        const bound = this.#guard.resolveMaxRateAgeMs(pair);
        if (bound !== undefined && this.#now() - rateTimestamp > bound) {
          throw new StaleRateError({
            reason: 'stale_rate',
            maxRateAgeMs: bound,
            lastRateAt: rateTimestamp,
            pair: pairKey(pair),
          });
        }
      }
    } catch (err) {
      if (err instanceof StaleRateError) {
        const reject = buildStaleRateReject(err.data);
        return reject as Extract<RollingFillResponse, { accept: false }>;
      }
      this.#logger.warn?.('swap.rolling.rate_provider_failed', {
        pair: pairKey(pair),
        err: err instanceof Error ? err.message : String(err),
      });
      return buildRollingReject({
        code: 'T00',
        semantic: 'internal_error',
        message: 'rate provider error',
        reason: ROLLING_REJECT_REASONS.RATE_UNAVAILABLE,
      });
    }

    let targetAmount: bigint;
    try {
      targetAmount = applyRate({
        sourceAmount,
        fromScale: pair.from.assetScale,
        toScale: pair.to.assetScale,
        rate,
      });
    } catch (err) {
      return buildRollingReject({
        code: 'T00',
        semantic: 'internal_error',
        message: 'rate conversion error',
        reason: ROLLING_REJECT_REASONS.RATE_UNAVAILABLE,
        detail: { err: err instanceof Error ? err.message : String(err) },
      });
    }
    if (targetAmount <= 0n) {
      return buildRollingReject({
        code: 'F03',
        semantic: 'invalid_amount',
        message: 'fill too small: target amount truncates to zero',
        reason: ROLLING_REJECT_REASONS.FILL_TOO_SMALL,
        detail: { rate },
      });
    }

    // 6. Issue the chain-B claim: debit + watermark advance + WRITE-AHEAD
    //    persist (crash rule 1) — all BEFORE the claim leaves the process.
    let issued: IssueClaimResult;
    try {
      issued = await this.#claimIssuer.issueClaim({
        sourceAmount,
        targetAmount,
        pair,
        senderPubkey: session.senderPubkey,
        chainRecipient: session.chainRecipient,
        rumor: this.#syntheticRumor(session, payload),
      });
    } catch (err) {
      const code =
        (err as { code?: string }).code === 'INSUFFICIENT_INVENTORY' ||
        /insufficient/i.test(err instanceof Error ? err.message : '')
          ? 'T04'
          : 'T00';
      return buildRollingReject({
        code,
        semantic: code === 'T04' ? 'insufficient_funds' : 'internal_error',
        message:
          code === 'T04' ? 'insufficient liquidity' : 'claim issuance failed',
        reason:
          code === 'T04'
            ? ROLLING_REJECT_REASONS.INSUFFICIENT_LIQUIDITY
            : ROLLING_REJECT_REASONS.CLAIM_ISSUE_FAILED,
      });
    }

    // 7. Leg B: the chain-B cumulative advance under the SAME condition
    //    (spec R4). The sender verifies BEFORE revealing (R5).
    const advance: RollingAdvancePayload = {
      proto: ROLLING_PROTOCOL,
      type: 'advance',
      streamNonce: payload.streamNonce,
      seq: payload.seq,
      claim: Buffer.from(issued.claim).toString('base64'),
      ...(issued.claimId !== undefined && { claimId: issued.claimId }),
      ...(issued.channelId !== undefined && { channelId: issued.channelId }),
      ...(issued.nonce !== undefined && { nonce: issued.nonce.toString() }),
      ...(issued.cumulativeAmount !== undefined && {
        cumulativeAmount: issued.cumulativeAmount.toString(),
      }),
      ...(issued.recipient !== undefined && { recipient: issued.recipient }),
      ...(issued.swapSignerAddress !== undefined && {
        swapSignerAddress: issued.swapSignerAddress,
      }),
      rate,
      rateTimestamp,
      sourceAmount: sourceAmount.toString(),
      targetAmount: targetAmount.toString(),
    };

    let legB: LegBResult;
    try {
      legB = await this.#withDeadline(
        this.#legBSender({
          destination: session.senderIlpAddress,
          amount: targetAmount,
          expiresAt: new Date(legBExpiryMs),
          executionCondition: condition,
          data: Buffer.from(JSON.stringify(advance), 'utf8'),
        }),
        legBExpiryMs
      );
    } catch (err) {
      legB = {
        type: 'reject',
        code: 'T00',
        message: `leg-B send failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 8a. Preimage learned and verified → the ONLY way leg A fulfills (R6).
    if (legB.type === 'fulfill') {
      const preimage = legB.fulfillment;
      if (
        preimage instanceof Uint8Array &&
        preimage.length === 32 &&
        timingSafeEqualish(sha256(preimage), condition)
      ) {
        const record: RollingAcceptRecord = {
          proto: ROLLING_PROTOCOL,
          type: 'accept',
          streamNonce: payload.streamNonce,
          seq: payload.seq,
          rate,
          rateTimestamp,
          targetAmount: targetAmount.toString(),
          ...(issued.channelId !== undefined && {
            channelId: issued.channelId,
          }),
          ...(issued.nonce !== undefined && { nonce: issued.nonce.toString() }),
          ...(issued.cumulativeAmount !== undefined && {
            cumulativeAmount: issued.cumulativeAmount.toString(),
          }),
        };
        this.#logger.info?.('swap.rolling.fill_fulfilled', {
          streamNonce: payload.streamNonce,
          seq: payload.seq,
          sourceAmount: sourceAmount.toString(),
          targetAmount: targetAmount.toString(),
          rate,
        });
        return {
          accept: true,
          data: Buffer.from(JSON.stringify(record), 'utf8').toString('base64'),
          fulfillment: Buffer.from(preimage).toString('base64'),
        };
      }
      // A leg-B FULFILL without the correct preimage cannot satisfy leg A
      // (the connector would F99 it anyway — contract rule 3). Unwind.
      this.#unwind(session, targetAmount, payload, 'leg_b_fulfillment_invalid');
      return buildRollingReject({
        code: 'F99',
        semantic: 'application_error',
        message:
          'leg-B FULFILL did not reveal the execution-condition preimage',
        reason: ROLLING_REJECT_REASONS.LEG_B_FULFILLMENT_INVALID,
      });
    }

    // 8b. Leg B rejected/timed out → full unwind + benign leg-A reject
    //     (AC-2/AC-4: nothing stays debited on a failed packet).
    this.#unwind(session, targetAmount, payload, legB.code);
    const legBFClass = legB.code.startsWith('F');
    return buildRollingReject({
      code: legBFClass ? 'F99' : 'T00',
      semantic: legBFClass ? 'application_error' : 'timeout',
      message: 'leg B failed; fill not executed',
      reason: ROLLING_REJECT_REASONS.LEG_B_FAILED,
      detail: { legB: { code: legB.code, message: legB.message } },
    });
  }

  #unwind(
    session: RollingSession,
    targetAmount: bigint,
    payload: RollingFillPayload,
    cause: string
  ): void {
    this.#logger.warn?.('swap.rolling.fill_unwound', {
      streamNonce: payload.streamNonce,
      seq: payload.seq,
      targetAmount: targetAmount.toString(),
      cause,
    });
    this.#claimIssuer.rollbackClaim({
      pair: session.pair,
      senderPubkey: session.senderPubkey,
      targetAmount,
    });
  }

  #syntheticRumor(
    session: RollingSession,
    payload: RollingFillPayload
  ): UnsignedEvent {
    return {
      kind: ROLLING_FILL_CONTEXT_KIND,
      pubkey: session.senderPubkey,
      created_at: Math.floor(this.#now() / 1000),
      content: '',
      tags: [
        [
          'swap-from',
          `${session.pair.from.assetCode}:${session.pair.from.chain}`,
        ],
        ['swap-to', `${session.pair.to.assetCode}:${session.pair.to.chain}`],
        ['chain-recipient', session.chainRecipient],
        ['stream-nonce', payload.streamNonce],
        ['seq', String(payload.seq)],
      ],
    };
  }

  async #withDeadline(
    promise: Promise<LegBResult>,
    deadlineMs: number
  ): Promise<LegBResult> {
    const remaining = deadlineMs - this.#now();
    if (!Number.isFinite(remaining)) return promise;
    if (remaining <= 0) {
      return { type: 'reject', code: 'R00', message: 'leg B timed out' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<LegBResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                type: 'reject',
                code: 'R00',
                message: 'leg B timed out',
              }),
            remaining
          );
          // Do not hold the event loop open for the deadline alone.
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Constant-ish 32-byte comparison. Not security-critical here (both inputs
 * are already public on the wire), but cheap to do right.
 */
function timingSafeEqualish(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
