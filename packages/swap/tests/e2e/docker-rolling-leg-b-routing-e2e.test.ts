/**
 * swap#153 — the two ROUTING-shaped ways a rolling swap dies on delivery.
 *
 * Both showed up on rolling's first live day and were fixed by swap#148, and
 * both are invisible to a unit test: the addresses were right, the sessions
 * registered, the engine behaved. What was missing was a routing table entry
 * and a peer relation, i.e. facts that only exist once a real connector is
 * carrying a real socket. So this suite boots a REAL standalone
 * `startSwapNode()` and drives it from a REAL BTP client.
 *
 * ```
 *   F02  maker: REJECT destination=g.toon.client errorCode=F02 "no route found"
 *        → a leg B addressed to a DIRECT-DIALLED sender, which by definition
 *          is in nobody's routing table. Refused now at leg 0 instead, where
 *          failing is free.
 *
 *   T00  maker: "No payment channel available for peer"
 *        → leg B is VALUE-BEARING, and a connector demands a settlement claim
 *          before forwarding value to any next hop that is not its `child`.
 *          The maker can never hold a channel toward its own customer, so the
 *          return peer is marked `child` when the route is bound.
 * ```
 *
 * Why a maker of its own rather than the shared peer1: `global-setup.ts` boots
 * peer1 in the Vitest globalSetup process, so a suite file cannot reach its
 * connector's routing table or peer relations — and these are assertions about
 * exactly those two things. This maker is standalone, parentless and
 * direct-dialled, which is the deployed maker's shape.
 *
 * Nothing here needs a chain: leg 0 is free and the leg-B egress is driven at
 * the production seam (`createConnectorLegBSender` — literally what
 * `startSwapNode()` hands the rolling engine), so the assertions are about
 * routing, not about claims.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { wrapSwapPacketToToon } from '@toon-protocol/sdk';
import { BtpRuntimeClient } from '@toon-protocol/client';
import {
  PacketType,
  deserializePrepare,
  serializeFulfill,
} from '@toon-protocol/shared';
import type { UnsignedEvent } from 'nostr-tools';
import {
  startSwapNode,
  createConnectorLegBSender,
  ROLLING_PROTOCOL,
  ROLLING_RFQ_REQUEST_KIND,
  ROLLING_RFQ_REJECT_REASONS,
} from '@toon-protocol/swap';
import type { SwapNodeInstance } from '@toon-protocol/swap';

import { randomStreamNonce, rejectReason } from './helpers/rolling-driver.js';
import { present } from './helpers/present.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const CHAIN = 'evm:8453';
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);
const MAKER_ILP = 'g.toon.swap.e2eroute';
const MAKER_BTP_PORT = 19940;

/**
 * The sender's ILP address AND the BTP `peerId` it authenticates under — a
 * stock client uses one expression for both, and the maker binds an inbound
 * session under that string verbatim.
 */
const SENDER_ILP = 'g.toon.client.e2eroute01';
/** An address no session ever authenticated under and no route reaches. */
const UNREACHABLE_ILP = 'g.toon.client.e2eroute-elsewhere';

/** Minimal introspection surface `ConnectorNode` exposes at runtime. */
interface MakerConnector {
  routingTable: { getNextHop(addr: string): string | null };
  _packetHandler?: {
    setPeerRelation?: (peerId: string, relation: string) => void;
    getPeerRelation?: (peerId: string) => string | undefined;
  };
}

/** Narrowed handles the tests read — see `present()` for why not `!`. */
function handles(
  connector: MakerConnector | null,
  client: BtpRuntimeClient | null
): {
  connector: MakerConnector;
  client: BtpRuntimeClient;
  setRelation: (peerId: string, relation: string) => void;
  getRelation: (peerId: string) => string | undefined;
} {
  const conn = present(connector, "the maker's connector");
  const packetHandler = present(
    conn._packetHandler,
    "the connector's packet handler"
  );
  return {
    connector: conn,
    client: present(client, 'the BTP sender'),
    setRelation: present(
      packetHandler.setPeerRelation,
      'PacketHandler.setPeerRelation'
    ).bind(packetHandler),
    getRelation: present(
      packetHandler.getPeerRelation,
      'PacketHandler.getPeerRelation'
    ).bind(packetHandler),
  };
}

