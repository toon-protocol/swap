/**
 * Opt-in: the swap against TOON's live devnet — the real relay, the real
 * relay connector, Base Sepolia and Solana devnet. Never runs in CI; needs
 * two funded identities (native gas + USDC on both chains):
 *
 *   SWAP_E2E_DEVNET=1 \
 *   SWAP_E2E_MAKER_FILE=~/.toon-swap-dev/maker.json \
 *   SWAP_E2E_TAKER_FILE=~/.toon-swap-dev/taker.json \
 *   pnpm --filter @toon-protocol/swap test:e2e -- devnet-swap
 *
 * Each identity file is `{ mnemonic }` (what `SWAP_AUTOGEN_IDENTITY` writes).
 * The maker publishes USDC@Base-Sepolia → USDC@Solana-devnet; the taker
 * swaps 0.3 USDC in three fills and redeems on Solana (claim → close → settle
 * needs the challenge window, so this suite asserts the recorded claim, not
 * the payout).
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import { startSwapNode } from '../../src/swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from '../../src/swap-node.js';
import { createTakerRuntime } from '../../src/taker-runtime.js';
import type { TakerRuntime } from '../../src/taker-runtime.js';
import { readSolanaChannel } from './helpers/solana-chain.js';

const ENABLED = process.env['SWAP_E2E_DEVNET'] === '1';
const RELAY_READ = 'wss://relay-ws.devnet.toonprotocol.dev';
const RELAY_CONNECTOR = 'https://proxy.relay.devnet.toonprotocol.dev/ilp';
const EVM_CHAIN = 'evm:84532';
const SOL_CHAIN = 'solana:devnet';
const USDC = 1_000_000n;
const FILL = USDC / 10n;

function mnemonicFrom(envVar: string, fallback: string): string {
  const path = (process.env[envVar] ?? fallback).replace(/^~/, homedir());
  return (JSON.parse(readFileSync(path, 'utf8')) as { mnemonic: string })
    .mnemonic;
}

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

describe.skipIf(!ENABLED)('devnet: a swap through the live relay', () => {
  let dir: string;
  let maker: SwapNodeInstance;
  let rt: TakerRuntime;

  beforeAll(async () => {
    // Persistent on purpose: a verified leg-B claim is money, and it lives in
    // the taker's state file. Never delete it.
    dir = join(homedir(), '.toon-swap-dev', 'e2e');
    mkdirSync(dir, { recursive: true });
    maker = await startSwapNode({
      mnemonic: mnemonicFrom(
        'SWAP_E2E_MAKER_FILE',
        '~/.toon-swap-dev/maker.json'
      ),
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
        channelDeposit: 2n * FILL,
      })),
      relay: {
        readUrl: RELAY_READ,
        connectorUrl: RELAY_CONNECTOR,
        payChain: 'evm',
        deposit: USDC,
        transport: 'btp',
        channelStorePath: join(dir, 'maker-relay.json'),
      },
      order: {
        fill: { min: FILL, max: 5n * FILL },
        ttlMs: 600_000,
        refreshMs: 300_000,
      },
      statePath: join(dir, 'maker-state.json'),
      reconcileIntervalMs: 0,
      appPort: 0,
      logger: {
        debug: () => undefined,
        info: (...a) =>
          console.log('[maker]', ...a.map((x) => JSON.stringify(x))),
        warn: (...a) =>
          console.warn('[maker]', ...a.map((x) => JSON.stringify(x))),
        error: (...a) =>
          console.error('[maker]', ...a.map((x) => JSON.stringify(x))),
      },
    });
    rt = await createTakerRuntime({
      mnemonic: mnemonicFrom(
        'SWAP_E2E_TAKER_FILE',
        '~/.toon-swap-dev/taker.json'
      ),
      chains: ['evm', 'solana'],
      chainProviders,
      relay: {
        readUrl: RELAY_READ,
        connectorUrl: RELAY_CONNECTOR,
        payChain: 'evm',
        deposit: USDC,
        transport: 'btp',
        channelStorePath: join(dir, 'taker-relay.json'),
      },
      statePath: join(dir, 'taker-state.json'),
      logger: {
        info: (...a) =>
          console.log('[taker]', ...a.map((x) => JSON.stringify(x))),
        warn: (...a) =>
          console.warn('[taker]', ...a.map((x) => JSON.stringify(x))),
      },
      answerTimeoutMs: 60_000,
    });
  }, 300_000);

  afterAll(async () => {
    await rt?.stop();
    await maker?.stop();
  });

  async function takerSol(): Promise<number> {
    const res = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [rt.addresses.solana],
      }),
    });
    const json = (await res.json()) as { result?: { value?: number } };
    return (json.result?.value ?? 0) / 1e9;
  }

  let streamNonce: string | undefined;

  it('three fills EVM→Solana, verified both ways, through the live relay', async () => {
    rt.taker.listOrders();
    const deadline = Date.now() + 60_000;
    while (
      !rt.taker
        .listOrders()
        .some((o) => o.makerPubkey === maker.nostr.pubkey) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const listing = rt.taker
      .listOrders()
      .find((o) => o.makerPubkey === maker.nostr.pubkey);
    expect(
      listing,
      'the maker order is live on the devnet relay'
    ).toBeDefined();
    const session = await rt.taker.accept(listing!, {
      size: 3n * FILL,
      delta: FILL,
    });
    const done = await rt.taker.run(session.streamNonce, {
      onFill: (a) =>
        console.log(
          `[devnet] fill ${a.seq}: +${a.targetAmount} cumulative ${a.claim.cumulativeAmount}`
        ),
    });
    expect(done.status).toBe('done');
    expect(done.received?.cumulative).toBe('297000');
    streamNonce = session.streamNonce;
    console.log(
      `[devnet] session ${streamNonce} holds a verified leg-B claim on ${done.received?.channelId}; state at ${dir}`
    );
  }, 600_000);

  it('the taker records its claim on Solana devnet (needs SOL on the taker key)', async () => {
    expect(streamNonce).toBeDefined();
    const sol = await takerSol();
    if (sol === 0) {
      console.log(
        `[devnet] taker ${rt.addresses.solana} holds 0 SOL — skipping the on-chain claim; run \`toon-swap redeem --stream ${streamNonce}\` once funded`
      );
      return;
    }
    const { txId } = await rt.taker.redeem(streamNonce!);
    console.log(`[devnet] ClaimFromChannel ${txId}`);
    const acct = await readSolanaChannel(
      'https://api.devnet.solana.com',
      new PublicKey(rt.taker.session(streamNonce!)!.received!.channelId)
    );
    expect(acct).not.toBeNull();
  }, 300_000);
});
