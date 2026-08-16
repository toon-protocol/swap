/**
 * swap#136 defect 1 — the rejection that logged absolutely nothing.
 *
 * Live repro (devnet, 2026-08-16): after ONE successful swap the maker
 * refused every subsequent swap with `{"code":"T00","message":"Internal
 * error"}` and wrote not a single line to `docker logs`. The real cause was
 * mundane — `channel-state.ts`'s `reserve()` refuses to issue a claim against
 * a channel whose previous claim is still unredeemed, and says so
 * (`0x0124a370…: 1000 unredeemed`) — but the message died in the SDK swap
 * handler's `catch`, which logs `swap_handler.issuer_failed` into a no-op
 * logger and returns `ctx.reject('T00', 'Internal error')`.
 *
 * These tests therefore assert on the OBSERVABLE surface only — what an
 * operator reads in the logs and what a client reads off the wire — driving
 * real gift-wrapped packets through the connector-facing packet handler
 * (`setPacketHandler`), which is exactly what the connector calls in
 * production. A test that only asserted the internal throw would have passed
 * throughout the outage; `swap-node.channel-rebind.test.ts` had one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

import { wrapSwapPacketToToon } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { CLAIM_REFUSAL_REASONS } from './claim-refusal.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN = 'evm:8453';
const CHANNEL_ID = '0x' + '01'.repeat(32);
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const DESTINATION = 'g.toon.swap.fixture';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

interface PacketRequest {
  amount: string;
  destination: string;
  data: string;
  executionCondition?: string;
}
interface PacketResponse {
  accept: boolean;
  code?: string;
  message?: string;
  data?: string;
  rejectReason?: { code: string; message: string };
}
type PacketHandlerFn = (request: PacketRequest) => Promise<PacketResponse>;

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

function capturingLogger(sink: LogLine[]): SwapNodeConfig['logger'] {
  const at =
    (level: LogLine['level']) =>
    (...args: unknown[]): void => {
      sink.push({ level, args });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

/** Flatten a captured log line to one searchable string. */
function renderLine(line: LogLine): string {
  return line.args
    .map((a) =>
      typeof a === 'string'
        ? a
        : JSON.stringify(a, (_k, v: unknown) =>
            typeof v === 'bigint' ? v.toString() : v
          )
    )
    .join(' ');
}

function word(hex: string): string {
  return hex.toLowerCase().padStart(64, '0');
}

/** `eth_call`-only JSON-RPC whose `channels()` answer is `cumulativePaid`. */
async function startFakeChainRpc(cumulativePaid: bigint): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number };
      const result =
        '0x' +
        [
          word('11'.repeat(20)),
          word('22'.repeat(20)),
          word(3n.toString(16)),
          word(cumulativePaid.toString(16)),
          word(1_000_000n.toString(16)),
          word(0n.toString(16)),
          word((1).toString(16)),
        ].join('');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function bootNode(rpcUrl: string): Promise<{
  instance: SwapNodeInstance;
  handler: PacketHandlerFn;
  logs: LogLine[];
}> {
  const logs: LogLine[] = [];
  let captured: PacketHandlerFn | undefined;
  const connector = {
    sendPacket: async () => ({
      type: 'reject' as const,
      code: 'F02',
      message: 'no route (fixture)',
    }),
    registerPeer: async () => undefined,
    removePeer: async () => undefined,
    setPacketHandler: (h: unknown) => {
      captured = h as PacketHandlerFn;
    },
    close: async () => undefined,
  } as unknown as SwapNodeConfig['connector'];

  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector,
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    chains: ['evm'],
    logger: capturingLogger(logs),
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        rate: '1.0',
      },
    ],
    // ONE channel — the single-channel deployment the live maker runs.
    channels: {
      [CHAIN]: [
        {
          channelId: CHANNEL_ID,
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [CHAIN]: 15_000_000n },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: CHAIN,
        rpcUrl,
        registryAddress: '0x' + '33'.repeat(20),
        tokenAddress: '0x' + '44'.repeat(20),
        tokenNetworkAddress: '0x' + '55'.repeat(20),
        channelAddress: '0x' + 'aa'.repeat(20),
      },
    ],
  });
  if (!captured) throw new Error('setPacketHandler was never called');
  return { instance, handler: captured, logs };
}

