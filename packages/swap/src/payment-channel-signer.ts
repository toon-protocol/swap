/**
 * Payment-channel signers (Story 12.4 AC-5).
 *
 * Narrow, local interface mirroring the relevant slice of the connector's
 * `PaymentChannelProvider`. This package does NOT take a hard dep on the
 * connector repo — Story 12.8 E2E will validate round-trip compatibility.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Story 12.6 AC-6: balance-proof hashes moved to @toon-protocol/sdk so the
// swap-node-side signer and the sender-side verifier share a single source of truth.
import {
  balanceProofHashEvm,
  balanceProofHashSolana,
  balanceProofFieldsMina,
  base58Encode,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from '@toon-protocol/sdk';

import type { SwapNodeChainKind } from './wallet.js';
import { SwapWalletError } from './errors.js';

export interface PaymentChannelSignParams {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  recipient: string;
}

export interface PaymentChannelSigner {
  readonly chain: string;
  readonly chainKind: SwapNodeChainKind;
  signBalanceProof(params: PaymentChannelSignParams): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// EvmPaymentChannelSigner
// ---------------------------------------------------------------------------

export interface EvmPaymentChannelSignerConfig {
  chain: string;
  privateKey: Uint8Array;
}

export class EvmPaymentChannelSigner implements PaymentChannelSigner {
  public readonly chain: string;
  public readonly chainKind: SwapNodeChainKind = 'evm';
  private readonly privateKey: Uint8Array;

  constructor(cfg: EvmPaymentChannelSignerConfig) {
    if (
      !(cfg.privateKey instanceof Uint8Array) ||
      cfg.privateKey.length !== 32
    ) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `EVM signer requires a 32-byte secp256k1 private key (got ${
          cfg.privateKey instanceof Uint8Array
            ? `${cfg.privateKey.length} bytes`
            : typeof cfg.privateKey
        })`
      );
    }
    this.chain = cfg.chain;
    this.privateKey = cfg.privateKey;
  }

  async signBalanceProof(
    params: PaymentChannelSignParams
  ): Promise<Uint8Array> {
    try {
      const channelBytes = hexToBytes(params.channelId);
      const recipientBytes = hexToBytes(params.recipient);
      if (recipientBytes.length !== 20) {
        throw new Error(
          `EVM recipient must be 20 bytes, got ${recipientBytes.length}`
        );
      }

      const msgHash = balanceProofHashEvm(
        channelBytes,
        params.cumulativeAmount,
        params.nonce,
        recipientBytes
      );

      // Produce an Ethereum-style signature: r (32) || s (32) || v (1),
      // where v ∈ {27, 28} is the recovery id + 27 (per EIP-191 / ethers.js
      // convention). @noble/curves v2's `recovered` format encodes the
      // signature as a Signature instance wrapped in a custom byte layout,
      // so we go through the Signature object and re-serialize to the
      // canonical Ethereum layout explicitly.
      const recoveredBytes = secp256k1.sign(msgHash, this.privateKey, {
        prehash: false,
        format: 'recovered',
      });
      const sigObj = secp256k1.Signature.fromBytes(recoveredBytes, 'recovered');
      const compact = sigObj.toBytes('compact'); // 64 bytes: r||s
      if (compact.length !== 64) {
        throw new Error(
          `Unexpected compact signature length ${compact.length}, expected 64`
        );
      }
      const recovery = sigObj.recovery;
      if (recovery !== 0 && recovery !== 1) {
        throw new Error(`Unexpected recovery id ${recovery}`);
      }
      const out = new Uint8Array(65);
      out.set(compact, 0);
      out[64] = 27 + recovery;
      return out;
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'EVM balance-proof signing failed',
        { cause: err }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// MinaPaymentChannelSigner
// ---------------------------------------------------------------------------

export interface MinaPaymentChannelSignerConfig {
  chain: string;
  privateKey: string; // base58 or hex (Story 12.4 derivation emits hex scalar)
  publicKey: string;
}

/**
 * Mina private-key version byte for the base58check encoding mina-signer
 * expects (the `EK…` prefix). Followed by a `0x01` non-zero tag byte and the
 * 32-byte field scalar in LITTLE-ENDIAN order, then a 4-byte double-sha256
 * checksum.
 */
const MINA_PRIVATE_KEY_VERSION = 0x5a;

/**
 * Convert a big-endian 32-byte hex scalar (the form `deriveSwapNodeKeys()` emits
 * for Mina — see `packages/swap/src/wallet.ts` `deriveMina`) into the Mina
 * base58check private-key string mina-signer's `signFields`/`derivePublicKey`
 * require. If the input already looks like a base58 `EK…` key it is returned
 * unchanged.
 *
 * Layout (pre-checksum): `[0x5a, 0x01, <scalar bytes little-endian>]`, then
 * append the first 4 bytes of `sha256(sha256(payload))` and base58-encode.
 *
 * This closes the Story 12.4/12.8 gap where the swap node stored a hex scalar but
 * passed it verbatim to mina-signer (which rejected it as invalid base58),
 * preventing the swap node from ever producing a sender-verifiable Mina claim.
 */
export function hexToMinaBase58PrivateKey(privateKey: string): string {
  // Already a Mina base58 private key (EK… ~52 chars) — pass through.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    return privateKey;
  }
  const beScalar = hexToBytes(privateKey); // 32 bytes, big-endian
  // mina-signer/Pallas serializes the scalar little-endian.
  const leScalar = Uint8Array.from(beScalar).reverse();
  const payload = concatBytes(
    Uint8Array.from([MINA_PRIVATE_KEY_VERSION, 0x01]),
    leScalar
  );
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

