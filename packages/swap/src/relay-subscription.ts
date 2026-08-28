/**
 * The read half of the swap client: a long-lived NIP-01 WebSocket to the
 * relay. Reads are free — payment gates writes only — so this keeps one
 * socket open, re-issues every active `REQ` after a reconnect, buffers events
 * de-duplicated by `event.id`, and lets a caller drain them past a monotonic
 * cursor.
 *
 * Two things a swap party cares about beyond plain streaming:
 *
 *  - **EOSE is a fact, not noise.** A party that resumes asks the relay for
 *    everything since its last cursor and must know when history has been
 *    replayed before deciding "my fill was never answered". `waitForEose`
 *    exposes that per subscription.
 *  - **Frames are plain JSON.** The relay's WebSocket broadcasts canonical
 *    NIP-01 `["EVENT", subId, {…}]` frames; nothing here decodes TOON text.
 *
 * Ported from toon-client's daemon (`client-mcp/src/relay-subscription.ts`,
 * removed with the 2.0 client) — the WebSocket is injectable so unit tests
 * drive the wire without a relay; the default factory uses `ws`.
 */

import { createRequire } from 'node:module';
import type { NostrEvent } from 'nostr-tools/pure';

const nodeRequire = createRequire(import.meta.url);

/** NIP-01 filter. Tag filters are single-letter (`#p`, `#e`, `#d`). */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

/** Minimal WebSocket surface this module depends on (subset of `ws`). */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface RelaySubscriptionOptions {
  /** Relay WS URL, e.g. `ws://localhost:7100`. */
  relayUrl: string;
  /** Max events retained in the ring buffer (oldest evicted). Default 5000. */
  bufferSize?: number;
  /** Base reconnect delay, ms. Default 1000. */
  reconnectBaseMs?: number;
  /** Max reconnect delay, ms. Default 30000. */
  reconnectMaxMs?: number;
  wsFactory?: WebSocketFactory;
  /** Invoked once per newly-buffered (de-duplicated) event. */
  onEvent?: (subId: string, event: NostrEvent) => void;
  /** Invoked when the relay reports end-of-stored-events for a subscription. */
  onEose?: (subId: string) => void;
  logger?: (msg: string) => void;
}

interface BufferedEvent {
  seq: number;
  subId: string;
  event: NostrEvent;
}

export interface DrainResult {
  events: NostrEvent[];
  cursor: number;
  hasMore: boolean;
}

const DEFAULT_BUFFER = 5000;
const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30_000;

const noop = (): void => undefined;

export class RelaySubscription {
  readonly relayUrl: string;
  readonly #bufferSize: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #log: (msg: string) => void;
  readonly #wsFactory: WebSocketFactory;
  readonly #onEvent?: (subId: string, event: NostrEvent) => void;
  readonly #onEose?: (subId: string) => void;

  /** Active subscriptions: subId → filters (re-sent on every (re)connect). */
  readonly #subscriptions = new Map<string, NostrFilter[]>();
  /** Subscriptions whose EOSE has arrived since the last (re)connect. */
  readonly #eose = new Set<string>();
  readonly #eoseWaiters = new Map<string, (() => void)[]>();

  #buffer: BufferedEvent[] = [];
  readonly #seen = new Set<string>();
  #seqCounter = 0;
  #subIdCounter = 0;

