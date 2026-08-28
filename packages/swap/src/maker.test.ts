/**
 * The relay-mediated swap, end to end in one process: a maker booted by
 * `startSwapNode` and a `SwapTaker`, talking through an in-memory relay.
 * Chains are faked at the read seam only — every claim is REALLY signed
 * (TokenNetwork EIP-712 on leg A, TOON-BALPROOF-V2 on leg B) and REALLY
 * verified by the counterparty.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { base58Encode } from '@toon-protocol/sdk';

import { deriveEvmChannelId } from './evm-leg-b-channel.js';
import { unwrapGiftWrap, wrapGiftWrap } from './nip59.js';
import { deriveNostrIdentity } from './nostr-keys.js';
import { MemoryRelay } from './memory-relay.test-support.js';
import type { ChannelSlotReader } from './received-claim.js';
import { deriveSolanaChannelPda } from './solana-pda.js';
import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { SwapTaker } from './swap-taker.js';
import type { ChannelFunder } from './swap-taker.js';
import { InMemoryTakerStateStore } from './taker-state.js';
import type { PersistedSwapState, SwapStateStore } from './state-store.js';
import { deriveSwapNodeKeys } from './wallet.js';
import { SWAP_RUMOR_KIND, SWAP_WIRE_PROTOCOL } from './wire.js';
import type { SwapAdvance, SwapFill } from './wire.js';

const MAKER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TAKER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const EVM_CHAIN = 'evm:8453';
const SOL_CHAIN = 'solana:devnet';
const TOKEN_NETWORK = '0x' + '44'.repeat(20);
const USDC_EVM = '0x' + '22'.repeat(20);
const PROGRAM_ID = base58Encode(
  Uint8Array.from(Buffer.from('55'.repeat(32), 'hex'))
);
const MINT = base58Encode(Uint8Array.from(Buffer.from('66'.repeat(32), 'hex')));
const FILL = 1_000_000n;

class MemoryStateStore implements SwapStateStore {
  state: PersistedSwapState | null = null;
  load() {
    return this.state
      ? (JSON.parse(JSON.stringify(this.state)) as PersistedSwapState)
      : null;
  }
  save(s: PersistedSwapState) {
    this.state = JSON.parse(JSON.stringify(s)) as PersistedSwapState;
  }
}

/** A chain where every channel is open and richly funded. */
function fakeSlotReader(): ChannelSlotReader {
  return {
    async evmEpoch() {
      return 0n;
    },
    async evmSlot() {
      return {
        state: 'opened',
        deposit: 1_000_000_000n,
        nonce: 0n,
        transferredAmount: 0n,
      };
    },
    async solanaChannel(facts) {
      return {
        participantA: facts.counterparty,
        participantB: facts.self,
        tokenMint: facts.mint,
        depositA: 1_000_000_000n,
        depositB: 1_000_000_000n,
        transferredAmountA: 0n,
        transferredAmountB: 0n,
        nonceA: 0n,
        nonceB: 0n,
        challengeDuration: 3600n,
        state: 0,
      };
    },
  };
}

