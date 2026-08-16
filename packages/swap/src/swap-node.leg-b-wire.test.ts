/**
 * Leg-B delivery — REAL WIRE test.
 *
 * ## What this proves, and why nothing weaker would
 *
 * A rolling session negotiated end to end against the live devnet maker and
 * then died on delivery:
 *
 * ```
 * maker: REJECT destination=g.toon.client errorCode=F02 "no route found"
 * maker: swap.rolling.fill_unwound streamNonce=… seq=1 cause=F02
 * client: F99 "leg B failed; fill not executed"  packetsAccepted 0
 * ```
 *
 * Every existing rolling test injects `rollingLegBSender` or drives a fake
 * connector, so leg B never touched a routing table and the defect was
 * invisible. A unit test of how `senderIlpAddress` is derived would have been
 * just as blind — the address was RIGHT; the maker simply had no way to reach
 * it.
 *
 * So this suite boots a REAL standalone `startSwapNode()` (real
 * `ConnectorNode`, real BTP server) and drives it from a REAL BTP client
 * (`@toon-protocol/client`'s `BtpRuntimeClient`, the same transport a stock
 * client uses, with the same `onMessage` seam its rolling leg-B router is
 * installed on). Both legs cross a socket:
 *
 * ```
 *  sender (BtpRuntimeClient, peerId g.toon.client.wire01)
 *     │  leg 0  PREPARE kind:20033 RFQ ─────────────▶ maker BTP server
 *     │  ◀───────────── FULFILL kind:20034 quote
 *     │  leg A  PREPARE δ + condition C ────────────▶ maker
 *     │                                       maker originates leg B …
 *     │  ◀─── BTP MESSAGE: PREPARE(claim, C)   … over THIS session
 *     │  ─────────────────────── FULFILL(P) ──▶
 *     │  ◀───────────── FULFILL(P) for leg A
 * ```
 *
 * Before the fix the leg-B PREPARE never left the maker's connector (F02) and
 * the leg-A assert fails with `leg B failed; fill not executed`.
 *
 * The withhold property (spec R5/R8) has its own assertion here too: a session
 * whose sender answers leg B with a REJECT must leave leg A rejected, with the
 * preimage never revealed.
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { wrapSwapPacketToToon, unwrapSwapPacket } from '@toon-protocol/sdk';
import type { ConnectorNode } from '@toon-protocol/connector';
import { BtpRuntimeClient } from '@toon-protocol/client';
import {
  PacketType,
  deserializePrepare,
  serializeFulfill,
  serializeReject,
} from '@toon-protocol/shared';
import type { UnsignedEvent } from 'nostr-tools';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import {
  ROLLING_PROTOCOL,
  createConnectorLegBSender,
} from './rolling-engine.js';
import type { LegBSender } from './rolling-engine.js';
import {
  ROLLING_RFQ_REQUEST_KIND,
  ROLLING_RFQ_RESPONSE_KIND,
  ROLLING_RFQ_REJECT_REASONS,
  type RollingRfqResponse,
} from './rolling-rfq.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const CHAIN = 'evm:8453';
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const MAKER_ILP = 'g.toon.swap.wireseam';

/**
 * The sender's ILP address AND the `peerId` it authenticates its BTP session
 * with — a stock `ToonClient` uses one expression for both
 * (`getOwnIlpAddress()` === the BTP greeting `peerId`), and the maker's
 * connector binds an inbound session under that string verbatim
 * (connector `btp/btp-server.ts` `authenticatePeer`).
 */
const SENDER_ILP = 'g.toon.client.wire01';

/** Ephemeral-range BTP port; the suite runs unforked, so randomize. */
function freePort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

interface BootedMaker {
  instance: SwapNodeInstance;
  connector: ConnectorNode;
  btpUrl: string;
}

async function bootMaker(
  port: number,
  overrides?: Partial<SwapNodeConfig>
): Promise<BootedMaker> {
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
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
    relayUrls: ['ws://127.0.0.1:1'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    // Standalone, parentless, direct-dialled — the deployed maker's shape.
    btpServerPort: port,
    ilpAddress: MAKER_ILP,
    nodeId: 'toon-swap-wireseam',
    ...overrides,
  });
  return {
    instance,
    connector: instance.connector as unknown as ConnectorNode,
    btpUrl: `ws://127.0.0.1:${port}`,
  };
}

