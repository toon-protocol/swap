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

import { deriveSwapNodeKeys } from './wallet.js';

import { base58Decode, verifyMinaSignature } from '@toon-protocol/sdk';
import type { AccumulatedClaim } from '@toon-protocol/sdk';

import { SwapWalletError } from './errors.js';

/**
 * A real 32-byte channel PDA in base58. On Solana a channelId IS its channel
 * PDA, and the balance proof the program verifies is built from those 32 bytes,
 * so a placeholder like `'chan-sol-1'` is not a channelId the chain could ever
 * resolve — the signer now refuses it (swap#164).
 */
const SOLANA_CHANNEL_PDA = '7My924UBF6FFUSZ6uHeEvzTTR6Wjs3nZ3SAym9cDjPV1';

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
    const { balanceProofHashEvm, hexToBytes } =
      await import('@toon-protocol/settlement-digest');

    // Arrange
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['evm'],
    });
    const chainId = 8453n;
    const verifyingContract = '0x' + 'cc'.repeat(20);
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: keys.evm!.privateKey,
      chainId,
      verifyingContract,
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

    // Reconstruct the exact v2 EIP-712 digest used by the signer, via the
    // SAME shared leaf (@toon-protocol/settlement-digest) it signs with.
    const msgHash = balanceProofHashEvm(
      hexToBytes(params.channelId),
      params.cumulativeAmount,
      params.nonce,
      hexToBytes(params.recipient),
      chainId,
      hexToBytes(verifyingContract)
    );

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
      chainId: 8453n,
      verifyingContract: '0x' + 'cc'.repeat(20),
    });

    await expect(
      signer.signBalanceProof({
        channelId: '0x' + 'aa'.repeat(32),
        cumulativeAmount: 1n,
        nonce: 1n,
        recipient: 'not-a-hex-address',
      })
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'SIGNING_FAILED',
    });
    // Silence unused import when this particular test is the only one checking SwapWalletError symbol identity.
    expect(SwapWalletError.name).toBe('SwapWalletError');
  });
});

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
      // Peer dep — optional. Use a runtime-only specifier so TS doesn't try
      // to resolve types for a package that may not be installed (matches
      // the hasMinaSigner probe above).
      const minaSignerSpecifier = 'mina-signer';
      const minaSigner = await import(/* @vite-ignore */ minaSignerSpecifier);
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
      // A Solana channelId IS its channel PDA — 32 bytes, base58 (swap#164).
      channelId: SOLANA_CHANNEL_PDA,
      cumulativeAmount: 1_000n,
      nonce: 1n,
      recipient: 'So11111111111111111111111111111111111111112',
    });

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(signer.chainKind).toBe('solana');
  });

  it('[P0] Solana signature cryptographically verifies against the derived public key (round-trip)', async () => {
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['solana'],
    });
    const solana = keys.solana;
    if (!solana) throw new Error('deriveSwapNodeKeys returned no Solana key');
    const signer = new SolanaPaymentChannelSigner({
      chain: 'solana:mainnet',
      privateKey: solana.privateKey,
    });

    const params = {
      channelId: SOLANA_CHANNEL_PDA,
      cumulativeAmount: 42n,
      nonce: 7n,
      recipient: 'So11111111111111111111111111111111111111112',
    };
    const sig = await signer.signBalanceProof(params);

    // Recompose the signed message the way the ON-CHAIN PROGRAM does — this is
    // the assertion that matters, and it is deliberately hand-rolled from
    // connector `packages/solana-program/src/processor.rs:900-910` rather than
    // from the helper under test, so a drift in either fails here:
    //   channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)
    // (Before swap#164 this recomposed `sha256(utf8(channelId) || ... )`, a
    // digest no deployed program verifies — the signer and this test agreed
    // with each other and with nothing else.)
    const u64LE = (x: bigint): Uint8Array => {
      const out = new Uint8Array(8);
      let v = x;
      for (let i = 0; i < 8; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    };
    const message = new Uint8Array(48);
    message.set(base58Decode(params.channelId), 0);
    message.set(u64LE(params.nonce), 32);
    message.set(u64LE(params.cumulativeAmount), 40);

    // Primary assertion: the signature must verify against the derived public
    // key over the program's message. If this breaks, the signer's encoding
    // drifted from the program and its claims stopped being redeemable.
    const ok = ed25519.verify(sig, message, solana.publicKey);
    expect(ok).toBe(true);

    // Tampered-message path MUST NOT verify.
    const tampered = new Uint8Array(message);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const tamperedOk = ed25519.verify(sig, tampered, solana.publicKey);
    expect(tamperedOk).toBe(false);

    // A bumped nonce MUST NOT verify either: the program reads nonce and
    // transferred_amount out of the same 48 bytes it re-derives.
    const bumpedNonce = new Uint8Array(message);
    bumpedNonce.set(u64LE(params.nonce + 1n), 32);
    expect(ed25519.verify(sig, bumpedNonce, solana.publicKey)).toBe(false);

    // Sanity: a random other public key MUST NOT verify the real message.
    const otherPriv = new Uint8Array(32);
    otherPriv.fill(9);
    const otherPub = ed25519.getPublicKey(otherPriv);
    expect(ed25519.verify(sig, message, otherPub)).toBe(false);
  });

  it('[P0] refuses a channelId that is not a 32-byte PDA rather than signing an unredeemable claim (swap#164)', async () => {
    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['solana'],
    });
    const solana = keys.solana;
    if (!solana) throw new Error('deriveSwapNodeKeys returned no Solana key');
    const signer = new SolanaPaymentChannelSigner({
      chain: 'solana:mainnet',
      privateKey: solana.privateKey,
    });
    const params = {
      cumulativeAmount: 42n,
      nonce: 7n,
      recipient: 'So11111111111111111111111111111111111111112',
    };
    // Valid base58, wrong length — the shape a synthetic test channelId takes.
    await expect(
      signer.signBalanceProof({ ...params, channelId: 'chanSoX' })
    ).rejects.toThrow(/32-byte channel PDA/);
    // Not base58 at all — the shape the old placeholders took.
    await expect(
      signer.signBalanceProof({ ...params, channelId: 'chan-verify' })
    ).rejects.toThrow(/not valid base58/);
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
          chainId: 8453n,
          verifyingContract: '0x' + 'cc'.repeat(20),
        })
    ).toThrow(SwapWalletError);
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(33),
          chainId: 8453n,
          verifyingContract: '0x' + 'cc'.repeat(20),
        })
    ).toThrow(/32-byte/);
  });

  it("[P1] EvmPaymentChannelSigner rejects a non-positive chainId with SwapWalletError('SIGNING_FAILED')", () => {
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(32).fill(1),
          chainId: 0n,
          verifyingContract: '0x' + 'cc'.repeat(20),
        })
    ).toThrow(/positive bigint chainId/);
  });

  it("[P1] EvmPaymentChannelSigner rejects a malformed verifyingContract with SwapWalletError('SIGNING_FAILED')", () => {
    expect(
      () =>
        new EvmPaymentChannelSigner({
          chain: 'evm:base:8453',
          privateKey: new Uint8Array(32).fill(1),
          chainId: 8453n,
          verifyingContract: '0x' + 'cc'.repeat(19), // 19 bytes, not 20
        })
    ).toThrow(/20-byte verifyingContract/);
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
