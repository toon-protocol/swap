/**
 * The maker engine — quotes a session and turns each **paid** fill into a
 * cumulative leg-B balance proof.
 *
 * This is the app half of "the maker is an app behind a Rust connector's
 * route termination". The connector in front of it has already done
 * everything payment-shaped by the time {@link MakerEngine.fill} runs: it
 * verified the taker's leg-A claim against the chain, advanced the channel
 * watermark, and stated what it took as `X-TOON-Amount`. The engine never
 * sees a packet, a claim or a key that is not its own; it prices, reserves
 * capital, signs, and answers. Refusing is cheap and safe — but not free for
 * the taker, whose fill was charged before the app was asked (PF-23), which
 * is why a refusal of a paid fill is remembered as **credit** and applied to
 * the session's next accepted fill.
 *
 * What survived from `rolling/1`'s engine: the rate path (provider +
 * freshness guard), `applyRate`, the reservation → commit accounting on
 * `MultiChainClaimIssuer`, stream receipts. What did not: the coupled leg-B
 * PREPARE and its condition/preimage dance — see `docs/rust-connector-migration.md`.
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
import type {
  RateFreshnessGuard,
  SwapRateProvider,
} from './rate-staleness.js';
import {
  SWAP_REFUSAL_REASONS,
  SWAP_REFUSAL_STATUS,
  SWAP_WIRE_PROTOCOL,
} from './wire.js';
import type {
  PaymentAttribution,
  SwapAdvance,
  SwapFillRequest,
  SwapLegBTerms,
  SwapQuote,
  SwapRefusal,
  SwapRefusalReason,
  SwapRfqRequest,
  SwapWireAsset,
} from './wire.js';

export const DEFAULT_QUOTE_TTL_MS = 60_000;
export const DEFAULT_SESSION_TTL_MS = 3_600_000;
export const DEFAULT_MAX_SESSIONS = 1_024;

/** Synthetic rumor kind handed to the claim issuer as issuance context. */
export const SWAP_FILL_CONTEXT_KIND = 20_035;

export interface MakerSession {
  streamNonce: string;
  pair: SwapPair;
  chainRecipient: string;
  /** Quote the session was opened on; every fill re-prices, this is the tape's origin. */
  quotedRate: string;
  quotedAt: number;
  quoteExpiresAt: number;
  createdAt: number;
  expiresAt: number;
  /** The leg-A channel key bound at the first paid fill (`X-TOON-Payer`). */
  payer: string | null;
  lastSeq: number;
  lastAdvance: SwapAdvance | null;
  /** Source units the maker owes this session from refused-but-paid fills. */
  credit: bigint;
  /** Σ source units accepted, Σ target units issued — for health/admin. */
  sourceTotal: bigint;
  targetTotal: bigint;
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
  /** Leg-B facts for a target chain — signer, verifying contract / program, token. */
  legBTerms: (chain: string) => SwapLegBTerms;
  /** Where fills go and, if known, how big one is (the fill route's price). */
  fill: { destination: string; amount?: bigint };
  rateProvider?: SwapRateProvider;
  stalenessGuard?: RateFreshnessGuard;
  /**
   * For a Solana target chain: the channel PDA the maker must serve
   * `recipient` from (derived from participants + mint, ADR 0059). Returning
   * `undefined` means "no preference" (EVM pools bind first-unbound).
   */
  preferredChannelFor?: (chain: string, recipient: string) => string | undefined;
  /** Validates a `chainRecipient` for a chain family; the default checks EVM hex / Solana base58. */
  validateRecipient?: (chain: string, recipient: string) => string | null;
  quoteTtlMs?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  receiptSecretKey?: Uint8Array;
  receiptSessions?: ReceiptSessionStoreLike;
  logger?: MakerEngineLogger;
  now?: () => number;
}

export interface MakerAnswer<T> {
  status: number;
  body: T;
}

function assetKey(a: SwapWireAsset): string {
  return `${a.assetCode}:${a.assetScale}:${a.chain}`;
}

