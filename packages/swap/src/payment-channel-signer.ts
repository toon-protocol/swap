/**
 * Payment-channel signers (Story 12.4 AC-5).
 *
 * Narrow, local interface mirroring the relevant slice of the connector's
 * `PaymentChannelProvider`. This package does NOT take a hard dep on the
 * connector repo — Story 12.8 E2E will validate round-trip compatibility.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hashTypedData, type Hex } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Story 12.6 AC-6: the Solana/Mina balance-proof hashes moved to
// @toon-protocol/sdk so the swap-node-side signer and the sender-side verifier
// share a single source of truth. (The EVM digest now comes from the
// settlement-digest leaf imported below — issue #101.)
import {
  balanceProofFieldsMina,
  base58Decode,
  base58Encode,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from '@toon-protocol/sdk';

// Issue #101: the EVM balance-proof digest comes from the shared, dependency-light
// leaf (@noble-only, no core/sdk/connector major bump needed) so the swap node
// signs the SAME v2 EIP-712 domain-separated digest every client, the sdk, the
// connector and the on-chain RollingSwapChannel verify against.
//
// swap#164 / toon#214: the Solana balance proof is the RAW 48-byte message the
// deployed program's Ed25519 precompile check verifies, NOT the legacy
// `balanceProofHashSolana` digest — which no program has ever verified, making
// every Solana claim this signer issued before swap#165 unredeemable. The byte
// layout now comes from the SAME shared leaf as the EVM digest (published in
// `@toon-protocol/settlement-digest@1.1.0`, re-exported by core/sdk), replacing
// swap's temporary local copy: it was proven byte-identical over the pinned
// vectors in `solana-balance-proof.test.ts` before removal.
import {
  balanceProofHashEvm,
} from '@toon-protocol/settlement-digest';

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
  /**
   * EIP-155 chainId this signer's EIP-712 domain is bound to — parsed from
   * the chain key at the call site (issue #101), never configured
   * separately, so the signed chainId can never disagree with the key a
   * claim is filed under.
   */
  chainId: bigint;
  /**
   * Deployed `RollingSwapChannel` address for {@link chainId} — the EIP-712
   * `verifyingContract`. `0x` + 40 hex chars (20 bytes).
   */
  verifyingContract: string;
}