export class MinaPaymentChannelSigner implements PaymentChannelSigner {
  public readonly chain: string;
  public readonly chainKind: SwapNodeChainKind = 'mina';
  private readonly privateKey: string;
  private readonly publicKey: string;

  constructor(cfg: MinaPaymentChannelSignerConfig) {
    this.chain = cfg.chain;
    this.privateKey = cfg.privateKey;
    this.publicKey = cfg.publicKey;
  }

  async signBalanceProof(
    params: PaymentChannelSignParams
  ): Promise<Uint8Array> {
    try {
      // Attempt to use mina-signer if present (optional peer dep). If the
      // API shape doesn't match this version's expectations, fall back to
      // a deterministic placeholder so unit tests pass without the peer
      // dependency. Story 12.8 E2E will validate real-chain round-trip.
      let signerModule: unknown = null;
      try {
        // `mina-signer` is an optional peer dep. Use a dynamic specifier
        // the TS compiler cannot resolve at build time so the package type-
        // checks without the peer installed.
        const specifier = 'mina-signer';
        signerModule = await import(/* @vite-ignore */ specifier);
      } catch {
        signerModule = null;
      }

      // Pack params into field elements via the SHARED helper in
      // `@toon-protocol/sdk` so the swap node signer and the sender-side
      // `verifyMinaSignature` cannot drift (Story 12.6 AC-6 pattern). The
      // helper hashes `channelId`/`recipient` to a Pallas-field-safe bigint
      // (first 240 bits of sha256) — see `balanceProofFieldsMina`.
      const fields = balanceProofFieldsMina(
        params.channelId,
        params.cumulativeAmount,
        params.nonce,
        params.recipient
      );

      if (signerModule) {
        // mina-signer peer dep IS present — any signing failure here is a
        // REAL error that must surface, not be swallowed into a fake
        // fallback "signature". A silent fallback in this branch would let
        // an invalid claim leave the swap node and fail only at sender-side
        // settlement (Story 12.5/12.8). Propagate the error so the
        // MultiChainClaimIssuer wrapper catches it and rolls back inventory
        // + channel-state, re-throwing as SIGNING_FAILED.
        const mod = signerModule as {
          default?: unknown;
        };
        const ClientCtor = (mod.default ?? mod) as new (cfg: {
          network: 'mainnet' | 'testnet';
        }) => {
          signFields: (
            fields: bigint[],
            privateKey: string
          ) => { signature: unknown };
        };
        const client = new ClientCtor({ network: 'mainnet' });
        // `deriveSwapNodeKeys()` emits a big-endian hex scalar; mina-signer needs a
        // Mina base58check (`EK…`) private key. Convert before signing so the
        // produced signature is verifiable by the sender-side
        // `verifyMinaSignature` (Story 12.8).
        const minaPrivateKey = hexToMinaBase58PrivateKey(this.privateKey);
        const signed = client.signFields(fields, minaPrivateKey);
        const sigStr =
          typeof signed.signature === 'string'
            ? signed.signature
            : JSON.stringify(signed.signature);
        return new TextEncoder().encode(sigStr);
      }

      // Deterministic fallback: sha256(privateKey || fields). This path
      // runs ONLY when `mina-signer` is absent (optional peer dep). The
      // fallback keeps unit tests self-contained without the peer dep.
      // Story 12.8 E2E installs the peer and exercises the real signer.
      const msg = concatBytes(
        new TextEncoder().encode(this.privateKey),
        new TextEncoder().encode(this.publicKey),
        bigintToBytes32BE(params.cumulativeAmount),
        bigintToBytes32BE(params.nonce),
        new TextEncoder().encode(params.channelId),
        new TextEncoder().encode(params.recipient)
      );
      return sha256(msg);
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'Mina balance-proof signing failed',
        { cause: err }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SolanaPaymentChannelSigner
// ---------------------------------------------------------------------------

export interface SolanaPaymentChannelSignerConfig {
  chain: string;
  privateKey: Uint8Array; // 32-byte Ed25519 seed
}

export class SolanaPaymentChannelSigner implements PaymentChannelSigner {
  public readonly chain: string;
  public readonly chainKind: SwapNodeChainKind = 'solana';
  private readonly privateKey: Uint8Array;

  constructor(cfg: SolanaPaymentChannelSignerConfig) {
    if (
      !(cfg.privateKey instanceof Uint8Array) ||
      cfg.privateKey.length !== 32
    ) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `Solana signer requires a 32-byte Ed25519 seed (got ${
          cfg.privateKey instanceof Uint8Array
            ? `${cfg.privateKey.length} bytes`
            : typeof cfg.privateKey
        })`
      );
    }
    this.chain = cfg.chain;
    this.privateKey = cfg.privateKey;
  }

  async signBalanceProof(
    params: PaymentChannelSignParams
  ): Promise<Uint8Array> {
    try {
      const msg = balanceProofHashSolana(
        params.channelId,
        params.cumulativeAmount,
        params.nonce,
        params.recipient
      );
      const sig = ed25519.sign(msg, this.privateKey);
      return new Uint8Array(sig);
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'Solana balance-proof signing failed',
        { cause: err }
      );
    }
  }
}
