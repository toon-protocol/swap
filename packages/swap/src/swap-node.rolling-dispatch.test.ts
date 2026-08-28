/**
 * Issue #47 — `startSwapNode()` rolling dispatch-matrix tests.
 *
 * Exercises the connector-facing packet handler (the `setPacketHandler`
 * callback) across the condition-class × payload-class matrix
 * (swap#154, toon-meta#411 Stage 5 — the legacy claim-in-FULFILL row is gone):
 *
 *   - zero condition + kind:20033 RFQ    → rolling RFQ intake (session)
 *   - zero condition + anything else     → rfqIntake reject, terminal
 *   - zero condition + rolling fill      → F99 condition_required
 *   - sender-chosen condition + fill     → rolling engine (coupled legs)
 *   - sender-chosen condition + anything → F01 malformed_fill (not a
 *     distinct "legacy" case — the retired legacy path never set a
 *     sender-chosen condition, and rolling fills are the only thing this
 *     maker accepts under one)
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { ROLLING_PROTOCOL, ROLLING_REJECT_REASONS } from './rolling-engine.js';
import type { LegBPrepare, LegBResult } from './rolling-engine.js';
import { ROLLING_RFQ_REJECT_REASONS } from './rolling-rfq.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const CHAIN = 'evm:8453';
const STREAM_NONCE = '1f'.repeat(16);
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);

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

describe('issue #47 — rolling dispatch matrix', () => {
  it('zero condition + non-TOON payload → rfqIntake terminal reject (unreadable_request)', async () => {
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: Buffer.from('junk', 'utf8').toString('base64'),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F06');
      expect(decodeReason(res.data)).toBe(
        ROLLING_RFQ_REJECT_REASONS.UNREADABLE_REQUEST
      );
    } finally {
      await instance.stop();
    }
  });

  it('zero condition + rolling fill → F99 condition_required (no uncoupled fills)', async () => {
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F99');
      expect(decodeReason(res.data)).toBe(
        ROLLING_REJECT_REASONS.CONDITION_REQUIRED
      );
      expect(res.rejectReason?.code).toBe('application_error');
    } finally {
      await instance.stop();
    }
  });

  it('all-zero (legacy-class) condition bytes are treated as absent', async () => {
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(),
        executionCondition: Buffer.alloc(32).toString('base64'),
      });
      expect(res.accept).toBe(false);
      expect(decodeReason(res.data)).toBe(
        ROLLING_REJECT_REASONS.CONDITION_REQUIRED
      );
    } finally {
      await instance.stop();
    }
  });

  it('sender-chosen condition + non-fill payload → F01 malformed_fill; nothing debited', async () => {
    const { instance, handler } = await bootNode();
    try {
      const before = instance.health().inventoryAvailable[`USDC:${CHAIN}`];
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: Buffer.from('not-a-rolling-fill', 'utf8').toString('base64'),
        executionCondition: mint().conditionB64,
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F01');
      expect(decodeReason(res.data)).toBe(
        ROLLING_REJECT_REASONS.MALFORMED_FILL
      );
      expect(instance.health().inventoryAvailable[`USDC:${CHAIN}`]).toBe(
        before
      );
    } finally {
      await instance.stop();
    }
  });

  it('malformed rolling/1 payload → F01 malformed_fill (not the legacy F06)', async () => {
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: Buffer.from(
          JSON.stringify({ proto: ROLLING_PROTOCOL, type: 'fill', seq: 1 }),
          'utf8'
        ).toString('base64'),
        executionCondition: mint().conditionB64,
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F01');
      expect(decodeReason(res.data)).toBe(
        ROLLING_REJECT_REASONS.MALFORMED_FILL
      );
    } finally {
      await instance.stop();
    }
  });

  it('sender-chosen condition + fill for an unregistered session → benign F06 unknown_session', async () => {
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(),
        executionCondition: mint().conditionB64,
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

  it('registered session + injected leg-B sender: full coupled fill through the connector-facing handler', async () => {
    const legBCalls: LegBPrepare[] = [];
    let revealed: Uint8Array | undefined;
    const { instance, handler } = await bootNode({
      rollingLegBSender: async (prepare): Promise<LegBResult> => {
        legBCalls.push(prepare);
        // Compliant sender daemon: reveal the preimage for this condition.
        return { type: 'fulfill', fulfillment: revealed };
      },
    });
    try {
      instance.registerRollingSession({
        streamNonce: STREAM_NONCE,
        pair: {
          from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
          to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
          rate: '1.0',
        },
        chainRecipient: CHAIN_RECIPIENT,
        senderIlpAddress: 'g.toon.client.sender01',
        senderPubkey: 'e'.repeat(64),
      });

      const { preimage, conditionB64 } = mint();
      revealed = preimage;
      const res = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: fillDataB64(1),
        executionCondition: conditionB64,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });

      // Accept carries the base64 preimage — the exact bytes the connector's
      // sha256 check verifies before FULFILLing leg A upstream.
      expect(res.accept).toBe(true);
      expect(res.fulfillment).toBe(Buffer.from(preimage).toString('base64'));

      // Leg B went out with the SAME condition and the session destination.
      expect(legBCalls).toHaveLength(1);
      expect(
        Buffer.from(legBCalls[0]!.executionCondition).toString('base64')
      ).toBe(conditionB64);
      expect(legBCalls[0]!.destination).toBe('g.toon.client.sender01');
      expect(legBCalls[0]!.amount).toBe(250_000n); // 1:1 pair, same scale

      // Issue #49: NO permanent debit on the rolling flow — the fill's
      // amount is unsettled channel liability in the window view.
      const health = instance.health();
      expect(health.inventoryAvailable[`USDC:${CHAIN}`]).toBe(
        1_000_000_000n.toString()
      );
      expect(health.inventoryWindow[`USDC:${CHAIN}`]).toEqual({
        budget: 1_000_000_000n.toString(),
        inFlight: '0',
        unsettled: '250000',
        free: (1_000_000_000n - 250_000n).toString(),
      });
    } finally {
      await instance.stop();
    }
  });

  it('non-fill zero-condition traffic reaches the rfqIntake terminal reject, not a rolling-engine reject', async () => {
    // Pins the dispatch-order property: zero-condition, non-rolling-fill
    // traffic reaches `rfqIntake.handle()` (F06 unreadable_request for
    // arbitrary JSON, since it does not even unwrap as a gift wrap), NOT any
    // rolling-engine reject.
    const { instance, handler } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString(
          'base64'
        ),
      });
      expect(res.accept).toBe(false);
      expect(res.code).toBe('F06');
      expect(decodeReason(res.data)).toBe(
        ROLLING_RFQ_REJECT_REASONS.UNREADABLE_REQUEST
      );
    } finally {
      await instance.stop();
    }
  });
});