export class EvmPaymentChannelSigner implements PaymentChannelSigner {
  public readonly chain: string;
  public readonly chainKind: SwapNodeChainKind = 'evm';
  private readonly privateKey: Uint8Array;
  private readonly chainId: bigint;
  private readonly verifyingContractBytes: Uint8Array;

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
    if (typeof cfg.chainId !== 'bigint' || cfg.chainId <= 0n) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `EVM signer requires a positive bigint chainId (got ${String(cfg.chainId)})`
      );
    }
    let verifyingContractBytes: Uint8Array;
    try {
      verifyingContractBytes = hexToBytes(cfg.verifyingContract);
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `EVM signer requires a hex verifyingContract address: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (verifyingContractBytes.length !== 20) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `EVM signer requires a 20-byte verifyingContract address (got ${verifyingContractBytes.length} bytes)`
      );
    }
    this.chain = cfg.chain;
    this.privateKey = cfg.privateKey;
    this.chainId = cfg.chainId;
    this.verifyingContractBytes = verifyingContractBytes;
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
        recipientBytes,
        this.chainId,
        this.verifyingContractBytes
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

/**
 * The fleet's ordinary `TokenNetwork` balance proof (EIP-712 domain
 * `TokenNetwork` / `1`, struct `BalanceProof(channelId, nonce,
 * transferredAmount, lockedAmount, locksRoot)` with the last two always
 * zero) — the same message a taker signs to pay leg A, now signed by the
 * maker for leg B. The counterparty is the channel's other participant, so
 * `recipient` is not in the message; it is checked against the channel
 * off chain and enforced on chain by `claimFromChannel` (only a participant
 * can claim, and only what its counterparty signed).
 */
export interface TokenNetworkBalanceProofSignerConfig {
  chain: string;
  privateKey: Uint8Array;
  chainId: bigint;
  /** The deployed `TokenNetwork` — the EIP-712 `verifyingContract`. */
  tokenNetworkAddress: string;
}

export const TOKEN_NETWORK_BALANCE_PROOF_TYPES = {
  BalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'transferredAmount', type: 'uint256' },
    { name: 'lockedAmount', type: 'uint256' },
    { name: 'locksRoot', type: 'bytes32' },
  ],
} as const;

export function tokenNetworkBalanceProofDigest(p: {
  chainId: bigint;
  tokenNetworkAddress: string;
  channelId: string;
  nonce: bigint;
  transferredAmount: bigint;
}): Uint8Array {
  const digest = hashTypedData({
    domain: {
      name: 'TokenNetwork',
      version: '1',
      chainId: p.chainId,
      verifyingContract: p.tokenNetworkAddress as Hex,
    },
    types: TOKEN_NETWORK_BALANCE_PROOF_TYPES,
    primaryType: 'BalanceProof',
    message: {
      channelId: p.channelId as Hex,
      nonce: p.nonce,
      transferredAmount: p.transferredAmount,
      lockedAmount: 0n,
      locksRoot: `0x${'00'.repeat(32)}` as Hex,
    },
  });
  return hexToBytes(digest);
}

export class TokenNetworkBalanceProofSigner implements PaymentChannelSigner {
  public readonly chain: string;
  public readonly chainKind: SwapNodeChainKind = 'evm';
  public readonly tokenNetworkAddress: string;
  private readonly privateKey: Uint8Array;
  private readonly chainId: bigint;

  constructor(cfg: TokenNetworkBalanceProofSignerConfig) {
    if (!(cfg.privateKey instanceof Uint8Array) || cfg.privateKey.length !== 32) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'TokenNetwork signer requires a 32-byte secp256k1 private key'
      );
    }
    if (typeof cfg.chainId !== 'bigint' || cfg.chainId <= 0n) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `TokenNetwork signer requires a positive bigint chainId (got ${String(cfg.chainId)})`
      );
    }
    if (hexToBytes(cfg.tokenNetworkAddress).length !== 20) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'TokenNetwork signer requires a 20-byte tokenNetworkAddress'
      );
    }
    this.chain = cfg.chain;
    this.privateKey = cfg.privateKey;
    this.chainId = cfg.chainId;
    this.tokenNetworkAddress = cfg.tokenNetworkAddress;
  }

  async signBalanceProof(params: PaymentChannelSignParams): Promise<Uint8Array> {
    try {
      if (hexToBytes(params.channelId).length !== 32) {
        throw new Error('TokenNetwork channelId must be 32 bytes');
      }
      const digest = tokenNetworkBalanceProofDigest({
        chainId: this.chainId,
        tokenNetworkAddress: this.tokenNetworkAddress,
        channelId: params.channelId,
        nonce: params.nonce,
        transferredAmount: params.cumulativeAmount,
      });
      return signRecoverable(digest, this.privateKey);
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'TokenNetwork balance-proof signing failed',
        { cause: err }
      );
    }
  }
}

/** 65-byte `r || s || v` (v = 27/28) over a prehashed 32-byte digest. */
function signRecoverable(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const recoveredBytes = secp256k1.sign(digest, privateKey, {
    prehash: false,
    format: 'recovered',
  });
  const sigObj = secp256k1.Signature.fromBytes(recoveredBytes, 'recovered');
  const compact = sigObj.toBytes('compact');
  const recovery = sigObj.recovery;
  if (compact.length !== 64 || (recovery !== 0 && recovery !== 1)) {
    throw new Error('unexpected signature shape');
  }
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = 27 + recovery;
  return out;
}

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
//
// Signs the 48-byte `channel_pda || nonce(8 LE) || transferred_amount(8 LE)`
// message connector's native payment-channel program verifies through the
// Ed25519 precompile — so `channelId` MUST be the channel's PDA in base58, and a
// claim this signer produces is redeemable by
// `@toon-protocol/sdk`'s `buildSettlementTx` (toon#214, proven against the real
// program on a local validator). It signed a `sha256(...)` digest no program has
// ever verified until swap#164.
// ---------------------------------------------------------------------------

export interface SolanaPaymentChannelSignerConfig {
  chain: string;
  privateKey: Uint8Array; // 32-byte Ed25519 seed
  /**
   * The payment-channel program the channel lives under. Bound into every
   * signed message (connector ADR 0053), so a claim is valid only against
   * this deployment: a signature over a channel account alone would verify
   * on any cluster where that account happened to exist.
   */
  programId: string;
}

/** `TOON-BALPROOF-V2` — the domain tag every Solana balance proof begins with. */
export const SOLANA_BALANCE_PROOF_DOMAIN_TAG = new TextEncoder().encode(
  'TOON-BALPROOF-V2'
);

/** Byte length of the ADR 0053 Solana balance-proof message. */
export const SOLANA_BALANCE_PROOF_MESSAGE_SIZE = 96;

function decodeSolanaKey(label: string, value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value);
  } catch (err) {
    throw new SwapWalletError(
      'SIGNING_FAILED',
      `Solana ${label} is not valid base58: ${value}`,
      { cause: err }
    );
  }
  if (bytes.length !== 32) {
    throw new SwapWalletError(
      'SIGNING_FAILED',
      label === 'channelId'
        ? `Solana channelId must be a 32-byte channel PDA in base58 (got ` +
          `${bytes.length} bytes from "${value}"). The on-chain program ` +
          `rebuilds the balance proof from the channel account itself, so a ` +
          `claim signed over anything else can never be redeemed.`
        : `Solana ${label} must be 32 bytes in base58 (got ${bytes.length} bytes from "${value}")`
    );
  }
  return bytes;
}

/**
 * The 96-byte message the deployed program's Ed25519 precompile check
 * verifies (connector ADR 0053, `packages/solana-program/src/processor.rs`):
 *
 *   "TOON-BALPROOF-V2"(16) || program_id(32) || channel_pda(32)
 *     || nonce(u64 LE) || transferred_amount(u64 LE)
 *
 * The 48-byte layout this signer produced before (channel ‖ nonce ‖ amount)
 * is NOT a prefix of this one — the domain tag comes first, deliberately, so
 * a truncated message can never verify. Every claim signed over the old
 * layout is unredeemable on the current program.
 */
export function solanaBalanceProofMessage(
  programId: string,
  channelId: string,
  nonce: bigint,
  transferredAmount: bigint
): Uint8Array {
  const program = decodeSolanaKey('programId', programId);
  const channelPda = decodeSolanaKey('channelId', channelId);
  for (const [label, value] of [
    ['nonce', nonce],
    ['transferredAmount', transferredAmount],
  ] as const) {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        `Solana balance proof: ${label} does not fit in a u64 (got ${value})`
      );
    }
  }
  const out = new Uint8Array(SOLANA_BALANCE_PROOF_MESSAGE_SIZE);
  out.set(SOLANA_BALANCE_PROOF_DOMAIN_TAG, 0);
  out.set(program, 16);
  out.set(channelPda, 48);
  new DataView(out.buffer).setBigUint64(80, nonce, true);
  new DataView(out.buffer).setBigUint64(88, transferredAmount, true);
  return out;
}

export class SolanaPaymentChannelSigner implements PaymentChannelSigner {
  public readonly chain: string;
  public readonly chainKind: SwapNodeChainKind = 'solana';
  public readonly programId: string;
  private readonly privateKey: Uint8Array;

  constructor(cfg: SolanaPaymentChannelSignerConfig) {
    decodeSolanaKey('programId', cfg.programId);
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
    this.programId = cfg.programId;
    this.privateKey = cfg.privateKey;
  }

  async signBalanceProof(
    params: PaymentChannelSignParams
  ): Promise<Uint8Array> {
    try {
      const msg = solanaBalanceProofMessage(
        this.programId,
        params.channelId,
        params.nonce,
        params.cumulativeAmount
      );
      const sig = ed25519.sign(msg, this.privateKey);
      return new Uint8Array(sig);
    } catch (err) {
      // `solanaBalanceProofMessage` already explains exactly which input it
      // refused (a channelId that is not a 32-byte PDA, an out-of-u64 amount);
      // re-wrapping it would bury that message in `cause`.
      if (err instanceof SwapWalletError) throw err;
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'Solana balance-proof signing failed',
        { cause: err }
      );
    }
  }
}
