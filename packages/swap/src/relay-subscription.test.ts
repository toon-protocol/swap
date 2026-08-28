import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelaySubscription } from './relay-subscription.js';
import type { MinimalWebSocket } from './relay-subscription.js';

type Handler = (...args: unknown[]) => void;

class FakeSocket implements MinimalWebSocket {
  readonly sent: string[] = [];
  readonly handlers = new Map<string, Handler[]>();
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  on(event: string, cb: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  frame(msg: unknown[]): void {
    this.emit('message', JSON.stringify(msg));
  }
}

function event(id: string, kind = 1059) {
  return {
    id,
    kind,
    pubkey: 'p',
    created_at: 1,
    tags: [],
    content: '',
    sig: 's',
  };
}

describe('RelaySubscription', () => {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends REQs on open, buffers events once, reports EOSE', async () => {
    const eose: string[] = [];
    const sub = new RelaySubscription({
      relayUrl: 'ws://relay',
      wsFactory: factory,
      onEose: (id) => eose.push(id),
    });
    const id = sub.subscribe({ kinds: [1059], '#p': ['me'] }, 'inbox');
    sub.start();
    const s = sockets[0]!;
    expect(s.sent).toEqual([]); // nothing before open
    s.emit('open');
    expect(JSON.parse(s.sent[0]!)).toEqual([
      'REQ',
      'inbox',
      { kinds: [1059], '#p': ['me'] },
    ]);

    const wait = sub.waitForEose(id, 1000);
    s.frame(['EVENT', 'inbox', event('a')]);
    s.frame(['EVENT', 'inbox', event('a')]); // duplicate
    s.frame(['EVENT', 'inbox', event('b')]);
    s.frame(['EOSE', 'inbox']);
    await wait;
    expect(eose).toEqual(['inbox']);
    expect(sub.hasReachedEose('inbox')).toBe(true);

    const first = sub.getEvents({ subId: 'inbox', limit: 1 });
    expect(first.events.map((e) => e.id)).toEqual(['a']);
    expect(first.hasMore).toBe(true);
    const rest = sub.getEvents({ subId: 'inbox', cursor: first.cursor });
    expect(rest.events.map((e) => e.id)).toEqual(['b']);
    expect(rest.hasMore).toBe(false);
    expect(sub.bufferedCount()).toBe(2);
  });

  it('waitForEose rejects on timeout and resolves immediately once seen', async () => {
    const sub = new RelaySubscription({
      relayUrl: 'ws://relay',
      wsFactory: factory,
    });
    sub.subscribe({ kinds: [30032] }, 'orders');
    sub.start();
    const s = sockets[0]!;
    s.emit('open');
    const p = sub.waitForEose('orders', 50);
    vi.advanceTimersByTime(60);
    await expect(p).rejects.toThrow(/no EOSE/);
    s.frame(['EOSE', 'orders']);
    await expect(sub.waitForEose('orders', 50)).resolves.toBeUndefined();
  });

  it('reconnects with backoff and re-issues every REQ; EOSE state resets', async () => {
    const sub = new RelaySubscription({
      relayUrl: 'ws://relay',
      wsFactory: factory,
      reconnectBaseMs: 10,
    });
    sub.subscribe({ kinds: [1059] }, 'inbox');
    sub.start();
    sockets[0]!.emit('open');
    sockets[0]!.frame(['EOSE', 'inbox']);
    expect(sub.hasReachedEose('inbox')).toBe(true);

    sockets[0]!.emit('close');
    expect(sub.isConnected()).toBe(false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit('open');
    expect(sub.isConnected()).toBe(true);
    expect(sub.hasReachedEose('inbox')).toBe(false);
    expect(JSON.parse(sockets[1]!.sent[0]!)[1]).toBe('inbox');

    sub.close();
    expect(sockets[1]!.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2); // no reconnect after close()
  });

  it('evicts the oldest event past bufferSize and forgets its id', () => {
    const sub = new RelaySubscription({
      relayUrl: 'ws://relay',
      wsFactory: factory,
      bufferSize: 2,
    });
    sub.subscribe({ kinds: [1] }, 's');
    sub.start();
    const s = sockets[0]!;
    s.emit('open');
    for (const id of ['a', 'b', 'c']) s.frame(['EVENT', 's', event(id)]);
    expect(sub.getEvents().events.map((e) => e.id)).toEqual(['b', 'c']);
    s.frame(['EVENT', 's', event('a')]); // re-admitted after eviction
    expect(sub.getEvents().events.map((e) => e.id)).toEqual(['c', 'a']);
  });
});
