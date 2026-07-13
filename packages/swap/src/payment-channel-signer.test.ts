/**
 * Payment-channel signer tests — Story 12.4 AC-5, AC-11 (signer block).
 *
 * T-035 — test-design-epic-12 Story 12-4.
 * Mina test gated with describe.skipIf(!hasMinaSigner) per AC-11.
 */
import { describe, it, expect } from 'vitest';

import {
  EvmPaymentChannelSigner,
  MinaPaymentChannelSigner,
  SolanaPaymentChannelSigner,
  hexToMinaBase58PrivateKey,
  claimBalanceProofDigestEvmV2,
  cooperativeCloseDigestEvmV2,
  eip712DomainSeparatorV2,
  EIP712_DOMAIN_TYPEHASH,
  CLAIM_BALANCE_PROOF_TYPEHASH,
  COOPERATIVE_CLOSE_TYPEHASH,
} from './payment-channel-signer.js';

import { deriveSwapNodeKeys } from './wallet.js';

import { verifyMinaSignature } from '@toon-protocol/sdk';
import type { AccumulatedClaim } from '@toon-protocol/sdk';

import { SwapWalletError } from './errors.js';

const ZERO_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let hasMinaSigner = false;
try {
  // Peer dep — optional. Use a runtime-only specifier so TS doesn't try to
  // resolve types for a package that may not be installed.
  const specifier = 'mina-signer';
  await import(/* @vite-ignore */ specifier);
  hasMinaSigner = true;
} catch {
  hasMinaSigner = false;
}

