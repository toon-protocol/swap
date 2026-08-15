/**
 * swap#104 — minimal in-process Nostr relay for the self-contained E2E harness.
 *
 * The Docker cross-chain E2E suites have depended on a real relay since
 * Story 12.10 (kind:10032 peer-info discovery, AC-4), but the compose-based
 * relay service was never carried across the monorepo extraction (swap#51).
 * Rather than restoring cross-repo/Docker infra for a plain vanilla Nostr
 * relay, this implements just enough of NIP-01 in-process: `EVENT` (store +
 * OK), `REQ` (replay matching stored events, then `EOSE`, then keep the
 * subscription live for future matches), `CLOSE`. Filter matching supports
 * `kinds` and `authors` — the only fields the E2E suites' subscriptions use.
 *
 * `startSwapNode()`'s default relay publisher is a vanilla
 * `SimplePool`-backed Nostr WS publish (see `swap-node.ts`'s `relayUrls`
 * doc) — a plain NIP-01 relay like this one is exactly what it expects
 * (the pay-to-write TOON relay is a separate, unpaid-write-rejecting
 * concern this harness does not need).
 */

import { WebSocketServer, type WebSocket } from 'ws';

interface StoredEvent {
  id: string;
  kind: number;
  pubkey: string;
  [key: string]: unknown;
}

interface Filter {
  kinds?: number[];
  authors?: string[];
  [key: string]: unknown;
}

function matches(event: StoredEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  return true;
}

export interface LocalRelay {
  url: string;
  stop: () => Promise<void>;
}

export async function startLocalRelay(port: number): Promise<LocalRelay> {
  const events: StoredEvent[] = [];
  const subscriptions = new Map<WebSocket, Map<string, Filter[]>>();

  const wss = new WebSocketServer({ port });

  wss.on('connection', (socket: WebSocket) => {
    subscriptions.set(socket, new Map());

    socket.on('message', (raw: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg.length === 0) return;

      const [type] = msg as [string, ...unknown[]];

      if (type === 'EVENT') {
        const event = msg[1] as StoredEvent;
        events.push(event);
        socket.send(JSON.stringify(['OK', event.id, true, '']));

        // Push to every subscriber whose filters match, live.
        for (const [sub, subFilters] of subscriptions) {
          if (sub.readyState !== sub.OPEN) continue;
          for (const [subId, filters] of subFilters) {
            if (filters.some((f) => matches(event, f))) {
              sub.send(JSON.stringify(['EVENT', subId, event]));
              break;
            }
          }
        }
        return;
      }

      if (type === 'REQ') {
        const subId = msg[1] as string;
        const filters = msg.slice(2) as Filter[];
        const subFilters = subscriptions.get(socket) ?? new Map();
        subFilters.set(subId, filters);
        subscriptions.set(socket, subFilters);

        for (const event of events) {
          if (filters.some((f) => matches(event, f))) {
            socket.send(JSON.stringify(['EVENT', subId, event]));
          }
        }
        socket.send(JSON.stringify(['EOSE', subId]));
        return;
      }

      if (type === 'CLOSE') {
        const subId = msg[1] as string;
        subscriptions.get(socket)?.delete(subId);
        return;
      }
    });

    socket.on('close', () => {
      subscriptions.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
