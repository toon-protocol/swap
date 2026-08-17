/**
 * The Solana balance-proof message layout (swap#164 / toon#214).
 *
 * These vectors are pinned so that swapping this module out for
 * `@toon-protocol/sdk`'s `balanceProofMessageSolana` — once the sdk range is
 * bumped to a release carrying it — is provably byte-identical rather than
 * hopefully so. They are derived from connector
 * `packages/solana-program/src/processor.rs:900-910`, NOT from this module.
 */
import { describe, it, expect } from 'vitest';
import { base58Decode } from '@toon-protocol/sdk';

import { SwapWalletError } from './errors.js';
import {
  balanceProofMessageSolana,
  SOLANA_BALANCE_PROOF_MESSAGE_SIZE,
} from './solana-balance-proof.js';

/** A real 32-byte channel PDA in base58. */
const CHANNEL_PDA = '7My924UBF6FFUSZ6uHeEvzTTR6Wjs3nZ3SAym9cDjPV1';

describe('balanceProofMessageSolana', () => {
  it('[P0] is channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)', () => {
    const message = balanceProofMessageSolana(CHANNEL_PDA, 7n, 250_000n);
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
    const a = balanceProofMessageSolana(CHANNEL_PDA, 1n, 2n);
    const b = balanceProofMessageSolana(CHANNEL_PDA, 2n, 1n);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('[P0] refuses a channelId that is not a 32-byte PDA', () => {
    // Valid base58, wrong length.
    expect(() => balanceProofMessageSolana('chanSoX', 1n, 1n)).toThrow(
      SwapWalletError
    );
    expect(() => balanceProofMessageSolana('chanSoX', 1n, 1n)).toThrow(
      /32-byte channel PDA/
    );
    // Not base58 at all.
    expect(() => balanceProofMessageSolana('chan-1', 1n, 1n)).toThrow(
      /not valid base58/
    );
  });

  it('[P0] refuses values a u64 cannot hold, naming the field', () => {
    expect(() => balanceProofMessageSolana(CHANNEL_PDA, 1n << 64n, 1n)).toThrow(
      /nonce/
    );
    expect(() => balanceProofMessageSolana(CHANNEL_PDA, 1n, 1n << 64n)).toThrow(
      /transferredAmount/
    );
    expect(() => balanceProofMessageSolana(CHANNEL_PDA, -1n, 1n)).toThrow(
      /nonce/
    );
  });

  it('[P0] the boundary values a u64 CAN hold are accepted', () => {
    const max = 0xffffffffffffffffn;
    const message = balanceProofMessageSolana(CHANNEL_PDA, max, max);
    expect(Array.from(message.slice(32, 48))).toEqual(new Array(16).fill(0xff));
    expect(
      Array.from(balanceProofMessageSolana(CHANNEL_PDA, 0n, 0n).slice(32, 48))
    ).toEqual(new Array(16).fill(0));
  });
});