async function sleepUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('maker ↔ taker over the relay (EVM leg A → Solana leg B)', () => {
  const relay = new MemoryRelay();
  const makerStore = new MemoryStateStore();
  /** When set, the maker's next publish is refused (its answer is lost), the taker's writes are not. */
  let dropNextMakerWrite = false;
  /** When set, the maker's rate feed fails once (a retryable, credited refusal). */
  let failRateOnce = false;
  const makerWriter = () => {
    const inner = relay.writer();
    return {
      destination: inner.destination,
      publish: async (e: NostrEvent) => {
        if (dropNextMakerWrite) {
          dropNextMakerWrite = false;
          return {
            ok: false as const,
            eventId: e.id,
            refusedBy: 'path' as const,
            code: 'T04',
            message: 'dropped by test',
            retry: true,
          };
        }
        return inner.publish(e);
      },
    };
  };
  /** The taker's disk — one identity, one channel per maker, shared by every session. */
  const takerStore = new InMemoryTakerStateStore();
  let maker: SwapNodeInstance;
  let makerKeys: Awaited<ReturnType<typeof deriveSwapNodeKeys>>;
  let takerKeys: Awaited<ReturnType<typeof deriveSwapNodeKeys>>;
  let evmChannelId: string;
  let solPda: string;

  function makerConfig(store: SwapStateStore): SwapNodeConfig {
    return {
      mnemonic: MAKER_MNEMONIC,
      chains: ['evm', 'solana'],
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
          to: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
          rate: '0.99',
        },
      ],
      channels: {
        [SOL_CHAIN]: [
          { channelId: solPda, cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 },
        ],
      },
      inventory: { [SOL_CHAIN]: 100_000_000n },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: EVM_CHAIN,
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x' + '11'.repeat(20),
          tokenAddress: USDC_EVM,
          tokenNetworkAddress: TOKEN_NETWORK,
        },
        {
          chainType: 'solana',
          chainId: SOL_CHAIN,
          rpcUrl: 'http://127.0.0.1:1',
          programId: PROGRAM_ID,
          tokenMint: MINT,
        },
      ],
      order: { fill: { min: FILL, max: 5n * FILL }, ttlMs: 600_000 },
      quote: { sessionTtlMs: 600_000 },
      rateProvider: async (pair) => {
        if (failRateOnce) {
          failRateOnce = false;
          throw new Error('rate feed down (test)');
        }
        return pair.rate;
      },
      stateStore: store,
      reconcileIntervalMs: 0,
      appPort: 0,
      ...(process.env['SWAP_TEST_LOG'] && {
        logger: {
          debug: (...a: unknown[]) =>
            console.log('[maker:debug]', ...a.map((x) => JSON.stringify(x))),
          info: (...a: unknown[]) =>
            console.log('[maker]', ...a.map((x) => JSON.stringify(x))),
          warn: (...a: unknown[]) =>
            console.log('[maker:warn]', ...a.map((x) => JSON.stringify(x))),
          error: (...a: unknown[]) =>
            console.log('[maker:error]', ...a.map((x) => JSON.stringify(x))),
        },
      }),
      __testHooks: {
        relayTransport: (handler) => ({
          reader: relay.reader((_id, e) => handler(e)),
          writer: makerWriter(),
        }),
        slotReader: fakeSlotReader(),
      },
    };
  }

  function makeTaker(
    store = takerStore,
    opts: { answerTimeoutMs?: number; maxResends?: number } = {}
  ) {
    let onEvent: (e: NostrEvent) => void = () => undefined;
    const reader = relay.reader((_id, e) => onEvent(e));
    const funder: ChannelFunder = {
      async channelFor() {
        return evmChannelId;
      },
      async ensure() {
        return { channelId: evmChannelId, nonce: 0n, transferredAmount: 0n };
      },
    };
    const taker = new SwapTaker({
      nostr: deriveNostrIdentity({ mnemonic: TAKER_MNEMONIC }),
      keys: takerKeys,
      reader,
      writer: relay.writer(),
      slotReader: fakeSlotReader(),
      chainProviders: makerConfig(makerStore).chainProviders ?? [],
      store,
      channelFunder: funder,
      answerTimeoutMs: opts.answerTimeoutMs ?? 2000,
      maxResends: opts.maxResends ?? 2,
    });
    onEvent = (e) => void taker.handleEvent(e);
    return { taker, store };
  }

  beforeAll(async () => {
    makerKeys = await deriveSwapNodeKeys({
      mnemonic: MAKER_MNEMONIC,
      chains: ['evm', 'solana'],
    });
    takerKeys = await deriveSwapNodeKeys({
      mnemonic: TAKER_MNEMONIC,
      chains: ['evm', 'solana'],
    });
    evmChannelId = deriveEvmChannelId(
      takerKeys.evm!.address,
      makerKeys.evm!.address,
      0n
    );
    solPda = deriveSolanaChannelPda({
      participantA: base58Encode(makerKeys.solana!.publicKey),
      participantB: base58Encode(takerKeys.solana!.publicKey),
      mint: MINT,
      programId: PROGRAM_ID,
    });
    maker = await startSwapNode(makerConfig(makerStore));
  });

  afterAll(async () => {
    await maker.stop();
  });

  it('publishes one addressable order per pair with both legs’ facts', async () => {
    const { taker } = makeTaker();
    taker.start();
    taker.listOrders();
    await sleepUntil(
      () => taker.ordersReady() && taker.listOrders().length === 1
    );
    const [listing] = taker.listOrders();
    expect(listing?.makerPubkey).toBe(maker.nostr.pubkey);
    const order = listing!.order;
    expect(order.proto).toBe(SWAP_WIRE_PROTOCOL);
    expect(order.fill).toEqual({
      min: FILL.toString(),
      max: (5n * FILL).toString(),
    });
    expect(order.legA).toEqual({
      chain: EVM_CHAIN,
      swapSignerAddress: makerKeys.evm!.address.toLowerCase(),
      verifyingContract: TOKEN_NETWORK,
      token: USDC_EVM,
    });
    expect(order.legB.programId).toBe(PROGRAM_ID);
    expect(order.legB.swapSignerAddress).toBe(
      base58Encode(makerKeys.solana!.publicKey)
    );
    expect(order.maxAmount).toBe('100000000');
    taker.stop();
  });

  it('streams three fills: each leg-A claim is verified, each advance is a verified leg-B claim', async () => {
    const { taker } = makeTaker();
    taker.start();
    taker.listOrders();
    await sleepUntil(() => taker.listOrders().length === 1);
    const [listing] = taker.listOrders();
    const session = await taker.accept(listing!, {
      size: 3n * FILL,
      delta: FILL,
    });
    expect(session.quote?.lastSeq).toBe(0);
    expect(session.quote?.rate).toBe('0.99');

    const advances: SwapAdvance[] = [];
    const done = await taker.run(session.streamNonce, {
      onFill: (a) => {
        advances.push(a);
      },
    });
    expect(done.status).toBe('done');
    expect(advances.map((a) => a.seq)).toEqual([1, 2, 3]);
    expect(advances.map((a) => a.claim.nonce)).toEqual(['1', '2', '3']);
    expect(advances.map((a) => a.claim.cumulativeAmount)).toEqual([
      '990000',
      '1980000',
      '2970000',
    ]);
    expect(advances[0]?.claim.channelId).toBe(solPda);
    expect(done.received?.cumulative).toBe('2970000');
    expect(done.legA).toMatchObject({
      channelId: evmChannelId,
      nonce: '3',
      cumulative: '3000000',
    });
    expect(taker.channels()[`${EVM_CHAIN}:${evmChannelId}`]).toMatchObject({
      nonce: '3',
      cumulative: '3000000',
    });

    // The maker's side of the same stream.
    const ms = maker.engine.sessionFor(session.streamNonce);
    expect(ms?.lastSeq).toBe(3);
    expect(ms?.payer).toBe(`evm:${evmChannelId.toLowerCase()}`);
    expect(ms?.takerPubkey).toBe(taker.nostrPubkey);
    const inbound =
      maker.maker!.health().inbound[`${EVM_CHAIN}:${evmChannelId}`];
    expect(inbound).toMatchObject({
      nonce: '3',
      cumulative: '3000000',
      seq: 3,
    });
    expect(maker.health().inventoryWindow[`USDC:${SOL_CHAIN}`]?.unsettled).toBe(
      '2970000'
    );
    taker.stop();
  });

  it('answers a retransmitted fill with the same advance, and refuses a tampered one uncredited', async () => {
    const { taker } = makeTaker();
    taker.start();
    taker.listOrders();
    await sleepUntil(() => taker.listOrders().length === 1);
    const session = await taker.accept(taker.listOrders()[0]!, {
      size: FILL,
      delta: FILL,
    });
    await taker.run(session.streamNonce);
    const last = taker.session(session.streamNonce)!;
    const takerNostr = deriveNostrIdentity({ mnemonic: TAKER_MNEMONIC });

    const before = relay.published.length;
    const replay: SwapFill = {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'fill',
      streamNonce: session.streamNonce,
      seq: 1,
      claim: last.lastFill!.claim,
    };
    const { wrap } = wrapGiftWrap({
      rumor: { kind: SWAP_RUMOR_KIND, content: JSON.stringify(replay) },
      senderSecretKey: takerNostr.secretKey,
      recipientPubkey: maker.nostr.pubkey,
    });
    await maker.maker!.handleWrap(wrap);
    await sleepUntil(() => relay.published.length === before + 1);
    const answer = unwrapGiftWrap(
      takerNostr.secretKey,
      takerNostr.pubkey,
      relay.published.at(-1)!
    );
    expect(JSON.parse(answer.rumor.content)).toEqual(last.lastAdvance!.advance);

    const tampered: SwapFill = {
      ...replay,
      seq: 2,
      claim: { ...replay.claim, nonce: '2', cumulativeAmount: '2000000' },
    };
    const t = wrapGiftWrap({
      rumor: { kind: SWAP_RUMOR_KIND, content: JSON.stringify(tampered) },
      senderSecretKey: takerNostr.secretKey,
      recipientPubkey: maker.nostr.pubkey,
    });
    await maker.maker!.handleWrap(t.wrap);
    await sleepUntil(() => relay.published.length === before + 2);
    const refusal = JSON.parse(
      unwrapGiftWrap(
        takerNostr.secretKey,
        takerNostr.pubkey,
        relay.published.at(-1)!
      ).rumor.content
    );
    expect(refusal).toMatchObject({
      type: 'refusal',
      reason: 'claim_invalid',
      seq: 2,
      detail: { code: 'SIGNATURE_INVALID' },
    });
    expect(refusal.credited).toBeUndefined();
    expect(maker.engine.sessionFor(session.streamNonce)?.lastSeq).toBe(1);
    taker.stop();
  });

  it('a taker that loses an answer resumes from disk and finishes with no new nonce for the old seq', async () => {
    const store = takerStore;
    const first = makeTaker(store, { answerTimeoutMs: 150, maxResends: 1 });
    first.taker.start();
    first.taker.listOrders();
    await sleepUntil(() => first.taker.listOrders().length === 1);
    const session = await first.taker.accept(first.taker.listOrders()[0]!, {
      size: 3n * FILL,
      delta: FILL,
    });

    // Let two fills through, then make the maker's third answer vanish.
    let fills = 0;
    let threw: unknown;
    try {
      await first.taker.run(session.streamNonce, {
        onFill: () => {
          fills += 1;
          if (fills === 2) dropNextMakerWrite = true; // the maker's answer to fill 3 is lost
        },
      });
    } catch (err) {
      threw = err;
    }
    expect(fills).toBe(2);
    expect(String(threw)).toMatch(/no_answer/);
    first.taker.stop();
    const persisted = store.load()!.sessions[session.streamNonce]!;
    expect(persisted.lastFill?.seq).toBe(3);
    expect(persisted.lastAdvance?.seq).toBe(2);
    expect(maker.engine.sessionFor(session.streamNonce)?.lastSeq).toBe(3);

    const second = makeTaker(store);
    second.taker.start();
    const resumed = await second.taker.resume(session.streamNonce);
    expect(resumed.status).toBe('done');
    expect(resumed.lastAdvance?.seq).toBe(3);
    // The same claim was resent — the channel watermark did not move for seq 3.
    expect(resumed.legA.nonce).toBe(resumed.lastFill?.claim.nonce);
    expect(persisted.lastFill?.claim.nonce).toBe(resumed.lastFill?.claim.nonce);
    // The leg-B channel is shared by every session on it: the watermark is
    // the channel's cumulative, and this session's last advance sits on it.
    expect(resumed.received?.cumulative).toBe(
      resumed.lastAdvance?.advance.claim.cumulativeAmount
    );
    expect(resumed.lastAdvance?.advance.targetAmount).toBe('990000');
    second.taker.stop();
  });

  it('a taker that lost its state file resyncs its watermark from the maker’s refusal and continues', async () => {
    const before = BigInt(
      maker.maker!.health().inbound[`${EVM_CHAIN}:${evmChannelId}`]?.nonce ??
        '0'
    );
    const { taker } = makeTaker(new InMemoryTakerStateStore()); // fresh disk, used channel
    taker.start();
    taker.listOrders();
    await sleepUntil(() => taker.listOrders().length === 1);
    const session = await taker.accept(taker.listOrders()[0]!, {
      size: 2n * FILL,
      delta: FILL,
    });
    const advances: SwapAdvance[] = [];
    const done = await taker.run(session.streamNonce, {
      onFill: (a) => {
        advances.push(a);
      },
    });
    expect(done.status).toBe('done');
    expect(advances).toHaveLength(2);
    const makerInbound =
      maker.maker!.health().inbound[`${EVM_CHAIN}:${evmChannelId}`]!;
    // The fresh taker continued from the maker's watermark (two fills past it), not from nonce 1.
    expect(done.legA.nonce).toBe(makerInbound.nonce);
    expect(BigInt(done.legA.nonce)).toBe(before + 2n);
    expect(done.legA.acceptedCumulative).toBe(makerInbound.cumulative);
    taker.stop();
  });

  it('a fill refused after verification is credited once, and the retry of the same claim is priced on that credit', async () => {
    const { taker } = makeTaker();
    taker.start();
    taker.listOrders();
    await sleepUntil(() => taker.listOrders().length === 1);
    const session = await taker.accept(taker.listOrders()[0]!, {
      size: 2n * FILL,
      delta: FILL,
    });
    const advances: SwapAdvance[] = [];
    failRateOnce = true; // fill 1: verified, refused rate_unavailable, credited; the taker resends it
    const done = await taker.run(session.streamNonce, {
      onFill: (a) => {
        advances.push(a);
      },
    });
    expect(done.status).toBe('done');
    expect(advances.map((a) => a.seq)).toEqual([1, 2]);
    // The retried claim was worth ONE fill: the credit, and nothing on top of it.
    expect(advances[0]).toMatchObject({
      credited: FILL.toString(),
      sourceAmount: FILL.toString(),
      targetAmount: '990000',
    });
    expect(advances[1]?.credited).toBeUndefined();
    expect(advances[1]?.sourceAmount).toBe(FILL.toString());
    expect(maker.engine.sessionFor(session.streamNonce)?.credit).toBe(0n);
    taker.stop();
  });

  it('a maker restarted from its persisted state continues a stream at the right leg-B nonce', async () => {
    const { taker } = makeTaker();
    taker.start();
    taker.listOrders();
    await sleepUntil(() => taker.listOrders().length === 1);
    const session = await taker.accept(taker.listOrders()[0]!, {
      size: 3n * FILL,
      delta: FILL,
    });
    const advances: SwapAdvance[] = [];
    let restarted = false;
    await taker.run(session.streamNonce, {
      onFill: async (a) => {
        advances.push(a);
        if (a.seq === 1 && !restarted) {
          restarted = true;
          await maker.stop();
          maker = await startSwapNode(makerConfig(makerStore));
        }
      },
    });
    expect(advances.map((a) => a.seq)).toEqual([1, 2, 3]);
    // Leg-B nonces keep counting across the restart on the same channel.
    const nonces = advances.map((a) => BigInt(a.claim.nonce));
    expect(nonces[1]! > nonces[0]! && nonces[2]! > nonces[1]!).toBe(true);
    expect(new Set(advances.map((a) => a.claim.channelId))).toEqual(
      new Set([solPda])
    );
    const ms = maker.engine.sessionFor(session.streamNonce);
    expect(ms?.lastSeq).toBe(3);
    taker.stop();
  });
});
