import { describe, expect, it } from 'vitest';
import type { SendRequest, SendResult } from '@toon-protocol/client';

import { createRelayWriter } from './relay-writer.js';

const EVENT = {
  id: 'e1',
  kind: 1059,
  pubkey: 'p',
  created_at: 1,
  tags: [],
  content: '',
  sig: 's',
};

function fulfilled(status: number, body: unknown): SendResult {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    fulfilled: true,
    transport: 'http',
    status,
    headers: [],
    body: bytes,
    text: () => JSON.stringify(body),
    json: <T>() => body as T,
    fulfillment: new Uint8Array(32),
  } as unknown as SendResult;
}

describe('createRelayWriter', () => {
  it('POSTs {event} to the relay route and reports the relay status', async () => {
    const calls: { destination: string; request?: SendRequest }[] = [];
    const writer = createRelayWriter({
      destination: 'g.toon.relay',
      sender: {
        async send(destination, request) {
          calls.push({ destination, request });
          return fulfilled(200, { ok: true, eventId: 'e1' });
        },
      },
    });
    const r = await writer.publish(EVENT);
    expect(r).toEqual({
      ok: true,
      eventId: 'e1',
      status: 200,
      body: { ok: true, eventId: 'e1' },
    });
    expect(calls[0]?.destination).toBe('g.toon.relay');
    expect(calls[0]?.request?.method).toBe('POST');
    expect(calls[0]?.request?.body).toEqual({ event: EVENT });
  });

  it('turns a non-2xx relay answer into a relay refusal', async () => {
    const writer = createRelayWriter({
      destination: 'g.toon.relay',
      sender: {
        send: async () => fulfilled(422, { error: 'Invalid event signature' }),
      },
    });
    const r = await writer.publish(EVENT);
    expect(r).toEqual({
      ok: false,
      eventId: 'e1',
      refusedBy: 'relay',
      code: '422',
      message: 'Invalid event signature',
      retry: false,
    });
  });

  it('turns a path refusal into a path refusal, retryable for T-codes', async () => {
    const refused = {
      fulfilled: false,
      transport: 'http',
      refusedBy: 'path',
      code: 'T04',
      message: 'insufficient liquidity',
    } as unknown as SendResult;
    const writer = createRelayWriter({
      destination: 'g.toon.relay',
      sender: { send: async () => refused },
    });
    const r = await writer.publish(EVENT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusedBy).toBe('path');
    expect(r.code).toBe('T04');
    expect(r.retry).toBe(true);
  });

  it('never throws: a sender exception is a retryable path refusal', async () => {
    const writer = createRelayWriter({
      destination: 'g.toon.relay',
      sender: {
        send: async () => {
          throw new Error('socket hung up');
        },
      },
    });
    const r = await writer.publish(EVENT);
    expect(r).toMatchObject({
      ok: false,
      refusedBy: 'path',
      code: 'EXCEPTION',
      retry: true,
    });
  });
});
