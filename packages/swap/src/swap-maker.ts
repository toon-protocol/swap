/**
 * The maker on the relay: reads its inbox, verifies what takers send, drives
 * the {@link MakerEngine}, and writes its answers — plus the public order
 * that lets a taker find it in the first place.
 *
 * What arrives is a gift wrap (`nip59.ts`) addressed to this maker's Nostr
 * pubkey. What it does, per message:
 *
 *   accept → `engine.quote()` → wrapped quote back to the sealer.
 *   fill   → decide replay / gap / recovery from the session alone, then
 *            `verifyInboundClaim` (the taker's leg-A claim, against the
 *            chain), persist the inbound watermark WRITE-AHEAD, hand the
 *            engine a `PaymentAttribution`, wrap its advance/refusal back.
 *   done   → logged; the session expires on its own.
 *
 * Money rules that live here and nowhere else:
 *
 *   - A fill's claim is verified BEFORE the engine sees it, and the inbound
 *     watermark is persisted before the advance can leave — a crash between
 *     the two is recovered on replay as "already paid" (`inbound.seq ===
 *     fill.seq`), never as a second payment.
 *   - A retransmitted fill (same seq, same claim) gets the SAME advance, so a
 *     taker that lost the answer recovers it without a new claim.
 *   - Nothing is ever published to a stranger: an unknown session, another
 *     taker's pubkey, or a wrap older than the session TTL is dropped, not
 *     refused — a refusal is a paid write, and paying to say no to someone
 *     who has not paid is the one way a maker can be made to bleed.
 *   - Chain reads a taker can cause are bounded per taker pubkey.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

import type { MakerEngine, MakerSession } from './maker-engine.js';
import { makerRefusal } from './maker-engine.js';
import { unwrapGiftWrap, wrapGiftWrap } from './nip59.js';
import type { NostrIdentity } from './nostr-keys.js';
import { pairKey } from './rate-staleness.js';
import { createReadBudgets, verifyInboundClaim } from './received-claim.js';
import type {
  ChannelFacts,
  ChannelSlotReader,
  InboundWatermark,
} from './received-claim.js';
import type { RelayWriter } from './relay-writer.js';
import type { NostrFilter } from './relay-subscription.js';
import type {
  PersistedInboundEntry,
  PersistedOrderEntry,
  PersistentSeenPacketIds,
} from './state-store.js';
import {
  SWAP_ORDER_KIND,
  SWAP_REFUSAL_REASONS,
  SWAP_RUMOR_KIND,
  SWAP_WIRE_PROTOCOL,
  attributionPayerKey,
  parseSwapTakerMessage,
} from './wire.js';
import type {
  SwapFill,
  SwapLegTerms,
  SwapOrder,
  SwapWireAnswer,
} from './wire.js';

/** The subset of `RelaySubscription` the loop needs — injectable for tests. */
export interface RelayReader {
  start(): void;
  close(): void;
  subscribe(filters: NostrFilter | NostrFilter[], subId?: string): string;
  isConnected(): boolean;
  hasReachedEose(subId: string): boolean;
}

export interface SwapMakerLoopLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface SwapMakerLoopConfig {
  engine: MakerEngine;
  nostr: NostrIdentity;
  /** Constructed with `onEvent` wired to {@link SwapMakerLoop.handleWrap} by the caller. */
  reader: RelayReader;
  writer: RelayWriter;
  slotReader: ChannelSlotReader;
  /** The channel facts for a session's leg A, from the maker's config. */
  factsFor: (session: Readonly<MakerSession>) => ChannelFacts;
  legATerms: (chain: string) => SwapLegTerms;
  legBTerms: (chain: string) => SwapLegTerms;
  swapPairs: readonly SwapPair[];
  seen: PersistentSeenPacketIds;
  /** Persist everything (the caller's persister reads {@link SwapMakerLoop.extras}). */
  persist: () => void;
  initial?: {
    inbound?: Record<string, PersistedInboundEntry>;
    relayCursor?: number;
    orders?: Record<string, PersistedOrderEntry>;
  };
  sessionTtlMs: number;
  orderTtlMs?: number;
  orderRefreshMs?: number;
  maxChainReadsPerMin?: number;
  inboundRereadMs?: number;
  logger?: SwapMakerLoopLogger;
  now?: () => number;
}

