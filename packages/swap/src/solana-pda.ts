/**
 * Solana program-derived addresses, dependency-free.
 *
 * A payment channel on the connector's Solana program lives at
 * `find_program_address(["channel", min(a, b), max(a, b), mint], program)`
 * (`packages/solana-program/src/processor.rs`, connector ADR 0059): the
 * channel between two participants for one mint has exactly one address,
 * and either participant can compute it. The maker uses this to find the
 * leg-B channel it has provisioned for a given taker recipient without any
 * per-taker configuration beyond the channel itself.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '@toon-protocol/sdk';

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromHex(bytesToHex(bytes));
    return true;
  } catch {
    return false;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** `Pubkey::find_program_address` — returns `[address, bump]`. */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Uint8Array
): [Uint8Array, number] {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(
      concat([...seeds, Uint8Array.of(bump), programId, PDA_MARKER])
    );
    if (!isOnCurve(candidate)) return [candidate, bump];
  }
  throw new Error('no viable program-derived address bump');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The channel PDA for a participant pair under `programId` and `mint`, as
 * base58. Participants are sorted, so argument order does not matter.
 */
export function deriveSolanaChannelPda(p: {
  participantA: string;
  participantB: string;
  mint: string;
  programId: string;
}): string {
  const a = base58Decode(p.participantA);
  const b = base58Decode(p.participantB);
  const mint = base58Decode(p.mint);
  const program = base58Decode(p.programId);
  for (const [label, bytes] of [
    ['participantA', a],
    ['participantB', b],
    ['mint', mint],
    ['programId', program],
  ] as const) {
    if (bytes.length !== 32) {
      throw new Error(`${label} must decode to 32 bytes (got ${bytes.length})`);
    }
  }
  const [min, max] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const [pda] = findProgramAddress(
    [new TextEncoder().encode('channel'), min, max, mint],
    program
  );
  return base58Encode(pda);
}