interface CapturedLegB {
  destination: string;
  amount: string;
  executionCondition: string;
}

describe('Docker Rolling leg-B routing E2E (swap#153) — the F02 and T00 shapes', () => {
  let instance: SwapNodeInstance | null = null;
  let connector: MakerConnector | null = null;
  let client: BtpRuntimeClient | null = null;
  const captured: CapturedLegB[] = [];
  const preimages = new Map<string, Uint8Array>();

  beforeAll(async () => {
    instance = await startSwapNode({
      mnemonic: MNEMONIC,
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
      blsPort: 19941,
      publisher: { publish: async () => undefined },
      // Standalone, parentless, direct-dialled — the deployed maker's shape.
      btpServerPort: MAKER_BTP_PORT,
      ilpAddress: MAKER_ILP,
      nodeId: 'toon-swap-e2eroute',
    });
    connector = instance.connector as unknown as MakerConnector;

    client = new BtpRuntimeClient({
      btpUrl: `ws://127.0.0.1:${MAKER_BTP_PORT}`,
      peerId: SENDER_ILP,
      authToken: '',
      onMessage: (message) => {
        if (!message.ilpPacket) return {};
        const prepare = deserializePrepare(Buffer.from(message.ilpPacket));
        const conditionB64 = Buffer.from(prepare.executionCondition).toString(
          'base64'
        );
        captured.push({
          destination: prepare.destination,
          amount: prepare.amount.toString(),
          executionCondition: conditionB64,
        });
        const preimage = preimages.get(conditionB64);
        if (!preimage) return {};
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
  }, 60_000);

  afterAll(async () => {
    await client?.disconnect().catch(() => undefined);
    await instance?.stop().catch(() => undefined);
  });

  // ---------------------------------------------------------------------
  // F02 — a session the maker could not answer is refused at leg 0
  // ---------------------------------------------------------------------
  it('T-1 [P0] an RFQ advertising an address the maker cannot reach is refused F02 at leg 0, and invents no route', async () => {
    const h = handles(connector, client);
    expect(h.connector.routingTable.getNextHop(UNREACHABLE_ILP)).toBe(null);

    const rfq = await h.client.sendIlpPacket({
      destination: MAKER_ILP,
      amount: '0',
      data: rfqData(randomStreamNonce(), UNREACHABLE_ILP),
    });

    // Refused at the one moment failing is free: no quote, no session, no
    // inventory reserved, no leg A revealed.
    expect(rfq.accepted).toBe(false);
    expect(rfq.code).toBe('F02');
    expect(rejectReason(rfq.data)).toBe(
      ROLLING_RFQ_REJECT_REASONS.NO_RETURN_PATH
    );
    // And nothing was invented for an address the maker cannot reach.
    expect(h.connector.routingTable.getNextHop(UNREACHABLE_ILP)).toBe(null);
  }, 30_000);

  // ---------------------------------------------------------------------
  // The fix — the arrival session becomes the return path, marked `child`
  // ---------------------------------------------------------------------
  it('T-2 [P0] an RFQ on a direct-dialled session binds that session as the return path and marks it `child`', async () => {
    // Pre-state: a direct-dialled client is in nobody's routing table. This
    // is the state in which every leg B was F02-rejected before swap#148.
    const h = handles(connector, client);
    expect(h.connector.routingTable.getNextHop(SENDER_ILP)).toBe(null);

    const rfq = await h.client.sendIlpPacket({
      destination: MAKER_ILP,
      amount: '0',
      data: rfqData(randomStreamNonce(), SENDER_ILP),
    });
    expect(rfq.accepted).toBe(true);

    expect(h.connector.routingTable.getNextHop(SENDER_ILP)).toBe(SENDER_ILP);
    // `child`, not `peer`: see T-3 for what the difference costs.
    expect(h.getRelation(SENDER_ILP)).toBe('child');
  }, 30_000);

  // ---------------------------------------------------------------------
  // T00 — a value-bearing forward to a non-`child` next hop
  // ---------------------------------------------------------------------
  it('T-3 [P0] leg B to a non-`child` next hop is refused T00 before it reaches the wire — and delivered once the relation is restored', async () => {
    const h = handles(connector, client);
    // Arm the session (idempotent — the route is already bound).
    const rfq = await h.client.sendIlpPacket({
      destination: MAKER_ILP,
      amount: '0',
      data: rfqData(randomStreamNonce(), SENDER_ILP),
    });
    expect(rfq.accepted).toBe(true);

    const legB = createConnectorLegBSender(h.connector, {
      nodeId: 'toon-swap-e2eroute',
    });

    // --- the defect: demote the return peer to an ordinary `peer` ---------
    h.setRelation(SENDER_ILP, 'peer');
    const before = captured.length;
    const demoted = await legB(prepare(mint().conditionB64));

    expect(demoted.type).toBe('reject');
    expect(demoted.type === 'reject' ? demoted.code : undefined).toBe('T00');
    expect(demoted.type === 'reject' ? demoted.message : '').toMatch(
      /payment channel/i
    );
    // The packet never left the maker — a value-bearing hop is gated BEFORE
    // forwarding, so the sender saw nothing at all.
    expect(captured.length).toBe(before);

    // --- the fix: `child`, as the RFQ's return-route binder sets it -------
    h.setRelation(SENDER_ILP, 'child');
    const { preimage, conditionB64 } = mint();
    const delivered = await legB(prepare(conditionB64));

    expect(captured.length).toBe(before + 1);
    const seen = present(captured.at(-1), 'the delivered leg-B PREPARE');
    expect(seen.destination).toBe(SENDER_ILP);
    expect(seen.amount).toBe('3000');
    // The sender-minted condition rode across verbatim (spec R4 coupling) …
    expect(seen.executionCondition).toBe(conditionB64);
    // … and came back as the preimage that alone can satisfy leg A.
    expect(delivered.type).toBe('fulfill');
    expect(
      delivered.type === 'fulfill' && delivered.fulfillment
        ? Buffer.from(delivered.fulfillment).toString('base64')
        : undefined
    ).toBe(Buffer.from(preimage).toString('base64'));
  }, 30_000);

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  function mint(): { preimage: Uint8Array; conditionB64: string } {
    const preimage = new Uint8Array(32);
    globalThis.crypto.getRandomValues(preimage);
    const conditionB64 = Buffer.from(sha256(preimage)).toString('base64');
    preimages.set(conditionB64, preimage);
    return { preimage, conditionB64 };
  }

  function prepare(conditionB64: string) {
    return {
      destination: SENDER_ILP,
      amount: 3000n,
      expiresAt: new Date(Date.now() + 10_000),
      executionCondition: Buffer.from(conditionB64, 'base64'),
      data: Buffer.from(
        JSON.stringify({
          proto: ROLLING_PROTOCOL,
          type: 'advance',
          streamNonce: randomStreamNonce(),
          seq: 1,
        }),
        'utf8'
      ),
    };
  }

  function rfqData(streamNonce: string, senderIlpAddress: string): string {
    const secretKey = schnorr.utils.randomSecretKey();
    const rumor = {
      kind: ROLLING_RFQ_REQUEST_KIND,
      content: JSON.stringify({
        proto: ROLLING_PROTOCOL,
        type: 'rfq',
        streamNonce,
        pair: {
          from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
          to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        },
        chainRecipient: CHAIN_RECIPIENT,
        senderIlpAddress,
      }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: '',
    } as unknown as UnsignedEvent;
    const { ilpPrepare } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey: secretKey,
      recipientPubkey: present(instance, 'the maker instance').identity.pubkey,
      destination: MAKER_ILP,
      amount: 1000n,
    });
    return ilpPrepare.data;
  }
});