export const DEFAULT_ORDER_TTL_MS = 10 * 60_000;
export const DEFAULT_ORDER_REFRESH_MS = 8 * 60_000;
export const DEFAULT_MAX_CHAIN_READS_PER_MIN = 30;
export const INBOX_SUB_ID = 'inbox';
/** How far behind the cursor a resumed subscription starts (clock skew). */
const CURSOR_SKEW_SECONDS = 60;

interface InboundEntry extends InboundWatermark {
  delta: bigint;
  seq: number;
  streamNonce: string;
  fillEventId: string;
  signer: string;
  handled?: 'answered' | 'refused';
  updatedAt: number;
}

export interface SwapMakerLoopHealth {
  relay: { connected: boolean; eose: boolean; cursor: number; seen: number };
  orders: Record<
    string,
    { orderId: string; eventId: string; expiresAt: number }
  >;
  writes: { ok: number; refused: number };
  inbound: Record<
    string,
    { nonce: string; cumulative: string; seq: number; streamNonce: string }
  >;
}

export class SwapMakerLoop {
  readonly #c: SwapMakerLoopConfig;
  readonly #inbound = new Map<string, InboundEntry>();
  readonly #orders = new Map<string, PersistedOrderEntry>();
  readonly #budgets: (key: string) => { tryAcquire(): boolean };
  readonly #log: SwapMakerLoopLogger;
  readonly #now: () => number;
  #cursor: number;
  #queue: Promise<void> = Promise.resolve();
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #writes = { ok: 0, refused: 0 };

