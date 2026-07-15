/**
 * swap#50 — rolling swap settlement-batching e2e (spec §8/§9).
 *
 * THE PROPERTY UNDER TEST: a rolling swap of N coupled micro-packets between
 * two parties across two chains produces N leg-A channel advances and N
 * leg-B channel advances OFF-chain, and at close exactly ONE on-chain
 * settlement per chain, each for the final cumulative watermark. The chains
 * see only the envelope.
 *
 * ## Topology (all real, in-process — no Docker)
 *
 *   two anvils               chain A (evm:31337): TokenNetwork + USDC
 *                            chain B (evm:31338): RollingSwapChannel fixture
 *
 *   senderConnector ══ BTP ══ makerConnector           (two REAL ConnectorNodes,
 *        │    ▲                   │                     mutual BTP peering,
 *        │    │                   ├─ setPacketHandler → startSwapNode()
 *        │    │                   │    (rolling engine; leg-B egress via the
 *        │    │                   │     PUBLIC sendPacket executionCondition)
 *        │    └── leg-B PREPARE ──┘
 *        └─ setLocalDeliveryHandler → sender daemon (R5 verify-before-reveal,
 *           via @toon-protocol/client 0.18.0 `ingestReceivedClaims`)
 *
 *   - Leg-A fills: `senderConnector.sendPacket({ executionCondition })` →
 *     BTP → maker connector → local delivery → rolling engine. The sender
 *     connector's PerPacketClaimService attaches REAL chain-A channel claims
 *     (TokenNetwork channel on anvil A) to every forwarded fill; the maker
 *     connector's ClaimReceiver ingests + verifies them.
 *   - Leg-A close: the connector's OWN settlement auto-drive — the
 *     proxy-apex `SettlementMonitor` (threshold crossing) triggering
 *     `SettlementExecutor.claimFromChannel()` — submits the ONE on-chain
 *     TokenNetwork claim. No test code initiates the chain-A settlement.
 *   - Leg-B close: the receive side (toon-client#352's machinery:
 *     `ingestReceivedClaims` → `JsonFileReceivedClaimStore` →
 *     `buildSwapSettlements` → `submitEvmSettlement`) redeems the final
 *     watermark against the RollingSwapChannel contract on anvil B.
 *   - Receipts (sdk 2.2.0, toon#84): the maker signs a per-fulfill stream
 *     receipt on every accept record; the sender accumulates them in a
 *     `ReceiptChainTracker` and the artifact must match the settled amount.
 *
 * ## Gating
 *
 * Runtime-skips when `anvil` is not on PATH (the devbox CI job pins
 * foundry, so it runs there). Ports are fixed but uncommon.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { privateKeyToAccount } from 'viem/accounts';

import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import type {
  LocalDeliveryRequest,
  LocalDeliveryResponse,
} from '@toon-protocol/connector';
import {
  ReceiptChainTracker,
  serializeReceiptChain,
  verifyStreamReceipt,
} from '@toon-protocol/sdk';
import type { AccumulatedClaim, SwapPair } from '@toon-protocol/sdk';
import {
  ingestReceivedClaims,
  JsonFileReceivedClaimStore,
  buildSwapSettlements,
  submitEvmSettlement,
} from '@toon-protocol/client';
import { startSwapNode, ROLLING_PROTOCOL } from '@toon-protocol/swap';
import type {
  RollingAcceptRecord,
  RollingAdvancePayload,
  SwapNodeConfig,
  SwapNodeInstance,
} from '@toon-protocol/swap';

import {
  isAnvilAvailable,
  startAnvil,
  rpc,
  sendUnlockedTx,
  getLogs,
  pad32,
  encodeCall,
  waitFor,
  USDC_TOKEN_ADDRESS,
  TOKEN_NETWORK_REGISTRY_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  ROLLING_SWAP_CHANNEL_ADDRESS,
  MAKER_EVM_PRIVATE_KEY,
  MAKER_EVM_ADDRESS,
  SENDER_EVM_PRIVATE_KEY,
  SENDER_EVM_ADDRESS,
  SETTLE_SUBMITTER_PRIVATE_KEY,
  type AnvilInstance,
} from './helpers/rolling-e2e-harness.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANVIL_A_PORT = 18601;
const ANVIL_B_PORT = 18602;
const MAKER_BTP_PORT = 18611;
const SENDER_BTP_PORT = 18612;
const MAKER_HEALTH_PORT = 18613;
const SENDER_HEALTH_PORT = 18614;

const CHAIN_A = 'evm:31337';
const CHAIN_B = 'evm:31338';

const MAKER_ILP = 'g.toon.swap.e2e';
const SENDER_DAEMON_ILP = 'g.toon.client.e2edaemon';

const STREAM_NONCE = '6e'.repeat(16);
/** Chain-B channel id provisioned on both the swap node and the contract. */
const CHANNEL_B_ID = '0x' + '5b'.repeat(32);
/**
 * Chain-B payout address: a key-less fresh account, so its final balance is
 * EXACTLY the settled watermark (no gas spend can perturb it — the gas payer
 * is anvil account #5, never a party).
 */
