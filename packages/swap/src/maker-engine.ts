/**
 * The maker engine — quotes a session and turns each **verified** fill into a
 * cumulative leg-B balance proof.
 *
 * On the relay-mediated swap the engine is the app half of `swap-maker.ts`:
 * by the time {@link MakerEngine.fill} runs, the maker has already unwrapped
 * the taker's gift wrap, verified the taker's leg-A claim against the chain
 * (`received-claim.ts`), advanced its inbound watermark, and stated what that
 * claim was worth as a {@link PaymentAttribution}. The engine never sees a
 * wrap, a signature or a key that is not its own; it prices, reserves
 * capital, signs, and answers. Refusing is cheap and safe — but not free for
 * the taker, whose claim the maker now holds — which is why a refusal of a
 * paid fill is remembered as **credit** and applied to the session's next
 * accepted fill.
 *
 * Sessions are exportable (`exportSessions`) and rehydratable (the
 * constructor's `sessions`) so a maker that restarts answers a replayed fill
 * with the same advance and continues a stream at `lastSeq + 1`.
 */

import type { UnsignedEvent } from 'nostr-tools/pure';
import {
  applyRate,
  issueSessionReceipt,
  BoundedReceiptSessions,
} from '@toon-protocol/sdk';
import type { ReceiptSessionStoreLike } from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import type {
  MultiChainClaimIssuer,
  RollingIssueClaimResult,
} from './claim-issuer.js';
import { classifyClaimIssuerError } from './claim-refusal.js';
import type { SwapInventory } from './inventory.js';
import { StaleRateError, pairKey } from './rate-staleness.js';
import type { RateFreshnessGuard, SwapRateProvider } from './rate-staleness.js';
import type { PersistedMakerSession } from './state-store.js';
import { SWAP_REFUSAL_REASONS, SWAP_WIRE_PROTOCOL } from './wire.js';
import type {
  PaymentAttribution,
  SwapAccept,
  SwapAdvance,
  SwapFill,
  SwapLegTerms,
  SwapQuote,
  SwapRefusal,
  SwapRefusalReason,
  SwapWireAsset,
  SwapWirePair,
} from './wire.js';

export const DEFAULT_QUOTE_TTL_MS = 60_000;
export const DEFAULT_SESSION_TTL_MS = 3_600_000;
export const DEFAULT_MAX_SESSIONS = 1_024;

/** Synthetic rumor kind handed to the claim issuer as issuance context. */
export const SWAP_FILL_CONTEXT_KIND = 20_035;

export interface MakerSession {
  streamNonce: string;
  orderId: string;
  /** The taker's Nostr pubkey — bound at accept; every later message must come from it. */
  takerPubkey: string;
  pair: SwapPair;
  chainRecipient: string;
  /** The taker's leg-A address on `pair.from.chain`, as declared at accept. */
  payerAddress: string;
  /** Quote the session was opened on; every fill re-prices, this is the tape's origin. */
  quotedRate: string;
  quotedAt: number;
  quoteExpiresAt: number;
  createdAt: number;
  expiresAt: number;
  /** The leg-A channel key bound at the first verified fill (`attribution.payer`). */
  payer: string | null;
  lastSeq: number;
  lastAdvance: SwapAdvance | null;
  /** Source units the maker owes this session from refused-but-paid fills. */
  credit: bigint;
  /** Σ source units accepted, Σ target units issued — for health/admin. */
  sourceTotal: bigint;
  targetTotal: bigint;
  lastFillEventId?: string;
}

