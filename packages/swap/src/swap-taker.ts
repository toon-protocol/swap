/**
 * The taker on the relay: finds an order, opens a session, streams fills,
 * verifies every advance, and can pick a stream back up after going away.
 *
 * Per fill the taker MOVES FIRST — it signs the next cumulative leg-A claim
 * and gives it to the maker before it holds anything in return. That is the
 * designed exposure (one fill), and it is why the per-fill delta is small and
 * the taker's own. What the taker never does is sign a lower nonce than one
 * it already handed out: `lastFill` is persisted BEFORE the wrap is
 * published, and a session resumes from that record, never from memory.
 *
 * Every advance is verified with the same ladder the maker uses on the
 * taker's claims (`received-claim.ts`), against the facts pinned from the
 * order at accept time — a maker cannot rotate its signer, contract or
 * channel mid-stream by saying so in a message.
 */

import { randomBytes } from 'node:crypto';
import type { NostrEvent } from 'nostr-tools/pure';
import { base58Encode } from '@toon-protocol/sdk';

import { createEvmLegBChannelProvisioner } from './evm-leg-b-channel.js';
import { unwrapGiftWrap, wrapGiftWrap, eventExpiration } from './nip59.js';
import type { NostrIdentity } from './nostr-keys.js';
import {
  SolanaPaymentChannelSigner,
  TokenNetworkBalanceProofSigner,
} from './payment-channel-signer.js';
import type { PaymentChannelSigner } from './payment-channel-signer.js';
import { createReadBudgets, verifyInboundClaim } from './received-claim.js';
import type {
  ChannelFacts,
  ChannelSlotReader,
  InboundWatermark,
} from './received-claim.js';
import type { RelayWriter } from './relay-writer.js';
import type { NostrFilter } from './relay-subscription.js';
import { createSolanaLegBChannelProvisioner } from './solana-leg-b-channel.js';
import { deriveSolanaChannelPda } from './solana-pda.js';
import type { RelayReader } from './swap-maker.js';
import type { SwapNodeChainProvider } from './swap-node.js';
import { parseEvmChainId } from './swap-node.js';
import { emptyTakerState } from './taker-state.js';
import type {
  PersistedTakerState,
  TakerChannelWatermark,
  TakerSessionState,
  TakerStateStore,
} from './taker-state.js';
import type { SwapNodeKeys } from './wallet.js';
import {
  SWAP_ORDER_KIND,
  SWAP_RUMOR_KIND,
  SWAP_WIRE_PROTOCOL,
  parseSwapOrder,
  parseSwapWireAnswer,
} from './wire.js';
import type {
  SwapAccept,
  SwapAdvance,
  SwapClaim,
  SwapFill,
  SwapOrder,
  SwapQuote,
  SwapRefusal,
  SwapWireAnswer,
} from './wire.js';

export interface SwapOrderListing {
  order: SwapOrder;
  /** The maker's Nostr pubkey — the order's author. */
  makerPubkey: string;
  eventId: string;
  createdAt: number;
}

/** Puts the taker's deposit into its leg-A channel with the maker. Chain transactions live here. */
export interface ChannelFunder {
  channelFor(chain: string, counterparty: string): Promise<string>;
  /**
   * Ensure my deposit in channel(me, counterparty) on `chain` is at least
   * `minDeposit`; returns the channel id and MY on-chain slot so a lost
   * outbound watermark can be seeded.
   */
  ensure(
    chain: string,
    counterparty: string,
    minDeposit: bigint
  ): Promise<{ channelId: string; nonce: bigint; transferredAmount: bigint }>;
}

/** Redeems a verified leg-B claim on chain. Chain transactions live here. */
export interface Redeemer {
  redeem(session: Readonly<TakerSessionState>): Promise<{ txId: string }>;
}

export interface SwapTakerLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface SwapTakerConfig {
  nostr: NostrIdentity;
  keys: SwapNodeKeys;
  reader: RelayReader;
  writer: RelayWriter;
  slotReader: ChannelSlotReader;
  chainProviders: readonly SwapNodeChainProvider[];
  store: TakerStateStore;
  channelFunder?: ChannelFunder;
  /** Redeems on the taker's own gas. */
  redeemer?: Redeemer;
  /** Redeems with the gas station paying (`redeem(…, { via: 'gas-station' })`). */
  gasStationRedeemer?: Redeemer;
  /** How long to wait for a quote/advance before resending (default 30 s). */
  answerTimeoutMs?: number;
  /** How many times a fill is resent before the stream is left for `resume` (default 3). */
  maxResends?: number;
  sessionTtlMs?: number;
  maxChainReadsPerMin?: number;
  logger?: SwapTakerLogger;
  now?: () => number;
  randomNonce?: () => string;
}

export const DEFAULT_ANSWER_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESENDS = 3;
export const DEFAULT_TAKER_SESSION_TTL_MS = 3_600_000;
/** Chain reads one maker may cause per minute; a session's first advance reads once, then only on top-ups/staleness. */
export const DEFAULT_TAKER_MAX_CHAIN_READS_PER_MIN = 30;
/** Transient verifier outcomes worth waiting on rather than aborting a stream over. */
const TRANSIENT_VERDICTS = new Set(['RATE_LIMITED', 'CHAIN_READ_FAILED']);
export const ORDERS_SUB_ID = 'orders';
export const TAKER_INBOX_SUB_ID = 'inbox';
const CURSOR_SKEW_SECONDS = 60;