const CHAIN_B_RECIPIENT = '0x' + '7e57'.repeat(10);

/** USDC (chain A) → USDB (chain B, paid 1:1 in wei by the fixture contract). */
const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN_A },
  to: { assetCode: 'USDB', assetScale: 6, chain: CHAIN_B },
  rate: '0.5',
};
const POOL_KEY = `USDB:${CHAIN_B}`;

const DELTA = 2_000_000n; // 2 USDC per fill
const TARGET = 1_000_000n; // ⌊δ·0.5⌋ per fill
const TOTAL_FILLS = 25; // seq 1..25; seq FAIL_SEQ is withheld mid-stream
const FAIL_SEQ = 3;
const FULFILLED = TOTAL_FILLS - 1; // 24
const FINAL_WATERMARK_B = TARGET * BigInt(FULFILLED); // 24_000_000

/** Warmup packet amount (registers the claim pipeline; see docker notes). */
const WARMUP = 100n;

/**
 * Chain-A auto-drive threshold. Per-packet claims attach at FORWARD time on
 * the sender→maker hop, so the maker's received cumulative advances by δ for
 * EVERY attempted fill (including the withheld one) plus the warmup:
 * final = WARMUP + TOTAL_FILLS·δ = 50_000_100. The threshold sits between
 * the second-to-last and last attempt so the LAST fill's claim (and only it)
 * crosses — the settlement fires once, at close, for the final watermark.
 * (Empirically pinned; if claim accounting ever changes to fulfilled-only,
 * the exactly-one assertion below will catch it loudly.)
 */
const LEG_A_FINAL = WARMUP + DELTA * BigInt(TOTAL_FILLS); // 50_000_100
const SETTLE_THRESHOLD_A = (LEG_A_FINAL - DELTA / 2n).toString(); // 49_000_100

const MNEMONIC = 'test test test test test test test test test test test junk';

// Event topics / selectors.
const topic = (sig: string): string =>
  '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
const selector = (sig: string): string =>
  Buffer.from(keccak_256(new TextEncoder().encode(sig)))
    .slice(0, 4)
    .toString('hex');

const CHANNEL_CLAIMED_TOPIC = topic(
  'ChannelClaimed(bytes32,address,uint256,uint256)'
);
const CHANNEL_OPENED_TOPIC = topic(
  'ChannelOpened(bytes32,address,address,uint256)'
);
const SETTLEMENT_SUCCEEDED_TOPIC = topic(
  'SettlementSucceeded(bytes32,uint256,uint256,address)'
);

// ---------------------------------------------------------------------------
// Sender daemon (leg-B terminator) — toon-client#352's role, R5 semantics
// ---------------------------------------------------------------------------

interface SenderDaemon {
  handler: (
    request: LocalDeliveryRequest,
    sourcePeerId: string
  ) => Promise<LocalDeliveryResponse>;
  /** Register a freshly minted (preimage, condition) pair. */
  mint(): { preimage: Uint8Array; conditionB64: string };
  /** Toggle: withhold every reveal (mid-stream failure scenario). */
  reveal: boolean;
  advances: RollingAdvancePayload[];
  store: JsonFileReceivedClaimStore;
  expectedSignerAddress: string;
}

