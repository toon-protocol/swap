/**
 * swap#47 — rolling coupled-leg engine integration tests.
 *
 * Full `startSwapNode()` topology driven through the CONNECTOR-FACING packet
 * handler (the `setPacketHandler` callback), with the two surrounding
 * parties modeled exactly per their published contracts:
 *
 *   - the maker connector's local-delivery enforcement is mocked
 *     byte-for-byte per `connector/docs/local-delivery-fulfillment-contract.md`
 *     rule 3: `sha256(fulfillment) === executionCondition` or F99 with
 *     nothing recorded;
 *   - the sender daemon (leg-B terminator, toon-client#352's role) implements
 *     spec R5 verify-before-reveal: it checks the advance payload's
 *     recipient, watermark monotonicity (over ACCEPTED packets only — R8:
 *     claims from rejected packets are void), and its rate floor, and only
 *     then reveals the preimage.
 *
 * Scenarios: multi-packet rolling swap (AC-1/AC-5 contract level), maker
 * stall / sender withhold mid-stream (AC-1/AC-2), and legacy gift-wrap
 * coexistence on the same node (zero-condition path unchanged).
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import { encodeEventToToon } from '@toon-protocol/core';
import { wrapSwapPacket } from '@toon-protocol/sdk';
import { startSwapNode, ROLLING_PROTOCOL } from '@toon-protocol/swap';
import type {
  LegBPrepare,
  LegBResult,
  RollingAdvancePayload,
  SwapNodeConfig,
  SwapNodeInstance,
} from '@toon-protocol/swap';

const MNEMONIC = 'test test test test test test test test test test test junk';

const CHAIN = 'evm:31337';
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
  to: { assetCode: 'ETH', assetScale: 18, chain: CHAIN },
  rate: '0.0004',
} as const;
const CHANNEL_ID = '0x' + '31'.repeat(32);
const CHAIN_RECIPIENT = '0x' + '42'.repeat(20);
// v2 EIP-712 domain (connector#324 finding #1): the EVM signer folds a per-chain
// `verifyingContract` (deployed RollingSwapChannel address) into the signed
// digest and fails closed (`SIGNING_FAILED`) without one. This flow settles
// nothing on-chain (the daemon does spec-R5 verify-before-reveal on the claim
// bytes, never an on-chain signature check), so a well-formed dummy address is
// sufficient to let claim signing — and therefore the coupled fill — succeed.
const SETTLEMENT_ADDRESS = '0x' + 'cc'.repeat(20);
const SENDER_ILP = 'g.toon.client.rollingsender';
const STREAM_NONCE = '7e'.repeat(16);
const INITIAL_INVENTORY = 10n ** 20n; // 100 ETH (wei)
const INVENTORY_KEY = `ETH:${CHAIN}`;

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
  metadata?: Record<string, unknown>;
  fulfillment?: string;
}>;

// ---------------------------------------------------------------------------
// The sender daemon — spec R5 verify-before-reveal (toon-client#352's role)
// ---------------------------------------------------------------------------

interface SenderDaemon {
  legBSender: LegBSender;
  /** Mint a packet: fresh 32-byte preimage, condition = sha256(P). */
  mint(): { preimage: Uint8Array; conditionB64: string };
  advances: RollingAdvancePayload[];
  /** Toggle: when false the sender withholds every reveal (maker-stall sim). */
  reveal: boolean;
  /** Sender's session floor — R5(d). */
  minExchangeRate: number;
}

type LegBSender = (prepare: LegBPrepare) => Promise<LegBResult>;

