/**
 * An in-memory relay for unit tests: stores every published event, fans
 * matching events out to subscribers, answers EOSE, and lets a test inject
 * write refusals. Both `RelayReader` and `RelayWriter` are served from one
 * instance so a maker and a taker in the same process talk through it.
 */
import type { NostrEvent } from 'nostr-tools/pure';

import type { NostrFilter } from './relay-subscription.js';
import type { RelayWriteResult, RelayWriter } from './relay-writer.js';
import type { RelayReader } from './swap-maker.js';

export interface MemoryRelaySubscriber {
  filters: NostrFilter[];
  onEvent: (subId: string, event: NostrEvent) => void;
  onEose?: (subId: string) => void;
}

function matches(filter: NostrFilter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  for (const [k, v] of Object.entries(filter)) {
    if (!k.startsWith('#') || !Array.isArray(v)) continue;
    const tag = k.slice(1);
    if (!event.tags.some((t) => t[0] === tag && v.includes(t[1] ?? '')))
      return false;
  }
  return true;
}

export class MemoryRelay {
  readonly events: NostrEvent[] = [];
  readonly published: NostrEvent[] = [];
  /** Set to make the next N publishes fail with a path refusal. */
  refuseNext = 0;
  /** Keyed per reader — a sub id is scoped to its connection, as on a real relay. */
  readonly #subs = new Map<
    string,
    { reader: symbol; id: string; sub: MemoryRelaySubscriber }
  >();
  #subCounter = 0;
  readonly #readerIds = new Map<symbol, number>();
  #readerCounter = 0;

  #readerSeq(reader: symbol): number {
    let n = this.#readerIds.get(reader);
    if (n === undefined) {
      n = ++this.#readerCounter;
      this.#readerIds.set(reader, n);
    }
    return n;
  }

  /** Store and broadcast (addressable kinds replace by (pubkey, kind, d)). */
  store(event: NostrEvent): void {
    if (event.kind >= 30000 && event.kind < 40000) {
      const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
      const i = this.events.findIndex(
        (e) =>
          e.kind === event.kind &&
          e.pubkey === event.pubkey &&
          (e.tags.find((t) => t[0] === 'd')?.[1] ?? '') === d
      );
      if (i >= 0) this.events.splice(i, 1);
    }
    if (event.kind < 20000 || event.kind >= 30000) this.events.push(event);
    for (const { id, sub } of this.#subs.values()) {
      if (sub.filters.some((f) => matches(f, event))) sub.onEvent(id, event);
    }
  }

  writer(): RelayWriter {
    return {
      destination: 'g.toon.relay',
      publish: async (event): Promise<RelayWriteResult> => {
        if (this.refuseNext > 0) {
          this.refuseNext -= 1;
          return {
            ok: false,
            eventId: event.id,
            refusedBy: 'path',
            code: 'T04',
            message: 'refused by test',
            retry: true,
          };
        }
        this.published.push(event);
        this.store(event);
        return { ok: true, eventId: event.id, status: 200 };
      },
    };
  }

  /** A reader whose subscriptions replay stored history, then EOSE, then live events. */
  reader(
    onEvent: (subId: string, event: NostrEvent) => void,
    onEose?: (subId: string) => void
  ): RelayReader & { close(): void } {
    const me = Symbol('reader');
    const eose = new Set<string>();
    let started = false;
    const pending: { id: string; filters: NostrFilter[] }[] = [];
    const replay = (id: string, filters: NostrFilter[]): void => {
      for (const e of [...this.events]) {
        if (filters.some((f) => matches(f, e))) onEvent(id, e);
      }
      eose.add(id);
      onEose?.(id);
    };
    return {
      start: () => {
        started = true;
        for (const p of pending.splice(0)) replay(p.id, p.filters);
      },
      close: () => {
        for (const [key, s] of [...this.#subs])
          if (s.reader === me) this.#subs.delete(key);
      },
      subscribe: (filters, subId) => {
        const id = subId ?? `mem-${++this.#subCounter}`;
        const list = Array.isArray(filters) ? filters : [filters];
        this.#subs.set(
          `${String(me.description)}:${this.#readerSeq(me)}:${id}`,
          {
            reader: me,
            id,
            sub: { filters: list, onEvent, ...(onEose && { onEose }) },
          }
        );
        if (started) replay(id, list);
        else pending.push({ id, filters: list });
        return id;
      },
      isConnected: () => started,
      hasReachedEose: (subId) => eose.has(subId),
    };
  }
}
