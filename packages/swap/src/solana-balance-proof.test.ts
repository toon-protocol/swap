/**
 * The Solana balance-proof message the maker signs — connector ADR 0053.
 *
 * The deployed payment-channel program rebuilds the message itself from the
 * program id, the channel account and the two u64s in the instruction, and
 * compares it byte for byte with what the Ed25519 precompile verified
 * (`packages/solana-program/src/processor.rs`). So this layout is not a
 * convention: a claim signed over anything else is unredeemable.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '@toon-protocol/sdk';

import { SwapWalletError } from './errors.js';
import {
  SOLANA_BALANCE_PROOF_DOMAIN_TAG,
  SOLANA_BALANCE_PROOF_MESSAGE_SIZE,
  SolanaPaymentChannelSigner,
  solanaBalanceProofMessage,
} from './payment-channel-signer.js';

const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const CHANNEL = base58Encode(new Uint8Array(32).fill(7));

function le64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

describe('solanaBalanceProofMessage (ADR 0053, 96 bytes)', () => {
  it('lays out tag || program_id || channel_pda || nonce LE || amount LE', () => {
    const msg = solanaBalanceProofMessage(PROGRAM_ID, CHANNEL, 5n, 1_000_000n);
    expect(msg.length).toBe(SOLANA_BALANCE_PROOF_MESSAGE_SIZE);
    expect(Buffer.from(msg.subarray(0, 16)).toString('utf8')).toBe(
      'TOON-BALPROOF-V2'
    );
    expect(msg.subarray(0, 16)).toEqual(SOLANA_BALANCE_PROOF_DOMAIN_TAG);
    expect(msg.subarray(16, 48)).toEqual(base58Decode(PROGRAM_ID));
    expect(msg.subarray(48, 80)).toEqual(base58Decode(CHANNEL));
    expect(msg.subarray(80, 88)).toEqual(le64(5n));
    expect(msg.subarray(88, 96)).toEqual(le64(1_000_000n));
  });

  it('matches the connector wire vector prefix byte for byte', () => {
    // vectors/wire-vectors.json → peer_carriage.claim_solana.signed_message_hex
    // begins with the tag; pin that the tag bytes are the ASCII the program
    // compares against.
    const msg = solanaBalanceProofMessage(PROGRAM_ID, CHANNEL, 1n, 1n);
    expect(Buffer.from(msg.subarray(0, 16)).toString('hex')).toBe(
      '544f4f4e2d42414c50524f4f462d5632'
    );
  });

  it('the 48-byte legacy layout is NOT a prefix of the new message', () => {
    const msg = solanaBalanceProofMessage(PROGRAM_ID, CHANNEL, 9n, 10n);
    const legacy = Buffer.concat([
      Buffer.from(base58Decode(CHANNEL)),
      Buffer.from(le64(9n)),
      Buffer.from(le64(10n)),
    ]);
    expect(Buffer.from(msg.subarray(0, 48)).equals(legacy)).toBe(false);
  });

  it('refuses a channel id that is not 32 base58 bytes', () => {
    expect(() =>
      solanaBalanceProofMessage(PROGRAM_ID, 'not-a-pda', 1n, 1n)
    ).toThrow(SwapWalletError);
    expect(() =>
      solanaBalanceProofMessage(
        PROGRAM_ID,
        base58Encode(new Uint8Array(20)),
        1n,
        1n
      )
    ).toThrow(/32-byte/);
  });

  it('refuses a program id that is not 32 base58 bytes', () => {
    expect(() =>
      solanaBalanceProofMessage('abc', CHANNEL, 1n, 1n)
    ).toThrow(SwapWalletError);
  });

  it('refuses u64 overflow on either integer', () => {
    expect(() =>
      solanaBalanceProofMessage(PROGRAM_ID, CHANNEL, 2n ** 64n, 1n)
    ).toThrow(/u64/);
    expect(() =>
      solanaBalanceProofMessage(PROGRAM_ID, CHANNEL, 1n, -1n)
    ).toThrow(/u64/);
  });
});

describe('SolanaPaymentChannelSigner signs the 96-byte message', () => {
  it('verifies under the signer pubkey over exactly the ADR 0053 bytes', async () => {
    const seed = new Uint8Array(32).fill(3);
    const signer = new SolanaPaymentChannelSigner({
      chain: 'solana:devnet',
      privateKey: seed,
      programId: PROGRAM_ID,
    });
    const sig = await signer.signBalanceProof({
      channelId: CHANNEL,
      cumulativeAmount: 2_500_000n,
      nonce: 3n,
      recipient: base58Encode(new Uint8Array(32).fill(9)),
    });
    expect(sig.length).toBe(64);
    const msg = solanaBalanceProofMessage(PROGRAM_ID, CHANNEL, 3n, 2_500_000n);
    expect(ed25519.verify(sig, msg, ed25519.getPublicKey(seed))).toBe(true);
    // And NOT over a message bound to another program.
    const other = solanaBalanceProofMessage(
      base58Encode(new Uint8Array(32).fill(1)),
      CHANNEL,
      3n,
      2_500_000n
    );
    expect(ed25519.verify(sig, other, ed25519.getPublicKey(seed))).toBe(false);
  });

  it('refuses to construct without a valid programId', () => {
    expect(
      () =>
        new SolanaPaymentChannelSigner({
          chain: 'solana:devnet',
          privateKey: new Uint8Array(32),
          programId: 'nope',
        })
    ).toThrow(SwapWalletError);
  });
});
