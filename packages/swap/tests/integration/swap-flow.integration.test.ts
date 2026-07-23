/**
 * Story 12.8 — End-to-End Swap Flow Integration Tests
 *
 * In-process fixture topology (NOT Docker). See
 * `./helpers/fixture-topology.ts` for the peered-sender bridge:
 *   streamSwap() → gift-wrap (kind:1059) → in-process dispatch
 *     → real createSwapHandler + MultiChainClaimIssuer
 *     → signed claim → NIP-44 encrypted FULFILL → sender decrypts
 *     → buildSettlementTx() schema round-trip
 *
 * Source ACs: `_bmad-output/implementation-artifacts/12-8-e2e-swap-flow-integration-tests.md`
 * Source T-IDs: `_bmad-output/planning-artifacts/test-design-epic-12.md` §2.8
 *
 * Session 4 (2026-04-14 — Story 12.9 unblocked AC-3..AC-8, AC-12):
 *   Story 12.9 threaded `chainRecipient` through StreamSwapParams →
 *   rumor `chain-recipient` tag → swap-handler → claim-issuer →
 *   signer.signBalanceProof({ recipient }). With the schema drift fixed,
 *   AC-3..AC-7, AC-8, AC-12 un-skip here and assert against the real
 *   fulfilled swap. AC-9 remains opt-in (Anvil required).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  parseIlpPeerInfo,
  buildIlpPeerInfoEvent,
} from '@toon-protocol/core';
import {
  streamSwap,
  buildSettlementTx,
  SWAP_HANDLER_REJECT_CODES,
  SWAP_HANDLER_REJECT_MESSAGES,
  unwrapSwapPacketFromToon,
} from '@toon-protocol/sdk';
import type { BuildSettlementTxResult } from '@toon-protocol/sdk';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';

import type { SwapNodeInstance } from '@toon-protocol/swap';

import {
  FIXTURE_MNEMONIC,
  ANVIL_CHAIN_ID,
  buildFixtureSwapNode,
  buildFixtureSender,
  deriveFixtureConnectorEvmAddress,
  fixtureSwapPair,
  type FixtureSender,
} from './helpers/fixture-topology.js';

// ---------------------------------------------------------------------------
// Shared fixture values (Story 12.9 threaded chainRecipient)
// ---------------------------------------------------------------------------

/** Sender's 20-byte EVM payout address (chainRecipient for `evm:31337`). */
const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);
/** Second-sender EVM payout (AC-7 two-sender distinctness). */
const FIXTURE_EVM_RECIPIENT_2 = '0x' + '22'.repeat(20);
/** Deterministic ILP destination used by the fixture bridge. The handler
 *  dispatch is direct, so the value is illustrative only. */
const FIXTURE_SWAP_NODE_ILP_ADDRESS = 'g.toon.swap.fixture';

// ---------------------------------------------------------------------------
// AC-1 — Deterministic fixture topology
// ---------------------------------------------------------------------------

