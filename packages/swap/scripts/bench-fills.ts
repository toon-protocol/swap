/**
 * Fill-size benchmark against TOON's live devnet: how small a fill δ can go,
 * how fast fills complete, what each costs in relay writes.
 *
 *   pnpm exec tsx scripts/bench-fills.ts
 *   BENCH_DELTAS=2,10,100 BENCH_FILLS=5 pnpm exec tsx scripts/bench-fills.ts
 *
 * One maker (`startSwapNode`) and one taker (built like `createTakerRuntime`,
 * with the relay writer wrapped to stamp publish timings). Per δ: a session
 * of N fills, EVM→Solana at rate 0.99. Writes to scripts/bench-fills.last.md
 * and scripts/bench-fills.last.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startSwapNode } from '../src/swap-node.js';
import type { SwapNodeConfig } from '../src/swap-node.js';
import { deriveNostrIdentity } from '../src/nostr-keys.js';
import { createRpcChannelSlotReader } from '../src/received-claim.js';
import { createRedeemer } from '../src/redeem.js';
import { RelaySubscription } from '../src/relay-subscription.js';
import { createRelayClient, createRelayWriter } from '../src/relay-writer.js';
import type { RelayWriter } from '../src/relay-writer.js';
import { SwapTaker } from '../src/swap-taker.js';
import { JsonFileTakerStateStore } from '../src/taker-state.js';
import { deriveSwapNodeKeys } from '../src/wallet.js';
import type { SwapAdvance } from '../src/wire.js';

/** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`expected ${what} to be present`);
  return value;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = join(homedir(), '.toon-swap-dev');
const STATE = join(DEV, 'e2e');
const RELAY_READ = 'wss://relay-ws.devnet.toonprotocol.dev';
const RELAY_CONNECTOR = 'https://proxy.relay.devnet.toonprotocol.dev/ilp';
const EVM_CHAIN = 'evm:84532';
const SOL_CHAIN = 'solana:devnet';
const USDC = 1_000_000n;

const DELTAS = (process.env['BENCH_DELTAS'] ?? '2,10,100,1000,10000,100000')
  .split(',')
  .map((s) => BigInt(s.trim()));
const FILLS = Number(process.env['BENCH_FILLS'] ?? '10');

const chainProviders: NonNullable<SwapNodeConfig['chainProviders']> = [
  {
    chainType: 'evm',
    chainId: EVM_CHAIN,
    rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
    registryAddress: '0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5',
    tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
    tokenNetworkAddress: '0xe9E05dfecfe165266C88d73e61D483612651952a',
  },
  {
    chainType: 'solana',
    chainId: SOL_CHAIN,
    rpcUrl: 'https://api.devnet.solana.com',
    programId: '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip',
    tokenMint: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
  },
];

function mnemonic(file: string): string {
  return (
    JSON.parse(readFileSync(join(DEV, file), 'utf8')) as { mnemonic: string }
  ).mnemonic;
}

interface MakerEvent {
  t: number;
  event: string;
  data: Record<string, unknown>;
}
const makerEvents: MakerEvent[] = [];
const makerLogger = {
  debug: (event: unknown, data?: unknown) =>
    makerEvents.push({
      t: Date.now(),
      event: String(event),
      data: (data ?? {}) as Record<string, unknown>,
    }),
  info: (event: unknown, data?: unknown) =>
    makerEvents.push({
      t: Date.now(),
      event: String(event),
      data: (data ?? {}) as Record<string, unknown>,
    }),
  warn: (event: unknown, data?: unknown) => {
    makerEvents.push({
      t: Date.now(),
      event: String(event),
      data: (data ?? {}) as Record<string, unknown>,
    });
    console.warn('[maker:warn]', event, JSON.stringify(data));
  },
  error: (event: unknown, data?: unknown) => {
    makerEvents.push({
      t: Date.now(),
      event: String(event),
      data: (data ?? {}) as Record<string, unknown>,
    });
    console.error('[maker:error]', event, JSON.stringify(data));
  },
};

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return must(sorted[i], 'percentile sample');
}
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

async function main(): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  const makerMnemonic = mnemonic('maker.json');
  const takerMnemonic = mnemonic('taker.json');

  console.log('booting maker…');
  const maker = await startSwapNode({
    mnemonic: makerMnemonic,
    chains: ['evm', 'solana'],
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
        rate: '0.99',
      },
    ],
    channels: { [SOL_CHAIN]: [] },
    inventory: { [SOL_CHAIN]: 5n * USDC },
    chainProviders: chainProviders.map((p) => ({
      ...p,
      channelDeposit: 1n * USDC,
    })),
    relay: {
      readUrl: RELAY_READ,
      connectorUrl: RELAY_CONNECTOR,
      payChain: 'evm',
      deposit: USDC,
      transport: 'btp',
      channelStorePath: join(STATE, 'maker-relay.json'),
    },
    order: {
      fill: { min: 1n, max: 10n * USDC },
      ttlMs: 1_800_000,
      refreshMs: 1_500_000,
    },
    quote: { sessionTtlMs: 3_600_000 },
    statePath: join(STATE, 'maker-state.json'),
    reconcileIntervalMs: 0,
    appPort: 0,
    logger: makerLogger,
  });
  console.log(`maker up: nostr=${maker.nostr.pubkey}`);

  console.log('booting taker…');
  const keys = await deriveSwapNodeKeys({
    mnemonic: takerMnemonic,
    chains: ['evm', 'solana'],
  });
  const nostr = deriveNostrIdentity({ mnemonic: takerMnemonic });
  const rpcUrls: Record<string, string> = {};
  for (const p of chainProviders)
    if (p.chainType !== 'mina') rpcUrls[p.chainId] = p.rpcUrl;
  const relayClient = await createRelayClient({
    connectorUrl: RELAY_CONNECTOR,
    chain: 'evm',
    evmPrivateKey: must(keys.evm, 'evm key').privateKey,
    rpcUrl: must(rpcUrls[EVM_CHAIN], 'evm rpc'),
    channelStore: join(STATE, 'taker-relay.json'),
    deposit: USDC,
    transport: 'btp',
    autoOpenChannel: true,
    logger: {
      info: (e, d) => console.log('[taker]', e, JSON.stringify(d)),
      warn: (e, d) => console.warn('[taker:warn]', e, JSON.stringify(d)),
    },
  });
  const innerWriter = createRelayWriter({
    sender: relayClient.sender,
    destination: 'g.toon.relay',
  });
  /** publish timings, by wrap event id */
  const publishes = new Map<
    string,
    { started: number; finished: number; ok: boolean }
  >();
  const writer: RelayWriter = {
    destination: innerWriter.destination,
    async publish(event) {
      const started = Date.now();
      const r = await innerWriter.publish(event);
      publishes.set(event.id, { started, finished: Date.now(), ok: r.ok });
      return r;
    },
  };
  const pending: { taker?: SwapTaker } = {};
  const sub = new RelaySubscription({
    relayUrl: RELAY_READ,
    onEvent: (_id, e) => void pending.taker?.handleEvent(e),
  });
  const taker = new SwapTaker({
    nostr,
    keys,
    reader: sub,
    writer,
    slotReader: createRpcChannelSlotReader({ rpcUrls }),
    chainProviders,
    store: new JsonFileTakerStateStore(join(STATE, 'taker-state.json')),
    redeemer: createRedeemer({ keys, chainProviders }),
    answerTimeoutMs: 60_000,
    maxResends: 2,
    logger: {
      warn: (e, d) => console.warn('[taker:warn]', e, JSON.stringify(d)),
      error: (e, d) => console.error('[taker:error]', e, JSON.stringify(d)),
    },
  });
  taker.start();
  taker.listOrders();
  const deadline = Date.now() + 60_000;
  while (
    !taker.listOrders().some((o) => o.makerPubkey === maker.nostr.pubkey) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const listing = taker
    .listOrders()
    .find((o) => o.makerPubkey === maker.nostr.pubkey);
  if (!listing) throw new Error('order not visible on the relay');
  console.log(
    `order ${listing.order.orderId} live; fill bounds [${listing.order.fill.min}, ${listing.order.fill.max}]`
  );

  interface Row {
    delta: string;
    fills: number;
    notional: string;
    wallMs: number;
    fillsPerSec: number;
    latMeanMs: number;
    latP50Ms: number;
    latMaxMs: number;
    takerPublishMeanMs: number;
    makerPublishMeanMs: number;
    makerVerifyMeanMs: number | null;
    writes: number;
    carriageUSDCmicro: number;
    carriagePctOfNotional: number;
    refusals: string[];
    ensureMs: number;
    status: string;
    error?: string;
  }
  const rows: Row[] = [];

  const RESUME = process.env['BENCH_RESUME'];
  const plan: { delta: bigint; resume?: string }[] = RESUME
    ? [{ delta: BigInt(taker.session(RESUME)?.delta ?? '0'), resume: RESUME }]
    : DELTAS.map((delta) => ({ delta }));

  for (const { delta, resume } of plan) {
    const notional = resume
      ? BigInt(must(taker.session(resume), 'resume session').size)
      : delta * BigInt(FILLS);
    console.log(
      `\n=== δ=${delta} × ${FILLS} fills (notional ${notional} µUSDC)${resume ? ` RESUME ${resume}` : ''} ===`
    );
    const makerEventsStart = makerEvents.length;
    const writesBefore = must(maker.maker, 'maker loop').health().writes.ok;
    const t0 = Date.now();
    let session;
    try {
      session = resume
        ? must(taker.session(resume), 'resume session')
        : await taker.accept(listing, { size: notional, delta });
    } catch (err) {
      rows.push({
        delta: delta.toString(),
        fills: 0,
        notional: notional.toString(),
        wallMs: 0,
        fillsPerSec: 0,
        latMeanMs: 0,
        latP50Ms: 0,
        latMaxMs: 0,
        takerPublishMeanMs: 0,
        makerPublishMeanMs: 0,
        makerVerifyMeanMs: null,
        writes: 0,
        carriageUSDCmicro: 0,
        carriagePctOfNotional: 0,
        refusals: [],
        ensureMs: 0,
        status: 'accept_failed',
        error: String(err),
      });
      console.error('accept failed', err);
      continue;
    }
    const fillTimes: number[] = []; // per-fill latency: previous advance (or first publish) → this advance
    let lastMark = 0;
    let firstPublishAt = 0;
    const seqPublishedAt = new Map<number, number>();
    const advances: SwapAdvance[] = [];
    const refusals: string[] = [];
    let status = 'done';
    let error: string | undefined;
    let ensureMs = 0;
    const runStart = Date.now();
    try {
      const runner = resume ? taker.resume.bind(taker) : taker.run.bind(taker);
      await runner(session.streamNonce, {
        onFill: (a) => {
          const now = Date.now();
          const s = must(
            taker.session(must(session, 'session').streamNonce),
            'session'
          );
          // publish time of THIS fill's wrap
          const pub = s.lastFill
            ? publishes.get(s.lastFill.eventId)
            : undefined;
          if (pub && !firstPublishAt) {
            firstPublishAt = pub.started;
            ensureMs = pub.started - runStart;
          }
          if (pub) seqPublishedAt.set(a.seq, pub.started);
          const base = lastMark || (pub?.started ?? now);
          fillTimes.push(now - base);
          lastMark = now;
          advances.push(a);
        },
      });
    } catch (err) {
      status = 'aborted';
      error = String(err);
      console.error('run failed', err);
    }
    const wallMs =
      lastMark && firstPublishAt
        ? lastMark - firstPublishAt
        : Date.now() - runStart;
    const sess = must(taker.session(session.streamNonce), 'session');
    if (sess.lastRefusal) refusals.push(sess.lastRefusal.refusal.reason);
    const sorted = [...fillTimes].sort((a, b) => a - b);
    const pubDur: number[] = [];
    for (const [, p] of publishes)
      if (p.started >= t0) pubDur.push(p.finished - p.started);
    // maker side: swap.fill.accepted → swap.answer.published (its publish RTT); and
    // verify time ≈ fill accepted − previous answer published is not receipt-based; report publish RTT only.
    const ev = makerEvents.slice(makerEventsStart);
    const makerPub: number[] = [];
    const verify: number[] = [];
    ev.forEach((cur, i) => {
      if (cur.event === 'swap.fill.accepted') {
        const next = ev
          .slice(i + 1)
          .find((e) => e.event === 'swap.answer.published');
        if (next) makerPub.push(next.t - cur.t);
        const prevPub = [...ev.slice(0, i)]
          .reverse()
          .find((e) => e.event === 'swap.answer.published');
        if (prevPub) verify.push(cur.t - prevPub.t); // upper bound: includes taker turnaround + relay fan-out
      }
    });
    const writes =
      must(maker.maker, 'maker loop').health().writes.ok -
      writesBefore +
      [...publishes.values()].filter((p) => p.started >= t0 && p.ok).length;
    const carriage = writes; // 1 µUSDC per write
    const row: Row = {
      delta: delta.toString(),
      fills: advances.length,
      notional: notional.toString(),
      wallMs,
      fillsPerSec:
        wallMs > 0 ? +(advances.length / (wallMs / 1000)).toFixed(3) : 0,
      latMeanMs: Math.round(mean(fillTimes)),
      latP50Ms: Math.round(pct(sorted, 50)),
      latMaxMs: Math.round(sorted.at(-1) ?? 0),
      takerPublishMeanMs: Math.round(mean(pubDur)),
      makerPublishMeanMs: Math.round(mean(makerPub)),
      makerVerifyMeanMs: null,
      writes,
      carriageUSDCmicro: carriage,
      carriagePctOfNotional:
        notional > 0n ? +((carriage / Number(notional)) * 100).toFixed(3) : 0,
      refusals,
      ensureMs,
      status,
      ...(error && { error }),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const md = [
    `# bench-fills — devnet ${new Date().toISOString()} — ${FILLS} fills per δ, rate 0.99, EVM→Solana`,
    '',
    '| δ (µUSDC) | fills | notional | wall ms | fills/s | lat mean | p50 | max | taker pub ms | maker pub ms | writes | carriage µUSDC | carriage % | refusals | status |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.delta} | ${r.fills} | ${r.notional} | ${r.wallMs} | ${r.fillsPerSec} | ${r.latMeanMs} | ${r.latP50Ms} | ${r.latMaxMs} | ${r.takerPublishMeanMs} | ${r.makerPublishMeanMs} | ${r.writes} | ${r.carriageUSDCmicro} | ${r.carriagePctOfNotional}% | ${r.refusals.join(',') || '-'} | ${r.status}${r.error ? ` (${r.error.slice(0, 80)})` : ''} |`
    ),
  ].join('\n');
  console.log('\n' + md);
  const suffix = RESUME ? '.resume' : '';
  writeFileSync(join(HERE, `bench-fills${suffix}.last.md`), md + '\n');
  writeFileSync(
    join(HERE, `bench-fills${suffix}.last.json`),
    JSON.stringify(
      {
        rows,
        makerEvents: makerEvents.filter((e) =>
          /fill|answer|order|refus|provision/.test(e.event)
        ),
      },
      null,
      2
    )
  );

  taker.stop();
  await relayClient.close();
  await maker.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