export class SwapTakerError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'SwapTakerError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

interface Waiter {
  streamNonce: string;
  match: (answer: SwapWireAnswer) => boolean;
  resolve: (a: { answer: SwapWireAnswer; eventId: string }) => void;
}

export class SwapTaker {
  readonly #c: SwapTakerConfig;
  readonly #log: SwapTakerLogger;
  readonly #now: () => number;
  #state: PersistedTakerState;
  readonly #seen: Set<string>;
  readonly #orders = new Map<string, SwapOrderListing>();
  /** Answers per session that arrived before anyone waited for them. */
  readonly #answers = new Map<
    string,
    { answer: SwapWireAnswer; eventId: string }[]
  >();
  readonly #waiters: Waiter[] = [];
  readonly #budgets: (key: string) => { tryAcquire(): boolean };
  readonly #funder: ChannelFunder;
  #ordersSubscribed = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(config: SwapTakerConfig) {
    this.#c = config;
    this.#log = config.logger ?? {};
    this.#now = config.now ?? Date.now;
    this.#state = config.store.load() ?? emptyTakerState();
    this.#seen = new Set(this.#state.seenEventIds);
    this.#budgets = createReadBudgets({
      maxReadsPerMinute:
        config.maxChainReadsPerMin ?? DEFAULT_TAKER_MAX_CHAIN_READS_PER_MIN,
      now: this.#now,
    });
    this.#funder =
      config.channelFunder ??
      defaultChannelFunder(config.keys, config.chainProviders);
  }

  get nostrPubkey(): string {
    return this.#c.nostr.pubkey;
  }

  /** Subscribe to the inbox (and orders) and connect. */
  start(): void {
    this.#c.reader.subscribe(this.inboxFilter(), TAKER_INBOX_SUB_ID);
    this.#c.reader.start();
  }

  stop(): void {
    this.#c.reader.close();
  }

  inboxFilter(): NostrFilter {
    return {
      kinds: [1059],
      '#p': [this.#c.nostr.pubkey],
      since: Math.max(0, this.#state.relayCursor - CURSOR_SKEW_SECONDS),
    };
  }

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /** Feed one relay event (an order or a wrap addressed to me). */
  handleEvent(event: NostrEvent): Promise<void> {
    const run = this.#queue.then(() => this.#handleOne(event));
    this.#queue = run.catch((err) => {
      this.#log.error?.('taker.inbox.unhandled', {
        eventId: event.id,
        err: errMsg(err),
      });
    });
    return this.#queue;
  }

  async #handleOne(event: NostrEvent): Promise<void> {
    if (event.kind === SWAP_ORDER_KIND) {
      this.#ingestOrder(event);
      return;
    }
    if (event.kind !== 1059 || this.#seen.has(event.id)) return;
    let opened;
    try {
      opened = unwrapGiftWrap(
        this.#c.nostr.secretKey,
        this.#c.nostr.pubkey,
        event
      );
    } catch (err) {
      this.#log.debug?.('taker.inbox.unopenable', {
        eventId: event.id,
        err: errMsg(err),
      });
      this.#markSeen(event);
      return;
    }
    if (opened.rumor.kind !== SWAP_RUMOR_KIND) {
      this.#markSeen(event);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(opened.rumor.content);
    } catch {
      this.#markSeen(event);
      return;
    }
    const parsed = parseSwapWireAnswer(payload);
    if (!parsed.ok) {
      this.#log.debug?.('taker.inbox.malformed', {
        eventId: event.id,
        error: parsed.error,
      });
      this.#markSeen(event);
      return;
    }
    const answer = parsed.value;
    const streamNonce = answer.streamNonce;
    if (!streamNonce) {
      this.#markSeen(event);
      return;
    }
    const session = this.#state.sessions[streamNonce];
    if (!session || session.makerPubkey !== opened.sealPubkey) {
      this.#log.debug?.('taker.inbox.answer_for_unknown_session', {
        eventId: event.id,
        streamNonce,
        from: opened.sealPubkey,
      });
      this.#markSeen(event);
      return;
    }
    this.#markSeen(event);
    const hit = { answer, eventId: event.id };
    const i = this.#waiters.findIndex(
      (w) => w.streamNonce === streamNonce && w.match(answer)
    );
    if (i >= 0) {
      const [w] = this.#waiters.splice(i, 1);
      w?.resolve(hit);
    } else {
      const list = this.#answers.get(streamNonce) ?? [];
      list.push(hit);
      this.#answers.set(streamNonce, list);
    }
  }

  #markSeen(event: NostrEvent): void {
    this.#seen.add(event.id);
    this.#state.seenEventIds = [...this.#seen].slice(-10_000);
    if (event.created_at > this.#state.relayCursor)
      this.#state.relayCursor = event.created_at;
  }

  #waitFor(
    streamNonce: string,
    match: (a: SwapWireAnswer) => boolean,
    timeoutMs: number
  ): Promise<{ answer: SwapWireAnswer; eventId: string } | null> {
    const buffered = this.#answers.get(streamNonce) ?? [];
    const j = buffered.findIndex((b) => match(b.answer));
    if (j >= 0) {
      const [hit] = buffered.splice(j, 1);
      return Promise.resolve(hit ?? null);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { streamNonce, match, resolve: (a) => resolve(a) };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const k = this.#waiters.indexOf(waiter);
        if (k >= 0) this.#waiters.splice(k, 1);
        resolve(null);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  /**
   * Like `#waitFor`, but for an answer that is already in the relay's history:
   * give up a moment after the inbox subscription reaches EOSE instead of
   * waiting the full answer timeout for something that is not coming.
   */
  async #waitForHistory(
    streamNonce: string,
    match: (a: SwapWireAnswer) => boolean,
    timeoutMs: number
  ): Promise<{ answer: SwapWireAnswer; eventId: string } | null> {
    const deadline = this.#now() + timeoutMs;
    let eoseAt: number | null = null;
    for (;;) {
      const buffered = this.#answers.get(streamNonce) ?? [];
      const j = buffered.findIndex((b) => match(b.answer));
      if (j >= 0) {
        const [hit] = buffered.splice(j, 1);
        return hit ?? null;
      }
      const now = this.#now();
      if (this.#c.reader.hasReachedEose(TAKER_INBOX_SUB_ID)) eoseAt ??= now;
      if (eoseAt !== null && now - eoseAt > 1_000) return null;
      if (now > deadline) return null;
      await sleep(100);
    }
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  #ingestOrder(event: NostrEvent): void {
    let payload: unknown;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
    const parsed = parseSwapOrder(payload);
    if (!parsed.ok) return;
    const key = `${event.pubkey}:${parsed.value.orderId}`;
    const existing = this.#orders.get(key);
    if (existing && existing.createdAt > event.created_at) return;
    this.#orders.set(key, {
      order: parsed.value,
      makerPubkey: event.pubkey,
      eventId: event.id,
      createdAt: event.created_at,
    });
  }

  /** Subscribe to orders (once) and return the live ones. */
  listOrders(
    filter: {
      pair?: {
        from: { chain: string; assetCode: string };
        to: { chain: string; assetCode: string };
      };
    } = {}
  ): SwapOrderListing[] {
    if (!this.#ordersSubscribed) {
      this.#c.reader.subscribe({ kinds: [SWAP_ORDER_KIND] }, ORDERS_SUB_ID);
      this.#ordersSubscribed = true;
    }
    const nowMs = this.#now();
    const out: SwapOrderListing[] = [];
    for (const listing of this.#orders.values()) {
      const { order } = listing;
      if (order.expiresAt <= nowMs) continue;
      if (filter.pair) {
        const p = filter.pair;
        if (
          order.pair.from.chain !== p.from.chain ||
          order.pair.from.assetCode !== p.from.assetCode ||
          order.pair.to.chain !== p.to.chain ||
          order.pair.to.assetCode !== p.to.assetCode
        ) {
          continue;
        }
      }
      out.push(listing);
    }
    return out;
  }

  /** Whether the orders subscription has replayed history. */
  ordersReady(): boolean {
    return (
      this.#ordersSubscribed && this.#c.reader.hasReachedEose(ORDERS_SUB_ID)
    );
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  sessions(): Readonly<Record<string, TakerSessionState>> {
    return this.#state.sessions;
  }

  session(streamNonce: string): TakerSessionState | undefined {
    return this.#state.sessions[streamNonce];
  }

  /**
   * Open a session against an order: publish the accept, wait for the quote.
   * `size` is the total to swap (source base units); `delta` the per-fill
   * step, defaulting to the order's `fill.min`.
   */
  async accept(
    listing: SwapOrderListing,
    opts: { size: bigint; delta?: bigint; chainRecipient?: string }
  ): Promise<TakerSessionState> {
    const { order } = listing;
    const min = BigInt(order.fill.min);
    const max = BigInt(order.fill.max);
    const delta = opts.delta ?? min;
    if (delta < min || delta > max) {
      throw new SwapTakerError(
        'delta_out_of_bounds',
        `delta ${delta} is outside the order's fill bounds [${min}, ${max}]`
      );
    }
    if (opts.size < delta) {
      throw new SwapTakerError(
        'size_too_small',
        `size ${opts.size} is below one fill of ${delta}`
      );
    }
    const payerAddress = this.#myAddressOn(order.pair.from.chain);
    const chainRecipient =
      opts.chainRecipient ?? this.#myAddressOn(order.pair.to.chain);
    const streamNonce = (
      this.#c.randomNonce ?? (() => randomBytes(16).toString('hex'))
    )();
    const nowMs = this.#now();
    const session: TakerSessionState = {
      streamNonce,
      orderId: order.orderId,
      makerPubkey: listing.makerPubkey,
      order,
      quote: null,
      size: opts.size.toString(),
      delta: delta.toString(),
      chainRecipient,
      payerAddress,
      legA: {
        chain: order.pair.from.chain,
        channelId: null,
        nonce: '0',
        cumulative: '0',
      },
      lastFill: null,
      lastAdvance: null,
      lastRefusal: null,
      received: null,
      credit: '0',
      status: 'quoting',
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.#state.sessions[streamNonce] = session;
    this.#persist();
    await this.#requote(session, false);
    return session;
  }

  async #requote(
    session: TakerSessionState,
    resume: boolean
  ): Promise<SwapQuote> {
    const accept: SwapAccept = {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'accept',
      orderId: session.orderId,
      streamNonce: session.streamNonce,
      pair: session.order.pair,
      chainRecipient: session.chainRecipient,
      payer: {
        chain: session.order.pair.from.chain,
        address: session.payerAddress,
      },
      sizeHint: session.size,
      ...(resume && { resume: true }),
    };
    const timeout = this.#c.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    const attempts = this.#c.maxResends ?? DEFAULT_MAX_RESENDS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.#send(session, accept);
      const hit = await this.#waitFor(
        session.streamNonce,
        (a) =>
          a.type === 'quote' || (a.type === 'refusal' && a.seq === undefined),
        timeout
      );
      if (!hit) continue;
      if (hit.answer.type === 'refusal') {
        session.status = 'aborted';
        this.#persist();
        throw new SwapTakerError(
          hit.answer.reason,
          hit.answer.message,
          hit.answer.detail
        );
      }
      if (hit.answer.type === 'quote') {
        session.quote = hit.answer;
        session.status = 'filling';
        session.updatedAt = this.#now();
        this.#persist();
        this.#log.info?.('taker.quoted', {
          streamNonce: session.streamNonce,
          rate: hit.answer.rate,
          lastSeq: hit.answer.lastSeq,
          resume,
        });
        return hit.answer;
      }
    }
    throw new SwapTakerError(
      'no_quote',
      `the maker did not answer the accept within ${attempts} attempts`
    );
  }

  /**
   * Stream fills until `size` is reached. Safe to call again after a crash
   * via {@link resume}; each fill is persisted before it is published.
   */
  async run(
    streamNonce: string,
    opts: {
      onFill?: (advance: SwapAdvance) => void | Promise<void>;
      answerTimeoutMs?: number;
      maxResends?: number;
    } = {}
  ): Promise<TakerSessionState> {
    const session = this.#state.sessions[streamNonce];
    if (!session) throw new SwapTakerError('unknown_session', streamNonce);
    if (!session.quote) await this.#requote(session, false);
    const size = BigInt(session.size);
    const delta = BigInt(session.delta);
    const legA = session.legA;

    // Fund my leg-A channel with the maker before the first fill. The channel
    // is shared by every session on it, so the deposit must cover what has
    // ALREADY been sent on it plus this session — not this session alone.
    // Then seed my outbound watermark from the highest of what I persisted
    // and what the chain shows, so a lost state cannot sign below it.
    const counterparty = session.order.legA.swapSignerAddress;
    if (legA.channelId === null)
      legA.channelId = await this.#funder.channelFor(legA.chain, counterparty);
    const wm = this.#channelWatermark(legA.chain, legA.channelId, counterparty);
    const sentOnChannel = BigInt(wm.cumulative);
    const ensured = await this.#funder.ensure(
      legA.chain,
      counterparty,
      sentOnChannel + size
    );
    if (ensured.channelId !== legA.channelId) {
      // A fresh epoch (the pair's previous channel settled): start a new watermark.
      legA.channelId = ensured.channelId;
    }
    if (legA.startCumulative === undefined) {
      const wmNow = this.#channelWatermark(
        legA.chain,
        legA.channelId,
        counterparty
      );
      const nonce =
        ensured.nonce > BigInt(wmNow.nonce)
          ? ensured.nonce
          : BigInt(wmNow.nonce);
      const cumulative =
        ensured.transferredAmount > BigInt(wmNow.cumulative)
          ? ensured.transferredAmount
          : BigInt(wmNow.cumulative);
      legA.nonce = nonce.toString();
      legA.cumulative = cumulative.toString();
      legA.startCumulative = legA.cumulative;
      legA.acceptedCumulative = legA.cumulative;
      wmNow.nonce = legA.nonce;
      wmNow.cumulative = legA.cumulative;
      wmNow.updatedAt = this.#now();
      session.updatedAt = this.#now();
      this.#persist();
    }
    const channelWm = this.#channelWatermark(
      legA.chain,
      legA.channelId,
      session.order.legA.swapSignerAddress
    );
    const signer = this.#legASigner(session);
    const facts = this.#legBFacts(session);
    const timeout =
      opts.answerTimeoutMs ??
      this.#c.answerTimeoutMs ??
      DEFAULT_ANSWER_TIMEOUT_MS;
    const maxResends =
      opts.maxResends ?? this.#c.maxResends ?? DEFAULT_MAX_RESENDS;

    let sent = this.#sentSoFar(session);
    while (sent < size) {
      const answeredSeq = session.lastAdvance?.seq ?? 0;
      let fill: SwapFill;
      if (session.lastFill && session.lastFill.seq === answeredSeq + 1) {
        // Unanswered (or refused-and-retryable) fill: resend the SAME claim.
        fill = {
          proto: SWAP_WIRE_PROTOCOL,
          type: 'fill',
          streamNonce,
          seq: session.lastFill.seq,
          claim: session.lastFill.claim,
        };
      } else {
        const step = delta < size - sent ? delta : size - sent;
        const nonce = BigInt(legA.nonce) + 1n;
        const cumulative = BigInt(legA.cumulative) + step;
        const signature = await signer.signBalanceProof({
          channelId: legA.channelId,
          nonce,
          cumulativeAmount: cumulative,
          recipient: session.order.legA.swapSignerAddress,
        });
        const claim: SwapClaim = {
          chain: legA.chain,
          channelId: legA.channelId,
          nonce: nonce.toString(),
          cumulativeAmount: cumulative.toString(),
          signature: Buffer.from(signature).toString('base64'),
          signer: session.payerAddress,
        };
        fill = {
          proto: SWAP_WIRE_PROTOCOL,
          type: 'fill',
          streamNonce,
          seq: answeredSeq + 1,
          claim,
        };
        // Write-ahead: the watermark advances before the claim can leave —
        // on the session AND on the channel every other session shares.
        legA.nonce = claim.nonce;
        legA.cumulative = claim.cumulativeAmount;
        channelWm.nonce = claim.nonce;
        channelWm.cumulative = claim.cumulativeAmount;
        channelWm.updatedAt = this.#now();
        session.lastFill = {
          seq: fill.seq,
          claim,
          eventId: '',
          sentAt: this.#now(),
        };
        session.updatedAt = this.#now();
        this.#persist();
      }

      let outcome: 'advanced' | 'retry' | 'abort' = 'retry';
      let lastRetryable: SwapRefusal | null = null;
      for (
        let attempt = 0;
        attempt < maxResends && outcome === 'retry';
        attempt++
      ) {
        const eventId = await this.#send(session, fill);
        if (session.lastFill) {
          session.lastFill.eventId = eventId;
          session.lastFill.sentAt = this.#now();
          this.#persist();
        }
        const hit = await this.#waitFor(
          streamNonce,
          (a) =>
            (a.type === 'advance' || a.type === 'refusal') &&
            a.seq === fill.seq,
          timeout
        );
        if (!hit) {
          this.#log.warn?.('taker.fill.no_answer', {
            streamNonce,
            seq: fill.seq,
            attempt,
          });
          continue;
        }
        if (hit.answer.type === 'advance') {
          await this.#acceptAdvance(session, hit.answer, hit.eventId, facts);
          legA.acceptedCumulative = fill.claim.cumulativeAmount;
          this.#persist();
          await opts.onFill?.(hit.answer);
          outcome = 'advanced';
          break;
        }
        const refusal = hit.answer as SwapRefusal;
        session.lastRefusal = { seq: fill.seq, refusal, eventId: hit.eventId };
        if (refusal.credited !== undefined) session.credit = refusal.credited;
        this.#persist();
        this.#log.warn?.('taker.fill.refused', {
          streamNonce,
          seq: fill.seq,
          reason: refusal.reason,
          retry: refusal.retry,
          credited: refusal.credited,
        });
        if (refusal.retry) {
          lastRetryable = refusal;
          await sleep(Math.min(5_000, 500 * 2 ** attempt));
          continue; // same claim again; the maker recovers it as already paid
        }
        const resync = this.#resyncFromRefusal(session, refusal);
        if (resync) {
          // My watermark was behind the maker's (a lost state file): adopt
          // the maker's, drop the stale claim, and sign the next one.
          this.#log.warn?.('taker.watermark.resynced', {
            streamNonce,
            ...resync,
          });
          session.lastFill = null;
          this.#persist();
          outcome = 'advanced';
          break;
        }
        if (refusal.credited !== undefined) {
          // Paid but refused for good: the maker owes the credit and will fold
          // it into the next accepted fill. Move to a fresh claim, same seq.
          legA.acceptedCumulative = fill.claim.cumulativeAmount;
          session.lastFill = null;
          this.#persist();
          outcome = 'advanced';
          break;
        }
        session.status = 'aborted';
        this.#persist();
        throw new SwapTakerError(
          refusal.reason,
          refusal.message,
          refusal.detail
        );
      }
      if (outcome === 'retry') {
        // Left for `resume()`: lastFill stays on disk; the maker holds its value
        // (credited if it refused it) and will fold it into the next accepted fill.
        if (lastRetryable) {
          throw new SwapTakerError(
            lastRetryable.reason,
            `fill ${fill.seq} was refused ${maxResends}× (${lastRetryable.message}); credited ${lastRetryable.credited ?? '0'} — resume later`,
            lastRetryable.detail
          );
        }
        throw new SwapTakerError(
          'no_answer',
          `fill ${fill.seq} was not answered after ${maxResends} attempts; resume later`
        );
      }
      sent = this.#sentSoFar(session);
    }
    session.status = 'done';
    session.updatedAt = this.#now();
    this.#persist();
    await this.#send(session, {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'done',
      streamNonce,
      lastSeq: session.lastAdvance?.seq ?? 0,
    });
    return session;
  }

  /** Re-quote a session found on disk and continue it. */
  async resume(
    streamNonce: string,
    opts: { onFill?: (advance: SwapAdvance) => void | Promise<void> } = {}
  ): Promise<TakerSessionState> {
    const session = this.#state.sessions[streamNonce];
    if (!session) throw new SwapTakerError('unknown_session', streamNonce);
    if (session.status === 'done') return session;
    const quote = await this.#requote(session, true);
    const answered = session.lastAdvance?.seq ?? 0;
    if (
      session.lastFill &&
      session.lastFill.seq === answered + 1 &&
      quote.lastSeq >= session.lastFill.seq
    ) {
      // The maker answered a fill I never read: it is in my inbox history.
      const facts = this.#legBFacts(session);
      const hit = await this.#waitForHistory(
        streamNonce,
        (a) => a.type === 'advance' && a.seq === session.lastFill?.seq,
        this.#c.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
      );
      if (hit && hit.answer.type === 'advance') {
        await this.#acceptAdvance(session, hit.answer, hit.eventId, facts);
        session.legA.acceptedCumulative =
          session.lastFill?.claim.cumulativeAmount ??
          session.legA.acceptedCumulative;
        this.#persist();
        await opts.onFill?.(hit.answer);
      }
    }
    return this.run(streamNonce, opts);
  }

  /**
   * Redeem the latest verified leg-B claim on chain. `via: 'own'` (default)
   * spends the taker's gas; `via: 'gas-station'` asks the station to pay and
   * falls back to own gas if it refuses and `fallback` is not `false`.
   */
  async redeem(
    streamNonce: string,
    opts: { via?: 'own' | 'gas-station'; fallback?: boolean } = {}
  ): Promise<{ txId: string; via: 'own' | 'gas-station' }> {
    const session = this.#state.sessions[streamNonce];
    if (!session) throw new SwapTakerError('unknown_session', streamNonce);
    if (!session.received)
      throw new SwapTakerError(
        'nothing_to_redeem',
        'no verified leg-B claim on this session'
      );
    const via = opts.via ?? 'own';
    let result: { txId: string; via: 'own' | 'gas-station' } | undefined;
    if (via === 'gas-station') {
      if (!this.#c.gasStationRedeemer)
        throw new SwapTakerError(
          'no_gas_station',
          'no gas-station redeemer configured'
        );
      try {
        result = {
          ...(await this.#c.gasStationRedeemer.redeem(session)),
          via: 'gas-station',
        };
      } catch (err) {
        this.#log.warn?.('taker.redeem.gas_station_failed', {
          streamNonce,
          err: err instanceof Error ? err.message : String(err),
        });
        if (opts.fallback === false || !this.#c.redeemer) {
          throw new SwapTakerError(
            'gas_station_refused',
            err instanceof Error ? err.message : String(err)
          );
        }
        this.#log.info?.('taker.redeem.falling_back_to_own_gas', {
          streamNonce,
        });
      }
    }
    if (!result) {
      if (!this.#c.redeemer)
        throw new SwapTakerError(
          'no_redeemer',
          'no redeemer configured for on-chain redemption'
        );
      result = { ...(await this.#c.redeemer.redeem(session)), via: 'own' };
    }
    session.redeemed = {
      txId: result.txId,
      cumulative: session.received.cumulative,
      at: this.#now(),
    };
    this.#persist();
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #acceptAdvance(
    session: TakerSessionState,
    advance: SwapAdvance,
    eventId: string,
    facts: ChannelFacts
  ): Promise<void> {
    // The inbound watermark is per CHANNEL (every session with this maker on
    // this chain shares it); the session keeps a copy for its own view.
    const key = `${advance.claim.chain}:${advance.claim.channelId}`;
    const stored = this.#state.inbound[key];
    const fromSession = session.received;
    const pick =
      stored && fromSession
        ? BigInt(stored.nonce) >= BigInt(fromSession.nonce)
          ? stored
          : fromSession
        : (stored ?? fromSession ?? null);
    const wm: InboundWatermark | null = pick
      ? {
          nonce: BigInt(pick.nonce),
          cumulative: BigInt(pick.cumulative),
          ...(pick.deposit !== undefined && { deposit: BigInt(pick.deposit) }),
          ...(pick.depositReadAt !== undefined && {
            depositReadAt: pick.depositReadAt,
          }),
          ...(pick.epoch !== undefined && { epoch: BigInt(pick.epoch) }),
        }
      : null;
    let verdict;
    for (let attempt = 0; ; attempt++) {
      verdict = await verifyInboundClaim({
        claim: advance.claim,
        facts,
        expectedDelta: BigInt(advance.targetAmount),
        watermark: wm,
        reader: this.#c.slotReader,
        budget: this.#budgets(session.makerPubkey),
        now: this.#now,
      });
      if (verdict.ok || !TRANSIENT_VERDICTS.has(verdict.code) || attempt >= 5)
        break;
      // A read budget or an RPC blip is not the maker's fault: wait and look again.
      const delay = Math.min(8_000, 500 * 2 ** attempt);
      this.#log.warn?.('taker.advance.verify_retry', {
        streamNonce: session.streamNonce,
        seq: advance.seq,
        code: verdict.code,
        delay,
      });
      await sleep(delay);
    }
    if (!verdict.ok) {
      if (TRANSIENT_VERDICTS.has(verdict.code)) {
        // Leave the stream where it is — nothing was accepted, `resume()` re-reads the advance from the relay.
        throw new SwapTakerError(
          'advance_unverified',
          `could not verify the maker's leg-B claim yet: ${verdict.message}; resume later`,
          { code: verdict.code, seq: advance.seq }
        );
      }
      session.status = 'aborted';
      this.#persist();
      throw new SwapTakerError(
        'advance_invalid',
        `the maker's leg-B claim failed verification: ${verdict.message}`,
        { code: verdict.code, seq: advance.seq }
      );
    }
    const record = {
      chain: advance.claim.chain,
      channelId: advance.claim.channelId,
      nonce: verdict.watermark.nonce.toString(),
      cumulative: verdict.watermark.cumulative.toString(),
      signer: advance.claim.signer,
      ...(verdict.watermark.deposit !== undefined && {
        deposit: verdict.watermark.deposit.toString(),
      }),
      ...(verdict.watermark.depositReadAt !== undefined && {
        depositReadAt: verdict.watermark.depositReadAt,
      }),
      ...(verdict.watermark.epoch !== undefined && {
        epoch: verdict.watermark.epoch.toString(),
      }),
    };
    session.received = record;
    this.#state.inbound[key] = { ...record, updatedAt: this.#now() };
    session.lastAdvance = { seq: advance.seq, advance, eventId };
    session.credit = '0';
    session.updatedAt = this.#now();
    this.#persist();
    this.#log.info?.('taker.fill.advanced', {
      streamNonce: session.streamNonce,
      seq: advance.seq,
      targetAmount: advance.targetAmount,
      cumulative: advance.claim.cumulativeAmount,
      rate: advance.rate,
    });
  }

  /**
   * A `claim_invalid` refusal that names the maker's inbound watermark above
   * mine means my state is stale (lost file, older copy). Adopt it — on the
   * session and the shared channel record — and report what moved.
   */
  #resyncFromRefusal(
    session: TakerSessionState,
    refusal: SwapRefusal
  ): { nonce: string; cumulative: string } | null {
    const detail = refusal.detail as
      | { code?: string; watermark?: { nonce?: string; cumulative?: string } }
      | undefined;
    const wm = detail?.watermark;
    if (
      !wm ||
      typeof wm.nonce !== 'string' ||
      typeof wm.cumulative !== 'string'
    )
      return null;
    if (!/^[0-9]+$/.test(wm.nonce) || !/^[0-9]+$/.test(wm.cumulative))
      return null;
    const legA = session.legA;
    if (legA.channelId === null) return null;
    const theirs = {
      nonce: BigInt(wm.nonce),
      cumulative: BigInt(wm.cumulative),
    };
    const mineAccepted = BigInt(
      legA.acceptedCumulative ?? legA.startCumulative ?? '0'
    );
    if (theirs.cumulative <= mineAccepted) return null;
    legA.nonce = theirs.nonce.toString();
    legA.cumulative = theirs.cumulative.toString();
    // Nothing of THIS session was accepted at the maker's watermark: the
    // stream restarts from there.
    legA.startCumulative = legA.cumulative;
    legA.acceptedCumulative = legA.cumulative;
    const channel = this.#channelWatermark(
      legA.chain,
      legA.channelId,
      session.order.legA.swapSignerAddress
    );
    channel.nonce = legA.nonce;
    channel.cumulative = legA.cumulative;
    channel.updatedAt = this.#now();
    return { nonce: legA.nonce, cumulative: legA.cumulative };
  }

  #sentSoFar(session: TakerSessionState): bigint {
    // What this session has handed the maker and been answered for: the
    // channel cumulative of the last answered fill, minus where the session
    // started on that channel.
    const start = BigInt(session.legA.startCumulative ?? '0');
    const accepted = BigInt(
      session.legA.acceptedCumulative ?? session.legA.startCumulative ?? '0'
    );
    return accepted > start ? accepted - start : 0n;
  }

  async #send(
    session: TakerSessionState,
    payload:
      | SwapAccept
      | SwapFill
      | {
          proto: typeof SWAP_WIRE_PROTOCOL;
          type: 'done';
          streamNonce: string;
          lastSeq: number;
        }
  ): Promise<string> {
    const ttl = this.#c.sessionTtlMs ?? DEFAULT_TAKER_SESSION_TTL_MS;
    const { wrap } = wrapGiftWrap({
      rumor: {
        kind: SWAP_RUMOR_KIND,
        content: JSON.stringify(payload),
        tags: [['stream', session.streamNonce]],
      },
      senderSecretKey: this.#c.nostr.secretKey,
      recipientPubkey: session.makerPubkey,
      expiresAt: Math.floor((this.#now() + ttl) / 1000),
      now: this.#now,
    });
    const result = await this.#c.writer.publish(wrap);
    if (!result.ok) {
      this.#log.warn?.('taker.publish.refused', {
        type: payload.type,
        refusedBy: result.refusedBy,
        code: result.code,
        message: result.message,
      });
      if (!result.retry)
        throw new SwapTakerError(
          'publish_refused',
          `${result.refusedBy} refused the write: ${result.code} ${result.message}`
        );
    }
    return wrap.id;
  }

  #persist(): void {
    this.#c.store.save(this.#state);
  }

  #channelWatermark(chain: string, channelId: string, counterparty: string) {
    const key = `${chain}:${channelId}`;
    let wm = this.#state.channels[key];
    if (!wm) {
      wm = {
        chain,
        channelId,
        counterparty,
        nonce: '0',
        cumulative: '0',
        updatedAt: this.#now(),
      };
      this.#state.channels[key] = wm;
    }
    return wm;
  }

  /** My outbound watermarks, per leg-A channel. */
  channels(): Readonly<Record<string, TakerChannelWatermark>> {
    return this.#state.channels;
  }

  #myAddressOn(chain: string): string {
    if (chain.startsWith('evm:')) {
      if (!this.#c.keys.evm)
        throw new SwapTakerError('missing_key', `no EVM key for ${chain}`);
      return this.#c.keys.evm.address;
    }
    if (chain.startsWith('solana:')) {
      if (!this.#c.keys.solana)
        throw new SwapTakerError('missing_key', `no Solana key for ${chain}`);
      return base58Encode(this.#c.keys.solana.publicKey);
    }
    throw new SwapTakerError('unsupported_chain', chain);
  }

  #legASigner(session: TakerSessionState): PaymentChannelSigner {
    const chain = session.order.pair.from.chain;
    const terms = session.order.legA;
    if (chain.startsWith('evm:')) {
      if (!this.#c.keys.evm)
        throw new SwapTakerError('missing_key', `no EVM key for ${chain}`);
      if (!terms.verifyingContract)
        throw new SwapTakerError(
          'order_incomplete',
          'legA.verifyingContract missing'
        );
      return new TokenNetworkBalanceProofSigner({
        chain,
        privateKey: this.#c.keys.evm.privateKey,
        chainId: parseEvmChainId(chain),
        tokenNetworkAddress: terms.verifyingContract,
      });
    }
    if (!this.#c.keys.solana)
      throw new SwapTakerError('missing_key', `no Solana key for ${chain}`);
    if (!terms.programId)
      throw new SwapTakerError('order_incomplete', 'legA.programId missing');
    return new SolanaPaymentChannelSigner({
      chain,
      privateKey: this.#c.keys.solana.privateKey,
      programId: terms.programId,
    });
  }

  #legBFacts(session: TakerSessionState): ChannelFacts {
    const chain = session.order.pair.to.chain;
    const terms = session.order.legB;
    if (chain.startsWith('evm:')) {
      if (!terms.verifyingContract)
        throw new SwapTakerError(
          'order_incomplete',
          'legB.verifyingContract missing'
        );
      return {
        family: 'evm',
        chain,
        chainId: parseEvmChainId(chain),
        tokenNetwork: terms.verifyingContract,
        self: session.chainRecipient,
        counterparty: terms.swapSignerAddress,
      };
    }
    if (!terms.programId || !terms.token)
      throw new SwapTakerError(
        'order_incomplete',
        'legB.programId / token missing'
      );
    return {
      family: 'solana',
      chain,
      programId: terms.programId,
      mint: terms.token,
      self: session.chainRecipient,
      counterparty: terms.swapSignerAddress,
    };
  }
}

/** The default funder: this repo's provisioners, driven by the taker's own keys. */
export function defaultChannelFunder(
  keys: SwapNodeKeys,
  providers: readonly SwapNodeChainProvider[]
): ChannelFunder {
  const evmFor = (chain: string) =>
    providers.find((p) => p.chainType === 'evm' && p.chainId === chain);
  const solFor = (chain: string) =>
    providers.find((p) => p.chainType === 'solana' && p.chainId === chain);
  return {
    async channelFor(chain, counterparty) {
      if (chain.startsWith('evm:')) {
        const p = evmFor(chain);
        if (!p || p.chainType !== 'evm' || !keys.evm)
          throw new SwapTakerError('no_provider', chain);
        return createEvmLegBChannelProvisioner({
          rpcUrl: p.rpcUrl,
          tokenNetworkAddress: p.tokenNetworkAddress,
          tokenAddress: p.tokenAddress,
          makerPrivateKey: keys.evm.privateKey,
          channelDeposit: 1n,
        }).channelFor(counterparty);
      }
      const p = solFor(chain);
      if (!p || p.chainType !== 'solana' || !keys.solana)
        throw new SwapTakerError('no_provider', chain);
      return deriveSolanaChannelPda({
        participantA: base58Encode(keys.solana.publicKey),
        participantB: counterparty,
        mint: p.tokenMint,
        programId: p.programId,
      });
    },
    async ensure(chain, counterparty, minDeposit) {
      if (chain.startsWith('evm:')) {
        const p = evmFor(chain);
        if (!p || p.chainType !== 'evm' || !keys.evm)
          throw new SwapTakerError('no_provider', chain);
        const prov = createEvmLegBChannelProvisioner({
          rpcUrl: p.rpcUrl,
          tokenNetworkAddress: p.tokenNetworkAddress,
          tokenAddress: p.tokenAddress,
          makerPrivateKey: keys.evm.privateKey,
          channelDeposit: minDeposit,
          ...(p.settlementTimeoutSeconds !== undefined && {
            settlementTimeoutSeconds: BigInt(p.settlementTimeoutSeconds),
          }),
        });
        const ensured = await prov.ensure(counterparty, minDeposit);
        return {
          channelId: ensured.channelId,
          nonce: ensured.nonce,
          transferredAmount: ensured.transferredAmount,
        };
      }
      const p = solFor(chain);
      if (!p || p.chainType !== 'solana' || !keys.solana)
        throw new SwapTakerError('no_provider', chain);
      const prov = createSolanaLegBChannelProvisioner({
        rpcUrl: p.rpcUrl,
        programId: p.programId,
        tokenMint: p.tokenMint,
        makerSeed: keys.solana.privateKey,
        channelDeposit: minDeposit,
        ...(p.challengeDurationSeconds !== undefined && {
          challengeDurationSeconds: p.challengeDurationSeconds,
        }),
      });
      const ensured = await prov.ensure(counterparty, minDeposit);
      const acct = await prov.read(counterparty);
      const me = base58Encode(keys.solana.publicKey);
      const isA = acct?.participantA === me;
      return {
        channelId: ensured.channelId,
        nonce: acct ? (isA ? acct.nonceA : acct.nonceB) : 0n,
        transferredAmount: acct
          ? isA
            ? acct.transferredAmountA
            : acct.transferredAmountB
          : 0n,
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { eventExpiration };
