/**
 * The maker as an app behind a Rust connector — exercised over plain HTTP
 * exactly the way the connector delivers to it: a free `POST /swap/rfq`,
 * then `POST /swap/fill` requests carrying the ADR 0040 attribution headers
 * the connector states after it verified the taker's leg-A claim.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { recoverEvmClaimSigner } from '@toon-protocol/settlement-digest';
import { base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeInstance } from './swap-node.js';
import { deriveSolanaChannelPda } from './solana-pda.js';
import { deriveSwapNodeKeys } from './wallet.js';
import { solanaBalanceProofMessage } from './payment-channel-signer.js';
import { SWAP_WIRE_PROTOCOL } from './wire.js';
import type { SwapAdvance, SwapQuote, SwapRefusal } from './wire.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EVM_TARGET = 'evm:31337';
const SOL_TARGET = 'solana:localnet';
const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const MINT = 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H';
const ROLLING_CHANNEL = '0x' + 'd3'.repeat(20);
const EVM_CHANNEL_ID = '0x' + '01'.repeat(32);
const EVM_RECIPIENT = '0x' + 'ab'.repeat(20);
const SOL_RECIPIENT = base58Encode(new Uint8Array(32).fill(5));
const PAYER_EVM = `evm:0x${'aa'.repeat(32)}`;
const PAYER_SOL = 'solana:G5mXQzfZb4tXWX7cQvXP9ZJnDBcUo6irWTmGGtX3xpzL';

let instance: SwapNodeInstance;
let makerSolanaPubkey: string;
let solLegBChannel: string;
let base: string;

function nonce(seed: number): string {
  return seed.toString(16).padStart(32, '0');
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: SwapQuote | SwapAdvance | SwapRefusal }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
}

const paid = (payer: string, amount: bigint, chain: 'evm' | 'solana') => ({
  'x-toon-payer': payer,
  'x-toon-amount': amount.toString(),
  'x-toon-chain': chain,
});

beforeAll(async () => {
  const keys = await deriveSwapNodeKeys({ mnemonic: MNEMONIC, chains: ['solana'] });
  makerSolanaPubkey = base58Encode(
    (keys.solana as NonNullable<typeof keys.solana>).publicKey
  );
  solLegBChannel = deriveSolanaChannelPda({
    participantA: makerSolanaPubkey,
    participantB: SOL_RECIPIENT,
    mint: MINT,
    programId: PROGRAM_ID,
  });
  instance = await startSwapNode({
    mnemonic: MNEMONIC,
    ilpAddress: 'g.test.maker',
    fillAmount: 1_000_000n,
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'solana:localnet' },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
        rate: '2.0',
      },
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
        to: { assetCode: 'USDC', assetScale: 6, chain: SOL_TARGET },
        rate: '0.5',
      },
    ],
    chains: ['evm', 'solana'],
    channels: {
      [EVM_TARGET]: [
        { channelId: EVM_CHANNEL_ID, cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 },
      ],
      [SOL_TARGET]: [
        { channelId: solLegBChannel, cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 },
        // A decoy: first in pool order, but not the recipient's PDA.
        {
          channelId: base58Encode(new Uint8Array(32).fill(77)),
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [EVM_TARGET]: 10_000_000n, [SOL_TARGET]: 3_000_000n },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: EVM_TARGET,
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        channelAddress: ROLLING_CHANNEL,
      },
      {
        chainType: 'solana',
        chainId: SOL_TARGET,
        rpcUrl: 'http://127.0.0.1:1',
        programId: PROGRAM_ID,
        tokenMint: MINT,
      },
    ],
    reconcileIntervalMs: 0,
    appPort: 0,
  });
  base = `http://127.0.0.1:${instance.appPort}`;
});

afterAll(async () => {
  await instance.stop();
});

describe('health', () => {
  it('names the routes to put in front of it and the leg-B terms', async () => {
    const res = await fetch(`${base}/health`);
    const h = (await res.json()) as {
      status: string;
      rfqDestination: string;
      fillDestination: string;
      legB: Record<string, { verifyingContract?: string; programId?: string }>;
      sessions: number;
    };
    expect(h.status).toBe('ok');
    expect(h.rfqDestination).toBe('g.test.maker.rfq');
    expect(h.fillDestination).toBe('g.test.maker');
    expect(h.legB[EVM_TARGET]?.verifyingContract).toBe(ROLLING_CHANNEL);
    expect(h.legB[SOL_TARGET]?.programId).toBe(PROGRAM_ID);
    expect(instance.ilpAddress).toBe('g.test.maker');
  });
});

describe('RFQ', () => {
  it('quotes a known pair with the fill route and leg-B facts', async () => {
    const { status, json } = await post('/swap/rfq', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: nonce(1),
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'solana:localnet' },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
      },
      chainRecipient: EVM_RECIPIENT,
    });
    expect(status).toBe(200);
    const q = json as SwapQuote;
    expect(q.type).toBe('quote');
    expect(q.rate).toBe('2.0');
    expect(q.fill).toEqual({
      destination: 'g.test.maker',
      amount: '1000000',
      chain: 'solana:localnet',
    });
    expect(q.legB.verifyingContract).toBe(ROLLING_CHANNEL);
    expect(q.legB.swapSignerAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(q.maxAmount).toBe('10000000');
    expect(q.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses an unknown pair (404) and a malformed recipient (400)', async () => {
    const unknown = await post('/swap/rfq', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: nonce(2),
      pair: {
        from: { assetCode: 'ETH', assetScale: 18, chain: EVM_TARGET },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
      },
      chainRecipient: EVM_RECIPIENT,
    });
    expect(unknown.status).toBe(404);
    expect((unknown.json as SwapRefusal).reason).toBe('unknown_pair');
    const bad = await post('/swap/rfq', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: nonce(3),
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'solana:localnet' },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
      },
      chainRecipient: 'not-an-address',
    });
    expect(bad.status).toBe(400);
    expect((bad.json as SwapRefusal).reason).toBe('invalid_recipient');
  });

  it('answers garbage with a 400 refusal, never a crash', async () => {
    const res = await fetch(`${base}/swap/rfq`, {
      method: 'POST',
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const get = await fetch(`${base}/swap/fill`);
    expect(get.status).toBe(400);
  });
});

describe('fill → EVM leg B', () => {
  const N = nonce(10);
  beforeAll(async () => {
    const r = await post('/swap/rfq', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: N,
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'solana:localnet' },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
      },
      chainRecipient: EVM_RECIPIENT,
    });
    expect(r.status).toBe(200);
  });

  it('refuses an unpaid fill with 402 and issues nothing', async () => {
    const { status, json } = await post('/swap/fill', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'fill',
      streamNonce: N,
      seq: 1,
    });
    expect(status).toBe(402);
    expect((json as SwapRefusal).reason).toBe('unpaid');
  });

  it('refuses a fill paid on the wrong chain family, crediting the payment', async () => {
    const { status, json } = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 1 },
      paid(PAYER_EVM, 1_000_000n, 'evm')
    );
    expect(status).toBe(422);
    const r = json as SwapRefusal;
    expect(r.reason).toBe('chain_mismatch');
    expect(r.credited).toBe('1000000');
  });

  it('turns a paid fill into a recoverable v2 balance proof, applying the credit', async () => {
    const { status, json } = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 1 },
      paid(PAYER_SOL, 1_000_000n, 'solana')
    );
    expect(status).toBe(200);
    const a = json as SwapAdvance;
    expect(a.type).toBe('advance');
    expect(a.seq).toBe(1);
    expect(a.credited).toBe('1000000');
    expect(a.sourceAmount).toBe('2000000'); // charge + credit
    expect(a.targetAmount).toBe('4000000'); // × 2.0
    expect(a.channelId).toBe(EVM_CHANNEL_ID);
    expect(a.nonce).toBe('1');
    expect(a.cumulativeAmount).toBe('4000000');
    expect(a.recipient).toBe(EVM_RECIPIENT);
    const recovered = recoverEvmClaimSigner(
      {
        channelId: a.channelId,
        cumulativeAmount: a.cumulativeAmount,
        nonce: a.nonce,
        recipient: a.recipient,
        chainId: 31337n,
        verifyingContract: ROLLING_CHANNEL,
      },
      Uint8Array.from(Buffer.from(a.claim, 'base64'))
    );
    expect(recovered.toLowerCase()).toBe(a.swapSignerAddress.toLowerCase());
    expect(a.receipt).toBeDefined();
  });

  it('answers a retransmitted seq with the same advance, and a gap with 409', async () => {
    const again = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 1 },
      paid(PAYER_SOL, 1_000_000n, 'solana')
    );
    expect(again.status).toBe(200);
    expect((again.json as SwapAdvance).cumulativeAmount).toBe('4000000');
    const gap = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 3 },
      paid(PAYER_SOL, 1_000_000n, 'solana')
    );
    expect(gap.status).toBe(409);
    expect((gap.json as SwapRefusal).reason).toBe('seq_gap');
    expect((gap.json as SwapRefusal).credited).toBe('1000000');
  });

  it('binds the session to the first payer; another payer is refused uncredited', async () => {
    const other = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 2 },
      paid('solana:11111111111111111111111111111111', 1_000_000n, 'solana')
    );
    expect(other.status).toBe(403);
    expect((other.json as SwapRefusal).reason).toBe('payer_mismatch');
    expect((other.json as SwapRefusal).credited).toBeUndefined();
  });

  it('advances the cumulative on seq 2 with the earlier credit applied', async () => {
    const { status, json } = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 2 },
      paid(PAYER_SOL, 1_000_000n, 'solana')
    );
    expect(status).toBe(200);
    const a = json as SwapAdvance;
    expect(a.credited).toBe('1000000');
    expect(a.nonce).toBe('2');
    expect(a.cumulativeAmount).toBe('8000000');
    const h = instance.health();
    expect(h.inventoryWindow[`USDC:${EVM_TARGET}`]?.unsettled).toBe('8000000');
  });

  it('refuses a fill for an unknown session with 404', async () => {
    const { status, json } = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: nonce(99), seq: 1 },
      paid(PAYER_SOL, 1_000_000n, 'solana')
    );
    expect(status).toBe(404);
    expect((json as SwapRefusal).reason).toBe('unknown_session');
  });
});

describe('fill → Solana leg B', () => {
  const N = nonce(20);
  it('serves the recipient from the PDA the participants derive, not the first pool channel', async () => {
    const q = await post('/swap/rfq', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: N,
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
        to: { assetCode: 'USDC', assetScale: 6, chain: SOL_TARGET },
      },
      chainRecipient: SOL_RECIPIENT,
    });
    expect(q.status).toBe(200);
    expect((q.json as SwapQuote).legB.programId).toBe(PROGRAM_ID);
    expect((q.json as SwapQuote).legB.swapSignerAddress).toBe(makerSolanaPubkey);

    const { status, json } = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N, seq: 1 },
      paid(PAYER_EVM, 1_000_000n, 'evm')
    );
    expect(status).toBe(200);
    const a = json as SwapAdvance;
    expect(a.channelId).toBe(solLegBChannel);
    expect(a.targetAmount).toBe('500000');
    const msg = solanaBalanceProofMessage(
      PROGRAM_ID,
      a.channelId,
      BigInt(a.nonce),
      BigInt(a.cumulativeAmount)
    );
    const ok = ed25519.verify(
      Uint8Array.from(Buffer.from(a.claim, 'base64')),
      msg,
      Uint8Array.from(Buffer.from(base58DecodeLocal(makerSolanaPubkey)))
    );
    expect(ok).toBe(true);
  });

  it('refuses a recipient whose PDA is not provisioned, naming the channel to open', async () => {
    const N2 = nonce(21);
    const stranger = base58Encode(new Uint8Array(32).fill(6));
    await post('/swap/rfq', {
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce: N2,
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_TARGET },
        to: { assetCode: 'USDC', assetScale: 6, chain: SOL_TARGET },
      },
      chainRecipient: stranger,
    });
    const { status, json } = await post(
      '/swap/fill',
      { proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce: N2, seq: 1 },
      paid(`evm:0x${'bb'.repeat(32)}`, 1_000_000n, 'evm')
    );
    console.log('DEBUG stranger fill', status, JSON.stringify(json));
    expect(status).toBe(503);
    const r = json as SwapRefusal;
    expect(r.reason).toBe('no_channel_available');
    expect(r.detail?.['preferredChannelId']).toBe(
      deriveSolanaChannelPda({
        participantA: makerSolanaPubkey,
        participantB: stranger,
        mint: MINT,
        programId: PROGRAM_ID,
      })
    );
    expect(r.credited).toBe('1000000');
  });
});

function base58DecodeLocal(s: string): Uint8Array {
  const ALPHABET =
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
