/**
 * swap#48 — maker staleness-reject (`maxRateAge`) integration tests.
 *
 * Exercises the full fixture topology (real `createSwapHandler` +
 * `MultiChainClaimIssuer` + `withMaxRateAge` gate, wired by `startSwapNode()`)
 * against the issue's acceptance criteria:
 *
 *   - stale packet → distinct benign reject code with a sender-visible
 *     reason (T99 / 'stale_rate' / base64-JSON data)
 *   - the sender can re-request (feed ticks again) and continue
 *   - fresh packets are unaffected — a full streamSwap under an armed guard
 *     completes exactly as without one
 *   - a staleness reject leaves NO replay reservation and NO inventory debit
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import { encodeEventToToon } from '@toon-protocol/core';
import { streamSwap, wrapSwapPacket } from '@toon-protocol/sdk';
import {
  STALE_RATE_REJECT_CODE,
  STALE_RATE_REJECT_MESSAGE,
  STALE_RATE_REASON,
  pairKey,
  type StaleRateRejectData,
  type SwapNodeInstance,
  type TimestampedRate,
} from '@toon-protocol/swap';

import {
  buildFixtureSwapNode,
  buildFixtureSender,
  fixtureSwapPair,
} from './helpers/fixture-topology.js';

const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);
const FIXTURE_SWAP_NODE_ILP_ADDRESS = 'g.toon.swap.fixture';

/** A controllable timestamped feed: tests move `at` to age the quote. */
function makeFeed(initialAt: number): {
  provider: () => TimestampedRate;
  tick: (at: number) => void;
} {
  let at = initialAt;
  return {
    provider: () => ({ rate: '0.0004', at }),
    tick: (next: number) => {
      at = next;
    },
  };
}

/** Build a raw wrapped swap PREPARE for the fixture pair (bypasses streamSwap
 *  so a single packet's reject surface can be asserted precisely). */
function buildWrappedPacket(swapNode: SwapNodeInstance, senderSecretKey: Uint8Array): Uint8Array {
  const pair = fixtureSwapPair();
  const rumor: UnsignedEvent = {
    kind: 30_078,
    pubkey: getPublicKey(senderSecretKey),
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['swap-from', `${pair.from.assetCode}:${pair.from.chain}`],
      ['swap-to', `${pair.to.assetCode}:${pair.to.chain}`],
      ['chain-recipient', FIXTURE_EVM_RECIPIENT],
    ],
  };
  const { giftWrap } = wrapSwapPacket({
    rumor,
    senderSecretKey,
    recipientPubkey: swapNode.identity.pubkey,
  });
  return new Uint8Array(encodeEventToToon(giftWrap));
}

describe('swap#48 — maker staleness reject (maxRateAge)', () => {
  it('stale feed → T99 stale_rate reject with structured data; fresh tick → same sender continues', async () => {
    const feed = makeFeed(Date.now());
    const swapNode = await buildFixtureSwapNode({
      rateProvider: feed.provider,
      maxRateAge: { perChain: { evm: 1_500 } },
    });
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(21));
    try {
      // Age the feed past the bound.
      feed.tick(Date.now() - 5_000);

      const stale = await sender.client.sendSwapPacket({
        destination: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        amount: 1_000_000n,
        toonData: buildWrappedPacket(swapNode, sender.secretKey),
      });

      // AC: distinct benign reject code with a sender-visible reason.
      expect(stale.accepted).toBe(false);
      expect(stale.code).toBe(STALE_RATE_REJECT_CODE);
      expect(stale.message).toBe(STALE_RATE_REJECT_MESSAGE);
      const data = JSON.parse(
        Buffer.from(stale.data!, 'base64').toString('utf8')
      ) as StaleRateRejectData;
      expect(data.reason).toBe(STALE_RATE_REASON);
      expect(data.maxRateAgeMs).toBe(1_500);
      expect(typeof data.lastRateAt).toBe('number');
      expect(data.pair).toBe(pairKey(fixtureSwapPair()));

      // No inventory was debited by the reject.
      const healthAfterReject = swapNode.health();
      expect(healthAfterReject.inventoryAvailable['evm:31337']).toBe(
        healthAfterReject.inventory['evm:31337']
      );

      // AC: the sender re-requests once the feed ticks and CONTINUES — a
      // full streamSwap completes against the same swapNode.
      feed.tick(Date.now());
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
      expect(result.state).toBe('completed');
      expect(result.claims.length).toBe(1);
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });

  it('a staleness reject takes NO replay reservation: the identical packet fulfills after a feed tick', async () => {
    const feed = makeFeed(Date.now() - 60_000); // stale from the start
    const swapNode = await buildFixtureSwapNode({
      rateProvider: feed.provider,
      maxRateAge: { defaultMs: 1_500 },
    });
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(22));
    try {
      const packet = buildWrappedPacket(swapNode, sender.secretKey);

      const stale = await sender.client.sendSwapPacket({
        destination: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        amount: 1_000_000n,
        toonData: packet,
      });
      expect(stale.accepted).toBe(false);
      expect(stale.code).toBe(STALE_RATE_REJECT_CODE);

      // Replaying the SAME bytes after a fresh tick must fulfill — proving
      // the gate rejected before the handler's seenPacketIds reservation
      // (an F04 here would mean the reject burned the packet id).
      feed.tick(Date.now());
      const retry = await sender.client.sendSwapPacket({
        destination: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        amount: 1_000_000n,
        toonData: packet,
      });
      expect(retry.accepted).toBe(true);
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });

  it('fresh packets unaffected: multi-packet streamSwap under an armed guard completes', async () => {
    const feed = makeFeed(Date.now());
    const refresher = setInterval(() => feed.tick(Date.now()), 100);
    const swapNode = await buildFixtureSwapNode({
      rateProvider: feed.provider,
      maxRateAge: { perChain: { evm: 1_500 }, defaultMs: 60_000 },
    });
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(23));
    try {
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 5_000_000n,
        packetCount: 5,
      });
      expect(result.state).toBe('completed');
      expect(result.claims.length).toBe(5);
      // Monotonic nonces — the guarded path still threads settlement context.
      const nonces = result.claims.map((c) => BigInt(c.nonce!));
      for (let i = 1; i < nonces.length; i++) {
        expect(nonces[i]! > nonces[i - 1]!).toBe(true);
      }
    } finally {
      clearInterval(refresher);
      await sender.close();
      await swapNode.stop();
    }
  });

  it('no maxRateAge → behavior is untouched even with an ancient timestamped quote', async () => {
    const feed = makeFeed(Date.now() - 3_600_000);
    const swapNode = await buildFixtureSwapNode({ rateProvider: feed.provider });
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(24));
    try {
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
      expect(result.state).toBe('completed');
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });
});
