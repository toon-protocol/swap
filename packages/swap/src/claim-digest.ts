/**
 * Claim digests and signer recovery — the byte layouts a swap claim is signed
 * over and checked against. Moved here from `@toon-protocol/settlement-digest`
 * 1.1.0 (and the sdk 3.3.0 re-exports) unchanged; the golden vectors in
 * `claim-digest.test.ts` pin the bytes.
 *
 * On-chain strings keep their names: the EIP-712 domain is
 * `RollingSwapChannel`/`2` and the struct type is `ClaimBalanceProof`.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  hexToBytes as nobleHexToBytes,
} from '@noble/hashes/utils.js';

/** Hex string (with or without `0x`) to bytes. Rejects odd-length and non-hex. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  return nobleHexToBytes(clean);
}

/** Non-negative bigint as 32-byte big-endian. Throws if negative or over 256 bits. */
export function bigintToBytes32BE(x: bigint): Uint8Array {
  if (x < 0n) {
    throw new Error('bigint must be non-negative for claim encoding');
  }
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error('bigint exceeds 256 bits');
  }
  return out;
}

/** Concatenate N byte arrays into one new array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const EIP712_PREFIX = new Uint8Array([0x19, 0x01]);
export const EIP712DOMAIN_TYPEHASH = keccak_256(
  utf8(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  )
);
export const DOMAIN_NAME_HASH = keccak_256(utf8('RollingSwapChannel'));
export const DOMAIN_VERSION_HASH = keccak_256(utf8('2'));
export const CLAIM_TYPEHASH = keccak_256(
  utf8(
    'ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)'
  )
);

function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new Error(`cannot left-pad ${bytes.length} bytes into 32`);
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** EIP-712 domain separator of the `RollingSwapChannel` v2 domain. */
export function eip712DomainSeparatorEvm(
  chainId: bigint,
  verifyingContractBytes: Uint8Array
): Uint8Array {
  if (verifyingContractBytes.length !== 20) {
    throw new Error(
      `verifyingContract must be 20 bytes (got ${verifyingContractBytes.length})`
    );
  }
  return keccak_256(
    concatBytes(
      EIP712DOMAIN_TYPEHASH,
      DOMAIN_NAME_HASH,
      DOMAIN_VERSION_HASH,
      bigintToBytes32BE(chainId),
      leftPad32(verifyingContractBytes)
    )
  );
}

/**
 * The 32-byte EIP-712 digest of a claim:
 * `keccak256(0x1901 || domainSeparator || keccak256(abi.encode(CLAIM_TYPEHASH,
 * channelId, cumulativeAmount, nonce, recipient)))`.
 */
export function claimHashEvm(
  channelIdBytes: Uint8Array,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipientBytes: Uint8Array,
  chainId: bigint,
  verifyingContractBytes: Uint8Array
): Uint8Array {
  if (channelIdBytes.length !== 32) {
    throw new Error(`channelId must be 32 bytes (got ${channelIdBytes.length})`);
  }
  if (recipientBytes.length !== 20) {
    throw new Error(`recipient must be 20 bytes (got ${recipientBytes.length})`);
  }
  const structHash = keccak_256(
    concatBytes(
      CLAIM_TYPEHASH,
      channelIdBytes,
      bigintToBytes32BE(cumulativeAmount),
      bigintToBytes32BE(nonce),
      leftPad32(recipientBytes)
    )
  );
  return keccak_256(
    concatBytes(
      EIP712_PREFIX,
      eip712DomainSeparatorEvm(chainId, verifyingContractBytes),
      structHash
    )
  );
}

/** A string hashed into a Pallas-field-safe bigint (first 240 bits of sha256). */
export function minaHashToField(s: string): bigint {
  return BigInt('0x' + bytesToHex(sha256(utf8(s))).slice(0, 60));
}

