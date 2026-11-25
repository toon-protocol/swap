/**
 * Golden vectors for the claim digests moved from
 * `@toon-protocol/settlement-digest` 1.1.0. Every literal below was produced
 * by that package before it was removed, so a byte change here fails a test.
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  CLAIM_TYPEHASH,
  DOMAIN_NAME_HASH,
  DOMAIN_VERSION_HASH,
  EIP712DOMAIN_TYPEHASH,
  bigintToBytes32BE,
  claimFieldsMina,
  claimHashEvm,
  concatBytes,
  eip712DomainSeparatorEvm,
  hexToBytes,
  recoverEvmClaimSigner,
  recoverEvmSigner,
} from './claim-digest.js';

const hex = (b: Uint8Array) => bytesToHex(b);
const VERIFYING = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHANNEL =
  '0x000000000000000000000000000000000000000000000000000000000000005b';
const RECIPIENT = '0x00000000000000000000000000000000DEADBEEF';
const ANVIL_KEY_0 =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('claim digest byte helpers', () => {
  it('hexToBytes accepts 0x and bare hex, rejects odd or non-hex input', () => {
    expect(hex(hexToBytes('0xdeadBEEF'))).toBe('deadbeef');
    expect(hex(hexToBytes('00ff'))).toBe('00ff');
    expect(() => hexToBytes('0xabc')).toThrow(/Invalid hex/);
    expect(() => hexToBytes('0xzz')).toThrow(/Invalid hex/);
  });

  it('bigintToBytes32BE is big-endian, 32 bytes, bounded', () => {
    expect(hex(bigintToBytes32BE(0x0102n))).toBe('00'.repeat(30) + '0102');
    expect(() => bigintToBytes32BE(-1n)).toThrow();
    expect(() => bigintToBytes32BE(2n ** 256n)).toThrow(/256 bits/);
    expect(bigintToBytes32BE(2n ** 256n - 1n)).toEqual(
      new Uint8Array(32).fill(0xff)
    );
  });

  it('concatBytes joins in order', () => {
    expect(
      concatBytes(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('claim digest — golden vectors', () => {
  it('pins the EIP-712 type and domain hashes', () => {
    expect(hex(EIP712DOMAIN_TYPEHASH)).toBe(
      '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f'
    );
    expect(hex(DOMAIN_NAME_HASH)).toBe(
      '03b1e55f7f93cd70e54a750705030a137e734d1a9c1f1921ac04f8898b004f7f'
    );
    expect(hex(DOMAIN_VERSION_HASH)).toBe(
      'ad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5'
    );
    expect(hex(CLAIM_TYPEHASH)).toBe(
      'a0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91'
    );
  });

  it('pins the domain separator', () => {
    expect(hex(eip712DomainSeparatorEvm(8453n, hexToBytes(VERIFYING)))).toBe(
      'b94d6e9c9c28083295de906f48c4db4110392800177aad52c3f99f2afbce594f'
    );
    expect(() => eip712DomainSeparatorEvm(1n, new Uint8Array(19))).toThrow();
  });

  it('pins the claim digest and refuses bad lengths', () => {
    const digest = claimHashEvm(
      hexToBytes(CHANNEL),
      24000000n,
      24n,
      hexToBytes(RECIPIENT),
      8453n,
      hexToBytes(VERIFYING)
    );
    expect('0x' + hex(digest)).toBe(
      '0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede'
    );
    expect(() =>
      claimHashEvm(
        new Uint8Array(31),
        1n,
        1n,
        hexToBytes(RECIPIENT),
        1n,
        hexToBytes(VERIFYING)
      )
    ).toThrow(/channelId/);
    expect(() =>
      claimHashEvm(
        hexToBytes(CHANNEL),
        1n,
        1n,
        new Uint8Array(19),
        1n,
        hexToBytes(VERIFYING)
      )
    ).toThrow(/recipient/);
  });

  it('pins the Mina claim fields', () => {
    expect(claimFieldsMina('chan-1', 5n, 2n, 'B62qrecipient')).toEqual([
      173830988772594064985264964209543854372065722235232364220677162484461325n,
      5n,
      2n,
      780186583980149327759507351216474740888728963265855702959176734121497096n,
    ]);
  });
});

describe('recoverEvmClaimSigner', () => {
  const params = {
    channelId: CHANNEL,
    cumulativeAmount: 24000000n,
    nonce: 24n,
    recipient: RECIPIENT,
    chainId: 8453n,
    verifyingContract: VERIFYING,
  };
  const digest = claimHashEvm(
    hexToBytes(CHANNEL),
    24000000n,
    24n,
    hexToBytes(RECIPIENT),
    8453n,
    hexToBytes(VERIFYING)
  );
  const sign = (d: Uint8Array) => {
    const raw = secp256k1.sign(d, hexToBytes(ANVIL_KEY_0), {
      prehash: false,
      format: 'recovered',
    });
    // recovered format is recovery(1) || r || s; rearrange to r||s||v.
    return concatBytes(raw.slice(1), new Uint8Array([raw[0]! + 27]));
  };

  it('recovers the Anvil #0 address from a signed claim', () => {
    expect(recoverEvmClaimSigner(params, sign(digest))).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    );
  });

  it('accepts decimal-string amounts and chain id', () => {
    expect(
      recoverEvmClaimSigner(
        {
          ...params,
          cumulativeAmount: '24000000',
          nonce: '24',
          chainId: '8453',
        },
        sign(digest)
      )
    ).toBe(recoverEvmClaimSigner(params, sign(digest)));
  });

  it('refuses malformed signatures and params', () => {
    expect(() => recoverEvmSigner(digest, new Uint8Array(64))).toThrow(/65/);
    const bad = sign(digest);
    bad[64] = 5;
    expect(() => recoverEvmSigner(digest, bad)).toThrow(/27 or 28/);
    expect(() =>
      recoverEvmClaimSigner(
        { ...params, verifyingContract: '0x1234' },
        sign(digest)
      )
    ).toThrow(/verifyingContract/);
  });
});