  #ws: MinimalWebSocket | null = null;
  #connected = false;
  #closing = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelaySubscriptionOptions) {
    this.relayUrl = opts.relayUrl;
    this.#bufferSize = opts.bufferSize ?? DEFAULT_BUFFER;
    this.#reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_BASE_MS;
    this.#reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_MAX_MS;
    this.#log = opts.logger ?? noop;
    this.#wsFactory = opts.wsFactory ?? defaultWebSocketFactory();
    if (opts.onEvent) this.#onEvent = opts.onEvent;
    if (opts.onEose) this.#onEose = opts.onEose;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  bufferedCount(): number {
    return this.#buffer.length;
  }

  activeSubscriptions(): string[] {
    return [...this.#subscriptions.keys()];
  }

  /** Whether `subId` has seen EOSE on the current connection. */
  hasReachedEose(subId: string): boolean {
    return this.#eose.has(subId);
  }

  /** Open the connection (idempotent). */
  start(): void {
    this.#closing = false;
    if (this.#ws) return;
    this.#open();
  }

  /** Register a persistent subscription and (if connected) send the REQ. */
  subscribe(filters: NostrFilter | NostrFilter[], subId?: string): string {
    const id = subId ?? `sub-${++this.#subIdCounter}`;
    const list = Array.isArray(filters) ? filters : [filters];
    this.#subscriptions.set(id, list);
    this.#eose.delete(id);
    if (this.#connected) this.#sendReq(id, list);
    return id;
  }

  unsubscribe(subId: string): void {
    if (!this.#subscriptions.delete(subId)) return;
    this.#eose.delete(subId);
    if (this.#connected) this.#sendRaw(['CLOSE', subId]);
  }

  /**
   * Resolve when `subId` reaches EOSE on the current connection, or reject
   * after `timeoutMs`. Resolves immediately if EOSE already arrived.
   */
  waitForEose(subId: string, timeoutMs: number): Promise<void> {
    if (this.#eose.has(subId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.#eoseWaiters.get(subId) ?? [];
        this.#eoseWaiters.set(
          subId,
          list.filter((w) => w !== done)
        );
        reject(
          new Error(
            `relay ${this.relayUrl}: no EOSE for ${subId} within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const list = this.#eoseWaiters.get(subId) ?? [];
      list.push(done);
      this.#eoseWaiters.set(subId, list);
    });
  }

  /** Drain events newer than `cursor` (the highest `seq` previously returned). */
  getEvents(
    opts: { subId?: string; cursor?: number; limit?: number } = {}
  ): DrainResult {
    const after = opts.cursor ?? 0;
    const limit = opts.limit ?? 200;
    const matches = this.#buffer.filter(
      (b) =>
        b.seq > after && (opts.subId === undefined || b.subId === opts.subId)
    );
    const page = matches.slice(0, limit);
    const hasMore = matches.length > page.length;
    const last = page.at(-1);
    return {
      events: page.map((b) => b.event),
      cursor: last ? last.seq : after,
      hasMore,
    };
  }

  /** Close the connection permanently and stop reconnecting. */
  close(): void {
    this.#closing = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        /* ignore */
      }
      this.#ws = null;
    }
    this.#connected = false;
  }

  // ── internals ────────────────────────────────────────────────────────────

  #open(): void {
    let ws: MinimalWebSocket;
    try {
      ws = this.#wsFactory(this.relayUrl);
    } catch (err) {
      this.#log(`[relay] connect failed: ${errMsg(err)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.on('open', () => {
      this.#connected = true;
      this.#reconnectAttempts = 0;
      this.#eose.clear();
      this.#log(`[relay] connected to ${this.relayUrl}`);
      for (const [id, filters] of this.#subscriptions)
        this.#sendReq(id, filters);
    });
    ws.on('message', (data: unknown) => this.#handleMessage(data));
    ws.on('error', (err: unknown) => {
      this.#log(`[relay] socket error: ${errMsg(err)}`);
    });
    ws.on('close', () => {
      this.#connected = false;
      this.#ws = null;
      if (!this.#closing) {
        this.#log('[relay] disconnected; scheduling reconnect');
        this.#scheduleReconnect();
      }
    });
  }

  #scheduleReconnect(): void {
    if (this.#closing || this.#reconnectTimer) return;
    const delay = Math.min(
      this.#reconnectMaxMs,
      this.#reconnectBaseMs * 2 ** this.#reconnectAttempts
    );
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#closing) this.#open();
    }, delay);
    (this.#reconnectTimer as { unref?: () => void }).unref?.();
  }

  #sendReq(subId: string, filters: NostrFilter[]): void {
    this.#sendRaw(['REQ', subId, ...filters]);
  }

  #sendRaw(message: unknown[]): void {
    if (!this.#ws || !this.#connected) return;
    try {
      this.#ws.send(JSON.stringify(message));
    } catch (err) {
      this.#log(`[relay] send failed: ${errMsg(err)}`);
    }
  }

  #handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toText(data));
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    switch (parsed[0]) {
      case 'EVENT': {
        const subId = typeof parsed[1] === 'string' ? parsed[1] : '';
        const raw = parsed[2];
        if (
          raw &&
          typeof raw === 'object' &&
          typeof (raw as NostrEvent).id === 'string'
        ) {
          this.#bufferEvent(subId, raw as NostrEvent);
        }
        break;
      }
      case 'EOSE': {
        const subId = typeof parsed[1] === 'string' ? parsed[1] : '';
        this.#eose.add(subId);
        const waiters = this.#eoseWaiters.get(subId) ?? [];
        this.#eoseWaiters.delete(subId);
        for (const w of waiters) w();
        this.#onEose?.(subId);
        break;
      }
      case 'CLOSED':
        this.#log(
          `[relay] subscription closed by relay: ${String(parsed[2] ?? '')}`
        );
        break;
      case 'NOTICE':
        this.#log(`[relay] NOTICE: ${String(parsed[1] ?? '')}`);
        break;
      default:
        break;
    }
  }

  #bufferEvent(subId: string, event: NostrEvent): void {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    this.#buffer.push({ seq: ++this.#seqCounter, subId, event });
    if (this.#buffer.length > this.#bufferSize) {
      const evicted = this.#buffer.shift();
      if (evicted) this.#seen.delete(evicted.event.id);
    }
    this.#onEvent?.(subId, event);
  }
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWebSocketFactory(): WebSocketFactory {
  return (url: string): MinimalWebSocket => {
    const WebSocketImpl = nodeRequire('ws') as new (
      address: string
    ) => MinimalWebSocket;
    return new WebSocketImpl(url);
  };
}