export interface MakerEngineLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface MakerEngineConfig {
  swapPairs: readonly SwapPair[];
  claimIssuer: MultiChainClaimIssuer;
  inventory: SwapInventory;
  /** Leg-A facts for a source chain — where the taker pays this maker. */
  legATerms: (chain: string) => SwapLegTerms;
  /** Leg-B facts for a target chain — signer, verifying contract / program, token. */
  legBTerms: (chain: string) => SwapLegTerms;
  /** Bounds on one fill's delta, source base units. */
  fill: { min: bigint; max: bigint };
  /** The order id this maker publishes for a pair; an accept naming another is refused. */
  orderIdFor?: (pair: SwapPair) => string;
  rateProvider?: SwapRateProvider;
  stalenessGuard?: RateFreshnessGuard;
  /**
   * For a Solana target chain: the channel PDA the maker must serve
   * `recipient` from (derived from participants + mint, ADR 0059). Returning
   * `undefined` means "no preference" (EVM pools bind first-unbound).
   */
  preferredChannelFor?: (
    chain: string,
    recipient: string
  ) => string | undefined;
  /**
   * Make the preferred channel exist and hold enough to cover this fill —
   * a leg-B channel is opened and funded by the maker on demand. Runs after
   * the taker has paid, before the claim is issued; returns the channel id
   * to serve from, or throws with a reason the taker is told.
   */
  ensureChannel?: (
    pair: SwapPair,
    recipient: string,
    targetAmount: bigint
  ) => Promise<string | undefined>;
  /** Validates a `chainRecipient` for a chain family; the default checks EVM hex / Solana base58. */
  validateRecipient?: (chain: string, recipient: string) => string | null;
  quoteTtlMs?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  receiptSecretKey?: Uint8Array;
  receiptSessions?: ReceiptSessionStoreLike;
  /** Sessions persisted by a previous run, rehydrated as-is (expired ones are dropped). */
  sessions?: readonly PersistedMakerSession[];
  logger?: MakerEngineLogger;
  now?: () => number;
}

function assetKey(a: SwapWireAsset): string {
  return `${a.assetCode}:${a.assetScale}:${a.chain}`;
}

