/**
 * Intake classification — WIRE-LEVEL tests (issue #152).
 *
 * ADR 0003 gates every legacy-removal stage on "no legacy traffic observed for
 * N consecutive days", and before this stage that was unmeasurable: the maker
 * logged refusals only, so a maker serving legacy all day and a maker serving
 * none looked identical.
 *
 * These tests drive the REAL dispatch seam — boot `startSwapNode()` against a
 * fake connector, capture the `setPacketHandler` callback, feed it real
 * packets — because the thing under test is which row of the issue #47
 * dispatch matrix an arrival lands on. A unit test of the meter proves
 * nothing about that; the classification only exists at the seam.
 *
 * The headline pair is `legacy` vs `rolling-rfq`: two gift wraps built by the
 * same primitives, addressed to the same maker, differing ONLY by their inner
 * rumor kind (20032 vs 20033). Nothing downstream of the unwrap can still tell
 * them apart, which is exactly why the class has to be recorded here.
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
import { ROLLING_RFQ_REQUEST_KIND } from './rolling-rfq.js';
import { SWAP_INTAKE_EVENT } from './intake-classification.js';
import type { SwapIntakeReport } from './intake-classification.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const CHAIN = 'evm:8453';
const STREAM_NONCE = '1f'.repeat(16);
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const SENDER_ILP = 'g.toon.client.sender01';
const MAKER_ILP = 'g.toon.swap.x';
/** The legacy discriminator: inner rumor kind of a legacy swap request. */
const LEGACY_SWAP_RUMOR_KIND = 20032;

interface PacketRequest {
  amount: string;
  destination: string;
  data: string;
  sourceAccount?: string;
  executionCondition?: string;
  expiresAt?: string;
}
type PacketHandlerFn = (request: PacketRequest) => Promise<{
  accept: boolean;
  code?: string;
  data?: string;
}>;

/** One captured `swap.intake` record. */
type IntakeLine = Record<string, unknown>;

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
  intakeLines: () => IntakeLine[];
}> {
  const { connector, handler } = capturingConnector();
  const lines: IntakeLine[] = [];
  const record = (...args: unknown[]): void => {
    const [event, fields] = args;
    if (event === SWAP_INTAKE_EVENT) {
      lines.push((fields as IntakeLine | undefined) ?? {});
    }
  };
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector,
    logger: {
      debug: () => undefined,
      info: record,
      warn: () => undefined,
      error: () => undefined,
    },
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
  return { instance, handler, intakeLines: () => lines };
}

function senderKeys(): { secretKey: Uint8Array; pubkey: string } {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

/**
 * Build the base64 PREPARE `data` of a real NIP-59 gift wrap carrying an
 * arbitrary inner rumor. The ONLY thing the legacy and RFQ cases below vary is
 * `kind` (and the content that kind implies) — the envelope is identical.
 */
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
    destination: MAKER_ILP,
    amount: 1000n,
  });
  return ilpPrepare.data;
}

/** The tags a legacy kind:20032 swap rumor carries (`sdk` `buildSwapRumor`). */
function legacyRumorTags(): string[][] {
  return [
    ['swap-from', `USDC:${CHAIN}`],
    ['swap-to', `USDC:${CHAIN}`],
    ['amount', '1000'],
    ['seq', '1', '1'],
    ['nonce', 'ab'.repeat(16)],
    ['chain-recipient', CHAIN_RECIPIENT],
  ];
}

function rfqRequestContent(): string {
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
  });
}

function fillDataB64(seq = 1, streamNonce = STREAM_NONCE): string {
  return Buffer.from(
    JSON.stringify({ proto: ROLLING_PROTOCOL, type: 'fill', streamNonce, seq }),
    'utf8'
  ).toString('base64');
}

function nonZeroConditionB64(): string {
  const preimage = new Uint8Array(32).fill(7);
  return Buffer.from(sha256(preimage)).toString('base64');
}

function zeroConditionB64(): string {
  return Buffer.from(new Uint8Array(32)).toString('base64');
}