function makeSenderDaemon(): SenderDaemon {
  const preimages = new Map<string, Uint8Array>();
  let lastAcceptedNonce = 0n;
  let lastAcceptedCumulative = 0n;

  const daemon: SenderDaemon = {
    advances: [],
    reveal: true,
    minExchangeRate: 0.00035,
    mint() {
      const preimage = new Uint8Array(32);
      globalThis.crypto.getRandomValues(preimage);
      const conditionB64 = Buffer.from(sha256(preimage)).toString('base64');
      preimages.set(conditionB64, preimage);
      return { preimage, conditionB64 };
    },
    legBSender: async (prepare) => {
      const advance = JSON.parse(
        prepare.data.toString('utf8')
      ) as RollingAdvancePayload;
      daemon.advances.push(advance);

      // R5 verification, BEFORE any reveal. (Chain-signature verification is
      // R5(a) via the sdk settlement verifier — structural checks here; the
      // real daemon story toon-client#352 wires the full verifier.)
      if (
        advance.proto !== ROLLING_PROTOCOL ||
        advance.type !== 'advance' ||
        advance.claim.length === 0
      ) {
        return { type: 'reject', code: 'F99', message: 'malformed advance' };
      }
      // (b) recipient equals the session chainRecipient (EVM: case-insensitive).
      if (advance.recipient?.toLowerCase() !== CHAIN_RECIPIENT.toLowerCase()) {
        return { type: 'reject', code: 'F99', message: 'recipient mismatch' };
      }
      // (c) nonce + cumulative strictly monotone over ACCEPTED packets. A
      // claim from a packet the sender rejected is void (R8), so a re-used
      // nonce after a maker-side unwind is legitimate.
      const nonce = BigInt(advance.nonce ?? '0');
      const cumulative = BigInt(advance.cumulativeAmount ?? '0');
      if (nonce <= lastAcceptedNonce || cumulative <= lastAcceptedCumulative) {
        return { type: 'reject', code: 'F99', message: 'non-monotone claim' };
      }
      // (d) effective rate ≥ the session floor (Δcumulative / δ).
      const delta = cumulative - lastAcceptedCumulative;
      const sourceAmount = BigInt(advance.sourceAmount);
      const effectiveRate =
        Number(delta) /
        10 ** PAIR.to.assetScale /
        (Number(sourceAmount) / 10 ** PAIR.from.assetScale);
      if (effectiveRate < daemon.minExchangeRate) {
        return {
          type: 'reject',
          code: 'F99',
          message: 'below_floor',
        };
      }

      if (!daemon.reveal) {
        // Withhold: the commit act never happens (maker-stall scenario).
        return { type: 'reject', code: 'T00', message: 'reveal withheld' };
      }

      const key = Buffer.from(prepare.executionCondition).toString('base64');
      const preimage = preimages.get(key);
      if (!preimage) {
        return { type: 'reject', code: 'F99', message: 'unknown condition' };
      }
      // The reveal IS the commit: only now update the accepted watermarks.
      lastAcceptedNonce = nonce;
      lastAcceptedCumulative = cumulative;
      return { type: 'fulfill', fulfillment: preimage };
    },
  };
  return daemon;
}

// ---------------------------------------------------------------------------
// Maker-connector enforcement, per the local-delivery fulfillment contract
// ---------------------------------------------------------------------------