/** The four Mina field elements a claim signature covers. */
export function claimFieldsMina(
  channelId: string,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipient: string
): bigint[] {
  return [
    minaHashToField(channelId),
    cumulativeAmount,
    nonce,
    minaHashToField(recipient),
  ];
}

/** Recover the `0x…` lowercase signer address of a 65-byte `r||s||v` signature over `digest`. */
export function recoverEvmSigner(digest: Uint8Array, sig65: Uint8Array): string {
  if (sig65.length !== 65) {
    throw new Error(
      `EVM signature must be 65 bytes (r||s||v), got ${sig65.length}`
    );
  }
  const v = sig65.at(64);
  if (v !== 27 && v !== 28) {
    throw new Error(`EVM signature v must be 27 or 28, got ${v}`);
  }
  const sig = secp256k1.Signature.fromBytes(
    sig65.slice(0, 64),
    'compact'
  ).addRecoveryBit(v - 27);
  const point = sig.recoverPublicKey(digest);
  const addrHash = keccak_256(point.toBytes(false).slice(1));
  return '0x' + bytesToHex(addrHash.slice(-20)).toLowerCase();
}

export interface EvmClaimParams {
  channelId: string;
  cumulativeAmount: bigint | string | number;
  nonce: bigint | string | number;
  recipient: string;
  chainId: bigint | string | number;
  verifyingContract: string;
}

/** Recover the signer of an EVM claim under its `(chainId, verifyingContract)` domain. */
export function recoverEvmClaimSigner(
  params: EvmClaimParams,
  sig65: Uint8Array
): string {
  const channelIdBytes = hexToBytes(params.channelId);
  const recipientBytes = hexToBytes(params.recipient);
  const verifyingContractBytes = hexToBytes(params.verifyingContract);
  if (channelIdBytes.length !== 32) {
    throw new Error(`channelId must be 32 bytes (got ${channelIdBytes.length})`);
  }
  if (recipientBytes.length !== 20) {
    throw new Error(`recipient must be 20 bytes (got ${recipientBytes.length})`);
  }
  if (verifyingContractBytes.length !== 20) {
    throw new Error(
      `verifyingContract must be 20 bytes (got ${verifyingContractBytes.length})`
    );
  }
  const digest = claimHashEvm(
    channelIdBytes,
    BigInt(params.cumulativeAmount),
    BigInt(params.nonce),
    recipientBytes,
    BigInt(params.chainId),
    verifyingContractBytes
  );
  return recoverEvmSigner(digest, sig65);
}

/** The slice of a `mina-signer` client `verifyMinaSignature` needs. */
export interface MinaFieldsVerifier {
  verifyFields(args: {
    data: bigint[];
    signature: string;
    publicKey: string;
  }): boolean;
}

/**
 * Check a Mina claim signature (UTF-8 base58 in `claimBytes`) over the claim's
 * fields. Used by tests; production verification of a Mina claim is not done
 * here.
 */
export function verifyMinaSignature(
  claim: {
    claimBytes: Uint8Array;
    channelId?: string;
    cumulativeAmount?: string;
    nonce?: string;
    recipient?: string;
  },
  expectedSignerAddress: string,
  client: MinaFieldsVerifier
): boolean {
  if (
    claim.channelId === undefined ||
    claim.cumulativeAmount === undefined ||
    claim.nonce === undefined ||
    claim.recipient === undefined
  ) {
    throw new Error(
      'Claim missing channelId/cumulativeAmount/nonce/recipient for Mina signature verify'
    );
  }
  if (claim.claimBytes.length === 0) {
    throw new Error(
      'Mina claimBytes is empty (expected UTF-8 base58 signature string)'
    );
  }
  const fields = claimFieldsMina(
    claim.channelId,
    BigInt(claim.cumulativeAmount),
    BigInt(claim.nonce),
    claim.recipient
  );
  try {
    return client.verifyFields({
      data: fields,
      signature: new TextDecoder().decode(claim.claimBytes),
      publicKey: expectedSignerAddress,
    });
  } catch {
    return false;
  }
}