function senderKeys(): { secretKey: Uint8Array; pubkey: string } {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

function giftWrappedRfqDataB64(params: {
  content: string;
  senderSecretKey: Uint8Array;
  makerPubkey: string;
}): string {
  const rumor = {
    kind: ROLLING_RFQ_REQUEST_KIND,
    content: params.content,
    tags: [],
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

function rfqBody(streamNonce: string, senderIlpAddress = SENDER_ILP): string {
  return JSON.stringify({
    proto: ROLLING_PROTOCOL,
    type: 'rfq',
    streamNonce,
    pair: {
      from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
      to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
    },
    chainRecipient: CHAIN_RECIPIENT,
    senderIlpAddress,
  });
}

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

/** `data.reason` off a rolling reject's base64-JSON body. */
function decodeRejectReason(dataB64: string | undefined): unknown {
  if (!dataB64) return undefined;
  return (
    JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8')) as {
      reason?: unknown;
    }
  ).reason;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function mintCondition(): { preimage: Uint8Array; conditionB64: string } {
  const preimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimage);
  return {
    preimage,
    conditionB64: Buffer.from(sha256(preimage)).toString('base64'),
  };
}

/** One leg-B PREPARE as the sender's daemon saw it come off the socket. */
interface CapturedLegB {
  destination: string;
  amount: string;
  executionCondition: string;
  data: Buffer;
}

/**
 * A sender daemon on a REAL BTP session. `onMessage` is the same seam a stock
 * client installs its rolling leg-B router on (toon-client's `jobHandler`),
 * so a PREPARE only lands here if it genuinely crossed the socket.
 */
async function connectSender(params: {
  btpUrl: string;
  peerId: string;
  captured: CapturedLegB[];
  /** `null` ⇒ REJECT, i.e. withhold the preimage (spec R5/R8). */
  answer: (legB: CapturedLegB) => Uint8Array | null;
}): Promise<BtpRuntimeClient> {
  const client = new BtpRuntimeClient({
    btpUrl: params.btpUrl,
    peerId: params.peerId,
    authToken: '',
    onMessage: (message) => {
      if (!message.ilpPacket) return {};
      const prepare = deserializePrepare(Buffer.from(message.ilpPacket));
      const legB: CapturedLegB = {
        destination: prepare.destination,
        amount: prepare.amount.toString(),
        executionCondition: Buffer.from(prepare.executionCondition).toString(
          'base64'
        ),
        data: Buffer.from(prepare.data),
      };
      params.captured.push(legB);
      const preimage = params.answer(legB);
      if (!preimage) {
        return {
          ilpPacket: serializeReject({
            type: PacketType.REJECT,
            code: 'F99',
            triggeredBy: params.peerId,
            message: 'sender withheld leg B',
            data: Buffer.alloc(0),
          }),
        };
      }
      return {
        ilpPacket: serializeFulfill({
          type: PacketType.FULFILL,
          fulfillment: Buffer.from(preimage),
          data: Buffer.alloc(0),
        }),
      };
    },
  });
  await client.connect();
  return client;
}

/**
 * The PRODUCTION leg-B egress: exactly what `startSwapNode` hands the rolling
 * engine (`swap-node.ts` §11a-pre) — `ConnectorNode.sendPacket` with the
 * sender-minted condition. Driving this, rather than a stub, is what makes
 * the routing hop real: it is the call that answered `F02 no route found`.
 */
function productionLegBSender(connector: ConnectorNode): LegBSender {
  return createConnectorLegBSender(connector, { nodeId: 'toon-swap-wireseam' });
}

describe('rolling leg-B delivery over a real BTP session', () => {
  it('[P0] leg B reaches a direct-dialled sender on the session its RFQ arrived on', async () => {
    const { instance, connector, btpUrl } = await bootMaker(freePort());
    const sender = senderKeys();
    const streamNonce = randomNonce();
    const captured: CapturedLegB[] = [];
    const { preimage, conditionB64 } = mintCondition();
    let client: BtpRuntimeClient | undefined;
    try {
      client = await connectSender({
        btpUrl,
        peerId: SENDER_ILP,
        captured,
        answer: () => preimage,
      });

      // Nothing routes to the sender yet — it direct-dialled, and a
      // direct-dialled client is in nobody's routing table. This is the
      // pre-fix state in which every leg B was F02'd.
      expect(connector.routingTable.getNextHop(SENDER_ILP)).toBe(null);

      // --- leg 0: the RFQ, across the real socket ---------------------------
      const rfq = await client.sendIlpPacket({
        destination: MAKER_ILP,
        amount: '0',
        data: giftWrappedRfqDataB64({
          content: rfqBody(streamNonce),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(rfq.accepted).toBe(true);
      const { kind, quote } = decodeQuote(rfq.data, sender.secretKey);
      expect(kind).toBe(ROLLING_RFQ_RESPONSE_KIND);
      expect(quote.streamNonce).toBe(streamNonce);

      // The RFQ bound the arrival session as the session's return path.
      expect(connector.routingTable.getNextHop(SENDER_ILP)).toBe(SENDER_ILP);

      // --- leg B: the production egress, through the real connector --------
      const legB = await productionLegBSender(connector)({
        destination: SENDER_ILP,
        amount: 3000n,
        expiresAt: new Date(Date.now() + 10_000),
        executionCondition: Buffer.from(conditionB64, 'base64'),
        data: Buffer.from(
          JSON.stringify({
            proto: ROLLING_PROTOCOL,
            type: 'advance',
            streamNonce,
            seq: 1,
          }),
          'utf8'
        ),
      });

      // It crossed the socket …
      expect(captured).toHaveLength(1);
      expect(captured[0]?.destination).toBe(SENDER_ILP);
      expect(captured[0]?.amount).toBe('3000');
      // … carrying the sender-minted condition verbatim (spec R4 coupling) …
      expect(captured[0]?.executionCondition).toBe(conditionB64);
      // … and came back FULFILLed with the preimage that satisfies leg A.
      expect(legB.type).toBe('fulfill');
      expect(
        legB.type === 'fulfill'
          ? Buffer.from(legB.fulfillment!).toString('base64')
          : undefined
      ).toBe(Buffer.from(preimage).toString('base64'));
    } finally {
      await client?.disconnect().catch(() => undefined);
      await instance.stop();
    }
  }, 30_000);

  it('[P0] withhold survives the real wire: a rejected leg B yields no preimage', async () => {
    const { instance, connector, btpUrl } = await bootMaker(freePort());
    const sender = senderKeys();
    const streamNonce = randomNonce();
    const captured: CapturedLegB[] = [];
    const { conditionB64 } = mintCondition();
    let client: BtpRuntimeClient | undefined;
    try {
      client = await connectSender({
        btpUrl,
        peerId: SENDER_ILP,
        captured,
        answer: () => null, // withhold
      });

      const rfq = await client.sendIlpPacket({
        destination: MAKER_ILP,
        amount: '0',
        data: giftWrappedRfqDataB64({
          content: rfqBody(streamNonce),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });
      expect(rfq.accepted).toBe(true);

      const legB = await productionLegBSender(connector)({
        destination: SENDER_ILP,
        amount: 3000n,
        expiresAt: new Date(Date.now() + 10_000),
        executionCondition: Buffer.from(conditionB64, 'base64'),
        data: Buffer.from('{}', 'utf8'),
      });

      // Delivered (so this is a genuine withhold, not the old F02) but the
      // maker learned nothing: no preimage ⇒ leg A can never fulfil (R5/R8).
      expect(captured).toHaveLength(1);
      expect(legB.type).toBe('reject');
      expect(
        legB.type === 'fulfill' ? legB.fulfillment : undefined
      ).toBeUndefined();
    } finally {
      await client?.disconnect().catch(() => undefined);
      await instance.stop();
    }
  }, 30_000);

  it('[P0] a sender the maker cannot answer is refused at leg 0, not at the fill', async () => {
    const { instance, connector, btpUrl } = await bootMaker(freePort());
    const sender = senderKeys();
    const captured: CapturedLegB[] = [];
    let client: BtpRuntimeClient | undefined;
    try {
      // Authenticates as one name, advertises another: no session is bound
      // under `g.toon.client.elsewhere` and no route reaches it.
      client = await connectSender({
        btpUrl,
        peerId: SENDER_ILP,
        captured,
        answer: () => null,
      });

      const rfq = await client.sendIlpPacket({
        destination: MAKER_ILP,
        amount: '0',
        data: giftWrappedRfqDataB64({
          content: rfqBody(randomNonce(), 'g.toon.client.elsewhere'),
          senderSecretKey: sender.secretKey,
          makerPubkey: instance.identity.pubkey,
        }),
      });

      // Refused at the RFQ — the one moment failing is free (no quote, no
      // session, no inventory, no revealed leg A). A sender's existing
      // RFQ-failure fallback then takes the legacy swap path.
      expect(rfq.accepted).toBe(false);
      expect(rfq.code).toBe('F02');
      expect(decodeRejectReason(rfq.data)).toBe(
        ROLLING_RFQ_REJECT_REASONS.NO_RETURN_PATH
      );
      // And no route was invented for an address the maker cannot reach.
      expect(connector.routingTable.getNextHop('g.toon.client.elsewhere')).toBe(
        null
      );
    } finally {
      await client?.disconnect().catch(() => undefined);
      await instance.stop();
    }
  }, 30_000);
});