function makeSenderDaemon(
  storePath: string,
  swapSignerAddress: string
): SenderDaemon {
  const preimages = new Map<string, Uint8Array>();
  const store = new JsonFileReceivedClaimStore(storePath);

  const daemon: SenderDaemon = {
    reveal: true,
    advances: [],
    store,
    expectedSignerAddress: swapSignerAddress,
    mint() {
      const preimage = new Uint8Array(32);
      globalThis.crypto.getRandomValues(preimage);
      const conditionB64 = Buffer.from(sha256(preimage)).toString('base64');
      preimages.set(conditionB64, preimage);
      return { preimage, conditionB64 };
    },
    handler: async (request) => {
      let advance: RollingAdvancePayload;
      try {
        advance = JSON.parse(
          Buffer.from(request.data, 'base64').toString('utf8')
        ) as RollingAdvancePayload;
      } catch {
        return { reject: { code: 'F99', message: 'not JSON' } };
      }
      if (advance.proto !== ROLLING_PROTOCOL || advance.type !== 'advance') {
        return { reject: { code: 'F99', message: 'not a rolling advance' } };
      }
      daemon.advances.push(advance);

      // R5 verify-before-reveal, using the REAL client 0.18.0 pipeline
      // (signature vs the advertised signer, recipient equality, monotone
      // nonce+cumulative vs the persisted watermark, Δcumulative covers
      // targetAmount). The store is only allowed to keep the watermark when
      // the daemon actually reveals: per spec R8 a claim from a packet the
      // sender REJECTS is void, so a withheld packet's ingest is rolled
      // back (the production daemon composes verification and the reveal
      // decision atomically — toon-client#358 discusses that seam).
      const claim: AccumulatedClaim = {
        packetIndex: advance.seq,
        sourceAmount: BigInt(advance.sourceAmount),
        targetAmount: BigInt(advance.targetAmount),
        claimBytes: new Uint8Array(Buffer.from(advance.claim, 'base64')),
        swapEphemeralPubkey: '0'.repeat(64),
        pair: PAIR,
        receivedAt: Date.now(),
        ...(advance.channelId !== undefined && {
          channelId: advance.channelId,
        }),
        ...(advance.nonce !== undefined && { nonce: advance.nonce }),
        ...(advance.cumulativeAmount !== undefined && {
          cumulativeAmount: advance.cumulativeAmount,
        }),
        ...(advance.recipient !== undefined && {
          recipient: advance.recipient,
        }),
        ...(advance.swapSignerAddress !== undefined && {
          swapSignerAddress: advance.swapSignerAddress,
        }),
        rate: advance.rate,
        rateTimestamp: advance.rateTimestamp,
      };

      const prev = advance.channelId
        ? store.load(PAIR.to.chain, advance.channelId)
        : undefined;
      const result = ingestReceivedClaims({
        claims: [claim],
        expectedChain: PAIR.to.chain,
        chainRecipient: CHAIN_B_RECIPIENT,
        expectedSignerAddress: daemon.expectedSignerAddress,
        store,
      });
      if (result.verified.length !== 1) {
        const why = result.rejected[0]?.error;
        return {
          reject: {
            code: 'F99',
            message: `claim verification failed: ${why?.code ?? 'unknown'}`,
          },
        };
      }

      if (!daemon.reveal) {
        // Withhold the reveal — and roll the persisted watermark back to
        // the pre-ingest snapshot (R8: this claim is void).
        if (prev) store.save(prev);
        else if (advance.channelId)
          store.delete(PAIR.to.chain, advance.channelId);
        return { reject: { code: 'T00', message: 'reveal withheld (test)' } };
      }

      const preimage = preimages.get(request.executionCondition ?? '');
      if (!preimage) {
        return { reject: { code: 'F99', message: 'unknown condition' } };
      }
      return {
        fulfill: {
          fulfillment: Buffer.from(preimage).toString('base64'),
          data: Buffer.from('{}', 'utf8').toString('base64'),
        },
      };
    },
  };
  return daemon;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const BOOT_TIMEOUT = 240_000;

describe('swap#50 — N advances net to ONE settlement per chain (rolling e2e)', () => {
  const anvilOk = isAnvilAvailable();

  let scratch: string;
  let prevCwd: string;
  let anvilA: AnvilInstance | null = null;
  let anvilB: AnvilInstance | null = null;
  let makerConnector: ConnectorNode | null = null;
  let senderConnector: ConnectorNode | null = null;
  let swapNode: SwapNodeInstance | null = null;
  let daemon: SenderDaemon;
  let tracker: ReceiptChainTracker;
  let senderNostrPubkey: string;

  /** Accept records per fulfilled fill, in order. */
  const accepts: RollingAcceptRecord[] = [];
  /** Wire outcome of the withheld fill. */
  let withheldOutcome: { type: number; code?: string } | null = null;
  let chainBSettleTxHash: string | null = null;

  beforeAll(async () => {
    if (!anvilOk) return;
    prevCwd = process.cwd();
    scratch = mkdtempSync(join(tmpdir(), 'swap50-e2e-'));
    // The connector's libsql claim DBs are created at ./data/*.db relative
    // to cwd — point cwd at the scratch dir so runs never pollute the repo.
    mkdirSync(join(scratch, 'data'), { recursive: true });
    process.chdir(scratch);

    // 1. Chains.
    anvilA = await startAnvil({ port: ANVIL_A_PORT, chainId: 31337 });
    anvilB = await startAnvil({ port: ANVIL_B_PORT, chainId: 31338 });

    // 2. Maker connector — the proxy-apex role: chain-A provider (claims +
    //    settlement auto-drive), threshold pinned so the LAST fill's claim
    //    crosses it; routes deliver MAKER_ILP locally and leg-B PREPAREs to
    //    the sender peer.
    makerConnector = new ConnectorNode(
      {
        nodeId: 'maker-apex',
        btpServerPort: MAKER_BTP_PORT,
        healthCheckPort: MAKER_HEALTH_PORT,
        environment: 'development',
        deploymentMode: 'embedded',
        peers: [
          {
            id: 'sender-conn',
            url: `ws://127.0.0.1:${SENDER_BTP_PORT}`,
            authToken: '',
            evmAddress: SENDER_EVM_ADDRESS,
            chain: CHAIN_A,
          },
        ],
        routes: [
          { prefix: MAKER_ILP, nextHop: 'maker-apex', priority: 100 },
          { prefix: 'g.toon.client', nextHop: 'sender-conn', priority: 50 },
        ],
        localDelivery: { enabled: false },
        settlement: {
          connectorFeePercentage: 0,
          enableSettlement: true,
          tigerBeetleClusterId: 0,
          tigerBeetleReplicas: [],
        },
        chainProviders: [
          {
            chainType: 'evm',
            chainId: CHAIN_A,
            rpcUrl: anvilA.rpcUrl,
            registryAddress: TOKEN_NETWORK_REGISTRY_ADDRESS,
            tokenAddress: USDC_TOKEN_ADDRESS,
            keyId: MAKER_EVM_PRIVATE_KEY,
            settlementOptions: { threshold: SETTLE_THRESHOLD_A },
          },
        ],
      },
      createLogger('maker-apex', 'error')
    );

    // 3. Swap node on the maker connector (operator-owned mode) — the REAL
    //    production wiring: dispatch matrix + rolling engine + leg-B egress
    //    through the connector's PUBLIC sendPacket executionCondition.
    const swapConfig: SwapNodeConfig = {
      mnemonic: MNEMONIC,
      connector: makerConnector as unknown as SwapNodeConfig['connector'],
      swapPairs: [PAIR],
      chains: ['evm'],
      // v2 EIP-712 domain (connector#324 finding #1): the swap node signs
      // chain-B claims that are settled on-chain against the deployed
      // RollingSwapChannel. The v2 signer folds (chainId, verifyingContract)
      // into the digest and fails closed without a settlement address, so the
      // deployed RollingSwapChannel address MUST be threaded per chain here —
      // it is the exact `verifyingContract` the on-chain contract + client
      // `buildSwapSettlements` reconstruct the digest against.
      chainProviders: [
        {
          chainType: 'evm',
          chainId: CHAIN_B,
          rpcUrl: anvilB.rpcUrl,
          registryAddress: ROLLING_SWAP_CHANNEL_ADDRESS,
          tokenAddress: USDC_TOKEN_ADDRESS,
          settlementAddress: ROLLING_SWAP_CHANNEL_ADDRESS,
        },
      ],
      channels: {
        [CHAIN_B]: [
          {
            channelId: CHANNEL_B_ID,
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { [CHAIN_B]: 100_000_000n },
      relayUrls: ['ws://localhost:0'],
      blsPort: 0,
      btpEndpoint: `ws://127.0.0.1:${MAKER_BTP_PORT}`,
      ilpAddress: MAKER_ILP,
      publisher: { publish: async () => undefined },
      rateProvider: () => ({ rate: PAIR.rate, at: Date.now() }),
      rolling: { legBBudgetMs: 20_000 },
    };
    swapNode = await startSwapNode(swapConfig);
    const swapSignerAddress = swapNode.swapNodeKeys.evm!.address.toLowerCase();

    // 4. Sender connector + daemon (leg-B terminator on its local-delivery
    //    seat). Its own auto-drive threshold is parked out of reach so the
    //    ONLY settlement initiated on chain A is the maker's.
    daemon = makeSenderDaemon(
      join(scratch, 'received-claims.json'),
      swapSignerAddress
    );
    const senderSecret = generateSecretKey();
    senderNostrPubkey = getPublicKey(senderSecret);
    senderConnector = new ConnectorNode(
      {
        nodeId: 'sender-conn',
        btpServerPort: SENDER_BTP_PORT,
        healthCheckPort: SENDER_HEALTH_PORT,
        environment: 'development',
        deploymentMode: 'embedded',
        peers: [
          {
            id: 'maker-apex',
            url: `ws://127.0.0.1:${MAKER_BTP_PORT}`,
            authToken: '',
            evmAddress: MAKER_EVM_ADDRESS,
            chain: CHAIN_A,
          },
        ],
        routes: [
          { prefix: SENDER_DAEMON_ILP, nextHop: 'sender-conn', priority: 100 },
          { prefix: 'g.toon.swap', nextHop: 'maker-apex', priority: 50 },
        ],
        localDelivery: { enabled: false },
        settlement: {
          connectorFeePercentage: 0,
          enableSettlement: true,
          tigerBeetleClusterId: 0,
          tigerBeetleReplicas: [],
        },
        chainProviders: [
          {
            chainType: 'evm',
            chainId: CHAIN_A,
            rpcUrl: anvilA.rpcUrl,
            registryAddress: TOKEN_NETWORK_REGISTRY_ADDRESS,
            tokenAddress: USDC_TOKEN_ADDRESS,
            keyId: SENDER_EVM_PRIVATE_KEY,
            settlementOptions: { threshold: '999000000000000000' },
          },
        ],
      },
      createLogger('sender-conn', 'error')
    );
    senderConnector.setLocalDeliveryHandler(daemon.handler);

    // 5. Start both; wait for the mutual BTP sessions.
    await makerConnector.start();
    await senderConnector.start();
    await waitFor(
      async () =>
        makerConnector!
          .listPeers()
          .some((p) => p.id === 'sender-conn' && p.connected) &&
        senderConnector!
          .listPeers()
          .some((p) => p.id === 'maker-apex' && p.connected),
      { timeoutMs: 30_000, label: 'mutual BTP peering' }
    );

    // 6. Chain-A payment channel (TokenNetwork). Both connectors auto-open
    //    toward their peer at start() (`peers[].chain`); a channel is unique
    //    per participant pair, so whoever wins the race owns the open and
    //    the loser tolerates ChannelAlreadyExists. Wait for it on-chain,
    //    then raise BOTH participants' deposits directly (unlocked anvil
    //    accounts) so leg-A claim totals never hit the deposit cap.
    const openedLogs = await waitFor(
      async () => {
        const logs = await getLogs(anvilA!.rpcUrl, {
          address: TOKEN_NETWORK_ADDRESS,
          topic0: CHANNEL_OPENED_TOPIC,
        });
        return logs.length > 0 ? logs : null;
      },
      { timeoutMs: 45_000, label: 'auto-opened chain-A channel' }
    );
    const channelAId = openedLogs[0]!.topics[1]!;
    for (const participant of [SENDER_EVM_ADDRESS, MAKER_EVM_ADDRESS]) {
      // participants(channelId, participant) → (deposit, nonce, transferred)
      const current = await rpc<string>(anvilA.rpcUrl, 'eth_call', [
        {
          to: TOKEN_NETWORK_ADDRESS,
          data: encodeCall(selector('participants(bytes32,address)'), [
            channelAId.slice(2),
            pad32(participant.slice(2).toLowerCase()),
          ]),
        },
        'latest',
      ]);
      const currentDeposit = BigInt('0x' + current.slice(2, 66));
      const target = currentDeposit + 100_000_000n; // +100 USDC headroom
      await sendUnlockedTx(anvilA.rpcUrl, {
        from: participant,
        to: USDC_TOKEN_ADDRESS,
        data: encodeCall(selector('approve(address,uint256)'), [
          pad32(TOKEN_NETWORK_ADDRESS.slice(2).toLowerCase()),
          pad32(target.toString(16)),
        ]),
      });
      await sendUnlockedTx(anvilA.rpcUrl, {
        from: participant,
        to: TOKEN_NETWORK_ADDRESS,
        data: encodeCall(selector('setTotalDeposit(bytes32,address,uint256)'), [
          channelAId.slice(2),
          pad32(participant.slice(2).toLowerCase()),
          pad32(target.toString(16)),
        ]),
      });
    }

    // 7. Chain-B channel on the RollingSwapChannel contract, funded by the
    //    maker treasury with 1 ETH (covers the 24e6-wei watermark).
    await sendUnlockedTx(anvilB.rpcUrl, {
      from: MAKER_EVM_ADDRESS,
      to: ROLLING_SWAP_CHANNEL_ADDRESS,
      data: encodeCall(selector('openChannel(bytes32,address)'), [
        CHANNEL_B_ID.slice(2),
        pad32(swapSignerAddress.slice(2)),
      ]),
      value: 10n ** 18n,
    });

    // 8. Warmup packet — flushes the per-packet claim pipeline so the
    //    sender's channel is registered maker-side before fills race it.
    try {
      await senderConnector.sendPacket({
        destination: MAKER_ILP,
        amount: WARMUP,
        expiresAt: new Date(Date.now() + 10_000),
        data: Buffer.alloc(0),
      });
    } catch {
      /* the swap node rejects it (not a swap packet) — the claim still ships */
    }
    await new Promise((r) => setTimeout(r, 1_000));

    // 9. Rolling session (the RFQ intake seam).
    swapNode.registerRollingSession({
      streamNonce: STREAM_NONCE,
      pair: PAIR,
      chainRecipient: CHAIN_B_RECIPIENT,
      senderIlpAddress: SENDER_DAEMON_ILP,
      senderPubkey: senderNostrPubkey,
    });
    tracker = new ReceiptChainTracker({
      streamNonce: STREAM_NONCE,
      makerPubkey: swapNode.identity.pubkey,
    });

    // 10. THE STREAM — N coupled fills over real BTP, one withheld.
    for (let seq = 1; seq <= TOTAL_FILLS; seq++) {
      const { preimage, conditionB64 } = daemon.mint();
      daemon.reveal = seq !== FAIL_SEQ;
      const result = await senderConnector.sendPacket({
        destination: MAKER_ILP,
        amount: DELTA,
        expiresAt: new Date(Date.now() + 30_000),
        data: Buffer.from(
          JSON.stringify({
            proto: ROLLING_PROTOCOL,
            type: 'fill',
            streamNonce: STREAM_NONCE,
            seq,
          }),
          'utf8'
        ),
        executionCondition: conditionB64,
      });

      if (seq === FAIL_SEQ) {
        withheldOutcome = {
          type: result.type as number,
          ...('code' in result && { code: (result as { code: string }).code }),
        };
        continue;
      }

      // FULFILL with the sender's own preimage relayed back (R6 + the
      // connector's rule-3 enforcement on BOTH hops).
      expect(result.type, `fill seq=${seq} should FULFILL`).toBe(13);
      const fulfill = result as { fulfillment?: Uint8Array; data: Buffer };
      expect(fulfill.fulfillment).toBeDefined();
      expect(
        Buffer.compare(Buffer.from(fulfill.fulfillment!), Buffer.from(preimage))
      ).toBe(0);

      const record = JSON.parse(
        Buffer.from(fulfill.data).toString('utf8')
      ) as RollingAcceptRecord;
      accepts.push(record);
      // Accumulate the receipt chain as a real controller would.
      expect(
        record.receipt,
        `accept seq=${seq} carries a receipt`
      ).toBeDefined();
      expect(tracker.add(record.receipt!)).toEqual({ ok: true });
    }
    daemon.reveal = true;
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    if (swapNode) await swapNode.stop().catch(() => undefined);
    if (makerConnector) await makerConnector.stop().catch(() => undefined);
    if (senderConnector) await senderConnector.stop().catch(() => undefined);
    if (anvilA) await anvilA.stop();
    if (anvilB) await anvilB.stop();
    if (prevCwd) process.chdir(prevCwd);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  // -------------------------------------------------------------------
  // Off-chain: N advances per leg, coupled, with one mid-stream failure
  // -------------------------------------------------------------------

  it('streams N fills = N leg-A advances + N leg-B advances off-chain, watermark cumulative and gapless across the failure', (ctx) => {
    if (!anvilOk) return ctx.skip();

    expect(accepts).toHaveLength(FULFILLED);
    // The withheld fill failed BENIGNLY on the wire (leg A rejected).
    expect(withheldOutcome).not.toBeNull();
    expect(withheldOutcome!.type).toBe(14);

    // Every fulfilled fill echoed a strictly monotone cumulative watermark;
    // the failed fill's nonce was rolled back and REUSED (R8) — no gap, no
    // double-count.
    for (let i = 0; i < accepts.length; i++) {
      expect(BigInt(accepts[i]!.nonce!)).toBe(BigInt(i + 1));
      expect(BigInt(accepts[i]!.cumulativeAmount!)).toBe(
        TARGET * BigInt(i + 1)
      );
      expect(accepts[i]!.channelId).toBe(CHANNEL_B_ID);
      expect(accepts[i]!.rate).toBe(PAIR.rate);
    }

    // The sender daemon terminated one leg-B PREPARE per ATTEMPTED fill.
    expect(daemon.advances).toHaveLength(TOTAL_FILLS);

    // Receive side (client 0.18.0): the persisted watermark is the final
    // cumulative — N advances collapsed losslessly into ONE claim.
    const entries = daemon.store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.channelId).toBe(CHANNEL_B_ID);
    expect(entries[0]!.nonce).toBe(BigInt(FULFILLED));
    expect(entries[0]!.cumulativeAmount).toBe(FINAL_WATERMARK_B);

    // Maker side: the delivered total is UNSETTLED window liability (issue
    // #49) — nothing was permanently debited for rolling fills.
    const window = swapNode!.health().inventoryWindow[POOL_KEY]!;
    expect(window.unsettled).toBe(FINAL_WATERMARK_B.toString());
    expect(window.inFlight).toBe('0');
    expect(swapNode!.health().inventoryAvailable[POOL_KEY]).toBe('100000000');
  });

  // -------------------------------------------------------------------
  // Chain A: exactly ONE settlement, submitted by the connector auto-drive
  // -------------------------------------------------------------------

  it('chain A nets to exactly ONE on-chain TokenNetwork claim for the final leg-A watermark — submitted by the SettlementMonitor auto-drive, not the test', async (ctx) => {
    if (!anvilOk) return ctx.skip();

    // The last fill's claim crossed the threshold; the executor's
    // claimFromChannel() lands asynchronously.
    const logs = await waitFor(
      async () => {
        const found = await getLogs(anvilA!.rpcUrl, {
          address: TOKEN_NETWORK_ADDRESS,
          topic0: CHANNEL_CLAIMED_TOPIC,
        });
        return found.length > 0 ? found : null;
      },
      { timeoutMs: 60_000, label: 'auto-drive ChannelClaimed on chain A' }
    );

    // Give any spurious second settlement a chance to land, then re-read.
    await new Promise((r) => setTimeout(r, 3_000));
    const finalLogs = await getLogs(anvilA!.rpcUrl, {
      address: TOKEN_NETWORK_ADDRESS,
      topic0: CHANNEL_CLAIMED_TOPIC,
    });
    expect(finalLogs).toHaveLength(1);
    expect(logs[0]!.transactionHash).toBe(finalLogs[0]!.transactionHash);

    const claimed = finalLogs[0]!;
    // claimant (indexed topic 2) is the MAKER — the auto-drive redeemed the
    // sender→maker channel; the sender's connector settled nothing.
    expect('0x' + claimed.topics[2]!.slice(26)).toBe(
      MAKER_EVM_ADDRESS.toLowerCase()
    );
    // data = claimedAmount(32) || totalClaimed(32); one claim ever, so both
    // equal the FINAL cumulative leg-A watermark: every attempted fill's δ
    // plus the warmup, netted to one envelope.
    const claimedAmount = BigInt('0x' + claimed.data.slice(2, 66));
    const totalClaimed = BigInt('0x' + claimed.data.slice(66, 130));
    expect(totalClaimed).toBe(LEG_A_FINAL);
    expect(claimedAmount).toBe(LEG_A_FINAL);
  }, 90_000);

  // -------------------------------------------------------------------
  // Chain B: exactly ONE settlement via the receive-side client machinery
  // -------------------------------------------------------------------

  it('chain B nets to exactly ONE on-chain settlement for the final watermark via client 0.18.0 buildSwapSettlements + submitEvmSettlement', async (ctx) => {
    if (!anvilOk) return ctx.skip();

    const builds = buildSwapSettlements({
      entries: daemon.store.list(),
      tokenNetworks: { [CHAIN_B]: ROLLING_SWAP_CHANNEL_ADDRESS.toLowerCase() },
    });
    expect(builds).toHaveLength(1);
    expect(builds[0]!.error).toBeUndefined();
    const bundle = builds[0]!.bundle!;
    expect(bundle.channelId).toBe(CHANNEL_B_ID);
    expect(bundle.nonce).toBe(String(FULFILLED));
    expect(bundle.cumulativeAmount).toBe(FINAL_WATERMARK_B.toString());
    expect(bundle.recipient).toBe(CHAIN_B_RECIPIENT);
    // Highest-nonce-wins: all N accumulated claims merged into this bundle
    // is a store-level invariant here (the store keeps only the winner);
    // the sdk-level N-claims merge is pinned by build-settlement-tx tests.

    const submitted = await submitEvmSettlement(bundle, {
      rpcUrl: anvilB!.rpcUrl,
      account: privateKeyToAccount(SETTLE_SUBMITTER_PRIVATE_KEY),
    });
    expect(submitted.status).toBe('success');
    chainBSettleTxHash = submitted.txHash;

    // Exactly ONE SettlementSucceeded ever, for the final watermark.
    const events = await getLogs(anvilB!.rpcUrl, {
      address: ROLLING_SWAP_CHANNEL_ADDRESS,
      topic0: SETTLEMENT_SUCCEEDED_TOPIC,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.topics[1]).toBe(CHANNEL_B_ID);
    expect(BigInt('0x' + events[0]!.data.slice(2, 66))).toBe(FINAL_WATERMARK_B);
    expect(BigInt('0x' + events[0]!.data.slice(66, 130))).toBe(
      BigInt(FULFILLED)
    );

    // Contract state: one settlement, final nonce/cumulative, and the
    // recipient's balance is EXACTLY the watermark (key-less account —
    // nothing else can move it).
    const channelWords = await rpc<string>(anvilB!.rpcUrl, 'eth_call', [
      {
        to: ROLLING_SWAP_CHANNEL_ADDRESS,
        data: encodeCall(selector('channels(bytes32)'), [
          CHANNEL_B_ID.slice(2),
        ]),
      },
      'latest',
    ]);
    const word = (i: number): bigint =>
      BigInt('0x' + channelWords.slice(2 + i * 64, 2 + (i + 1) * 64));
    expect(word(1)).toBe(BigInt(FULFILLED)); // nonce
    expect(word(2)).toBe(FINAL_WATERMARK_B); // cumulativePaid
    expect(word(4)).toBe(1n); // settlementCount

    const recipientBalance = await rpc<string>(
      anvilB!.rpcUrl,
      'eth_getBalance',
      [CHAIN_B_RECIPIENT, 'latest']
    );
    expect(BigInt(recipientBalance)).toBe(FINAL_WATERMARK_B);
  }, 60_000);

  // -------------------------------------------------------------------
  // Receipts artifact ties the stream to the settled amount (AC-4)
  // -------------------------------------------------------------------

  it('the accumulated rfc-0039-style receipt chain matches the settled chain-B amount exactly', (ctx) => {
    if (!anvilOk) return ctx.skip();

    const chain = tracker.chain();
    expect(chain.receipts).toHaveLength(FULFILLED);
    expect(chain.holes).toEqual([]);
    expect(chain.latest!.seq).toBe(FULFILLED);
    expect(chain.totalDelivered).toBe(FINAL_WATERMARK_B.toString());
    // Every receipt is independently verifiable against the maker pubkey.
    for (const receipt of chain.receipts) {
      expect(verifyStreamReceipt(receipt, swapNode!.identity.pubkey)).toBe(
        true
      );
    }
    // The serialized audit artifact round-trips.
    const artifact = JSON.parse(serializeReceiptChain(chain)) as {
      receipts: unknown[];
      totalDelivered: string;
    };
    expect(artifact.receipts).toHaveLength(FULFILLED);
    expect(artifact.totalDelivered).toBe(FINAL_WATERMARK_B.toString());
  });

  // -------------------------------------------------------------------
  // Settle-and-recycle (issue #49) closes the loop maker-side
  // -------------------------------------------------------------------

  it('recordSettlement() with the mined chain-B settlement recycles the window capacity', (ctx) => {
    if (!anvilOk) return ctx.skip();
    expect(chainBSettleTxHash).not.toBeNull();

    const reduced = swapNode!.recordSettlement({
      txHash: chainBSettleTxHash!,
      chain: 'evm',
      channelId: CHANNEL_B_ID,
      cumulativeAmount: FINAL_WATERMARK_B.toString(),
      nonce: String(FULFILLED),
      recipient: CHAIN_B_RECIPIENT,
      settledAt: Date.now(),
    });
    expect(reduced).toBe(FINAL_WATERMARK_B);

    const window = swapNode!.health().inventoryWindow[POOL_KEY]!;
    expect(window.unsettled).toBe('0');
    expect(window.inFlight).toBe('0');
    // Freed liability recycled into capacity; available never moved.
    expect(window.free).toBe('100000000');
    expect(swapNode!.health().inventoryAvailable[POOL_KEY]).toBe('100000000');

    // A replayed confirmation is a 0n no-op (monotone watermark).
    const replayed = swapNode!.recordSettlement({
      txHash: chainBSettleTxHash!,
      chain: 'evm',
      channelId: CHANNEL_B_ID,
      cumulativeAmount: FINAL_WATERMARK_B.toString(),
      nonce: String(FULFILLED),
      recipient: CHAIN_B_RECIPIENT,
      settledAt: Date.now(),
    });
    expect(replayed).toBe(0n);
  });
});