  constructor(config: SwapMakerLoopConfig) {
    this.#c = config;
    this.#log = config.logger ?? {};
    this.#now = config.now ?? Date.now;
    this.#cursor = config.initial?.relayCursor ?? 0;
    this.#budgets = createReadBudgets({
      maxReadsPerMinute:
        config.maxChainReadsPerMin ?? DEFAULT_MAX_CHAIN_READS_PER_MIN,
      now: this.#now,
    });
    for (const [k, v] of Object.entries(config.initial?.inbound ?? {})) {
      this.#inbound.set(k, {
        nonce: BigInt(v.nonce),
        cumulative: BigInt(v.cumulative),
        delta: BigInt(v.delta),
        seq: v.seq,
        streamNonce: v.streamNonce,
        fillEventId: v.fillEventId,
        signer: v.signer,
        ...(v.deposit !== undefined && { deposit: BigInt(v.deposit) }),
        ...(v.depositReadAt !== undefined && {
          depositReadAt: v.depositReadAt,
        }),
        ...(v.epoch !== undefined && { epoch: BigInt(v.epoch) }),
        ...(v.handled !== undefined && { handled: v.handled }),
        updatedAt: v.updatedAt,
      });
    }
    for (const [k, v] of Object.entries(config.initial?.orders ?? {}))
      this.#orders.set(k, v);
  }

  /** The inbox filter this maker subscribes with. */
  inboxFilter(): NostrFilter {
    return {
      kinds: [1059],
      '#p': [this.#c.nostr.pubkey],
      since: Math.max(0, this.#cursor - CURSOR_SKEW_SECONDS),
    };
  }

  /** Subscribe, connect, and publish orders once history has been replayed. */
  async start(): Promise<void> {
    this.#c.reader.subscribe(this.inboxFilter(), INBOX_SUB_ID);
    this.#c.reader.start();
    await this.publishOrders();
    const refresh = this.#c.orderRefreshMs ?? DEFAULT_ORDER_REFRESH_MS;
    this.#refreshTimer = setInterval(() => {
      void this.publishOrders().catch((err) => {
        this.#log.warn?.('swap.orders.refresh_failed', { err: errMsg(err) });
      });
    }, refresh);
    (this.#refreshTimer as { unref?: () => void }).unref?.();
  }

  /** Withdraw orders (best effort) and close the subscription. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    try {
      await this.withdrawOrders();
    } catch (err) {
      this.#log.warn?.('swap.orders.withdraw_failed', { err: errMsg(err) });
    }
    this.#c.reader.close();
  }

  /** Persisted view of what this loop owns. */
  extras(): {
    inbound: Record<string, PersistedInboundEntry>;
    relayCursor: number;
    orders: Record<string, PersistedOrderEntry>;
  } {
    const inbound: Record<string, PersistedInboundEntry> = {};
    for (const [k, v] of this.#inbound) {
      inbound[k] = {
        nonce: v.nonce.toString(),
        cumulative: v.cumulative.toString(),
        delta: v.delta.toString(),
        seq: v.seq,
        streamNonce: v.streamNonce,
        fillEventId: v.fillEventId,
        signer: v.signer,
        ...(v.deposit !== undefined && { deposit: v.deposit.toString() }),
        ...(v.depositReadAt !== undefined && {
          depositReadAt: v.depositReadAt,
        }),
        ...(v.epoch !== undefined && { epoch: v.epoch.toString() }),
        ...(v.handled !== undefined && { handled: v.handled }),
        updatedAt: v.updatedAt,
      };
    }
    return {
      inbound,
      relayCursor: this.#cursor,
      orders: Object.fromEntries(this.#orders),
    };
  }

  health(): SwapMakerLoopHealth {
    const inbound: SwapMakerLoopHealth['inbound'] = {};
    for (const [k, v] of this.#inbound) {
      inbound[k] = {
        nonce: v.nonce.toString(),
        cumulative: v.cumulative.toString(),
        seq: v.seq,
        streamNonce: v.streamNonce,
      };
    }
    return {
      relay: {
        connected: this.#c.reader.isConnected(),
        eose: this.#c.reader.hasReachedEose(INBOX_SUB_ID),
        cursor: this.#cursor,
        seen: this.#c.seen.size,
      },
      orders: Object.fromEntries(
        [...this.#orders].map(([k, o]) => [
          k,
          { orderId: o.orderId, eventId: o.eventId, expiresAt: o.expiresAt },
        ])
      ),
      writes: { ...this.#writes },
      inbound,
    };
  }

  get cursor(): number {
    return this.#cursor;
  }

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /**
   * Feed one relay event. Events are processed strictly in arrival order —
   * a taker's fills are sequential and so must the answers be. Returns when
   * this event has been fully handled.
   */
  handleWrap(event: NostrEvent): Promise<void> {
    const run = this.#queue.then(() => this.#handleOne(event));
    this.#queue = run.catch((err) => {
      this.#log.error?.('swap.inbox.unhandled', {
        eventId: event.id,
        err: errMsg(err),
      });
    });
    return this.#queue;
  }

  async #handleOne(event: NostrEvent): Promise<void> {
    if (this.#stopped) return;
    if (this.#c.seen.has(event.id)) return;
    const nowSec = Math.floor(this.#now() / 1000);

    let opened;
    try {
      opened = unwrapGiftWrap(
        this.#c.nostr.secretKey,
        this.#c.nostr.pubkey,
        event
      );
    } catch (err) {
      this.#log.debug?.('swap.inbox.unopenable', {
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
      this.#log.debug?.('swap.inbox.not_json', {
        eventId: event.id,
        from: opened.sealPubkey,
      });
      this.#markSeen(event);
      return;
    }
    const parsed = parseSwapTakerMessage(payload);
    if (!parsed.ok) {
      this.#log.debug?.('swap.inbox.malformed', {
        eventId: event.id,
        from: opened.sealPubkey,
        error: parsed.error,
      });
      this.#markSeen(event);
      return;
    }
    const msg = parsed.value;
    const from = opened.sealPubkey;
    const stale =
      event.created_at < nowSec - Math.floor(this.#c.sessionTtlMs / 1000);

    if (msg.type === 'accept') {
      if (stale && !this.#c.engine.sessionFor(msg.streamNonce)) {
        this.#log.debug?.('swap.inbox.stale_accept_dropped', {
          eventId: event.id,
          from,
        });
        this.#markSeen(event);
        return;
      }
      const answer = await this.#c.engine.quote(msg, { takerPubkey: from });
      await this.#answer(from, event.id, answer, msg.streamNonce);
      this.#markSeen(event);
      this.#c.persist();
      return;
    }

    if (msg.type === 'done') {
      this.#log.info?.('swap.session.done', {
        streamNonce: msg.streamNonce,
        lastSeq: msg.lastSeq,
        from,
      });
      this.#markSeen(event);
      return;
    }

    // fill
    const session = this.#c.engine.sessionFor(msg.streamNonce);
    if (!session || session.takerPubkey !== from) {
      this.#log.debug?.('swap.inbox.fill_for_unknown_session_dropped', {
        eventId: event.id,
        streamNonce: msg.streamNonce,
        from,
      });
      this.#markSeen(event);
      return;
    }
    const answer = await this.#fill(session, msg, event.id, from);
    await this.#answer(from, event.id, answer, msg.streamNonce);
    this.#markSeen(event);
    this.#c.persist();
  }

  async #fill(
    session: Readonly<MakerSession>,
    fill: SwapFill,
    eventId: string,
    from: string
  ): Promise<SwapWireAnswer> {
    const ctx = { streamNonce: fill.streamNonce, seq: fill.seq };
    const family = session.pair.from.chain.startsWith('evm:')
      ? 'evm'
      : 'solana';
    const key = `${session.pair.from.chain}:${fill.claim.channelId}`;
    const entry = this.#inbound.get(key);

    // Replay of the answered fill, same claim → the same advance, nothing verified twice.
    if (fill.seq === session.lastSeq && session.lastAdvance) {
      if (
        entry &&
        entry.streamNonce === session.streamNonce &&
        entry.nonce.toString() === fill.claim.nonce
      ) {
        this.#log.debug?.('swap.fill.retransmit', ctx);
        return session.lastAdvance;
      }
      return makerRefusal(
        SWAP_REFUSAL_REASONS.SEQ_GAP,
        `seq ${fill.seq} was already answered with a different claim; next is ${session.lastSeq + 1}`,
        { ...ctx, detail: { expected: session.lastSeq + 1 } },
        false
      );
    }
    if (fill.seq !== session.lastSeq + 1) {
      return makerRefusal(
        SWAP_REFUSAL_REASONS.SEQ_GAP,
        `expected seq ${session.lastSeq + 1}`,
        { ...ctx, detail: { expected: session.lastSeq + 1 } },
        false
      );
    }

    // The same claim again, already verified and persisted. Either it was
    // never handed to the engine (a crash window: hand it over now, its value
    // is `delta`) or the engine refused it and CREDITED the value (hand it
    // over with amount 0: the credit carries it, and must not be doubled).
    if (
      entry &&
      entry.streamNonce === session.streamNonce &&
      entry.seq === fill.seq &&
      entry.nonce.toString() === fill.claim.nonce &&
      entry.cumulative.toString() === fill.claim.cumulativeAmount
    ) {
      const amount = entry.handled === 'refused' ? 0n : entry.delta;
      this.#log.info?.(
        entry.handled === 'refused'
          ? 'swap.fill.retry_after_refusal'
          : 'swap.fill.recovered_after_crash',
        {
          ...ctx,
          delta: entry.delta.toString(),
          amount: amount.toString(),
        }
      );
      const answer = await this.#c.engine.fill({
        fill,
        attribution: {
          payer: attributionPayerKey(family, fill.claim.channelId),
          amount,
          chain: family,
        },
        takerPubkey: from,
        fillEventId: eventId,
      });
      entry.handled = answer.type === 'advance' ? 'answered' : 'refused';
      return answer;
    }

    const bounds = this.#c.engine.fillBounds;
    const verdict = await verifyInboundClaim({
      claim: fill.claim,
      facts: this.#c.factsFor(session),
      expectedDelta: bounds.min,
      maxDelta: bounds.max,
      watermark: entry ?? null,
      reader: this.#c.slotReader,
      budget: this.#budgets(from),
      ...(this.#c.inboundRereadMs !== undefined && {
        rereadMs: this.#c.inboundRereadMs,
      }),
      now: this.#now,
    });
    if (!verdict.ok) {
      this.#log.warn?.('swap.fill.claim_refused', {
        ...ctx,
        from,
        code: verdict.code,
        message: verdict.message,
      });
      const reason =
        verdict.code === 'RATE_LIMITED'
          ? SWAP_REFUSAL_REASONS.RATE_LIMITED
          : verdict.code === 'CHAIN_READ_FAILED'
            ? SWAP_REFUSAL_REASONS.CHAIN_READ_FAILED
            : verdict.code === 'DELTA_TOO_LARGE'
              ? SWAP_REFUSAL_REASONS.FILL_TOO_LARGE
              : SWAP_REFUSAL_REASONS.CLAIM_INVALID;
      // A taker that lost its state signs below my watermark; telling it
      // where the watermark stands lets it resync (I hold that claim anyway).
      const watermark =
        (verdict.code === 'NON_MONOTONIC_NONCE' ||
          verdict.code === 'NON_MONOTONIC_CUMULATIVE') &&
        entry
          ? {
              nonce: entry.nonce.toString(),
              cumulative: entry.cumulative.toString(),
            }
          : undefined;
      return makerRefusal(
        reason,
        verdict.message,
        {
          ...ctx,
          detail: { code: verdict.code, ...(watermark && { watermark }) },
        },
        verdict.retry
      );
    }

    // Write-ahead: the claim is ours before the advance can exist.
    this.#inbound.set(key, {
      ...verdict.watermark,
      delta: verdict.delta,
      seq: fill.seq,
      streamNonce: session.streamNonce,
      fillEventId: eventId,
      signer: fill.claim.signer,
      updatedAt: this.#now(),
    });
    try {
      this.#c.persist();
    } catch (err) {
      this.#inbound.delete(key);
      if (entry) this.#inbound.set(key, entry);
      this.#log.error?.('swap.fill.persist_failed', {
        ...ctx,
        err: errMsg(err),
      });
      return makerRefusal(
        SWAP_REFUSAL_REASONS.PERSISTENCE_FAILED,
        'could not persist the inbound watermark; resend this fill',
        ctx,
        true
      );
    }
    const answer = await this.#c.engine.fill({
      fill,
      attribution: {
        payer: attributionPayerKey(family, fill.claim.channelId),
        amount: verdict.delta,
        chain: family,
      },
      takerPubkey: from,
      fillEventId: eventId,
    });
    const stored = this.#inbound.get(key);
    if (stored)
      stored.handled = answer.type === 'advance' ? 'answered' : 'refused';
    return answer;
  }

  async #answer(
    to: string,
    inReplyTo: string,
    answer: SwapWireAnswer,
    streamNonce: string
  ): Promise<void> {
    const nowMs = this.#now();
    const { wrap } = wrapGiftWrap({
      rumor: {
        kind: SWAP_RUMOR_KIND,
        content: JSON.stringify(answer),
        tags: [
          ['e', inReplyTo],
          ['stream', streamNonce],
        ],
      },
      senderSecretKey: this.#c.nostr.secretKey,
      recipientPubkey: to,
      expiresAt: Math.floor((nowMs + this.#c.sessionTtlMs) / 1000),
      now: this.#now,
    });
    const result = await this.#c.writer.publish(wrap);
    if (result.ok) {
      this.#writes.ok += 1;
      this.#log.debug?.('swap.answer.published', {
        to,
        type: answer.type,
        streamNonce,
        eventId: wrap.id,
      });
    } else {
      this.#writes.refused += 1;
      // The taker will retransmit (a fill) or re-accept (a quote); the
      // engine answers the retransmit from its session, so nothing is lost.
      this.#log.warn?.('swap.answer.unpublished', {
        to,
        type: answer.type,
        streamNonce,
        refusedBy: result.refusedBy,
        code: result.code,
        message: result.message,
      });
    }
  }

  #markSeen(event: NostrEvent): void {
    this.#c.seen.add(event.id);
    if (event.created_at > this.#cursor) this.#cursor = event.created_at;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /** The order this maker would publish for `pair` right now, or null if it cannot price it. */
  async buildOrder(pair: SwapPair): Promise<SwapOrder | null> {
    const priced = await this.#c.engine.priceForOrder(pair);
    if ('refusal' in priced) {
      this.#log.warn?.('swap.order.unpriceable', {
        pair: pairKey(pair),
        reason: priced.refusal.reason,
      });
      return null;
    }
    const nowMs = this.#now();
    const bounds = this.#c.engine.fillBounds;
    const free = this.#c.engine.freeCapacity(pair);
    return {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'order',
      orderId: pairKey(pair),
      pair: {
        from: {
          assetCode: pair.from.assetCode,
          assetScale: pair.from.assetScale,
          chain: pair.from.chain,
        },
        to: {
          assetCode: pair.to.assetCode,
          assetScale: pair.to.assetScale,
          chain: pair.to.chain,
        },
      },
      rate: priced.rate,
      rateTimestamp: priced.rateTimestamp,
      fill: { min: bounds.min.toString(), max: bounds.max.toString() },
      ...(free !== null && { maxAmount: free.toString() }),
      legA: this.#c.legATerms(pair.from.chain),
      legB: this.#c.legBTerms(pair.to.chain),
      expiresAt: nowMs + (this.#c.orderTtlMs ?? DEFAULT_ORDER_TTL_MS),
    };
  }

  /** Publish (replace) one order per pair. */
  async publishOrders(): Promise<void> {
    for (const pair of this.#c.swapPairs) {
      const order = await this.buildOrder(pair);
      if (!order) continue;
      await this.#publishOrder(order, Math.floor(order.expiresAt / 1000));
    }
    this.#c.persist();
  }

  /** Republish every order with an expiration of now, so the relay stops serving it. */
  async withdrawOrders(): Promise<void> {
    const nowSec = Math.floor(this.#now() / 1000);
    for (const pair of this.#c.swapPairs) {
      const order = await this.buildOrder(pair);
      if (!order) continue;
      await this.#publishOrder({ ...order, expiresAt: nowSec * 1000 }, nowSec);
    }
  }

  async #publishOrder(order: SwapOrder, expirationSec: number): Promise<void> {
    const event = finalizeEvent(
      {
        kind: SWAP_ORDER_KIND,
        created_at: Math.floor(this.#now() / 1000),
        tags: [
          ['d', order.orderId],
          ['expiration', String(expirationSec)],
          ['from', `${order.pair.from.assetCode}:${order.pair.from.chain}`],
          ['to', `${order.pair.to.assetCode}:${order.pair.to.chain}`],
        ],
        content: JSON.stringify(order),
      },
      this.#c.nostr.secretKey
    );
    const result = await this.#c.writer.publish(event);
    if (result.ok) {
      this.#writes.ok += 1;
      this.#orders.set(order.orderId, {
        orderId: order.orderId,
        eventId: event.id,
        publishedAt: this.#now(),
        expiresAt: order.expiresAt,
      });
      this.#log.info?.('swap.order.published', {
        orderId: order.orderId,
        eventId: event.id,
        rate: order.rate,
        expiresAt: order.expiresAt,
      });
    } else {
      this.#writes.refused += 1;
      this.#log.warn?.('swap.order.unpublished', {
        orderId: order.orderId,
        refusedBy: result.refusedBy,
        code: result.code,
        message: result.message,
      });
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
