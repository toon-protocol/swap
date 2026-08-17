/**
 * swap#152 (ADR 0003's removal gate, toon-meta#411 Stage 0) — the maker's
 * dispatch seam must emit exactly one classified intake event per arrival,
 * so "no legacy traffic observed for N consecutive days" becomes a reading
 * instead of a guess.
 *
 * These drive real packets through the connector-facing packet handler
 * (`setPacketHandler`), the same seam `swap-node.rolling-rfq.test.ts`
 * exercises, and assert on the captured `swap.intake.arrival` log line —
 * never on internal state.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { wrapSwapPacketToToon } from '@toon-protocol/sdk';
import type { UnsignedEvent } from 'nostr-tools';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { ROLLING_PROTOCOL, ROLLING_REJECT_REASONS } from './rolling-engine.js';
import type { LegBResult } from './rolling-engine.js';
import {
  ROLLING_RFQ_REQUEST_KIND,
  ROLLING_RFQ_REJECT_REASONS,
} from './rolling-rfq.js';
import { SWAP_INTAKE_EVENT } from './intake-event.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN = 'evm:8453';
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const SENDER_ILP = 'g.toon.client.sender01';
const STREAM_NONCE = '2a'.repeat(16);
const PAIR_LABEL = `USDC:${CHAIN}→USDC:${CHAIN}`;

interface PacketRequest {
  amount: string;
  destination: string;
  data: string;
  executionCondition?: string;
  expiresAt?: string;
}
interface PacketResponse {
  accept: boolean;
  code?: string;
  message?: string;
  data?: string;
  rejectReason?: { code: string; message: string };
}
type PacketHandlerFn = (
  request: PacketRequest,
  sourcePeer?: string
) => Promise<PacketResponse>;

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

/** Every captured `swap.intake.arrival` record, in arrival order. */
function intakeEvents(logs: LogLine[]): Record<string, unknown>[] {
  return logs
    .filter((l) => l.args[0] === SWAP_INTAKE_EVENT)
    .map((l) => l.args[1] as Record<string, unknown>);
}

async function bootNode(overrides?: Partial<SwapNodeConfig>): Promise<{
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
    logger: capturingLogger(logs),
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        rate: '1.0',
        minAmount: '1000',
        maxAmount: '25000000',
      },
    ],
    chains: ['evm'],
    channels: {
      [CHAIN]: [
        {
          channelId: '0x' + 'cd'.repeat(32),
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [CHAIN]: 1_000_000_000n },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: CHAIN,
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        tokenNetworkAddress: '0x' + '44'.repeat(20),
        channelAddress: '0x' + '33'.repeat(20),
      },
    ],
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    ...overrides,
  });
  if (!captured) throw new Error('setPacketHandler was never called');
  return { instance, handler: captured, logs };
}

function senderKeys(): { secretKey: Uint8Array; pubkey: string } {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

function giftWrappedDataB64(params: {
  kind: number;
  content: string;
  tags?: string[][];
  senderSecretKey: Uint8Array;
  makerPubkey: string;
}): string {
  const rumor = {
    kind: params.kind,
    content: params.content,
    tags: params.tags ?? [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: '',
  } as unknown as UnsignedEvent;
  const { ilpPrepare } = wrapSwapPacketToToon({
    rumor,
    senderSecretKey: params.senderSecretKey,
    recipientPubkey: params.makerPubkey,
    destination: 'g.toon.swap.x',
    amount: 1000n,
  });
  return ilpPrepare.data;
}

function legacySwapDataB64(
  senderSecretKey: Uint8Array,
  makerPubkey: string
): string {
  return giftWrappedDataB64({
    kind: 20032,
    content: '',
    tags: [
      ['swap-from', `USDC:${CHAIN}`],
      ['swap-to', `USDC:${CHAIN}`],
      ['chain-recipient', CHAIN_RECIPIENT],
    ],
    senderSecretKey,
    makerPubkey,
  });
}

function rfqDataB64(senderSecretKey: Uint8Array, makerPubkey: string): string {
  return giftWrappedDataB64({
    kind: ROLLING_RFQ_REQUEST_KIND,
    content: JSON.stringify({
      proto: ROLLING_PROTOCOL,
      type: 'rfq',
      streamNonce: STREAM_NONCE,
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
      },
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
    }),
    senderSecretKey,
    makerPubkey,
  });
}

function fillDataB64(seq = 1, streamNonce = STREAM_NONCE): string {
  return Buffer.from(
    JSON.stringify({ proto: ROLLING_PROTOCOL, type: 'fill', streamNonce, seq }),
    'utf8'
  ).toString('base64');
}

function mint(): { preimage: Uint8Array; conditionB64: string } {
  const preimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimage);
  return {
    preimage,
    conditionB64: Buffer.from(sha256(preimage)).toString('base64'),
  };
}

