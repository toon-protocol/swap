import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@toon-protocol/sdk';
import { privateKeyToAccount } from 'viem/accounts';

import { deriveEvmChannelId } from './evm-leg-b-channel.js';
import {
  SolanaPaymentChannelSigner,
  TokenNetworkBalanceProofSigner,
} from './payment-channel-signer.js';
import { createReadBudgets, verifyInboundClaim } from './received-claim.js';
import type {
  ChannelFacts,
  ChannelSlotReader,
  CounterpartySlot,
  InboundClaim,
} from './received-claim.js';
import type { SolanaChannelAccount } from './solana-leg-b-channel.js';
import { deriveSolanaChannelPda } from './solana-pda.js';

// ── EVM fixtures ────────────────────────────────────────────────────────────

const takerKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const takerAddress = privateKeyToAccount(`0x${'11'.repeat(32)}`).address;
const makerAddress = privateKeyToAccount(`0x${'22'.repeat(32)}`).address;
const TOKEN_NETWORK = '0x' + 'ab'.repeat(20);
const EVM_CHAIN = 'evm:31337';
const EPOCH = 0n;
const evmChannelId = deriveEvmChannelId(takerAddress, makerAddress, EPOCH);

const evmFacts: ChannelFacts = {
  family: 'evm',
  chain: EVM_CHAIN,
  chainId: 31337n,
  tokenNetwork: TOKEN_NETWORK,
  self: makerAddress,
  counterparty: takerAddress,
};

const evmSigner = new TokenNetworkBalanceProofSigner({
  chain: EVM_CHAIN,
  privateKey: takerKey,
  chainId: 31337n,
  tokenNetworkAddress: TOKEN_NETWORK,
});

async function evmClaim(
  nonce: bigint,
  cumulative: bigint,
  over: Partial<InboundClaim> = {}
) {
  const sig = await evmSigner.signBalanceProof({
    channelId: evmChannelId,
    nonce,
    cumulativeAmount: cumulative,
    recipient: makerAddress,
  });
  return {
    chain: EVM_CHAIN,
    channelId: evmChannelId,
    nonce: nonce.toString(),
    cumulativeAmount: cumulative.toString(),
    signature: Buffer.from(sig).toString('base64'),
    signer: takerAddress,
    ...over,
  } satisfies InboundClaim;
}

// ── Solana fixtures ─────────────────────────────────────────────────────────

const takerSeed = Uint8Array.from(Buffer.from('33'.repeat(32), 'hex'));
const takerSolPub = base58Encode(ed25519.getPublicKey(takerSeed));
const makerSolPub = base58Encode(
  ed25519.getPublicKey(Uint8Array.from(Buffer.from('44'.repeat(32), 'hex')))
);
const PROGRAM_ID = base58Encode(
  Uint8Array.from(Buffer.from('55'.repeat(32), 'hex'))
);
const MINT = base58Encode(Uint8Array.from(Buffer.from('66'.repeat(32), 'hex')));
const SOL_CHAIN = 'solana:localnet';
const solPda = deriveSolanaChannelPda({
  participantA: takerSolPub,
  participantB: makerSolPub,
  mint: MINT,
  programId: PROGRAM_ID,
});
const solFacts: ChannelFacts = {
  family: 'solana',
  chain: SOL_CHAIN,
  programId: PROGRAM_ID,
  mint: MINT,
  self: makerSolPub,
  counterparty: takerSolPub,
};
const solSigner = new SolanaPaymentChannelSigner({
  chain: SOL_CHAIN,
  privateKey: takerSeed,
  programId: PROGRAM_ID,
});

async function solClaim(
  nonce: bigint,
  cumulative: bigint,
  over: Partial<InboundClaim> = {}
) {
  const sig = await solSigner.signBalanceProof({
    channelId: solPda,
    nonce,
    cumulativeAmount: cumulative,
    recipient: makerSolPub,
  });
  return {
    chain: SOL_CHAIN,
    channelId: solPda,
    nonce: nonce.toString(),
    cumulativeAmount: cumulative.toString(),
    signature: Buffer.from(sig).toString('base64'),
    signer: takerSolPub,
    ...over,
  } satisfies InboundClaim;
}

function solAccount(
  over: Partial<SolanaChannelAccount> = {}
): SolanaChannelAccount {
  // participants sorted by bytes, as the program stores them
  const [a, b] = [takerSolPub, makerSolPub];
  return {
    participantA: a,
    participantB: b,
    tokenMint: MINT,
    depositA: 10_000n,
    depositB: 0n,
    transferredAmountA: 0n,
    transferredAmountB: 0n,
    nonceA: 0n,
    nonceB: 0n,
    challengeDuration: 3600n,
    state: 0,
    ...over,
  };
}

// ── A counting fake reader ──────────────────────────────────────────────────

