/**
 * The Solana balance-proof message layout (swap#164 / toon#214).
 *
 * These vectors are derived from connector
 * `packages/solana-program/src/processor.rs:900-910` — the `expected_message` the
 * deployed program reconstructs and byte-compares — NOT from any TypeScript
 * implementation. They were pinned by swap#165 against a temporary local copy of
 * the layout, and that copy was deleted once these same vectors proved the
 * published `@toon-protocol/settlement-digest` implementation byte-identical to
 * it. They now guard the published bytes, which is what the swap signs.
 *
 * The subject is `solanaBalanceProofMessage` — the swap's thin adapter over the
 * published `balanceProofMessageSolana`, which adds base58 `channelId` decoding
 * and `SwapWalletError`s that name the offending field.
 */
import { describe, it, expect } from 'vitest';
import { base58Decode } from '@toon-protocol/sdk';
import {
  balanceProofMessageSolana,
  SOLANA_BALANCE_PROOF_MESSAGE_SIZE,
} from '@toon-protocol/settlement-digest';

import { SwapWalletError } from './errors.js';
import { solanaBalanceProofMessage as balanceProofMessage } from './payment-channel-signer.js';

/** A real 32-byte channel PDA in base58. */
const CHANNEL_PDA = '7My924UBF6FFUSZ6uHeEvzTTR6Wjs3nZ3SAym9cDjPV1';

describe('solanaBalanceProofMessage', () => {
  it('[P0] delegates the bytes to the published shared implementation', () => {
    // The swap must not carry a second implementation of the layout: the adapter
    // is base58 decoding + typed errors, and nothing else.
    expect(Array.from(balanceProofMessage(CHANNEL_PDA, 7n, 250_000n))).toEqual(
      Array.from(
        balanceProofMessageSolana(base58Decode(CHANNEL_PDA), 7n, 250_000n)
      )
    );
  });

  it('[P0] is channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)', () => {
    const message = balanceProofMessage(CHANNEL_PDA, 7n, 250_000n);
    expect(message.length).toBe(SOLANA_BALANCE_PROOF_MESSAGE_SIZE);
    expect(Array.from(message.slice(0, 32))).toEqual(
      Array.from(base58Decode(CHANNEL_PDA))
    );
    // nonce = 7, little-endian, in the FIRST u64 slot.
    expect(Array.from(message.slice(32, 40))).toEqual([7, 0, 0, 0, 0, 0, 0, 0]);
    // transferred_amount = 250000 = 0x3D090.
    expect(Array.from(message.slice(40, 48))).toEqual([
      0x90, 0xd0, 0x03, 0, 0, 0, 0, 0,
    ]);
  });

  it('[P0] puts the nonce BEFORE the amount — swapping them is a different message', () => {
    const a = balanceProofMessage(CHANNEL_PDA, 1n, 2n);
    const b = balanceProofMessage(CHANNEL_PDA, 2n, 1n);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('[P0] refuses a channelId that is not a 32-byte PDA', () => {
    // Valid base58, wrong length.
    expect(() => balanceProofMessage('chanSoX', 1n, 1n)).toThrow(
      SwapWalletError
    );
    expect(() => balanceProofMessage('chanSoX', 1n, 1n)).toThrow(
      /32-byte channel PDA/
    );
    // Not base58 at all.
    expect(() => balanceProofMessage('chan-1', 1n, 1n)).toThrow(
      /not valid base58/
    );
  });

  it('[P0] refuses values a u64 cannot hold, naming the field', () => {
    expect(() => balanceProofMessage(CHANNEL_PDA, 1n << 64n, 1n)).toThrow(
      /nonce/
    );
    expect(() => balanceProofMessage(CHANNEL_PDA, 1n, 1n << 64n)).toThrow(
      /transferredAmount/
    );
    expect(() => balanceProofMessage(CHANNEL_PDA, -1n, 1n)).toThrow(/nonce/);
  });

  it('[P0] the boundary values a u64 CAN hold are accepted', () => {
    const max = 0xffffffffffffffffn;
    const message = balanceProofMessage(CHANNEL_PDA, max, max);
    expect(Array.from(message.slice(32, 48))).toEqual(new Array(16).fill(0xff));
    expect(
      Array.from(balanceProofMessage(CHANNEL_PDA, 0n, 0n).slice(32, 48))
    ).toEqual(new Array(16).fill(0));
  });
});