describe('swap#152 — intake classification (ADR 0003 removal gate)', () => {
  it('a legacy (kind:20032) gift wrap emits class "refused" (swap#154 — the maker no longer accepts it)', async () => {
    const sender = senderKeys();
    const { instance, handler, logs } = await bootNode();
    try {
      const res = await handler(
        {
          amount: '1000',
          destination: 'g.toon.swap.x',
          data: legacySwapDataB64(sender.secretKey, instance.identity.pubkey),
        },
        'peer-legacy-01'
      );
      expect(res.accept).toBe(false);

      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        class: 'refused',
        sender: 'peer-legacy-01',
        reason: ROLLING_RFQ_REJECT_REASONS.LEGACY_PROTOCOL_REFUSED,
        pair: PAIR_LABEL,
      });
    } finally {
      await instance.stop();
    }
  });

  it('a kind:20033 gift wrap emits class "rolling-rfq" with the requested pair', async () => {
    const sender = senderKeys();
    const { instance, handler, logs } = await bootNode();
    try {
      const res = await handler(
        {
          amount: '1000',
          destination: 'g.toon.swap.x',
          data: rfqDataB64(sender.secretKey, instance.identity.pubkey),
        },
        'peer-rfq-01'
      );
      expect(res.accept).toBe(true);

      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        class: 'rolling-rfq',
        sender: 'peer-rfq-01',
        pair: PAIR_LABEL,
      });
    } finally {
      await instance.stop();
    }
  });

  it('a kind:20032 arrival and a kind:20033 arrival that differ ONLY by inner rumor kind classify differently', async () => {
    const sender = senderKeys();
    const { instance, handler, logs } = await bootNode();
    try {
      const sharedTags = [
        ['swap-from', `USDC:${CHAIN}`],
        ['swap-to', `USDC:${CHAIN}`],
        ['chain-recipient', CHAIN_RECIPIENT],
      ];
      const sharedContent = '';

      await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: 20032,
          content: sharedContent,
          tags: sharedTags,
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: sharedContent,
          tags: sharedTags,
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });

      const events = intakeEvents(logs);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        class: 'refused',
        reason: ROLLING_RFQ_REJECT_REASONS.LEGACY_PROTOCOL_REFUSED,
      });
      expect(events[1]?.['class']).toBe('rolling-rfq');
    } finally {
      await instance.stop();
    }
  });

  it('a coupled rolling fill emits class "rolling-fill" with the session pair', async () => {
    const sender = senderKeys();
    const { preimage, conditionB64 } = mint();
    const { instance, handler, logs } = await bootNode({
      rollingLegBSender: async (): Promise<LegBResult> => ({
        type: 'fulfill',
        fulfillment: preimage,
      }),
    });
    try {
      const rfqRes = await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: rfqDataB64(sender.secretKey, instance.identity.pubkey),
      });
      expect(rfqRes.accept).toBe(true);
      // Drop the RFQ's own intake event so the assertions below see only the
      // fill's.
      logs.length = 0;

      const fillRes = await handler(
        {
          amount: '250000',
          destination: 'g.toon.swap.x',
          data: fillDataB64(1),
          executionCondition: conditionB64,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        'peer-fill-01'
      );
      expect(fillRes.accept).toBe(true);

      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        class: 'rolling-fill',
        sender: 'peer-fill-01',
        pair: PAIR_LABEL,
      });
    } finally {
      await instance.stop();
    }
  });

  it('a malformed rolling fill emits class "refused" carrying the reject reason', async () => {
    const { instance, handler, logs } = await bootNode();
    try {
      const malformed = Buffer.from(
        JSON.stringify({
          proto: ROLLING_PROTOCOL,
          type: 'fill',
          streamNonce: 'nope',
        }),
        'utf8'
      ).toString('base64');
      const res = await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: malformed,
      });
      expect(res.accept).toBe(false);

      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        class: 'refused',
        reason: ROLLING_REJECT_REASONS.MALFORMED_FILL,
      });
    } finally {
      await instance.stop();
    }
  });

  it('a rolling fill with no sender-chosen condition emits class "refused" (condition_required)', async () => {
    const { instance, handler, logs } = await bootNode();
    try {
      const res = await handler({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
      });
      expect(res.accept).toBe(false);

      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        class: 'refused',
        reason: ROLLING_REJECT_REASONS.CONDITION_REQUIRED,
      });
    } finally {
      await instance.stop();
    }
  });

  it('a sender-chosen condition on a non-fill payload emits class "refused" (malformed_fill)', async () => {
    const { conditionB64 } = mint();
    const { instance, handler, logs } = await bootNode();
    try {
      const res = await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: Buffer.from('not a rolling fill', 'utf8').toString('base64'),
        executionCondition: conditionB64,
      });
      expect(res.accept).toBe(false);

      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        class: 'refused',
        reason: ROLLING_REJECT_REASONS.MALFORMED_FILL,
      });
    } finally {
      await instance.stop();
    }
  });

  it('does not log the sealed gift-wrap payload contents', async () => {
    const sender = senderKeys();
    const { instance, handler, logs } = await bootNode();
    try {
      await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, instance.identity.pubkey),
      });
      const events = intakeEvents(logs);
      expect(events).toHaveLength(1);
      const keys = Object.keys(events[0] ?? {});
      expect(keys.sort()).toEqual(['class', 'pair', 'reason', 'sender']);
    } finally {
      await instance.stop();
    }
  });
});
