/**
 * Rolling RFQ intake — WIRE-LEVEL reachability tests.
 *
 * These deliberately exercise the same seam as `swap-node.rolling-dispatch.test.ts`:
 * boot a real `startSwapNode()` against a fake connector, capture the
 * `setPacketHandler` callback, and drive it with real packets. Nothing here
 * calls `registerRollingSession` — that is the whole point. A unit test of
 * `registerRollingSession` proves nothing about reachability, because the
 * defect was that no wire path ever reached it.
 *
 * The headline test is `rfq → fill`: a gift-wrapped kind:20033 followed by a
 * rolling fill for the SAME `streamNonce`, asserting the fill is not
 * F06 `unknown_session`. That sequence is exactly what a stock client does and
 * exactly what failed before this module existed.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { wrapSwapPacketToToon, unwrapSwapPacket } from '@toon-protocol/sdk';
import type { UnsignedEvent } from 'nostr-tools';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { ROLLING_PROTOCOL, ROLLING_REJECT_REASONS } from './rolling-engine.js';
import type { LegBPrepare, LegBResult } from './rolling-engine.js';
import {
  ROLLING_RFQ_REQUEST_KIND,
  ROLLING_RFQ_RESPONSE_KIND,
  ROLLING_RFQ_REJECT_REASONS,
  type RollingRfqRequest,
  type RollingRfqResponse,
} from './rolling-rfq.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const CHAIN = 'evm:8453';
const STREAM_NONCE = '1f'.repeat(16);
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const SENDER_ILP = 'g.toon.client.sender01';

type PacketHandlerFn = (request: {
  amount: string;
  destination: string;
  data: string;
  executionCondition?: string;
  expiresAt?: string;
}) => Promise<{
  accept: boolean;
  code?: string;
  message?: string;
  data?: string;
  fulfillment?: string;
  rejectReason?: { code: string; message: string };
}>;

function capturingConnector(): {
  connector: SwapNodeConfig['connector'];
  handler: () => PacketHandlerFn;
} {
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
  };
  return {
    connector: connector as unknown as SwapNodeConfig['connector'],
    handler: () => {
      if (!captured) throw new Error('setPacketHandler was never called');
      return captured;
    },
  };
}

async function bootNode(overrides?: Partial<SwapNodeConfig>): Promise<{
  instance: SwapNodeInstance;
  handler: () => PacketHandlerFn;
}> {
  const { connector, handler } = capturingConnector();
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector,
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
  return { instance, handler };
}

/** A throwaway sender identity — the client side of the RFQ. */
function senderKeys(): { secretKey: Uint8Array; pubkey: string } {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

/**
 * Build the base64 PREPARE `data` of a real NIP-59 gift wrap carrying an
 * arbitrary inner rumor — the exact envelope spec §2.2 puts an RFQ in.
 */
function giftWrappedDataB64(params: {
  kind: number;
  content: string;
  senderSecretKey: Uint8Array;
  makerPubkey: string;
}): string {
  const rumor = {
    kind: params.kind,
    content: params.content,
    tags: [],
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
  // `wrapSwapPacketToToon` already base64s the TOON bytes into `data` — the
  // exact string the connector hands the packet handler.
  return ilpPrepare.data;
}

function rfqRequest(overrides?: Partial<RollingRfqRequest>): string {
  return JSON.stringify({
    proto: ROLLING_PROTOCOL,
    type: 'rfq',
    streamNonce: STREAM_NONCE,
    pair: {
      from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
      to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
    },
    chainRecipient: CHAIN_RECIPIENT,
    senderIlpAddress: SENDER_ILP,
    ...overrides,
  });
}

/** Unwrap the kind:20034 quote out of an accepted RFQ's FULFILL `data`. */
function decodeQuote(
  dataB64: string | undefined,
  senderSecretKey: Uint8Array
): { kind: number; quote: RollingRfqResponse } {
  if (!dataB64) throw new Error('RFQ accept carried no data');
  const giftWrap = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8'));
  const { rumor } = unwrapSwapPacket({
    giftWrap,
    recipientSecretKey: senderSecretKey,
  });
  return {
    kind: rumor.kind,
    quote: JSON.parse(rumor.content) as RollingRfqResponse,
  };
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

function decodeReason(dataB64?: string): unknown {
  return dataB64
    ? (
        JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8')) as Record<
          string,
          unknown
        >
      )['reason']
    : undefined;
}

describe('rolling RFQ intake — wire reachability', () => {
  it('a gift-wrapped kind:20033 on the packet handler is answered with a kind:20034 quote', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequest(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });

      expect(res.accept).toBe(true);
      const { kind, quote } = decodeQuote(res.data, sender.secretKey);
      expect(kind).toBe(ROLLING_RFQ_RESPONSE_KIND);
      expect(quote.proto).toBe(ROLLING_PROTOCOL);
      expect(quote.type).toBe('quote');
      expect(quote.streamNonce).toBe(STREAM_NONCE);
      expect(quote.rate).toBe('1.0');
      expect(quote.minAmount).toBe('1000');
      expect(quote.maxAmount).toBe('25000000');
      expect(quote.expiresAt).toBeGreaterThan(Date.now());
      // The maker's leg-B signer, so the sender can arm R5 verification.
      expect(quote.swapSignerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    } finally {
      await instance.stop();
    }
  });

  it('REACHABILITY: rfq then fill — the session comes from the wire, never registerRollingSession', async () => {
    const sender = senderKeys();
    const { preimage, conditionB64 } = mint();
    const legBCalls: LegBPrepare[] = [];

    const { instance, handler } = await bootNode({
      rollingLegBSender: async (prepare): Promise<LegBResult> => {
        legBCalls.push(prepare);
        // Compliant sender daemon: reveal the preimage for this condition.
        return { type: 'fulfill', fulfillment: preimage };
      },
    });
    try {
      // Step 1 — RFQ over the wire. No in-process registration anywhere.
      const rfqRes = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequest(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(rfqRes.accept).toBe(true);

      // Step 2 — a fill for the session the RFQ just minted.
      const fillRes = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
        executionCondition: conditionB64,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });

      // The defect this fixes: without wire intake this is F06 unknown_session.
      expect(decodeReason(fillRes.data)).not.toBe(
        ROLLING_REJECT_REASONS.UNKNOWN_SESSION
      );
      expect(fillRes.accept).toBe(true);
      // The session's routing data came off the RFQ, not a test fixture.
      expect(legBCalls).toHaveLength(1);
      expect(legBCalls[0]?.destination).toBe(SENDER_ILP);
    } finally {
      await instance.stop();
    }
  });

  it('without the RFQ, the same fill is still F06 unknown_session (the pre-fix behaviour)', async () => {
    const { conditionB64 } = mint();
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
        executionCondition: conditionB64,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F06');
      expect(decodeReason(res.data)).toBe(
        ROLLING_REJECT_REASONS.UNKNOWN_SESSION
      );
    } finally {
      await instance.stop();
    }
  });

  it('an unadvertised pair is refused and mints no session', async () => {
    const sender = senderKeys();
    const { conditionB64 } = mint();
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequest({
            pair: {
              from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
              to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
            },
          }),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F06');
      expect(decodeReason(res.data)).toBe(
        ROLLING_RFQ_REJECT_REASONS.UNSUPPORTED_PAIR
      );

      // and no session was minted for that nonce
      const fill = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
        executionCondition: conditionB64,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(decodeReason(fill.data)).toBe(
        ROLLING_REJECT_REASONS.UNKNOWN_SESSION
      );
    } finally {
      await instance.stop();
    }
  });

  it('a kind:20033 with a malformed body is rejected F01, not handed to the legacy handler', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          // valid proto tag, but streamNonce is not 32 lowercase hex
          content: rfqRequest({ streamNonce: 'nope' }),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F01');
      expect(decodeReason(res.data)).toBe(
        ROLLING_RFQ_REJECT_REASONS.MALFORMED_RFQ
      );
    } finally {
      await instance.stop();
    }
  });

  it('a short quote TTL does NOT cap the session — every fill is repriced anyway', async () => {
    const sender = senderKeys();
    const { preimage, conditionB64 } = mint();
    const { instance, handler } = await bootNode({
      rolling: { rfq: { quoteTtlMs: 1 } },
      rollingLegBSender: async (): Promise<LegBResult> => ({
        type: 'fulfill',
        fulfillment: preimage,
      }),
    });
    try {
      const rfqRes = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequest(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(rfqRes.accept).toBe(true);
      const { quote } = decodeQuote(rfqRes.data, sender.secretKey);
      expect(quote.expiresAt).toBeLessThanOrEqual(Date.now() + 1);

      // Quote is stale, session is not: the stream keeps working.
      await new Promise((r) => setTimeout(r, 5));
      const fill = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
        executionCondition: conditionB64,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(fill.accept).toBe(true);
    } finally {
      await instance.stop();
    }
  });

  it('the session honours rolling.sessionTtlMs — a fill after it F06s again', async () => {
    const sender = senderKeys();
    const { conditionB64 } = mint();
    const { instance, handler } = await bootNode({
      rolling: { sessionTtlMs: 1 },
    });
    try {
      const rfqRes = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequest(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(rfqRes.accept).toBe(true);

      await new Promise((r) => setTimeout(r, 5));
      const fill = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
        executionCondition: conditionB64,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(decodeReason(fill.data)).toBe(
        ROLLING_REJECT_REASONS.UNKNOWN_SESSION
      );
    } finally {
      await instance.stop();
    }
  });

  it('rolling.rfq.enabled=false leaves the RFQ to the legacy handler (opt-out is real)', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode({
      rolling: { rfq: { enabled: false } },
    });
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequest(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      // Falls through to the legacy swap handler, which does not know kind:20033.
      expect(res.accept).toBe(false);
      expect(res.code).not.toBe('F01');
      expect(decodeReason(res.data)).not.toBe(
        ROLLING_RFQ_REJECT_REASONS.MALFORMED_RFQ
      );
    } finally {
      await instance.stop();
    }
  });

  it('a gift wrap whose inner kind is NOT 20033 still takes the legacy path unchanged', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: giftWrappedDataB64({
          kind: 20032, // the legacy swap-request rumor kind
          content: '{}',
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      // Whatever the legacy handler says, it must not be an RFQ verdict.
      expect(decodeReason(res.data)).not.toBe(
        ROLLING_RFQ_REJECT_REASONS.MALFORMED_RFQ
      );
      expect(decodeReason(res.data)).not.toBe(
        ROLLING_RFQ_REJECT_REASONS.UNSUPPORTED_PAIR
      );
    } finally {
      await instance.stop();
    }
  });

  it('an unparseable (non-gift-wrap) payload is untouched — legacy F06 Invalid TOON payload', async () => {
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: Buffer.from('junk', 'utf8').toString('base64'),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F06');
      expect(res.message).toBe('Invalid TOON payload');
    } finally {
      await instance.stop();
    }
  });
});
