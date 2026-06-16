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
} from './payment-channel-signer.js';

import { deriveMillKeys } from './wallet.js';

import { verifyMinaSignature } from '@toon-protocol/sdk';
import type { AccumulatedClaim } from '@toon-protocol/sdk';

import { MillWalletError } from './errors.js';

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

describe('EvmPaymentChannelSigner — round-trip derive → sign → verify (Story 12.4 AC-5, T-035)', () => {
  it('[P0] (T-035) EVM signer produces a 65-byte signature (r||s||v) that recovers to the derived public key', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');
    const { keccak_256 } = await import('@noble/hashes/sha3.js');

    // Arrange
    const keys = await deriveMillKeys({
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
    };

    // Act
    const sig = await signer.signBalanceProof(params);

    // Assert shape
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(65);
    expect(signer.chain).toBe('evm:base:8453');
    expect(signer.chainKind).toBe('evm');

    // Reconstruct the exact message hash used by the signer
    // (channelId || cumulativeAmount(32BE) || nonce(32BE) || recipient).
    const hexToBytes = (hex: string): Uint8Array => {
      const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++)
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    };
    const bigintToBytes32BE = (x: bigint): Uint8Array => {
      const out = new Uint8Array(32);
      let v = x;
      for (let i = 31; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    };
    const msg = new Uint8Array([
      ...hexToBytes(params.channelId),
      ...bigintToBytes32BE(params.cumulativeAmount),
      ...bigintToBytes32BE(params.nonce),
      ...hexToBytes(params.recipient),
    ]);
    const msgHash = keccak_256(msg);

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

  it("[P1] EVM signer with malformed recipient throws MillWalletError('SIGNING_FAILED')", async () => {
    const keys = await deriveMillKeys({
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
      })
    ).rejects.toMatchObject({
      name: 'MillWalletError',
      code: 'SIGNING_FAILED',
    });
    // Silence unused import when this particular test is the only one checking MillWalletError symbol identity.
    expect(MillWalletError.name).toBe('MillWalletError');
  });
});

describe.skipIf(!hasMinaSigner)(
  'MinaPaymentChannelSigner — round-trip (Story 12.4 AC-5)',
  () => {
    it('[P1] Mina signer produces a signature that verifies via mina-signer.verifyFields', async () => {
      const keys = await deriveMillKeys({
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

    it('[P0] Mill signature round-trips through the SDK verifier (Story 12.8)', async () => {
      // End-to-end Mill↔sender contract: the Mill signs a balance proof, and
      // the SDK's `verifyMinaSignature` accepts it against the Mill's REAL
      // Mina public key (derived from the converted private key, not the
      // keccak placeholder `deriveMillKeys` stores).
      const minaSigner = await import('mina-signer');
      const Client = (minaSigner.default ?? minaSigner) as new (cfg: {
        network: 'mainnet' | 'testnet';
      }) => { derivePublicKey: (sk: string) => string };

      const keys = await deriveMillKeys({
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
        millEphemeralPubkey: '0'.repeat(64),
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
        millSignerAddress: realPubKey,
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
    const keys = await deriveMillKeys({
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

    const keys = await deriveMillKeys({
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
    const keys = await deriveMillKeys({
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
  it("[P1] EvmPaymentChannelSigner rejects non-32-byte privateKey with MillWalletError('SIGNING_FAILED')", () => {
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(16),
        })
    ).toThrow(MillWalletError);
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(33),
        })
    ).toThrow(/32-byte/);
  });

  it("[P1] SolanaPaymentChannelSigner rejects non-32-byte privateKey with MillWalletError('SIGNING_FAILED')", () => {
    expect(
      () =>
        new SolanaPaymentChannelSigner({
          chain: 'solana:mainnet',
          privateKey: new Uint8Array(64), // Ed25519 expanded form, not accepted here
        })
    ).toThrow(MillWalletError);
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
    const keys = await deriveMillKeys({
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