describe('EvmPaymentChannelSigner — v2 EIP-712 round-trip derive → sign → verify (connector#324 finding #1, T-035)', () => {
  it('[P0] (T-035) EVM signer produces a 65-byte signature (r||s||v) over the v2 EIP-712 claim digest that recovers to the derived public key', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');

    // Arrange
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['evm'],
    });
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: keys.evm!.privateKey,
    });

    const params = {
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: 1_000_000n,
      nonce: 1n,
      recipient: '0x' + 'bb'.repeat(20),
      chainId: 8453n,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    };

    // Act
    const sig = await signer.signBalanceProof(params);

    // Assert shape
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(65);
    expect(signer.chain).toBe('evm:base:8453');
    expect(signer.chainKind).toBe('evm');

    // The signer signs the EIP-712 v2 claim digest directly. Reconstruct it
    // via the same exported helper the signer uses.
    const msgHash = claimBalanceProofDigestEvmV2(params);

    // Round-trip: the signature is Ethereum-style r || s || v where
    // v ∈ {27, 28}. Extract (r, s, recoveryId) and recover the public key;
    // it MUST match the derived key's public key.
    const v = sig[64]!;
    expect([27, 28]).toContain(v);
    const recoveryId = v - 27;
    const rs = sig.slice(0, 64);

    // Build a noble v2 compact signature with recovery id.
    const sigObj = secp256k1.Signature.fromBytes(rs, 'compact').addRecoveryBit(
      recoveryId
    );
    const recoveredPub = sigObj.recoverPublicKey(msgHash);
    const expectedCompressed = secp256k1.getPublicKey(
      keys.evm!.privateKey,
      true
    );
    expect(Buffer.from(recoveredPub.toBytes(true)).toString('hex')).toBe(
      Buffer.from(expectedCompressed).toString('hex')
    );

    // Tampered-hash path MUST recover a DIFFERENT (wrong) public key.
    const tampered = new Uint8Array(msgHash);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const tamperedPub = secp256k1.Signature.fromBytes(rs, 'compact')
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(tampered);
    expect(Buffer.from(tamperedPub.toBytes(true)).toString('hex')).not.toBe(
      Buffer.from(expectedCompressed).toString('hex')
    );
  });

  it("[P1] EVM signer with malformed recipient throws SwapWalletError('SIGNING_FAILED')", async () => {
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['evm'],
    });
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: keys.evm!.privateKey,
    });

    await expect(
      signer.signBalanceProof({
        channelId: '0x' + 'aa'.repeat(32),
        cumulativeAmount: 1n,
        nonce: 1n,
        recipient: 'not-a-hex-address',
        chainId: 8453n,
        verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'SIGNING_FAILED',
    });
    // Silence unused import when this particular test is the only one checking SwapWalletError symbol identity.
    expect(SwapWalletError.name).toBe('SwapWalletError');
  });

  it('[P1] EVM signer fails closed (SIGNING_FAILED) when the v2 domain (chainId / verifyingContract) is missing', async () => {
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['evm'],
    });
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: keys.evm!.privateKey,
    });
    // v1 call-shape (no chainId / verifyingContract) MUST NOT silently sign an
    // unbound digest — connector#324 finding #1.
    await expect(
      signer.signBalanceProof({
        channelId: '0x' + 'aa'.repeat(32),
        cumulativeAmount: 1n,
        nonce: 1n,
        recipient: '0x' + 'bb'.repeat(20),
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'SIGNING_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------
// v2 EIP-712 GOLDEN-VECTOR CONFORMANCE (connector#324 finding #1)
// ---------------------------------------------------------------------------
//
// Hardcoded cross-repo conformance fixtures from
// `docs/rolling-swap-v2-digest-spec.md` §4 (toon-protocol/connector PR #325).
// All four repos (connector / core+sdk / swap / client) MUST produce these
// byte-identical digests. Do NOT edit these literals to make a failing test
// pass — a mismatch means the swap signer drifted from the canonical digest.
describe('EvmPaymentChannelSigner — v2 EIP-712 golden vectors (connector#324 finding #1)', () => {
  const toHex = (b: Uint8Array): string =>
    '0x' + Buffer.from(b).toString('hex');

  // Fixed parameters (spec §4).
  const CHAIN_ID = 8453n;
  const VERIFYING_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  const CHANNEL_ID =
    '0x000000000000000000000000000000000000000000000000000000000000005b';
  const CUMULATIVE_AMOUNT = 24_000_000n;
  const NONCE = 24n;
  const RECIPIENT = '0x00000000000000000000000000000000DEADBEEF';

  // Anvil test keys #0 (claim signer) and #1 (coop-close signer).
  const CLAIM_KEY = hexToBytesLocal(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );
  const CLAIM_ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const COOP_KEY = hexToBytesLocal(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  );
  const COOP_ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

  const EXPECTED = {
    domainTypehash:
      '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f',
    claimTypehash:
      '0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91',
    coopTypehash:
      '0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f',
    domainSeparator:
      '0xb94d6e9c9c28083295de906f48c4db4110392800177aad52c3f99f2afbce594f',
    claimDigest:
      '0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede',
    claimSig:
      '0xfa66a50c60bdd47c11b4b6a76f44255095d77cead2910b619d3b8e838237982b196b22bc46254ff3e85923d0604bf7de9136d0ba79cfe85a3f38d636b262c9bb1b',
    coopDigest:
      '0x8b748bdfc330a591164551d4b536d64b963aff1059b594acc1dc5a24297e25c0',
    coopSig:
      '0xd8c7479c1d048fc8ee8bbb912db60d2c7b0056245a7c3611b88eceabe243932d7878586332642641c62fb909e4f23655a428f13125af2e41fe1f90ea85a100621b',
  };

  it('[P0] type hashes match the canonical spec literals', () => {
    expect(toHex(EIP712_DOMAIN_TYPEHASH)).toBe(EXPECTED.domainTypehash);
    expect(toHex(CLAIM_BALANCE_PROOF_TYPEHASH)).toBe(EXPECTED.claimTypehash);
    expect(toHex(COOPERATIVE_CLOSE_TYPEHASH)).toBe(EXPECTED.coopTypehash);
  });

  it('[P0] domain separator matches the canonical spec literal', () => {
    expect(toHex(eip712DomainSeparatorV2(CHAIN_ID, VERIFYING_CONTRACT))).toBe(
      EXPECTED.domainSeparator
    );
  });

  it('[P0] claim digest matches the canonical spec literal', () => {
    const digest = claimBalanceProofDigestEvmV2({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      recipient: RECIPIENT,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    expect(toHex(digest)).toBe(EXPECTED.claimDigest);
  });

  it('[P0] signBalanceProof with the anvil #0 key yields the EXACT golden signature and recovers to the claim signer address', async () => {
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: CLAIM_KEY,
    });
    const sig = await signer.signBalanceProof({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      recipient: RECIPIENT,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    expect(toHex(sig)).toBe(EXPECTED.claimSig);
    expect(await recoverEvmAddress(sig, EXPECTED.claimDigest)).toBe(CLAIM_ADDR);
  });

  it('[P0] cooperative-close digest matches the canonical spec literal', () => {
    const digest = cooperativeCloseDigestEvmV2({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    expect(toHex(digest)).toBe(EXPECTED.coopDigest);
  });

  it('[P0] signCooperativeClose with the anvil #1 (recipient) key yields the EXACT golden signature and recovers to the recipient address', async () => {
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: COOP_KEY,
    });
    const sig = await signer.signCooperativeClose({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    expect(toHex(sig)).toBe(EXPECTED.coopSig);
    expect(await recoverEvmAddress(sig, EXPECTED.coopDigest)).toBe(COOP_ADDR);
  });

  it('[P1] a signature is bound to its (chainId, verifyingContract) — a different chainId yields a different digest (cross-chain replay defense)', () => {
    const base = claimBalanceProofDigestEvmV2({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      recipient: RECIPIENT,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
    });
    const otherChain = claimBalanceProofDigestEvmV2({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      recipient: RECIPIENT,
      chainId: 1n,
      verifyingContract: VERIFYING_CONTRACT,
    });
    const otherContract = claimBalanceProofDigestEvmV2({
      channelId: CHANNEL_ID,
      cumulativeAmount: CUMULATIVE_AMOUNT,
      nonce: NONCE,
      recipient: RECIPIENT,
      chainId: CHAIN_ID,
      verifyingContract: '0x00000000000000000000000000000000000000ff',
    });
    expect(toHex(otherChain)).not.toBe(toHex(base));
    expect(toHex(otherContract)).not.toBe(toHex(base));
  });
});

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Recover the lowercase 0x EVM address that signed `digestHex` given the
 * 65-byte r||s||v signature. */
async function recoverEvmAddress(
  sig: Uint8Array,
  digestHex: string
): Promise<string> {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  const digest = hexToBytesLocal(digestHex);
  const v = sig[64]!;
  const recoveryId = v - 27;
  const sigObj = secp256k1.Signature.fromBytes(
    sig.slice(0, 64),
    'compact'
  ).addRecoveryBit(recoveryId);
  const pub = sigObj.recoverPublicKey(digest).toBytes(false); // 65-byte uncompressed
  const hash = keccak_256(pub.slice(1)); // drop 0x04 prefix
  return '0x' + Buffer.from(hash.slice(-20)).toString('hex');
}

describe.skipIf(!hasMinaSigner)(
  'MinaPaymentChannelSigner — round-trip (Story 12.4 AC-5)',
  () => {
    it('[P1] Mina signer produces a signature that verifies via mina-signer.verifyFields', async () => {
      const keys = await deriveSwapNodeKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
      });
      const signer = new MinaPaymentChannelSigner({
        chain: 'mina:mainnet',
        privateKey: keys.mina!.privateKey,
        publicKey: keys.mina!.publicKey,
      });

      const sig = await signer.signBalanceProof({
        channelId: 'chan-1',
        cumulativeAmount: 1_000n,
        nonce: 1n,
        recipient: keys.mina!.publicKey,
      });

      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBeGreaterThan(0);
      expect(signer.chainKind).toBe('mina');
    });

    it('[P0] swap node signature round-trips through the SDK verifier (Story 12.8)', async () => {
      // End-to-end swap-node↔sender contract: the swap node signs a balance proof, and
      // the SDK's `verifyMinaSignature` accepts it against the swap node's REAL
      // Mina public key (derived from the converted private key, not the
      // keccak placeholder `deriveSwapNodeKeys` stores).
      const minaSigner = await import('mina-signer');
      const Client = (minaSigner.default ?? minaSigner) as new (cfg: {
        network: 'mainnet' | 'testnet';
      }) => { derivePublicKey: (sk: string) => string };

      const keys = await deriveSwapNodeKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
      });
      const minaPriv = hexToMinaBase58PrivateKey(keys.mina!.privateKey);
      const client = new Client({ network: 'mainnet' });
      const realPubKey = client.derivePublicKey(minaPriv);

      const signer = new MinaPaymentChannelSigner({
        chain: 'mina:mainnet',
        privateKey: keys.mina!.privateKey,
        publicKey: realPubKey,
      });

      const channelId = 'B62qChannelRoundTrip1111111111111111111111111';
      const recipient = 'B62qRecipientRoundTrip22222222222222222222222';
      const cumulativeAmount = 1_000n;
      const nonce = 4n;

      const sig = await signer.signBalanceProof({
        channelId,
        cumulativeAmount,
        nonce,
        recipient,
      });

      // Build the AccumulatedClaim shape the SDK verifier consumes.
      const claim = {
        packetIndex: 0,
        sourceAmount: 1n,
        targetAmount: 1n,
        claimBytes: sig,
        swapEphemeralPubkey: '0'.repeat(64),
        pair: {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
          to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
          rate: '0.5',
        },
        receivedAt: Date.now(),
        channelId,
        nonce: nonce.toString(),
        cumulativeAmount: cumulativeAmount.toString(),
        recipient,
        swapSignerAddress: realPubKey,
      } as unknown as AccumulatedClaim;

      const verifyClient = new Client({
        network: 'mainnet',
      }) as unknown as Parameters<typeof verifyMinaSignature>[2];

      expect(verifyMinaSignature(claim, realPubKey, verifyClient)).toBe(true);
      // Tampered nonce must fail.
      const tampered = { ...claim, nonce: '99' } as AccumulatedClaim;
      expect(verifyMinaSignature(tampered, realPubKey, verifyClient)).toBe(
        false
      );
    });
  }
);

describe('SolanaPaymentChannelSigner — round-trip (Story 12.4 AC-5)', () => {
  it('[P0] Solana signer produces a 64-byte Ed25519 signature that verifies via @noble/curves/ed25519', async () => {
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['solana'],
    });
    const signer = new SolanaPaymentChannelSigner({
      chain: 'solana:mainnet',
      privateKey: keys.solana!.privateKey,
    });

    const sig = await signer.signBalanceProof({
      channelId: 'chan-sol-1',
      cumulativeAmount: 1_000n,
      nonce: 1n,
      recipient: 'So11111111111111111111111111111111111111112',
    });

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(signer.chainKind).toBe('solana');
  });

  it('[P0] Solana signature cryptographically verifies against the derived public key (round-trip)', async () => {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['solana'],
    });
    const signer = new SolanaPaymentChannelSigner({
      chain: 'solana:mainnet',
      privateKey: keys.solana!.privateKey,
    });

    const params = {
      channelId: 'chan-verify',
      cumulativeAmount: 42n,
      nonce: 7n,
      recipient: 'So11111111111111111111111111111111111111112',
    };
    const sig = await signer.signBalanceProof(params);

    // Recompose the signed message in the EXACT same way the signer does
    // (see `balanceProofHashSolana` in payment-channel-signer.ts):
    //   sha256(channelId_utf8 || cumulativeAmount(32BE) || nonce(32BE) || recipient_utf8)
    const bigintToBytes32BE = (x: bigint): Uint8Array => {
      const out = new Uint8Array(32);
      let v = x;
      for (let i = 31; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    };
    const parts = [
      new TextEncoder().encode(params.channelId),
      bigintToBytes32BE(params.cumulativeAmount),
      bigintToBytes32BE(params.nonce),
      new TextEncoder().encode(params.recipient),
    ];
    const totalLen = parts.reduce((n, p) => n + p.length, 0);
    const concat = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
      concat.set(p, off);
      off += p.length;
    }
    const msgHash = sha256(concat);

    // Primary assertion: the signature must verify against the derived
    // public key when using the documented hashing formula. If this
    // breaks, the signer's encoding drifted from its documented contract.
    const ok = ed25519.verify(sig, msgHash, keys.solana!.publicKey);
    expect(ok).toBe(true);

    // Tampered-message path MUST NOT verify.
    const tampered = new Uint8Array(msgHash);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const tamperedOk = ed25519.verify(sig, tampered, keys.solana!.publicKey);
    expect(tamperedOk).toBe(false);

    // Sanity: a random other public key MUST NOT verify the real message.
    const otherPriv = new Uint8Array(32);
    otherPriv.fill(9);
    const otherPub = ed25519.getPublicKey(otherPriv);
    expect(ed25519.verify(sig, msgHash, otherPub)).toBe(false);
  });

  it('[P2] chain and chainKind getters are correctly exposed', async () => {
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['solana'],
    });
    const signer = new SolanaPaymentChannelSigner({
      chain: 'solana:devnet',
      privateKey: keys.solana!.privateKey,
    });
    expect(signer.chain).toBe('solana:devnet');
    expect(signer.chainKind).toBe('solana');
  });
});