function connectorEnforce(
  response: Awaited<ReturnType<PacketHandlerFn>>,
  conditionB64: string
):
  | { wire: 'FULFILL'; fulfillment: Uint8Array }
  | { wire: 'REJECT'; code: string } {
  if (!response.accept) {
    return { wire: 'REJECT', code: response.code ?? 'F99' };
  }
  const condition = new Uint8Array(Buffer.from(conditionB64, 'base64'));
  const f = response.fulfillment
    ? new Uint8Array(Buffer.from(response.fulfillment, 'base64'))
    : undefined;
  if (
    !f ||
    f.length !== 32 ||
    Buffer.compare(Buffer.from(sha256(f)), Buffer.from(condition)) !== 0
  ) {
    // Contract rule 3: F99, nothing recorded as delivered.
    return { wire: 'REJECT', code: 'F99' };
  }
  return { wire: 'FULFILL', fulfillment: f };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function bootRollingNode(daemon: SenderDaemon): Promise<{
  instance: SwapNodeInstance;
  handler: PacketHandlerFn;
}> {
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

  const instance = await startSwapNode({
    mnemonic: MNEMONIC,
    connector: connector as unknown as SwapNodeConfig['connector'],
    swapPairs: [PAIR],
    chains: ['evm'],
    chainProviders: [
      {
        chainType: 'evm',
        chainId: CHAIN,
        rpcUrl: 'http://localhost:0',
        registryAddress: '0x' + '22'.repeat(20),
        tokenAddress: '0x' + '33'.repeat(20),
        settlementAddress: SETTLEMENT_ADDRESS,
      },
    ],
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
    inventory: { [CHAIN]: INITIAL_INVENTORY },
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    rateProvider: () => ({ rate: '0.0004', at: Date.now() }),
    rollingLegBSender: daemon.legBSender,
  });
  if (!captured) {
    await instance.stop();
    throw new Error('setPacketHandler was never called');
  }

  instance.registerRollingSession({
    streamNonce: STREAM_NONCE,
    pair: { ...PAIR },
    chainRecipient: CHAIN_RECIPIENT,
    senderIlpAddress: SENDER_ILP,
    senderPubkey: getPublicKey(new Uint8Array(32).fill(21)),
  });

  return { instance, handler: captured };
}

function fillData(seq: number): string {
  return Buffer.from(
    JSON.stringify({
      proto: ROLLING_PROTOCOL,
      type: 'fill',
      streamNonce: STREAM_NONCE,
      seq,
    }),
    'utf8'
  ).toString('base64');
}

async function driveFill(
  handler: PacketHandlerFn,
  daemon: SenderDaemon,
  seq: number,
  deltaMicroUsdc: bigint
): Promise<ReturnType<typeof connectorEnforce>> {
  const { conditionB64 } = daemon.mint();
  const response = await handler({
    amount: deltaMicroUsdc.toString(),
    destination: 'g.toon.swap.rolling-fixture',
    data: fillData(seq),
    executionCondition: conditionB64,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  return connectorEnforce(response, conditionB64);
}

const DELTA = 2_000_000n; // 2 USDC per packet
const DELTA_WEI = 8n * 10n ** 14n; // ⌊2 USDC · 0.0004⌋ = 8e14 wei

// ---------------------------------------------------------------------------

describe('swap#47 — rolling coupled-leg engine (integration)', () => {
  it('multi-packet rolling swap: every fill couples, prices fresh, and nets to one cumulative claim stream', async () => {
    const daemon = makeSenderDaemon();
    const { instance, handler } = await bootRollingNode(daemon);
    try {
      const packets = 5;
      for (let seq = 1; seq <= packets; seq++) {
        const outcome = await driveFill(handler, daemon, seq, DELTA);
        expect(outcome.wire).toBe('FULFILL');
      }

      // The sender daemon saw one advance per packet, cumulative and
      // strictly monotone — N advances netting to ONE final watermark.
      expect(daemon.advances).toHaveLength(packets);
      for (let i = 0; i < packets; i++) {
        const advance = daemon.advances[i]!;
        expect(advance.streamNonce).toBe(STREAM_NONCE);
        expect(advance.seq).toBe(i + 1);
        expect(advance.rate).toBe('0.0004');
        expect(BigInt(advance.nonce!)).toBe(BigInt(i + 1));
        expect(BigInt(advance.cumulativeAmount!)).toBe(
          DELTA_WEI * BigInt(i + 1)
        );
        expect(advance.channelId).toBe(CHANNEL_ID);
      }

      // Issue #49: the delivered total is UNSETTLED LIABILITY in the
      // window view — no permanent debit on the rolling flow.
      const health = instance.health();
      expect(health.inventoryAvailable[INVENTORY_KEY]).toBe(
        INITIAL_INVENTORY.toString()
      );
      expect(health.inventoryWindow[INVENTORY_KEY]!.unsettled).toBe(
        (DELTA_WEI * BigInt(packets)).toString()
      );
      expect(health.inventoryWindow[INVENTORY_KEY]!.inFlight).toBe('0');
      expect(health.inventoryWindow[INVENTORY_KEY]!.free).toBe(
        (INITIAL_INVENTORY - DELTA_WEI * BigInt(packets)).toString()
      );
    } finally {
      await instance.stop();
    }
  });

  it('maker stall / withheld reveal mid-stream: the failed packet collects NOTHING and the stream recovers', async () => {
    const daemon = makeSenderDaemon();
    const { instance, handler } = await bootRollingNode(daemon);
    try {
      // Packets 1-2 fill normally.
      expect((await driveFill(handler, daemon, 1, DELTA)).wire).toBe('FULFILL');
      expect((await driveFill(handler, daemon, 2, DELTA)).wire).toBe('FULFILL');
      const availableAfter2 =
        instance.health().inventoryAvailable[INVENTORY_KEY];

      // Packet 3: the sender withholds the reveal (equivalently: the maker
      // cannot learn the preimage). Leg A MUST fail upstream — no
      // committed-A-without-B.
      daemon.reveal = false;
      const stalled = await driveFill(handler, daemon, 3, DELTA);
      expect(stalled.wire).toBe('REJECT');

      // Nothing stayed reserved for the failed packet (full unwind —
      // issue #49: the window releases; unsettled stays at the 2 fills).
      expect(instance.health().inventoryAvailable[INVENTORY_KEY]).toBe(
        availableAfter2
      );
      expect(instance.health().inventoryWindow[INVENTORY_KEY]!).toMatchObject({
        inFlight: '0',
        unsettled: (DELTA_WEI * 2n).toString(),
      });

      // Recovery: sender resumes with a NEW seq (spec: seq never reused).
      // The maker re-issues from the unwound watermark — nonce 3 again —
      // and the sender's R8-aware monotone check (over accepted packets)
      // admits it.
      daemon.reveal = true;
      expect((await driveFill(handler, daemon, 4, DELTA)).wire).toBe('FULFILL');
      const last = daemon.advances[daemon.advances.length - 1]!;
      expect(BigInt(last.nonce!)).toBe(3n);
      expect(BigInt(last.cumulativeAmount!)).toBe(DELTA_WEI * 3n);
      expect(instance.health().inventoryWindow[INVENTORY_KEY]!).toMatchObject({
        inFlight: '0',
        unsettled: (DELTA_WEI * 3n).toString(),
      });
      expect(instance.health().inventoryAvailable[INVENTORY_KEY]).toBe(
        INITIAL_INVENTORY.toString()
      );
    } finally {
      await instance.stop();
    }
  });

  it('legacy zero-condition gift-wrap flow still fills claim-in-FULFILL on the SAME node', async () => {
    const daemon = makeSenderDaemon();
    const { instance, handler } = await bootRollingNode(daemon);
    try {
      const senderSecretKey = new Uint8Array(32).fill(23);
      const rumor: UnsignedEvent = {
        kind: 30_078,
        pubkey: getPublicKey(senderSecretKey),
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [
          ['swap-from', `${PAIR.from.assetCode}:${PAIR.from.chain}`],
          ['swap-to', `${PAIR.to.assetCode}:${PAIR.to.chain}`],
          ['chain-recipient', CHAIN_RECIPIENT],
        ],
      };
      const { giftWrap } = wrapSwapPacket({
        rumor,
        senderSecretKey,
        recipientPubkey: instance.identity.pubkey,
      });
      const toonB64 = Buffer.from(encodeEventToToon(giftWrap)).toString(
        'base64'
      );

      const before = instance.health().inventoryAvailable[INVENTORY_KEY];
      const res = await handler({
        amount: '1000000', // 1 USDC
        destination: 'g.toon.swap.rolling-fixture',
        data: toonB64,
        // NO executionCondition: legacy class, byte-for-byte pre-#309 path.
      });

      // Legacy shape: accept with the claim in the FULFILL data/metadata —
      // and NO app-supplied fulfillment (the connector injects its NIP-59
      // preimage on this class).
      expect(res.accept).toBe(true);
      expect(res.fulfillment).toBeUndefined();
      const metadata = res.data
        ? (JSON.parse(
            Buffer.from(res.data, 'base64').toString('utf8')
          ) as Record<string, unknown>)
        : res.metadata!;
      expect(metadata['claim']).toBeTypeOf('string');
      expect((metadata['claim'] as string).length).toBeGreaterThan(0);
      expect(metadata['recipient']).toBe(CHAIN_RECIPIENT);
      // Quote tape (sdk 2.1.0, toon#82) still emitted on legacy accepts.
      expect(metadata['rate']).toBe('0.0004');
      expect(metadata['rateTimestamp']).toBeTypeOf('number');

      // Legacy fill debits inventory as before (1 USDC · 0.0004 = 4e14 wei).
      expect(instance.health().inventoryAvailable[INVENTORY_KEY]).toBe(
        (BigInt(before!) - 4n * 10n ** 14n).toString()
      );
      // And no leg-B traffic was generated for it.
      expect(daemon.advances).toHaveLength(0);
    } finally {
      await instance.stop();
    }
  });
});
