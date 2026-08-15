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
 *     spec R5 verify-before-reveal: it verifies the advance payload's chain
 *     signature FOR REAL (issue #103) via `@toon-protocol/settlement-digest`'s
 *     shared v2 recovery primitive — the SAME one every real verifier
 *     (client, sdk, connector, on-chain RollingSwapChannel) uses, never a
 *     hand-rolled reimplementation — then checks recipient, watermark
 *     monotonicity (over ACCEPTED packets only — R8: claims from rejected
 *     packets are void), and its rate floor, and only then reveals the
 *     preimage.
 *
 * Scenarios: multi-packet rolling swap (AC-1/AC-5 contract level), maker
 * stall / sender withhold mid-stream (AC-1/AC-2), legacy gift-wrap
 * coexistence on the same node (zero-condition path unchanged), and (issue
 * #103) three signature-verification guards: a tampered claim withholds the
 * reveal and unwinds, a claim verified under the wrong chain domain is
 * rejected, and a v1-style raw-packed signature fails v2 verification.
 *
 * The guard is known to bite (issue #103 AC-6), not assumed to: reverting
 * `EvmPaymentChannelSigner.signBalanceProof` to the pre-#101 v1 digest fails
 * both swap#47 rolling scenarios plus the AC-1/AC-2 case below.
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import { encodeEventToToon } from '@toon-protocol/core';
import { wrapSwapPacket } from '@toon-protocol/sdk';
import {
  verifyEvmClaimSignature,
  recoverEvmSigner,
  bigintToBytes32BE,
  concatBytes,
} from '@toon-protocol/settlement-digest';
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
const SENDER_ILP = 'g.toon.client.rollingsender';
const STREAM_NONCE = '7e'.repeat(16);
const INITIAL_INVENTORY = 10n ** 20n; // 100 ETH (wei)
const INVENTORY_KEY = `ETH:${CHAIN}`;

// v2 EIP-712 domain (issue #101) the fixture swap node signs leg-B claims
// under: the EIP-155 id embedded in CHAIN, and the `chainProviders`
// channelAddress configured below. The sender daemon verifies against this
// SAME domain by default.
const CHAIN_ID = 31337n;
const CHANNEL_CONTRACT_ADDRESS = '0x' + '33'.repeat(20);

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
  /**
   * One-shot toggle (issue #103 AC-2): when true, the NEXT claim's signature
   * bytes are flipped before verification — modeling a cross-repo wire break
   * (wrong digest layout, wrong domain, a stale signer). The flag is consumed
   * by that single check, so every later packet verifies untouched.
   */
  corruptNextSignature: boolean;
}

type LegBSender = (prepare: LegBPrepare) => Promise<LegBResult>;

interface SenderDaemonOptions {
  /**
   * EIP-712 domain the sender verifies leg-B claims under (issue #103).
   * Defaults to the fixture swap node's own domain; the AC-3 negative test
   * overrides these to prove a claim signed under one chain's domain is
   * rejected under another's.
   */
  chainId?: bigint;
  verifyingContract?: string;
}

function makeSenderDaemon(opts: SenderDaemonOptions = {}): SenderDaemon {
  const chainId = opts.chainId ?? CHAIN_ID;
  const verifyingContract = opts.verifyingContract ?? CHANNEL_CONTRACT_ADDRESS;
  const preimages = new Map<string, Uint8Array>();
  let lastAcceptedNonce = 0n;
  let lastAcceptedCumulative = 0n;

  const daemon: SenderDaemon = {
    advances: [],
    reveal: true,
    minExchangeRate: 0.00035,
    corruptNextSignature: false,
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

      // R5 verification, BEFORE any reveal.
      if (
        advance.proto !== ROLLING_PROTOCOL ||
        advance.type !== 'advance' ||
        advance.claim.length === 0
      ) {
        return { type: 'reject', code: 'F99', message: 'malformed advance' };
      }

      // (a) Chain-signature verification (issue #103) — the claim MUST
      // recover to the on-chain signer the advance advertises, under the
      // session's v2 EIP-712 domain (chainId + verifyingContract), using the
      // SAME shared digest leaf's recovery primitive every real verifier
      // (client, sdk, connector, on-chain RollingSwapChannel) uses rather
      // than a hand-rolled reimplementation. A wrong digest layout, a wrong
      // domain, a v1-shaped signature — anything that fails to recover to
      // that address is rejected HERE, before any reveal.
      if (
        !advance.channelId ||
        advance.nonce === undefined ||
        advance.cumulativeAmount === undefined ||
        !advance.recipient ||
        !advance.swapSignerAddress
      ) {
        return {
          type: 'reject',
          code: 'F99',
          message: 'claim missing settlement metadata',
        };
      }
      // `Buffer.from(_, 'base64')` never throws — it drops invalid
      // characters — so a garbled claim surfaces as a failed recovery below.
      const claimBytes = new Uint8Array(Buffer.from(advance.claim, 'base64'));
      if (daemon.corruptNextSignature) {
        daemon.corruptNextSignature = false;
        claimBytes[0] = (claimBytes[0] ?? 0) ^ 0xff;
      }
      // A malformed field length or an invalid `v` byte makes the shared
      // verifier throw — that is a verification failure, not a fixture crash.
      let sigValid: boolean;
      try {
        sigValid = verifyEvmClaimSignature(
          {
            channelId: advance.channelId,
            cumulativeAmount: advance.cumulativeAmount,
            nonce: advance.nonce,
            recipient: advance.recipient,
            chainId,
            verifyingContract,
          },
          claimBytes,
          advance.swapSignerAddress
        ).valid;
      } catch {
        sigValid = false;
      }
      if (!sigValid) {
        return {
          type: 'reject',
          code: 'F99',
          message: 'signature verification failed',
        };
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
    chainProviders: [
      {
        chainType: 'evm',
        chainId: CHAIN,
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        channelAddress: CHANNEL_CONTRACT_ADDRESS,
      },
    ],
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

// ---------------------------------------------------------------------------
// Issue #103 — the sender verifies leg-B claim signatures for real
// ---------------------------------------------------------------------------

// The pre-#101 hand-rolled v1 digest (no chainId/verifyingContract binding)
// — byte-identical to @toon-protocol/core@2.1.0's `balanceProofHashEvm`,
// which sdk@2.2.0 re-exported. Neither sdk@3.1.8 nor core@3.4.0 export this
// shape anymore (both now re-export the v2 digest from
// @toon-protocol/settlement-digest under the same name — issue #112),
// so the AC-4 negative test below reconstructs it locally to prove a
// v1-shaped signature still fails v2 verification.
function balanceProofHashEvmV1(
  channelIdBytes: Uint8Array,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipientBytes: Uint8Array
): Uint8Array {
  return keccak_256(
    concatBytes(
      channelIdBytes,
      bigintToBytes32BE(cumulativeAmount),
      bigintToBytes32BE(nonce),
      recipientBytes
    )
  );
}

describe('issue #103 — leg-B claim signature verification (integration)', () => {
  it('AC-1/AC-2: a tampered claim signature fails verification — the sender withholds the reveal and the packet unwinds', async () => {
    const daemon = makeSenderDaemon();
    const { instance, handler } = await bootRollingNode(daemon);
    try {
      // Packet 1 fills normally — proves the guard does not false-positive
      // on a genuinely valid v2 signature.
      expect((await driveFill(handler, daemon, 1, DELTA)).wire).toBe('FULFILL');
      const availableAfter1 =
        instance.health().inventoryAvailable[INVENTORY_KEY];

      // Packet 2: the claim's signature bytes are flipped in flight — a
      // stand-in for the exact class of cross-repo wire break (wrong
      // digest layout, wrong domain, a stale signer) that shipped in
      // toon-meta#394. The sender MUST reject before revealing.
      daemon.corruptNextSignature = true;
      const tampered = await driveFill(handler, daemon, 2, DELTA);
      expect(tampered.wire).toBe('REJECT');
      expect(daemon.advances).toHaveLength(2);

      // Full unwind: nothing stayed reserved for the rejected packet —
      // same window-release contract as the maker-stall scenario above.
      expect(instance.health().inventoryAvailable[INVENTORY_KEY]).toBe(
        availableAfter1
      );
      expect(instance.health().inventoryWindow[INVENTORY_KEY]!).toMatchObject({
        inFlight: '0',
        unsettled: DELTA_WEI.toString(),
      });

      // Recovery: a genuinely signed claim on a fresh seq fills normally —
      // proves the guard is a per-packet check, not a stuck failure mode.
      expect((await driveFill(handler, daemon, 3, DELTA)).wire).toBe('FULFILL');
    } finally {
      await instance.stop();
    }
  });

  it('AC-3: a claim signed under the fixture node domain fails verification under a different chain domain', async () => {
    // The sender expects a DIFFERENT (chainId, verifyingContract) pair than
    // the one the fixture swap node actually signs under — the exact replay
    // protection v2's domain separation exists to provide.
    const daemon = makeSenderDaemon({
      chainId: 84532n,
      verifyingContract: '0x' + 'cc'.repeat(20),
    });
    const { instance, handler } = await bootRollingNode(daemon);
    try {
      const outcome = await driveFill(handler, daemon, 1, DELTA);
      expect(outcome.wire).toBe('REJECT');
      // The advance WAS received and parsed — this is a signature-domain
      // failure, not a malformed/undelivered packet.
      expect(daemon.advances).toHaveLength(1);
      expect(instance.health().inventoryWindow[INVENTORY_KEY]!).toMatchObject({
        inFlight: '0',
        unsettled: '0',
      });
    } finally {
      await instance.stop();
    }
  });

  it('AC-4: a v1-style raw-packed signature (pre-#101 wire format) fails v2 verification — fail-closed pinning', async () => {
    const daemon = makeSenderDaemon();
    const { instance } = await bootRollingNode(daemon);
    try {
      const evmKeys = instance.swapNodeKeys.evm;
      if (!evmKeys) throw new Error('fixture swap node derived no EVM key');

      const channelIdBytes = new Uint8Array(
        Buffer.from(CHANNEL_ID.slice(2), 'hex')
      );
      const recipientBytes = new Uint8Array(
        Buffer.from(CHAIN_RECIPIENT.slice(2), 'hex')
      );
      const cumulativeAmount = DELTA_WEI;
      const nonce = 1n;

      // The pre-#101 hand-rolled v1 digest: no chainId / verifyingContract
      // binding at all — the exact gap toon-meta#394 identifies as the root
      // cause. Signed here with the maker's REAL private key, so a v1/v2
      // mismatch — not a wrong key — is the only variable.
      const v1Digest = balanceProofHashEvmV1(
        channelIdBytes,
        cumulativeAmount,
        nonce,
        recipientBytes
      );
      const recoveredBytes = secp256k1.sign(v1Digest, evmKeys.privateKey, {
        prehash: false,
        format: 'recovered',
      });
      const sigObj = secp256k1.Signature.fromBytes(recoveredBytes, 'recovered');
      const { recovery } = sigObj;
      if (recovery !== 0 && recovery !== 1) {
        throw new Error(`unexpected recovery id ${String(recovery)}`);
      }
      // Same r||s||v layout EvmPaymentChannelSigner emits — only the digest
      // underneath it is v1.
      const v1Sig = new Uint8Array(65);
      v1Sig.set(sigObj.toBytes('compact'), 0);
      v1Sig[64] = 27 + recovery;

      // Sanity: the v1 signature DOES recover under the legacy v1 digest —
      // it is well-formed, simply v1, not malformed (mirrors the epic's own
      // probe in toon-meta#394).
      const v1Recovered = recoverEvmSigner(v1Digest, v1Sig);
      expect(v1Recovered.toLowerCase()).toBe(evmKeys.address.toLowerCase());

      // `version: "2"` exists to make this fail closed: the SAME signature
      // does not verify against the v2 EIP-712 digest.
      const { valid } = verifyEvmClaimSignature(
        {
          channelId: CHANNEL_ID,
          cumulativeAmount,
          nonce,
          recipient: CHAIN_RECIPIENT,
          chainId: CHAIN_ID,
          verifyingContract: CHANNEL_CONTRACT_ADDRESS,
        },
        v1Sig,
        evmKeys.address
      );
      expect(valid).toBe(false);
    } finally {
      await instance.stop();
    }
  });
});