export function chainFamily(chain: string): 'evm' | 'solana' | 'mina' | null {
  if (chain.startsWith('evm:')) return 'evm';
  if (chain.startsWith('solana:')) return 'solana';
  if (chain.startsWith('mina:')) return 'mina';
  return null;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_32_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function defaultValidateRecipient(
  chain: string,
  recipient: string
): string | null {
  const fam = chainFamily(chain);
  if (fam === 'evm') {
    return EVM_ADDRESS_RE.test(recipient)
      ? null
      : 'chainRecipient must be a 0x-prefixed 20-byte hex address';
  }
  if (fam === 'solana') {
    return BASE58_32_RE.test(recipient)
      ? null
      : 'chainRecipient must be a base58 Solana public key';
  }
  return recipient.length > 0 ? null : 'chainRecipient must be non-empty';
}

export function makerRefusal(
  reason: SwapRefusalReason,
  message: string,
  extra: Partial<
    Pick<SwapRefusal, 'streamNonce' | 'seq' | 'credited' | 'detail'>
  > = {},
  retry?: boolean
): SwapRefusal {
  const retryable =
    retry ??
    (reason === SWAP_REFUSAL_REASONS.STALE_RATE ||
      reason === SWAP_REFUSAL_REASONS.RATE_UNAVAILABLE ||
      reason === SWAP_REFUSAL_REASONS.INSUFFICIENT_LIQUIDITY ||
      reason === SWAP_REFUSAL_REASONS.CHANNEL_UNREDEEMED ||
      reason === SWAP_REFUSAL_REASONS.PERSISTENCE_FAILED ||
      reason === SWAP_REFUSAL_REASONS.CHAIN_READ_FAILED ||
      reason === SWAP_REFUSAL_REASONS.INTERNAL_ERROR);
  return {
    proto: SWAP_WIRE_PROTOCOL,
    type: 'refusal',
    reason,
    message: `${reason}: ${message}`,
    retry: retryable,
    ...extra,
  };
}

function sessionFromPersisted(p: PersistedMakerSession): MakerSession {
  return {
    streamNonce: p.streamNonce,
    orderId: p.orderId,
    takerPubkey: p.takerPubkey,
    pair: p.pair as SwapPair,
    chainRecipient: p.chainRecipient,
    payerAddress: p.payerAddress,
    quotedRate: p.quotedRate,
    quotedAt: p.quotedAt,
    quoteExpiresAt: p.quoteExpiresAt,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    payer: p.payer,
    lastSeq: p.lastSeq,
    lastAdvance: (p.lastAdvance as SwapAdvance | null) ?? null,
    credit: BigInt(p.credit),
    sourceTotal: BigInt(p.sourceTotal),
    targetTotal: BigInt(p.targetTotal),
    ...(p.lastFillEventId !== undefined && {
      lastFillEventId: p.lastFillEventId,
    }),
  };
}

function sessionToPersisted(s: MakerSession): PersistedMakerSession {
  return {
    streamNonce: s.streamNonce,
    orderId: s.orderId,
    takerPubkey: s.takerPubkey,
    pair: s.pair,
    chainRecipient: s.chainRecipient,
    payerAddress: s.payerAddress,
    quotedRate: s.quotedRate,
    quotedAt: s.quotedAt,
    quoteExpiresAt: s.quoteExpiresAt,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    payer: s.payer,
    lastSeq: s.lastSeq,
    lastAdvance: s.lastAdvance,
    credit: s.credit.toString(),
    sourceTotal: s.sourceTotal.toString(),
    targetTotal: s.targetTotal.toString(),
    ...(s.lastFillEventId !== undefined && {
      lastFillEventId: s.lastFillEventId,
    }),
  };
}

export class MakerEngine {
  readonly #sessions = new Map<string, MakerSession>();
  readonly #pairs: readonly SwapPair[];
  readonly #claimIssuer: MultiChainClaimIssuer;
  readonly #inventory: SwapInventory;
  readonly #legATerms: (chain: string) => SwapLegTerms;
  readonly #legBTerms: (chain: string) => SwapLegTerms;
  readonly #fill: { min: bigint; max: bigint };
  readonly #orderIdFor?: (pair: SwapPair) => string;
  readonly #rateProvider?: SwapRateProvider;
  readonly #guard?: RateFreshnessGuard;
  readonly #preferredChannelFor?: (
    chain: string,
    recipient: string
  ) => string | undefined;
  readonly #ensureChannel?: MakerEngineConfig['ensureChannel'];
  readonly #validateRecipient: (
    chain: string,
    recipient: string
  ) => string | null;
  readonly #quoteTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #maxSessions: number;
  readonly #receiptSecretKey?: Uint8Array;
  readonly #receiptSessions: ReceiptSessionStoreLike;
  readonly #logger: MakerEngineLogger;
  readonly #now: () => number;
  /** Per-session serialization: fills on one session never interleave. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(config: MakerEngineConfig) {
    this.#pairs = config.swapPairs;
    this.#claimIssuer = config.claimIssuer;
    this.#inventory = config.inventory;
    this.#legATerms = config.legATerms;
    this.#legBTerms = config.legBTerms;
    if (config.fill.min <= 0n || config.fill.max < config.fill.min) {
      throw new Error('MakerEngineConfig.fill requires 0 < min <= max');
    }
    this.#fill = config.fill;
    if (config.orderIdFor) this.#orderIdFor = config.orderIdFor;
    if (config.rateProvider) this.#rateProvider = config.rateProvider;
    if (config.stalenessGuard) this.#guard = config.stalenessGuard;
    if (config.preferredChannelFor) {
      this.#preferredChannelFor = config.preferredChannelFor;
    }
    if (config.ensureChannel) this.#ensureChannel = config.ensureChannel;
    this.#validateRecipient =
      config.validateRecipient ?? defaultValidateRecipient;
    this.#quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
    this.#sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (config.receiptSecretKey !== undefined) {
      if (
        !(config.receiptSecretKey instanceof Uint8Array) ||
        config.receiptSecretKey.length !== 32
      ) {
        throw new Error(
          'MakerEngineConfig.receiptSecretKey must be a 32-byte secp256k1 key'
        );
      }
      this.#receiptSecretKey = config.receiptSecretKey;
    }
    this.#receiptSessions =
      config.receiptSessions ?? new BoundedReceiptSessions();
    this.#logger = config.logger ?? {};
    this.#now = config.now ?? Date.now;
    const now = this.#now();
    for (const p of config.sessions ?? []) {
      if (p.expiresAt <= now) continue;
      const s = sessionFromPersisted(p);
      this.#sessions.set(s.streamNonce, s);
    }
  }

  // -------------------------------------------------------------------------
  // Accept → quote
  // -------------------------------------------------------------------------

  async quote(
    accept: SwapAccept,
    ctx: { takerPubkey: string }
  ): Promise<SwapQuote | SwapRefusal> {
    const pair = this.#findPair(accept.pair);
    if (!pair) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.UNKNOWN_PAIR,
        'this maker does not quote that pair',
        {
          streamNonce: accept.streamNonce,
          detail: {
            pairs: this.#pairs.map((p) => ({ from: p.from, to: p.to })),
          },
        },
        false
      );
    }
    if (this.#orderIdFor && this.#orderIdFor(pair) !== accept.orderId) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.UNKNOWN_ORDER,
        'no live order with that id for this pair; re-read the order',
        {
          streamNonce: accept.streamNonce,
          detail: { orderId: accept.orderId },
        },
        false
      );
    }
    const recipientProblem = this.#validateRecipient(
      pair.to.chain,
      accept.chainRecipient
    );
    if (recipientProblem) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.INVALID_RECIPIENT,
        recipientProblem,
        { streamNonce: accept.streamNonce },
        false
      );
    }
    const payerProblem =
      accept.payer.chain !== pair.from.chain
        ? `payer.chain must be ${pair.from.chain}`
        : this.#validateRecipient(pair.from.chain, accept.payer.address);
    if (payerProblem) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.MALFORMED_REQUEST,
        payerProblem,
        { streamNonce: accept.streamNonce },
        false
      );
    }
    const now = this.#now();
    this.#evictExpired(now);
    const existing = this.#sessions.get(accept.streamNonce);
    if (existing && existing.takerPubkey !== ctx.takerPubkey) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.SESSION_CONFLICT,
        'a session with this streamNonce belongs to another taker; pick a fresh nonce',
        { streamNonce: accept.streamNonce },
        false
      );
    }
    const priced = await this.#priceNow(pair);
    if ('refusal' in priced) {
      return { ...priced.refusal, streamNonce: accept.streamNonce };
    }
    if (!existing && this.#sessions.size >= this.#maxSessions) {
      this.#evictOldestUnbound();
      if (this.#sessions.size >= this.#maxSessions) {
        return makerRefusal(
          SWAP_REFUSAL_REASONS.INSUFFICIENT_LIQUIDITY,
          'maker session table is full; retry shortly',
          { streamNonce: accept.streamNonce }
        );
      }
    }
    let session: MakerSession;
    if (existing) {
      // The same taker re-accepting (with or without `resume`) is a re-quote:
      // fresh rate, fresh expiry, and `lastSeq` tells it where it stands.
      existing.quotedRate = priced.rate;
      existing.quotedAt = priced.rateTimestamp;
      existing.quoteExpiresAt = now + this.#quoteTtlMs;
      existing.expiresAt = now + this.#sessionTtlMs;
      session = existing;
    } else {
      session = {
        streamNonce: accept.streamNonce,
        orderId: accept.orderId,
        takerPubkey: ctx.takerPubkey,
        pair,
        chainRecipient: accept.chainRecipient,
        payerAddress: accept.payer.address,
        quotedRate: priced.rate,
        quotedAt: priced.rateTimestamp,
        quoteExpiresAt: now + this.#quoteTtlMs,
        createdAt: now,
        expiresAt: now + this.#sessionTtlMs,
        payer: null,
        lastSeq: 0,
        lastAdvance: null,
        credit: 0n,
        sourceTotal: 0n,
        targetTotal: 0n,
      };
      this.#sessions.set(session.streamNonce, session);
    }

    const free = this.#freeCapacity(pair);
    const maxRateAgeMs = this.#guard?.resolveMaxRateAgeMs(pair);
    const quote: SwapQuote = {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'quote',
      streamNonce: session.streamNonce,
      orderId: session.orderId,
      rate: priced.rate,
      rateTimestamp: priced.rateTimestamp,
      expiresAt: session.quoteExpiresAt,
      fill: {
        min: this.#fill.min.toString(),
        max: this.#fill.max.toString(),
        chain: pair.from.chain,
      },
      ...(maxRateAgeMs !== undefined && { maxRateAgeMs }),
      ...(free !== null && { maxAmount: free.toString() }),
      lastSeq: session.lastSeq,
      legA: this.#legATerms(pair.from.chain),
      legB: this.#legBTerms(pair.to.chain),
    };
    this.#logger.info?.('swap.accept.quoted', {
      streamNonce: session.streamNonce,
      pair: pairKey(pair),
      rate: priced.rate,
      chainRecipient: accept.chainRecipient,
      resumed: existing !== undefined,
      lastSeq: session.lastSeq,
      free: free?.toString() ?? null,
    });
    return quote;
  }

  // -------------------------------------------------------------------------
  // Fill → advance
  // -------------------------------------------------------------------------

  /** The session a fill names, so the caller can decide replay/gap before verifying a claim. */
  sessionFor(streamNonce: string): Readonly<MakerSession> | undefined {
    const s = this.#sessions.get(streamNonce);
    if (!s) return undefined;
    if (this.#now() > s.expiresAt) {
      this.#sessions.delete(streamNonce);
      return undefined;
    }
    return s;
  }

  async fill(input: {
    fill: SwapFill;
    attribution: PaymentAttribution | null;
    takerPubkey: string;
    fillEventId?: string;
  }): Promise<SwapAdvance | SwapRefusal> {
    const key = input.fill.streamNonce;
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(
      () => this.#fillLocked(input),
      () => this.#fillLocked(input)
    );
    this.#locks.set(
      key,
      run.catch(() => undefined)
    );
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === run) this.#locks.delete(key);
    }
  }

  async #fillLocked(input: {
    fill: SwapFill;
    attribution: PaymentAttribution | null;
    takerPubkey: string;
    fillEventId?: string;
  }): Promise<SwapAdvance | SwapRefusal> {
    const { fill, attribution } = input;
    const now = this.#now();
    const session = this.#sessions.get(fill.streamNonce);
    const ctx = { streamNonce: fill.streamNonce, seq: fill.seq };

    if (!session) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.UNKNOWN_SESSION,
        'no quote was issued for this streamNonce (or it expired); send an accept first',
        ctx,
        false
      );
    }
    if (now > session.expiresAt) {
      this.#sessions.delete(session.streamNonce);
      return makerRefusal(
        SWAP_REFUSAL_REASONS.SESSION_EXPIRED,
        'this session is past its lifetime; send a fresh accept',
        ctx,
        false
      );
    }
    if (session.takerPubkey !== input.takerPubkey) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.PAYER_MISMATCH,
        'this session belongs to another taker',
        ctx,
        false
      );
    }
    if (fill.seq === session.lastSeq && session.lastAdvance) {
      // Retransmit of the last fill: the caller established it carries the
      // same claim, so answer the same advance and let the taker recover
      // the message it lost.
      this.#logger.debug?.('swap.fill.replayed', ctx);
      return session.lastAdvance;
    }
    if (!attribution) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.UNPAID,
        'this fill carried no verified claim; the maker issues nothing for free',
        ctx,
        false
      );
    }
    const credited = (): string | undefined =>
      session.credit > 0n ? session.credit.toString() : undefined;
    const creditAndRefuse = (
      reason: SwapRefusalReason,
      message: string,
      detail?: Record<string, unknown>,
      retry?: boolean
    ): SwapRefusal => {
      session.credit += attribution.amount;
      this.#logger.warn?.('swap.fill.refused_paid', {
        ...ctx,
        reason,
        charged: attribution.amount.toString(),
        credit: session.credit.toString(),
        ...detail,
      });
      return makerRefusal(
        reason,
        message,
        { ...ctx, credited: credited(), ...(detail && { detail }) },
        retry
      );
    };

    const fromFamily = chainFamily(session.pair.from.chain);
    if (fromFamily !== attribution.chain) {
      return creditAndRefuse(
        SWAP_REFUSAL_REASONS.CHAIN_MISMATCH,
        `this pair is paid on ${session.pair.from.chain}, but the claim was on ${attribution.chain}`,
        { expected: session.pair.from.chain, paidOn: attribution.chain },
        false
      );
    }
    if (session.payer === null) {
      session.payer = attribution.payer;
    } else if (session.payer !== attribution.payer) {
      return creditAndRefuse(
        SWAP_REFUSAL_REASONS.PAYER_MISMATCH,
        'this session is bound to a different leg-A channel',
        { bound: session.payer, paid: attribution.payer },
        false
      );
    }
    if (fill.seq !== session.lastSeq + 1) {
      return creditAndRefuse(
        SWAP_REFUSAL_REASONS.SEQ_GAP,
        `expected seq ${session.lastSeq + 1}`,
        { expected: session.lastSeq + 1 },
        false
      );
    }
    if (session.lastSeq === 0 && now > session.quoteExpiresAt) {
      return creditAndRefuse(
        SWAP_REFUSAL_REASONS.QUOTE_EXPIRED,
        'the quote lapsed before the first fill; send a fresh accept',
        { quoteExpiresAt: session.quoteExpiresAt },
        false
      );
    }

    const priced = await this.#priceNow(session.pair);
    if ('refusal' in priced) {
      return creditAndRefuse(
        priced.refusal.reason,
        priced.refusal.message.replace(/^[a-z_]+: /, ''),
        priced.refusal.detail
      );
    }
    const creditApplied = session.credit;
    const sourceAmount = attribution.amount + creditApplied;
    let targetAmount: bigint;
    try {
      targetAmount = applyRate({
        sourceAmount,
        fromScale: session.pair.from.assetScale,
        toScale: session.pair.to.assetScale,
        rate: priced.rate,
      });
    } catch (err) {
      return creditAndRefuse(
        SWAP_REFUSAL_REASONS.RATE_UNAVAILABLE,
        'rate conversion error',
        { err: err instanceof Error ? err.message : String(err) }
      );
    }
    if (targetAmount <= 0n) {
      return creditAndRefuse(
        SWAP_REFUSAL_REASONS.FILL_TOO_SMALL,
        'fill too small: target amount truncates to zero',
        { rate: priced.rate },
        false
      );
    }

    let preferredChannelId = this.#preferredChannelFor?.(
      session.pair.to.chain,
      session.chainRecipient
    );
    if (this.#ensureChannel) {
      try {
        const ensured = await this.#ensureChannel(
          session.pair,
          session.chainRecipient,
          targetAmount
        );
        if (ensured !== undefined) preferredChannelId = ensured;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#logger.error?.('swap.fill.channel_provision_failed', {
          ...ctx,
          recipient: session.chainRecipient,
          err: message,
        });
        return creditAndRefuse(
          SWAP_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE,
          `could not provision the leg-B channel for ${session.chainRecipient}: ${message}`,
          { recipient: session.chainRecipient }
        );
      }
    }
    let issued: RollingIssueClaimResult;
    try {
      issued = await this.#claimIssuer.issueRollingClaim({
        sourceAmount,
        targetAmount,
        pair: session.pair,
        senderPubkey: session.payer,
        chainRecipient: session.chainRecipient,
        rumor: this.#syntheticRumor(session, fill),
        reservationTtlMs: this.#sessionTtlMs,
        ...(preferredChannelId !== undefined && { preferredChannelId }),
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (
        code === 'INSUFFICIENT_INVENTORY' ||
        /insufficient/i.test(err instanceof Error ? err.message : '')
      ) {
        return creditAndRefuse(
          SWAP_REFUSAL_REASONS.INSUFFICIENT_LIQUIDITY,
          'insufficient liquidity',
          { targetAmount: targetAmount.toString() }
        );
      }
      const classified = classifyClaimIssuerError(err);
      this.#logger[classified.level]?.('swap.fill.claim_refused', {
        ...ctx,
        reason: classified.reason,
        ...classified.detail,
      });
      const mapped = mapClaimRefusal(classified.reason);
      return creditAndRefuse(
        mapped,
        classified.message.replace(/^[a-z_]+: /, ''),
        {
          ...classified.detail,
          ...(preferredChannelId !== undefined && { preferredChannelId }),
        }
      );
    }

    let receipt: unknown;
    if (this.#receiptSecretKey) {
      try {
        receipt = issueSessionReceipt({
          sessions: this.#receiptSessions,
          streamNonce: session.streamNonce,
          deliveredAmount: targetAmount,
          rate: priced.rate,
          rateTimestamp: priced.rateTimestamp,
          secretKey: this.#receiptSecretKey,
        });
      } catch (err) {
        this.#logger.warn?.('swap.fill.receipt_failed', {
          ...ctx,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const legB = this.#legBTerms(session.pair.to.chain);
    const advance: SwapAdvance = {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'advance',
      streamNonce: session.streamNonce,
      seq: fill.seq,
      claim: {
        chain: session.pair.to.chain,
        channelId: issued.channelId ?? '',
        nonce: (issued.nonce ?? 0n).toString(),
        cumulativeAmount: (issued.cumulativeAmount ?? 0n).toString(),
        signature: Buffer.from(issued.claim).toString('base64'),
        signer: issued.swapSignerAddress ?? legB.swapSignerAddress,
      },
      ...(issued.claimId !== undefined && { claimId: issued.claimId }),
      recipient: issued.recipient ?? session.chainRecipient,
      rate: priced.rate,
      rateTimestamp: priced.rateTimestamp,
      sourceAmount: sourceAmount.toString(),
      targetAmount: targetAmount.toString(),
      ...(creditApplied > 0n && { credited: creditApplied.toString() }),
      legB,
      ...(receipt !== undefined && { receipt }),
    };
    // Mutate the session BEFORE the commit persists, so one snapshot carries
    // both the leg-B watermark and the session that will retransmit it.
    session.credit = 0n;
    session.lastSeq = fill.seq;
    session.lastAdvance = advance;
    session.sourceTotal += sourceAmount;
    session.targetTotal += targetAmount;
    if (input.fillEventId !== undefined)
      session.lastFillEventId = input.fillEventId;

    // The taker has paid; the claim is out. Commit the reservation to
    // unsettled liability now — there is no leg-B outcome to wait for.
    this.#claimIssuer.commitRollingClaim({
      reservationId: issued.reservationId,
      pair: session.pair,
      targetAmount,
    });

    this.#logger.info?.('swap.fill.accepted', {
      ...ctx,
      payer: session.payer,
      sourceAmount: sourceAmount.toString(),
      targetAmount: targetAmount.toString(),
      rate: priced.rate,
      channelId: advance.claim.channelId,
      nonce: advance.claim.nonce,
      cumulativeAmount: advance.claim.cumulativeAmount,
      ...(creditApplied > 0n && { creditApplied: creditApplied.toString() }),
    });
    return advance;
  }

  // -------------------------------------------------------------------------
  // Introspection / persistence
  // -------------------------------------------------------------------------

  sessionsSnapshot(): readonly Readonly<
    Omit<
      MakerSession,
      'lastAdvance' | 'credit' | 'sourceTotal' | 'targetTotal'
    > & {
      credit: string;
      sourceTotal: string;
      targetTotal: string;
    }
  >[] {
    this.#evictExpired(this.#now());
    return [...this.#sessions.values()].map((s) => {
      const { lastAdvance: _drop, ...rest } = s;
      return {
        ...rest,
        credit: s.credit.toString(),
        sourceTotal: s.sourceTotal.toString(),
        targetTotal: s.targetTotal.toString(),
      };
    });
  }

  /** Every live session, in the persisted shape. */
  exportSessions(): Record<string, PersistedMakerSession> {
    this.#evictExpired(this.#now());
    const out: Record<string, PersistedMakerSession> = {};
    for (const s of this.#sessions.values())
      out[s.streamNonce] = sessionToPersisted(s);
    return out;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** The fill bounds this engine enforces. */
  get fillBounds(): { min: bigint; max: bigint } {
    return { ...this.#fill };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #findPair(wanted: SwapWirePair): SwapPair | null {
    const from = assetKey(wanted.from);
    const to = assetKey(wanted.to);
    return (
      this.#pairs.find(
        (p) => assetKey(p.from) === from && assetKey(p.to) === to
      ) ?? null
    );
  }

  async #priceNow(
    pair: SwapPair
  ): Promise<
    { rate: string; rateTimestamp: number } | { refusal: SwapRefusal }
  > {
    if (this.#guard) {
      const verdict = await this.#guard.check(pair);
      if (verdict.stale) {
        this.#logger.info?.('swap.stale_rate', verdict.data);
        return {
          refusal: makerRefusal(
            SWAP_REFUSAL_REASONS.STALE_RATE,
            'the maker rate feed is stale; re-quote and retry',
            { detail: { ...verdict.data } }
          ),
        };
      }
    }
    const now = this.#now();
    try {
      const quote = this.#rateProvider
        ? await this.#rateProvider(pair)
        : pair.rate;
      let rate: string;
      let rateTimestamp: number;
      if (typeof quote === 'string') {
        rate = quote;
        rateTimestamp = now;
      } else {
        rate = quote.rate;
        rateTimestamp = quote.at;
      }
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
      if (!/^[0-9]+(\.[0-9]+)?$/.test(rate) || Number(rate) <= 0) {
        throw new Error(`rate provider returned a non-positive rate "${rate}"`);
      }
      return { rate, rateTimestamp };
    } catch (err) {
      if (err instanceof StaleRateError) {
        return {
          refusal: makerRefusal(
            SWAP_REFUSAL_REASONS.STALE_RATE,
            'the maker rate feed is stale; re-quote and retry',
            { detail: { ...err.data } }
          ),
        };
      }
      this.#logger.warn?.('swap.rate_provider_failed', {
        pair: pairKey(pair),
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        refusal: makerRefusal(
          SWAP_REFUSAL_REASONS.RATE_UNAVAILABLE,
          'rate provider error'
        ),
      };
    }
  }

  /** Price a pair now — what an order advertises. */
  async priceForOrder(
    pair: SwapPair
  ): Promise<
    { rate: string; rateTimestamp: number } | { refusal: SwapRefusal }
  > {
    return this.#priceNow(pair);
  }

  /** Target-unit capacity the maker can issue against, if known. */
  freeCapacity(pair: SwapPair): bigint | null {
    return this.#freeCapacity(pair);
  }

  #freeCapacity(pair: SwapPair): bigint | null {
    const entry = this.#inventory
      .windowSnapshot()
      .find(
        (e) => e.assetCode === pair.to.assetCode && e.chain === pair.to.chain
      );
    return entry ? entry.free : null;
  }

  #evictExpired(now: number): void {
    for (const [k, s] of this.#sessions) {
      if (now > s.expiresAt) this.#sessions.delete(k);
    }
  }

  #evictOldestUnbound(): void {
    let oldest: MakerSession | null = null;
    for (const s of this.#sessions.values()) {
      if (s.payer !== null) continue;
      if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
    }
    if (oldest) this.#sessions.delete(oldest.streamNonce);
  }

  #syntheticRumor(session: MakerSession, fill: SwapFill): UnsignedEvent {
    return {
      kind: SWAP_FILL_CONTEXT_KIND,
      pubkey: session.takerPubkey,
      created_at: Math.floor(this.#now() / 1000),
      content: '',
      tags: [
        [
          'swap-from',
          `${session.pair.from.assetCode}:${session.pair.from.chain}`,
        ],
        ['swap-to', `${session.pair.to.assetCode}:${session.pair.to.chain}`],
        ['chain-recipient', session.chainRecipient],
        ['stream-nonce', session.streamNonce],
        ['seq', String(fill.seq)],
        ['payer', session.payer ?? ''],
      ],
    };
  }
}

function mapClaimRefusal(reason: string): SwapRefusalReason {
  switch (reason) {
    case 'channel_unredeemed':
      return SWAP_REFUSAL_REASONS.CHANNEL_UNREDEEMED;
    case 'no_channel_available':
      return SWAP_REFUSAL_REASONS.NO_CHANNEL_AVAILABLE;
    case 'persist_failed':
      return SWAP_REFUSAL_REASONS.PERSISTENCE_FAILED;
    case 'signing_failed':
      return SWAP_REFUSAL_REASONS.SIGNING_FAILED;
    default:
      return SWAP_REFUSAL_REASONS.INTERNAL_ERROR;
  }
}