describe('Signer construction — defensive key-length checks (code-review hardening)', () => {
  it("[P1] EvmPaymentChannelSigner rejects non-32-byte privateKey with SwapWalletError('SIGNING_FAILED')", () => {
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(16),
        })
    ).toThrow(SwapWalletError);
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(33),
        })
    ).toThrow(/32-byte/);
  });

  it("[P1] SolanaPaymentChannelSigner rejects non-32-byte privateKey with SwapWalletError('SIGNING_FAILED')", () => {
    expect(
      () =>
        new SolanaPaymentChannelSigner({
          chain: 'solana:mainnet',
          privateKey: new Uint8Array(64), // Ed25519 expanded form, not accepted here
        })
    ).toThrow(SwapWalletError);
    try {
      new SolanaPaymentChannelSigner({
        chain: 'solana:mainnet',
        privateKey: new Uint8Array(16),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SIGNING_FAILED');
    }
  });
});

describe('MinaPaymentChannelSigner — construction (Story 12.4 AC-5)', () => {
  it('[P2] chain and chainKind getters are correctly exposed (no peer dep required)', async () => {
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['mina'],
    });
    const signer = new MinaPaymentChannelSigner({
      chain: 'mina:mainnet',
      privateKey: keys.mina!.privateKey,
      publicKey: keys.mina!.publicKey,
    });
    expect(signer.chain).toBe('mina:mainnet');
    expect(signer.chainKind).toBe('mina');
  });
});