describe('intake classification at the dispatch seam (#152)', () => {
  it('a kind:20032 arrival is classified legacy, with the peer and the pair', async () => {
    const sender = senderKeys();
    const { instance, handler, intakeLines } = await bootNode();
    try {
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        sourceAccount: SENDER_ILP,
        data: giftWrappedDataB64({
          kind: LEGACY_SWAP_RUMOR_KIND,
          content: '',
          tags: legacyRumorTags(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });

      const lines = intakeLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        class: 'legacy',
        innerKind: LEGACY_SWAP_RUMOR_KIND,
        pair: `USDC:${CHAIN}>USDC:${CHAIN}`,
        peer: SENDER_ILP,
        senderPubkey: sender.pubkey,
        destination: MAKER_ILP,
        amount: '1000',
      });
      expect(instance.intakeReport().classes.legacy.total).toBe(1);
      expect(instance.intakeReport().legacyPeers).toEqual([
        { peer: SENDER_ILP, count: 1, lastAt: expect.any(String) },
      ]);
    } finally {
      await instance.stop();
    }
  });

  it('a kind:20033 arrival — same envelope, different inner kind — is classified rolling-rfq', async () => {
    const sender = senderKeys();
    const { instance, handler, intakeLines } = await bootNode();
    try {
      const res = await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        sourceAccount: SENDER_ILP,
        data: giftWrappedDataB64({
          kind: ROLLING_RFQ_REQUEST_KIND,
          content: rfqRequestContent(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(res.accept).toBe(true);

      const lines = intakeLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        class: 'rolling-rfq',
        accepted: true,
        innerKind: ROLLING_RFQ_REQUEST_KIND,
        pair: `USDC:${CHAIN}>USDC:${CHAIN}`,
        senderIlpAddress: SENDER_ILP,
        senderPubkey: sender.pubkey,
      });
      const report = instance.intakeReport();
      expect(report.classes['rolling-rfq'].total).toBe(1);
      expect(report.classes.legacy.total).toBe(0);
      // The gate's whole question: nobody is on legacy.
      expect(report.legacyPeers).toEqual([]);
    } finally {
      await instance.stop();
    }
  });

  it('THE DISCRIMINATOR: two arrivals differing only by inner rumor kind land on different classes', async () => {
    const sender = senderKeys();
    const { instance, handler, intakeLines } = await bootNode();
    try {
      const wrap = (kind: number, content: string): string =>
        giftWrappedDataB64({
          kind,
          content,
          tags: kind === LEGACY_SWAP_RUMOR_KIND ? legacyRumorTags() : [],
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        });

      // Identical outer shape for both: zero condition, kind:1059 gift wrap,
      // same amount, same destination, same sender, same maker.
      const packet = (data: string): PacketRequest => ({
        amount: '1000',
        destination: MAKER_ILP,
        sourceAccount: SENDER_ILP,
        executionCondition: zeroConditionB64(),
        data,
      });

      await handler()(packet(wrap(LEGACY_SWAP_RUMOR_KIND, '')));
      await handler()(
        packet(wrap(ROLLING_RFQ_REQUEST_KIND, rfqRequestContent()))
      );

      expect(intakeLines().map((l) => l['class'])).toEqual([
        'legacy',
        'rolling-rfq',
      ]);
      const report = instance.intakeReport();
      expect(report.classes.legacy.total).toBe(1);
      expect(report.classes['rolling-rfq'].total).toBe(1);
      expect(report.total).toBe(2);
    } finally {
      await instance.stop();
    }
  });

  it('a coupled fill is classified rolling-fill even when the engine rejects it', async () => {
    const { instance, handler, intakeLines } = await bootNode();
    try {
      // No session was ever minted, so the engine refuses — the CLASS is the
      // dispatch row taken, not the outcome, and `accepted:false` says what
      // happened to it.
      const res = await handler()({
        amount: '250000',
        destination: MAKER_ILP,
        sourceAccount: SENDER_ILP,
        data: fillDataB64(1),
        executionCondition: nonZeroConditionB64(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(res.accept).toBe(false);

      const lines = intakeLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        class: 'rolling-fill',
        accepted: false,
      });
      const report = instance.intakeReport();
      expect(report.classes['rolling-fill']).toMatchObject({
        total: 1,
        accepted: 0,
        rejected: 1,
      });
      expect(report.classes.refused.total).toBe(0);
    } finally {
      await instance.stop();
    }
  });

  it('each dispatch-table reject is classified refused, carrying its existing reason', async () => {
    const sender = senderKeys();
    const { instance, handler, intakeLines } = await bootNode();
    try {
      // Row: non-zero condition + a payload that is not a rolling fill.
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        data: giftWrappedDataB64({
          kind: LEGACY_SWAP_RUMOR_KIND,
          content: '',
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
        executionCondition: nonZeroConditionB64(),
      });
      // Row: rolling fill with no sender-chosen condition.
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        data: fillDataB64(1),
      });
      // Row: self-identified rolling/1 traffic violating the fill shape.
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        data: Buffer.from(
          JSON.stringify({ proto: ROLLING_PROTOCOL, type: 'fill' }),
          'utf8'
        ).toString('base64'),
        executionCondition: nonZeroConditionB64(),
      });

      const lines = intakeLines();
      expect(lines).toHaveLength(3);
      expect(lines.map((l) => l['class'])).toEqual([
        'refused',
        'refused',
        'refused',
      ]);
      expect(lines.map((l) => l['reason'])).toEqual([
        ROLLING_REJECT_REASONS.CONDITION_UNSUPPORTED_LEGACY,
        ROLLING_REJECT_REASONS.CONDITION_REQUIRED,
        ROLLING_REJECT_REASONS.MALFORMED_FILL,
      ]);
      const report = instance.intakeReport();
      expect(report.classes.refused).toMatchObject({ total: 3, rejected: 3 });
      expect(report.reasons).toEqual({
        [ROLLING_REJECT_REASONS.CONDITION_UNSUPPORTED_LEGACY]: 1,
        [ROLLING_REJECT_REASONS.CONDITION_REQUIRED]: 1,
        [ROLLING_REJECT_REASONS.MALFORMED_FILL]: 1,
      });
    } finally {
      await instance.stop();
    }
  });

  it('an unopenable gift wrap still counts, with a null inner kind', async () => {
    const other = senderKeys();
    const stranger = senderKeys();
    const { instance, handler, intakeLines } = await bootNode();
    try {
      // Wrapped to somebody else's pubkey: this maker cannot open it, so it
      // falls through to the legacy handler exactly as it always did.
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        data: giftWrappedDataB64({
          kind: LEGACY_SWAP_RUMOR_KIND,
          content: '',
          senderSecretKey: other.secretKey,
          makerPubkey: stranger.pubkey,
        }),
      });
      const lines = intakeLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ class: 'legacy', innerKind: null });
    } finally {
      await instance.stop();
    }
  });

  it('exactly one intake record per arrival, whatever the outcome', async () => {
    const sender = senderKeys();
    const { instance, handler, intakeLines } = await bootNode();
    try {
      for (let i = 0; i < 3; i++) {
        await handler()({
          amount: '1000',
          destination: MAKER_ILP,
          data: giftWrappedDataB64({
            kind: LEGACY_SWAP_RUMOR_KIND,
            content: '',
            tags: legacyRumorTags(),
            senderSecretKey: sender.secretKey,
            makerPubkey: instance.identity.pubkey,
          }),
        });
      }
      // Garbage that is neither a gift wrap nor rolling traffic.
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        data: Buffer.from('not a toon event', 'utf8').toString('base64'),
      });

      expect(intakeLines()).toHaveLength(4);
      expect(instance.intakeReport().total).toBe(4);
    } finally {
      await instance.stop();
    }
  });
});

describe('GET /admin/intake (#152)', () => {
  it('serves the same counts the log lines were bumped from, unauthenticated', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      await handler()({
        amount: '1000',
        destination: MAKER_ILP,
        sourceAccount: SENDER_ILP,
        data: giftWrappedDataB64({
          kind: LEGACY_SWAP_RUMOR_KIND,
          content: '',
          tags: legacyRumorTags(),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });

      // No admin token configured, and the read still answers — same rule
      // `GET /admin/inventory` set (writes are gated, reads are not).
      const res = await fetch(
        `http://127.0.0.1:${instance.blsPort}/admin/intake`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as SwapIntakeReport;

      expect(body.classes.legacy.total).toBe(1);
      expect(body.classes['rolling-rfq'].total).toBe(0);
      expect(body.total).toBe(1);
      expect(body.legacyPeers).toEqual([
        { peer: SENDER_ILP, count: 1, lastAt: expect.any(String) },
      ]);
      // An in-process reset must never be silent.
      expect(typeof body.since).toBe('string');
      expect(typeof body.windowSec).toBe('number');
      expect(body.note).toMatch(/in-process/);
    } finally {
      await instance.stop();
    }
  });
});