/** A real NIP-59 gift-wrapped swap request from a fresh ephemeral sender. */
function swapPacket(
  recipientPubkey: string,
  senderByte: number,
  amount: bigint
): PacketRequest {
  const { ilpPrepare } = wrapSwapPacketToToon({
    rumor: {
      pubkey: '',
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      content: '',
      tags: [
        ['swap-from', `USDC:${CHAIN}`],
        ['swap-to', `USDC:${CHAIN}`],
        ['chain-recipient', CHAIN_RECIPIENT],
      ],
    },
    senderSecretKey: new Uint8Array(32).fill(senderByte),
    recipientPubkey,
    destination: DESTINATION,
    amount,
  });
  return {
    amount: ilpPrepare.amount,
    destination: ilpPrepare.destination,
    data: ilpPrepare.data,
  };
}

describe('swap#136 — an unredeemed channel produces a LOGGED, actionable refusal', () => {
  it('[P0] the live repro: swap #1 fulfils; swap #2 from a fresh sender is refused loudly', async () => {
    // cumulativePaid = 0 on-chain → sender #1's claim is unredeemed, so the
    // single provisioned channel cannot be rebound to sender #2.
    const rpcUrl = await startFakeChainRpc(0n);
    const { instance, handler, logs } = await bootNode(rpcUrl);
    try {
      const recipient = instance.identity.pubkey;

      const first = await handler(swapPacket(recipient, 1, 1_000n));
      expect(first.accept).toBe(true);

      const inventoryBefore = { ...instance.health().inventory };
      const availableBefore = { ...instance.health().inventoryAvailable };
      logs.length = 0;

      const second = await handler(swapPacket(recipient, 2, 1_000n));

      // ---- (a) the maker LOGS the real reason ---------------------------
      const refusalLogs = logs.filter(
        (l) => l.level === 'warn' || l.level === 'error'
      );
      expect(refusalLogs.length).toBeGreaterThan(0);
      const rendered = refusalLogs.map(renderLine).join('\n');
      // names the channel …
      expect(rendered).toContain(CHANNEL_ID);
      // … and the unredeemed amount …
      expect(rendered).toContain('1000');
      // … under a greppable reason.
      expect(rendered).toContain(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED);

      // ---- (b) the CLIENT gets something it can act on ------------------
      expect(second.accept).toBe(false);
      expect(second.code).not.toBe('T00');
      expect(second.code).toBe('T04');
      expect(second.message).not.toBe('Internal error');
      expect(second.message).toContain(
        CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED
      );
      expect(second.message).toContain(CHANNEL_ID);
      expect(second.message?.toLowerCase()).toContain('redeem');
      // Semantic reason survives the connector's REJECT_CODE_MAP as T04.
      expect(second.rejectReason?.code).toBe('insufficient_funds');
      // Machine-readable discriminator in the ILP reject `data`.
      const data = JSON.parse(
        Buffer.from(second.data ?? '', 'base64').toString('utf8')
      ) as Record<string, unknown>;
      expect(data['reason']).toBe(CLAIM_REFUSAL_REASONS.CHANNEL_UNREDEEMED);
      expect(data['channelId']).toBe(CHANNEL_ID);
      expect(data['unredeemed']).toBe('1000');
      expect(data['chain']).toBe(CHAIN);

      // ---- (c) defect 2: the failed swap moved no inventory -------------
      expect(instance.health().inventory).toEqual(inventoryBefore);
      expect(instance.health().inventoryAvailable).toEqual(availableBefore);
    } finally {
      await instance.stop();
    }
  }, 20_000);

  it('[P0] once the first claim IS redeemed on-chain, the next sender swaps normally', async () => {
    // Same topology, but the chain reports the claim settled → rebind is safe.
    const rpcUrl = await startFakeChainRpc(1_000n);
    const { instance, handler } = await bootNode(rpcUrl);
    try {
      const recipient = instance.identity.pubkey;
      expect((await handler(swapPacket(recipient, 1, 1_000n))).accept).toBe(
        true
      );
      expect((await handler(swapPacket(recipient, 2, 1_000n))).accept).toBe(
        true
      );
    } finally {
      await instance.stop();
    }
  }, 20_000);
});