function chainFamily(chain: string): 'evm' | 'solana' | 'mina' | null {
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

function refusal(
  reason: SwapRefusalReason,
  message: string,
  extra: Partial<Pick<SwapRefusal, 'streamNonce' | 'seq' | 'credited' | 'detail'>> = {},
  retry?: boolean
): MakerAnswer<SwapRefusal> {
  const retryable =
    retry ??
    (reason === SWAP_REFUSAL_REASONS.STALE_RATE ||
      reason === SWAP_REFUSAL_REASONS.RATE_UNAVAILABLE ||
      reason === SWAP_REFUSAL_REASONS.INSUFFICIENT_LIQUIDITY ||
      reason === SWAP_REFUSAL_REASONS.CHANNEL_UNREDEEMED ||
      reason === SWAP_REFUSAL_REASONS.PERSISTENCE_FAILED ||
      reason === SWAP_REFUSAL_REASONS.INTERNAL_ERROR);
  return {
    status: SWAP_REFUSAL_STATUS[reason],
    body: {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'refusal',
      reason,
      message: `${reason}: ${message}`,
      retry: retryable,
      ...extra,
    },
  };
}

export class MakerEngine {
  readonly #sessions = new Map<string, MakerSession>();
  readonly #pairs: readonly SwapPair[];
  readonly #claimIssuer: MultiChainClaimIssuer;
  readonly #inventory: SwapInventory;
  readonly #legBTerms: (chain: string) => SwapLegBTerms;
  readonly #fill: { destination: string; amount?: bigint };
  readonly #rateProvider?: SwapRateProvider;
  readonly #guard?: RateFreshnessGuard;
  readonly #preferredChannelFor?: (chain: string, recipient: string) => string | undefined;
  readonly #validateRecipient: (chain: string, recipient: string) => string | null;
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
    this.#legBTerms = config.legBTerms;
    this.#fill = config.fill;
    if (config.rateProvider) this.#rateProvider = config.rateProvider;
    if (config.stalenessGuard) this.#guard = config.stalenessGuard;
    if (config.preferredChannelFor) {
      this.#preferredChannelFor = config.preferredChannelFor;
    }
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
  }

  // -------------------------------------------------------------------------
  // RFQ
  // -------------------------------------------------------------------------

  async quote(rfq: SwapRfqRequest): Promise<MakerAnswer<SwapQuote | SwapRefusal>> {
    const pair = this.#findPair(rfq);
    if (!pair) {
      return refusal(
        SWAP_REFUSAL_REASONS.UNKNOWN_PAIR,
        'this maker does not quote that pair',
        {
          streamNonce: rfq.streamNonce,
          detail: {
            pairs: this.#pairs.map((p) => ({ from: p.from, to: p.to })),
          },
        },
        false
      );
    }
    const recipientProblem = this.#validateRecipient(
      pair.to.chain,
      rfq.chainRecipient
    );
    if (recipientProblem) {
      return refusal(
        SWAP_REFUSAL_REASONS.INVALID_RECIPIENT,
        recipientProblem,
        { streamNonce: rfq.streamNonce },
        false
      );
    }
    const existing = this.#sessions.get(rfq.streamNonce);
    if (existing && existing.payer !== null) {
      return refusal(
        SWAP_REFUSAL_REASONS.SESSION_CONFLICT,
        'a session with this streamNonce is already live; pick a fresh nonce',
        { streamNonce: rfq.streamNonce },
        false
      );
    }
    const priced = await this.#priceNow(pair);
    if ('refusal' in priced) {
      return {
        ...priced.refusal,
        body: { ...priced.refusal.body, streamNonce: rfq.streamNonce },
      };
    }
    const now = this.#now();
    this.#evictExpired(now);
    if (!existing && this.#sessions.size >= this.#maxSessions) {
      this.#evictOldestUnbound();
      if (this.#sessions.size >= this.#maxSessions) {
        return refusal(
          SWAP_REFUSAL_REASONS.INSUFFICIENT_LIQUIDITY,
          'maker session table is full; retry shortly',
          { streamNonce: rfq.streamNonce }
        );
      }
    }
    const session: MakerSession = {
      streamNonce: rfq.streamNonce,
      pair,
      chainRecipient: rfq.chainRecipient,
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

    const free = this.#freeCapacity(pair);
    const legB = this.#legBTerms(pair.to.chain);
    const maxRateAgeMs = this.#guard?.resolveMaxRateAgeMs(pair);
    const quote: SwapQuote = {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'quote',
      streamNonce: session.streamNonce,
      rate: priced.rate,
      rateTimestamp: priced.rateTimestamp,
      expiresAt: session.quoteExpiresAt,
      fill: {
        destination: this.#fill.destination,
        ...(this.#fill.amount !== undefined && {
          amount: this.#fill.amount.toString(),
        }),
        chain: pair.from.chain,
      },
      ...(maxRateAgeMs !== undefined && { maxRateAgeMs }),
      ...(free !== null && { maxAmount: free.toString() }),
      legB,
    };
    this.#logger.info?.('swap.rfq.quoted', {
      streamNonce: session.streamNonce,
      pair: pairKey(pair),
      rate: priced.rate,
      chainRecipient: rfq.chainRecipient,
      free: free?.toString() ?? null,
    });
    return { status: 200, body: quote };
  }

  // -------------------------------------------------------------------------
  // Fill
  // -------------------------------------------------------------------------

  async fill(input: {
    fill: SwapFillRequest;
    attribution: PaymentAttribution | null;
  }): Promise<MakerAnswer<SwapAdvance | SwapRefusal>> {
    const key = input.fill.streamNonce;
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.#fillLocked(input), () => this.#fillLocked(input));
    this.#locks.set(key, run.catch(() => undefined));
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === run) this.#locks.delete(key);
    }
  }

  async #fillLocked(input: {
    fill: SwapFillRequest;
    attribution: PaymentAttribution | null;
  }): Promise<MakerAnswer<SwapAdvance | SwapRefusal>> {
    const { fill, attribution } = input;
    const now = this.#now();
    const session = this.#sessions.get(fill.streamNonce);
    const ctx = { streamNonce: fill.streamNonce, seq: fill.seq };

    if (!session) {
      return refusal(
        SWAP_REFUSAL_REASONS.UNKNOWN_SESSION,
        'no quote was issued for this streamNonce (or it expired); send an RFQ first',
        ctx,
        false
      );
    }
    if (now > session.expiresAt) {
      this.#sessions.delete(session.streamNonce);
      return refusal(
        SWAP_REFUSAL_REASONS.SESSION_EXPIRED,
        'this session is past its lifetime; send a fresh RFQ',
        ctx,
        false
      );
    }
    if (!attribution) {
      // A priced route always arrives with attribution (ADR 0040). Missing it
      // means the fill route is priced at 0 — an operator error that would
      // otherwise hand out leg-B claims for free.
      this.#logger.error?.('swap.fill.unpaid', {
        ...ctx,
        reason:
          'no X-TOON-* attribution on a fill: the connector route in front of /swap/fill must carry a non-zero price',
      });
      return refusal(
        SWAP_REFUSAL_REASONS.UNPAID,
        'this fill arrived without a verified payment; the maker issues nothing for free',
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
    ): MakerAnswer<SwapRefusal> => {
      session.credit += attribution.amount;
      this.#logger.warn?.('swap.fill.refused_paid', {
        ...ctx,
        reason,
        charged: attribution.amount.toString(),
        credit: session.credit.toString(),
        ...detail,
      });
      return refusal(
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
        `this pair is paid on ${session.pair.from.chain}, but the connector was paid on ${attribution.chain}`,
        { expected: session.pair.from.chain, paidOn: attribution.chain },
        false
      );
    }
    if (session.payer === null) {
      session.payer = attribution.payer;
    } else if (session.payer !== attribution.payer) {
      // Somebody else paid for this session's seq. Their money is the
      // connector's; the session's owner is not credited for it.
      return refusal(
        SWAP_REFUSAL_REASONS.PAYER_MISMATCH,
        'this session is bound to a different leg-A channel',
        { ...ctx, detail: { bound: session.payer, paid: attribution.payer } },
        false
      );
    }
    if (fill.seq === session.lastSeq && session.lastAdvance) {
      // Retransmit of the last fill: the connector treats a byte-identical
      // claim as idempotent, so the taker was not charged twice. Answer the
      // same advance so it can recover the response it lost.
      this.#logger.debug?.('swap.fill.replayed', ctx);
      return { status: 200, body: session.lastAdvance };
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
        'the quote lapsed before the first fill; send a fresh RFQ',
        { quoteExpiresAt: session.quoteExpiresAt },
        false
      );
    }

    const priced = await this.#priceNow(session.pair);
    if ('refusal' in priced) {
      return creditAndRefuse(
        priced.refusal.body.reason,
        priced.refusal.body.message.replace(/^[a-z_]+: /, ''),
        priced.refusal.body.detail
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

    const preferredChannelId = this.#preferredChannelFor?.(
      session.pair.to.chain,
      session.chainRecipient
    );
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

    // The taker has paid; the claim is out. Commit the reservation to
    // unsettled liability now — there is no leg-B outcome to wait for.
    this.#claimIssuer.commitRollingClaim({
      reservationId: issued.reservationId,
      pair: session.pair,
      targetAmount,
    });

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
      claim: Buffer.from(issued.claim).toString('base64'),
      ...(issued.claimId !== undefined && { claimId: issued.claimId }),
      channelId: issued.channelId ?? '',
      nonce: (issued.nonce ?? 0n).toString(),
      cumulativeAmount: (issued.cumulativeAmount ?? 0n).toString(),
      recipient: issued.recipient ?? session.chainRecipient,
      swapSignerAddress: issued.swapSignerAddress ?? legB.swapSignerAddress,
      rate: priced.rate,
      rateTimestamp: priced.rateTimestamp,
      sourceAmount: sourceAmount.toString(),
      targetAmount: targetAmount.toString(),
      ...(creditApplied > 0n && { credited: creditApplied.toString() }),
      legB,
      ...(receipt !== undefined && { receipt }),
    };
    session.credit = 0n;
    session.lastSeq = fill.seq;
    session.lastAdvance = advance;
    session.sourceTotal += sourceAmount;
    session.targetTotal += targetAmount;
    this.#logger.info?.('swap.fill.accepted', {
      ...ctx,
      payer: session.payer,
      sourceAmount: sourceAmount.toString(),
      targetAmount: targetAmount.toString(),
      rate: priced.rate,
      channelId: advance.channelId,
      nonce: advance.nonce,
      cumulativeAmount: advance.cumulativeAmount,
      ...(creditApplied > 0n && { creditApplied: creditApplied.toString() }),
    });
    return { status: 200, body: advance };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  sessionsSnapshot(): readonly Readonly<
    Omit<MakerSession, 'lastAdvance' | 'credit' | 'sourceTotal' | 'targetTotal'> & {
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

  get sessionCount(): number {
    return this.#sessions.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #findPair(rfq: SwapRfqRequest): SwapPair | null {
    const from = assetKey(rfq.pair.from);
    const to = assetKey(rfq.pair.to);
    return (
      this.#pairs.find(
        (p) => assetKey(p.from) === from && assetKey(p.to) === to
      ) ?? null
    );
  }

  async #priceNow(
    pair: SwapPair
  ): Promise<
    | { rate: string; rateTimestamp: number }
    | { refusal: MakerAnswer<SwapRefusal> }
  > {
    if (this.#guard) {
      const verdict = await this.#guard.check(pair);
      if (verdict.stale) {
        this.#logger.info?.('swap.stale_rate', verdict.data);
        return {
          refusal: refusal(
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
          refusal: refusal(
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
        refusal: refusal(
          SWAP_REFUSAL_REASONS.RATE_UNAVAILABLE,
          'rate provider error'
        ),
      };
    }
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

  #syntheticRumor(session: MakerSession, fill: SwapFillRequest): UnsignedEvent {
    return {
      kind: SWAP_FILL_CONTEXT_KIND,
      pubkey: '0'.repeat(64),
      created_at: Math.floor(this.#now() / 1000),
      content: '',
      tags: [
        ['swap-from', `${session.pair.from.assetCode}:${session.pair.from.chain}`],
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