describe('AC-1 [P1] deterministic fixture topology (T-061 prerequisite)', () => {
  let swapNode: SwapNodeInstance;
  let sender: FixtureSender;

  beforeAll(async () => {
    swapNode = await buildFixtureSwapNode();
    sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(1));
  });

  afterAll(async () => {
    await sender?.close?.();
    await swapNode?.stop?.();
  });

  it('AC-1.0 — fixture mnemonic is 12 words (BIP-39 shape)', () => {
    expect(FIXTURE_MNEMONIC.split(' ')).toHaveLength(12);
  });

  it('AC-1.1 — connector-side (account 1) EVM address ≠ swap-node-side (account 2) EVM address (D12-011)', async () => {
    const account1Addr = await deriveFixtureConnectorEvmAddress();
    const account2Addr = swapNode.swapNodeKeys.evm?.address.toLowerCase();
    expect(account1Addr).toMatch(/^0x[0-9a-f]{40}$/);
    expect(account2Addr).toMatch(/^0x[0-9a-f]{40}$/);
    expect(account1Addr).not.toBe(account2Addr);
  });

  it('AC-1.2 — swapNode.identity.pubkey is a valid 32-byte Nostr x-only pubkey', () => {
    expect(swapNode.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-1.3 — /health responds status:"ok" within 2s', async () => {
    expect(swapNode.blsPort).toBeGreaterThan(0);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(`http://127.0.0.1:${swapNode.blsPort}/health`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
    } finally {
      clearTimeout(t);
    }
  });

  it('AC-1.4 — sender has distinct Nostr pubkey from swap node', () => {
    expect(sender.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(sender.publicKey).not.toBe(swapNode.identity.pubkey);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — kind:10032 publication round-trip (T-8C, covers AC-2 + AC-13)
// ---------------------------------------------------------------------------

describe('AC-2 [P1] kind:10032 publication round-trip + publisher injection (T-8C)', () => {
  it('AC-2.1/2/3/4/5 — mockPublisher captures exactly one kind:10032 event with swapPairs', async () => {
    const captured: unknown[] = [];
    const mockPublisher = {
      publish: async (event: unknown) => {
        captured.push(event);
      },
    };
    const swapNode = await buildFixtureSwapNode({ publisher: mockPublisher });
    try {
      const start = Date.now();
      while (captured.length === 0 && Date.now() - start < 3_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(captured.length).toBe(1);
      const ev = captured[0] as { kind: number };
      expect(ev.kind).toBe(10032);

      const parsed = parseIlpPeerInfo(
        ev as Parameters<typeof parseIlpPeerInfo>[0],
      );
      expect(parsed.swapPairs).toEqual([fixtureSwapPair()]);
    } finally {
      await swapNode.stop();
    }
  });

  it('AC-2.6 — parseIlpPeerInfo round-trips an event without swapPairs (coexistence regression)', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const built = buildIlpPeerInfoEvent(
      {
        pubkey: pk,
        ilpAddress: 'g.test.peer',
        btpEndpoint: 'ws://localhost:0/town-peer',
        assetCode: 'USD',
        assetScale: 6,
      },
      sk,
    );
    const parsed = parseIlpPeerInfo(built);
    expect(parsed.swapPairs).toBeUndefined();
  });

  it('AC-13.4 — rejecting publisher does NOT fail startSwapNode() boot', async () => {
    const rejectingPublisher = {
      publish: async () => {
        throw new Error('simulated relay outage');
      },
    };
    const swapNode = await buildFixtureSwapNode({ publisher: rejectingPublisher });
    try {
      expect(swapNode).toBeDefined();
      expect(swapNode.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await swapNode.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 — Handler registered on kind:1059 (malformed gift-wrap → REJECT)
// ---------------------------------------------------------------------------

describe('AC-3 [P1] Handler registered on kind:1059 (T-8D, R-010, R-015)', () => {
  let swapNode: SwapNodeInstance;
  let sender: FixtureSender;

  beforeAll(async () => {
    swapNode = await buildFixtureSwapNode();
    sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(3));
  });

  afterAll(async () => {
    await sender.close();
    await swapNode.stop();
  });

  it('AC-3 — malformed kind:1059 payload → ILP REJECT with INVALID_GIFT_WRAP', async () => {
    // Send arbitrary bytes (not a valid TOON gift-wrap) through the fixture
    // bridge. The swap handler unwrap step must fail and reject with the
    // gift-wrap-enforcement code. REJECT (rather than "no handler") proves
    // the handler IS registered on kind:1059 (R-015) AND enforces gift-wrap
    // shape (R-010).
    //
    // Per Story 12.8 AC-3: DO NOT hardcode error-code strings — assert
    // against the exported `SWAP_HANDLER_REJECT_CODES` / `_MESSAGES`
    // symbols so a handler refactor propagates here.
    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37, 0xde, 0xad]);
    const response = await sender.client.sendSwapPacket({
      destination: FIXTURE_SWAP_NODE_ILP_ADDRESS,
      amount: 1_000_000n,
      toonData: garbage,
    });
    expect(response.accepted).toBe(false);
    // INVALID_GIFT_WRAP (handler-owned). UNREACHABLE would indicate a
    // MISSING handler — we assert the handler-owned code to prove both
    // registration (R-015) and gift-wrap enforcement (R-010).
    expect(response.code).toBe(SWAP_HANDLER_REJECT_CODES.INVALID_GIFT_WRAP);
    expect(response.code).not.toBe(SWAP_HANDLER_REJECT_CODES.UNREACHABLE);
    expect(response.message).toBe(
      SWAP_HANDLER_REJECT_MESSAGES.INVALID_GIFT_WRAP,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4 — Full swap cycle, 1 and 10 packets, rate drift (T-061, T-064)
// ---------------------------------------------------------------------------

describe('AC-4 [P0] end-to-end swap: 1-packet, 10-packet, rate-drift (T-061, T-064)', () => {
  it('AC-4.1 — single-packet swap: 1 USDC → ~0.0004 ETH', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(4));
    try {
      const pair = fixtureSwapPair();
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair,
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });

      expect(result.state).toBe('completed');
      expect(result.claims.length).toBe(1);
      const claim = result.claims[0]!;
      expect(claim.pair.to.chain).toBe(`evm:${ANVIL_CHAIN_ID}`);
      // Expected: 1_000_000 source micros (scale 6) * 0.0004 rate
      //         = 400 target whole-units scaled to 18 → 4e14 wei.
      expect(claim.targetAmount).toBe(400_000_000_000_000n);
      // Settlement-context fields must be present (12.6 + 12.9 threading).
      expect(claim.channelId).toBeDefined();
      expect(claim.nonce).toBeDefined();
      expect(claim.cumulativeAmount).toBeDefined();
      expect(claim.recipient).toBe(FIXTURE_EVM_RECIPIENT);
      expect(claim.swapSignerAddress?.toLowerCase()).toBe(
        swapNode.swapNodeKeys.evm!.address.toLowerCase(),
      );
      expect(claim.claimBytes).toBeInstanceOf(Uint8Array);
      expect(claim.claimBytes.length).toBeGreaterThan(0);
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });

  it('AC-4.2 — 10-packet swap: monotonic nonces, all signed by same swap node signer', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(5));
    try {
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 10_000_000n,
        packetCount: 10,
      });

      expect(result.state).toBe('completed');
      expect(result.claims.length).toBe(10);
      const signers = new Set(
        result.claims.map((c) => c.swapSignerAddress?.toLowerCase()),
      );
      expect(signers.size).toBe(1);
      expect([...signers][0]).toBe(swapNode.swapNodeKeys.evm!.address.toLowerCase());

      // Monotonic nonce across the claim sequence (decimal strings compared
      // via BigInt to avoid lexicographic pitfalls).
      const nonces = result.claims.map((c) => BigInt(c.nonce!));
      for (let i = 1; i < nonces.length; i++) {
        expect(nonces[i]! > nonces[i - 1]!).toBe(true);
      }

      // Every packet issued a distinct ephemeral pubkey (AC-6.3 precondition).
      const ephemeralKeys = new Set(
        result.claims.map((c) => c.swapEphemeralPubkey),
      );
      expect(ephemeralKeys.size).toBe(10);
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });

  it('AC-4.3 — rate drift: rateProvider cycles through 3 rates; claims reflect all of them', async () => {
    const rates = ['0.0004', '0.0003', '0.0005'] as const;
    let callCount = 0;
    const rateProvider = async () => {
      const r = rates[callCount % rates.length]!;
      callCount++;
      return r;
    };
    const swapNode = await buildFixtureSwapNode({ rateProvider });
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(6));
    try {
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 9_000_000n,
        packetCount: 9,
      });

      expect(result.state).toBe('completed');
      expect(result.claims.length).toBe(9);

      // Observed rates set (via per-packet target / source) must contain all 3.
      //
      // Story 12.8 Standard Guard: DO NOT downcast BigInt → Number anywhere
      // in test assertions (USDC/ETH micro-units can exceed MAX_SAFE_INTEGER).
      // We compute the rate in "0.000X 4-decimal" form via pure BigInt
      // arithmetic: target * 10^(4 + (fromScale - toScale)) / source, which
      // yields an integer representing the rate with 4 decimals of precision.
      //
      // For the fixtureSwapPair: fromScale=6, toScale=18, so the scale
      // exponent is (4 + 6 - 18) = -8 → target / (source * 10^8) gives the
      // 4-decimal integer form (e.g. 0.0004 → 4).
      const observed = new Set<string>();
      const scaleDivisor = 10n ** 8n;
      for (const c of result.claims) {
        const rate4dec = c.targetAmount / (c.sourceAmount * scaleDivisor);
        // Format as '0.XXXX' from the 4-decimal integer.
        const intStr = rate4dec.toString().padStart(4, '0');
        observed.add(`0.${intStr}`);
      }
      for (const r of rates) {
        // Normalize rate string '0.0004' → already 4-decimal form.
        // Each input is a known 4-decimal literal; assert as-is.
        expect(observed.has(r)).toBe(true);
      }
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5 — No-op replay protection (T-8E)
// ---------------------------------------------------------------------------

describe('AC-5 [P1] replay protection via seenPacketIds (T-8E)', () => {
  it('AC-5 — re-sending a captured PREPARE yields F04 "Duplicate packet"', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(7));
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
      expect(sender.exchanges.length).toBe(1);

      // Replay the captured packet bytes verbatim. Expect F04 (duplicate).
      const captured = sender.exchanges[0]!;
      const replay = await sender.client.sendSwapPacket({
        destination: captured.destination,
        amount: captured.amount,
        toonData: captured.toonData,
      });
      expect(replay.accepted).toBe(false);
      expect(replay.code).toBe(SWAP_HANDLER_REJECT_CODES.DUPLICATE_PACKET);
      expect(replay.message).toBe(
        SWAP_HANDLER_REJECT_MESSAGES.DUPLICATE_PACKET,
      );
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6 — Intermediary privacy properties (T-062, T-063, R-006)
// ---------------------------------------------------------------------------

describe('AC-6 [P0] intermediary privacy — gift-wrap opaque, distinct ephemerals (T-062/063, R-006)', () => {
  it('AC-6.1/6.2 — outbound PREPARE is a kind:1059 gift-wrap opaque to non-swap-node keys', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(8));
    try {
      await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });

      const captured = sender.exchanges[0]!;

      // AC-6.1: the outbound PREPARE's `toonData` MUST decode to a
      // well-formed kind:1059 gift-wrap at the TOON-codec layer. This is
      // the observable-from-intermediary layer assertion: a wire-monitor
      // peer sees a kind:1059 event (not, say, a plaintext swap rumor).
      //
      // `unwrapSwapPacketFromToon` internally decodes the TOON bytes and
      // validates `rumor.kind === 1059` wrapping; a non-gift-wrap shape
      // throws at decode, not at NIP-44 decrypt. To prove shape rather
      // than decryptability, we confirm the raw bytes parse as a TOON
      // event of kind 1059 by decoding with the core decoder directly.
      const { decodeEventFromToon } = await import('@toon-protocol/core');
      const giftWrapEvent = decodeEventFromToon(captured.toonData);
      expect(giftWrapEvent.kind).toBe(1059);

      // AC-6.2: attempting to decrypt the gift-wrap with a NON-swap-node private
      // key throws. This is what an intermediary on the ILP path would
      // experience — opaque ciphertext, no recoverable plaintext.
      const nonSwapNodeSk = generateSecretKey();
      expect(() =>
        unwrapSwapPacketFromToon({
          toonData: captured.toonData,
          recipientSecretKey: nonSwapNodeSk,
        }),
      ).toThrow();
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });

  it('AC-6.3 — 10-packet swap emits 10 distinct swap-node-side ephemeral pubkeys (D12-008, R-006)', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(9));
    try {
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 10_000_000n,
        packetCount: 10,
      });
      expect(result.claims.length).toBe(10);
      const ephemeralKeys = new Set(
        result.claims.map((c) => c.swapEphemeralPubkey),
      );
      expect(ephemeralKeys.size).toBe(10);
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });

  it('AC-6.4 — FULFILL claim ciphertext is sender-only readable (non-sender key throws)', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(10));
    try {
      await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
      const exchange = sender.exchanges[0]!;
      expect(exchange.response.accepted).toBe(true);
      const metaJson = Buffer.from(exchange.response.data!, 'base64').toString(
        'utf8',
      );
      const meta = JSON.parse(metaJson) as {
        claim: string;
        ephemeralPubkey: string;
      };
      // Attempt to decrypt with a random non-sender key — must throw.
      const nonSenderSk = generateSecretKey();
      const conv = nip44.v2.utils.getConversationKey(
        nonSenderSk,
        meta.ephemeralPubkey,
      );
      expect(() => nip44.v2.decrypt(meta.claim, conv)).toThrow();
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 + AC-12 — Two senders, sticky channel binding (T-066)
// ---------------------------------------------------------------------------

describe('AC-7 + AC-12 [P1] two-sender swap + sticky per-sender channel binding (T-066)', () => {
  it('AC-7 — two distinct senders both receive claims signed by same swap node', async () => {
    const swapNode = await buildFixtureSwapNode({ channelCount: 2 });
    const senderA = await buildFixtureSender(swapNode, new Uint8Array(32).fill(11));
    const senderB = await buildFixtureSender(swapNode, new Uint8Array(32).fill(12));
    try {
      expect(senderA.publicKey).not.toBe(senderB.publicKey);

      const resA = await streamSwap({
        client: senderA.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: senderA.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
      const resB = await streamSwap({
        client: senderB.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: senderB.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT_2,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });

      expect(resA.state).toBe('completed');
      expect(resB.state).toBe('completed');
      expect(resA.claims.length).toBe(1);
      expect(resB.claims.length).toBe(1);

      const swapNodeAddr = swapNode.swapNodeKeys.evm!.address.toLowerCase();
      expect(resA.claims[0]!.swapSignerAddress?.toLowerCase()).toBe(swapNodeAddr);
      expect(resB.claims[0]!.swapSignerAddress?.toLowerCase()).toBe(swapNodeAddr);

      expect(resA.claims[0]!.recipient).toBe(FIXTURE_EVM_RECIPIENT);
      expect(resB.claims[0]!.recipient).toBe(FIXTURE_EVM_RECIPIENT_2);

      // AC-12: each sender sticky-bound to a DISTINCT channel entry
      // (provisioning supplies 2 channels; two distinct senders must map
      // to disjoint channelIds on first use).
      expect(resA.claims[0]!.channelId).toBeDefined();
      expect(resB.claims[0]!.channelId).toBeDefined();
      expect(resA.claims[0]!.channelId).not.toBe(resB.claims[0]!.channelId);

      // Sticky regression: a second packet from senderA must re-use the
      // same channelId (sticky binding).
      const resA2 = await streamSwap({
        client: senderA.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: senderA.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
      expect(resA2.state).toBe('completed');
      expect(resA2.claims[0]!.channelId).toBe(resA.claims[0]!.channelId);
    } finally {
      await senderA.close();
      await senderB.close();
      await swapNode.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8 — streamSwap() → buildSettlementTx() schema round-trip (T-8A)
// ---------------------------------------------------------------------------

describe('AC-8 [P0] streamSwap → buildSettlementTx schema round-trip (T-8A)', () => {
  it('AC-8 — claims feed directly into buildSettlementTx with NO transformation', async () => {
    const swapNode = await buildFixtureSwapNode();
    const sender = await buildFixtureSender(swapNode, new Uint8Array(32).fill(13));
    try {
      const result = await streamSwap({
        client: sender.client,
        swapPubkey: swapNode.identity.pubkey,
        swapIlpAddress: FIXTURE_SWAP_NODE_ILP_ADDRESS,
        pair: fixtureSwapPair(),
        senderSecretKey: sender.secretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 10_000_000n,
        packetCount: 10,
      });
      expect(result.state).toBe('completed');
      expect(result.claims.length).toBe(10);

      const chain = `evm:${ANVIL_CHAIN_ID}`;
      // Test-only channel contract addr (EVM format). The real Anvil
      // deployment lives in AC-9.
      const channelContractAddress = '0x' + 'cc'.repeat(20);

      // NO transformation, NO adaptation — pipe AccumulatedClaim[] directly.
      const settlement: BuildSettlementTxResult = buildSettlementTx({
        claims: result.claims,
        signers: {
          [chain]: {
            address: swapNode.swapNodeKeys.evm!.address.toLowerCase(),
            contractAddress: channelContractAddress,
            chainId: ANVIL_CHAIN_ID,
          },
        },
        recipients: { [chain]: FIXTURE_EVM_RECIPIENT },
      });

      expect(settlement.bundles.length).toBeGreaterThan(0);
      const bundle = settlement.bundles[0]!;
      expect(bundle.chain).toBe(chain);
      expect(bundle.chainKind).toBe('evm');
      expect(bundle.unsignedTxBytes).toBeInstanceOf(Uint8Array);
      expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
      expect(bundle.recipient).toBe(FIXTURE_EVM_RECIPIENT);
      expect(bundle.swapSignerAddress.toLowerCase()).toBe(
        swapNode.swapNodeKeys.evm!.address.toLowerCase(),
      );
      // Winner should be highest-nonce claim (all 10 merged into one bundle).
      expect(bundle.claimsMerged).toBe(10);
      expect(settlement.rejected.length).toBe(0);
    } finally {
      await sender.close();
      await swapNode.stop();
    }
  });
});