function fakeReader(
  over: {
    epoch?: bigint | Error;
    slot?: CounterpartySlot | Error;
    sol?: SolanaChannelAccount | null | Error;
  } = {}
) {
  const calls = { epoch: 0, slot: 0, sol: 0 };
  const reader: ChannelSlotReader = {
    async evmEpoch() {
      calls.epoch++;
      if (over.epoch instanceof Error) throw over.epoch;
      return over.epoch ?? EPOCH;
    },
    async evmSlot() {
      calls.slot++;
      if (over.slot instanceof Error) throw over.slot;
      return (
        over.slot ?? {
          state: 'opened',
          deposit: 10_000n,
          nonce: 0n,
          transferredAmount: 0n,
        }
      );
    },
    async solanaChannel() {
      calls.sol++;
      if (over.sol instanceof Error) throw over.sol;
      return over.sol === undefined ? solAccount() : over.sol;
    },
  };
  return { reader, calls };
}

const NOW = 1_800_000_000_000;

describe('verifyInboundClaim — EVM TokenNetwork balance proof', () => {
  it('accepts a first claim: seeds the watermark from chain, reads epoch + slot once', async () => {
    const { reader, calls } = fakeReader();
    const r = await verifyInboundClaim({
      claim: await evmClaim(1n, 1000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delta).toBe(1000n);
    expect(r.deposit).toBe(10_000n);
    expect(r.watermark).toEqual({
      nonce: 1n,
      cumulative: 1000n,
      deposit: 10_000n,
      depositReadAt: NOW,
      epoch: 0n,
    });
    expect(calls).toEqual({ epoch: 1, slot: 1, sol: 0 });
    expect(r.chainReads).toBe(2);
  });

  it('a second claim within the cache window costs zero chain reads', async () => {
    const { reader, calls } = fakeReader();
    const first = await verifyInboundClaim({
      claim: await evmClaim(1n, 1000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    if (!first.ok) throw new Error(first.message);
    const second = await verifyInboundClaim({
      claim: await evmClaim(2n, 2000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: first.watermark,
      reader,
      now: () => NOW + 1000,
    });
    expect(second.ok).toBe(true);
    expect(calls).toEqual({ epoch: 1, slot: 1, sol: 0 });
    if (second.ok) expect(second.chainReads).toBe(0);
  });

  it('re-reads when the cumulative outgrows the cached deposit, and refuses a shortfall', async () => {
    const { reader, calls } = fakeReader({
      slot: {
        state: 'opened',
        deposit: 1500n,
        nonce: 0n,
        transferredAmount: 0n,
      },
    });
    const wm = {
      nonce: 1n,
      cumulative: 1000n,
      deposit: 1500n,
      depositReadAt: NOW,
      epoch: 0n,
    };
    const r = await verifyInboundClaim({
      claim: await evmClaim(2n, 2000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: wm,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('DEPOSIT_SHORTFALL');
    expect(calls.slot).toBe(1);
  });

  it('re-reads a stale cache and refuses a channel that is no longer open', async () => {
    const { reader } = fakeReader({
      slot: {
        state: 'closed',
        deposit: 10_000n,
        nonce: 0n,
        transferredAmount: 0n,
      },
    });
    const wm = {
      nonce: 1n,
      cumulative: 1000n,
      deposit: 10_000n,
      depositReadAt: NOW - 120_000,
      epoch: 0n,
    };
    const r = await verifyInboundClaim({
      claim: await evmClaim(2n, 2000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: wm,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CHANNEL_NOT_OPEN');
  });

  it('seeds from chain so an already-redeemed claim is not new value', async () => {
    const { reader } = fakeReader({
      slot: {
        state: 'opened',
        deposit: 10_000n,
        nonce: 3n,
        transferredAmount: 3000n,
      },
    });
    const r = await verifyInboundClaim({
      claim: await evmClaim(3n, 3000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NON_MONOTONIC_NONCE');
  });

  it.each([
    ['wrong signer', { signer: makerAddress }, 'SIGNER_MISMATCH'],
    ['wrong chain', { chain: 'evm:1' }, 'CHAIN_MISMATCH'],
    ['bad nonce text', { nonce: '1.5' }, 'MALFORMED_CLAIM'],
    [
      'short signature',
      { signature: Buffer.alloc(64).toString('base64') },
      'MALFORMED_CLAIM',
    ],
  ] as const)(
    'refuses %s before any chain read',
    async (_label, over, code) => {
      const { reader, calls } = fakeReader();
      const r = await verifyInboundClaim({
        claim: await evmClaim(1n, 1000n, over),
        facts: evmFacts,
        expectedDelta: 1000n,
        watermark: null,
        reader,
        now: () => NOW,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
      expect(calls).toEqual({ epoch: 0, slot: 0, sol: 0 });
    }
  );

  it('refuses a tampered claim (signature over different bytes) before any chain read', async () => {
    const { reader, calls } = fakeReader();
    const claim = await evmClaim(1n, 1000n);
    const r = await verifyInboundClaim({
      claim: { ...claim, cumulativeAmount: '5000' },
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SIGNATURE_INVALID');
    expect(calls.epoch + calls.slot).toBe(0);
  });

  it('refuses a validly signed claim on a channel that is not the pair channel', async () => {
    const { reader } = fakeReader();
    const otherChannel = deriveEvmChannelId(takerAddress, makerAddress, 7n);
    const sig = await evmSigner.signBalanceProof({
      channelId: otherChannel,
      nonce: 1n,
      cumulativeAmount: 1000n,
      recipient: makerAddress,
    });
    const r = await verifyInboundClaim({
      claim: {
        chain: EVM_CHAIN,
        channelId: otherChannel,
        nonce: '1',
        cumulativeAmount: '1000',
        signature: Buffer.from(sig).toString('base64'),
        signer: takerAddress,
      },
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CHANNEL_MISMATCH');
  });

  it('bounds the delta from both sides', async () => {
    const { reader } = fakeReader();
    const wm = {
      nonce: 1n,
      cumulative: 1000n,
      deposit: 10_000n,
      depositReadAt: NOW,
      epoch: 0n,
    };
    const small = await verifyInboundClaim({
      claim: await evmClaim(2n, 1500n),
      facts: evmFacts,
      expectedDelta: 1000n,
      maxDelta: 2000n,
      watermark: wm,
      reader,
      now: () => NOW,
    });
    expect(!small.ok && small.code).toBe('CUMULATIVE_SHORTFALL');
    const big = await verifyInboundClaim({
      claim: await evmClaim(2n, 4000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      maxDelta: 2000n,
      watermark: wm,
      reader,
      now: () => NOW,
    });
    expect(!big.ok && big.code).toBe('DELTA_TOO_LARGE');
  });

  it('a failed read is a retryable refusal; an exhausted budget is not', async () => {
    const failing = fakeReader({ epoch: new Error('rpc down') });
    const r1 = await verifyInboundClaim({
      claim: await evmClaim(1n, 1000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader: failing.reader,
      now: () => NOW,
    });
    expect(r1).toMatchObject({
      ok: false,
      code: 'CHAIN_READ_FAILED',
      retry: true,
    });

    const budgets = createReadBudgets({ maxReadsPerMinute: 1, now: () => NOW });
    const budget = budgets('taker');
    const { reader, calls } = fakeReader();
    const r2 = await verifyInboundClaim({
      claim: await evmClaim(1n, 1000n),
      facts: evmFacts,
      expectedDelta: 1000n,
      watermark: null,
      reader,
      budget,
      now: () => NOW,
    });
    expect(r2).toMatchObject({ ok: false, code: 'RATE_LIMITED', retry: false });
    expect(calls).toEqual({ epoch: 1, slot: 0, sol: 0 }); // the second read was refused
  });
});

describe('verifyInboundClaim — Solana TOON-BALPROOF-V2', () => {
  it('accepts a first claim against the counterparty slot of the pair PDA', async () => {
    const { reader, calls } = fakeReader();
    const r = await verifyInboundClaim({
      claim: await solClaim(1n, 700n),
      facts: solFacts,
      expectedDelta: 700n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deposit).toBe(10_000n);
    expect(r.watermark).toEqual({
      nonce: 1n,
      cumulative: 700n,
      deposit: 10_000n,
      depositReadAt: NOW,
    });
    expect(calls).toEqual({ epoch: 0, slot: 0, sol: 1 });
  });

  it('refuses a forged signature and a missing channel account', async () => {
    const { reader, calls } = fakeReader();
    const forged = await solClaim(1n, 700n, {
      signature: Buffer.alloc(64, 1).toString('base64'),
    });
    const r1 = await verifyInboundClaim({
      claim: forged,
      facts: solFacts,
      expectedDelta: 700n,
      watermark: null,
      reader,
      now: () => NOW,
    });
    expect(!r1.ok && r1.code).toBe('SIGNATURE_INVALID');
    expect(calls.sol).toBe(0);

    const missing = fakeReader({ sol: null });
    const r2 = await verifyInboundClaim({
      claim: await solClaim(1n, 700n),
      facts: solFacts,
      expectedDelta: 700n,
      watermark: null,
      reader: missing.reader,
      now: () => NOW,
    });
    expect(!r2.ok && r2.code).toBe('CHANNEL_NOT_OPEN');
  });

  it('reads the counterparty slot whichever side it sits on', async () => {
    const swapped = fakeReader({
      sol: solAccount({
        participantA: makerSolPub,
        participantB: takerSolPub,
        depositA: 0n,
        depositB: 900n,
      }),
    });
    const r = await verifyInboundClaim({
      claim: await solClaim(1n, 700n),
      facts: solFacts,
      expectedDelta: 700n,
      watermark: null,
      reader: swapped.reader,
      now: () => NOW,
    });
    expect(r.ok && r.deposit).toBe(900n);
  });
});
