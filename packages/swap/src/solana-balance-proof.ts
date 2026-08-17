/**
 * The Solana balance-proof message a claim must be signed over to be REDEEMABLE.
 *
 * The maker signed `balanceProofHashSolana` —
 * `sha256(utf8(channelId) || cumulative(32BE) || nonce(32BE) || utf8(recipient))`
 * — for as long as this package has issued Solana claims. No deployed program
 * has ever verified that digest, so no Solana claim any maker has issued could be
 * redeemed on chain (toon#214, swap#164).
 *
 * What connector's native `packages/solana-program` verifies, through the Ed25519
 * precompile and compared byte-for-byte, is the RAW 48 bytes:
 *
 * ```text
 *   channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)
 * ```
 *
 * (`processor.rs:900-910`). It binds neither the recipient nor the mint: which
 * side gets paid is fixed by the channel's participants, not by the proof.
 *
 * TEMPORARY HOME. The canonical implementation is `balanceProofMessageSolana` in
 * `@toon-protocol/settlement-digest`, re-exported by `@toon-protocol/core` and
 * `@toon-protocol/sdk` (toon#214 / toon PR #215). This package pins
 * `@toon-protocol/sdk@^3.2.0`, which predates that export, and a maker signing an
 * unredeemable claim is not worth waiting on a release for. DELETE this module and
 * import the shared one when the sdk range is bumped past the release that carries
 * it; `solana-balance-proof.test.ts` pins the bytes so the swap can be checked
 * against the sdk's own golden vectors on that swap.
 *
 * @module
 */

import { base58Decode, concatBytes } from '@toon-protocol/sdk';

import { SwapWalletError } from './errors.js';

/** `channel_pda(32) || nonce(8) || transferred_amount(8)`. */
export const SOLANA_BALANCE_PROOF_MESSAGE_SIZE = 48;

/** Encode a non-negative bigint as 8-byte little-endian (the program's `u64`). */
function u64LE(value: bigint, label: string): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new SwapWalletError(
      'SIGNING_FAILED',
      `Solana balance proof: ${label} does not fit in a u64 (got ${value})`
    );
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Build the 48-byte message the on-chain program verifies.
 *
 * `channelId` MUST be the channel's PDA in base58 — on Solana a channelId IS its
 * channel PDA, and the program reconstructs these bytes from the account it was
 * handed. A channelId that is not 32 bytes cannot name a channel on chain, so it
 * is rejected here rather than signed into a proof that could never be redeemed.
 */
export function balanceProofMessageSolana(
  channelId: string,
  nonce: bigint,
  transferredAmount: bigint
): Uint8Array {
  let channelPda: Uint8Array;
  try {
    channelPda = base58Decode(channelId);
  } catch (err) {
    throw new SwapWalletError(
      'SIGNING_FAILED',
      `Solana channelId is not valid base58: ${channelId}`,
      { cause: err }
    );
  }
  if (channelPda.length !== 32) {
    throw new SwapWalletError(
      'SIGNING_FAILED',
      `Solana channelId must be a 32-byte channel PDA in base58 (got ` +
        `${channelPda.length} bytes from "${channelId}"). The on-chain program ` +
        `rebuilds the balance proof from the channel account itself, so a claim ` +
        `signed over anything else can never be redeemed.`
    );
  }
  return concatBytes(
    channelPda,
    u64LE(nonce, 'nonce'),
    u64LE(transferredAmount, 'transferredAmount')
  );
}
