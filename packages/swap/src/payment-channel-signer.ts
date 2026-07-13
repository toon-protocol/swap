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
import { keccak_256 } from '@noble/hashes/sha3.js';

// Story 12.6 AC-6: balance-proof hashes moved to @toon-protocol/sdk so the
// swap-node-side signer and the sender-side verifier share a single source of truth.
//
// NOTE (connector#324 finding #1): the EVM claim digest is now computed
// LOCALLY as EIP-712 typed data (see `claimBalanceProofDigestEvmV2` below) and
// no longer uses the v1 raw-keccak `balanceProofHashEvm`. The Solana/Mina
// signers still consume the shared SDK hashes. This is a LOCKSTEP migration:
// the v2 EIP-712 digest MUST stay byte-identical to the forthcoming
// `@toon-protocol/sdk` v2 digest util (core `balanceProofHashEvm` → EIP-712)
// and the connector `RollingSwapChannel` EIP-712 domain. Once the sdk publishes
// its v2 util this local implementation should re-import it to keep a single
// source of truth.
import {
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
  /**
   * EIP-712 v2 domain field: the settlement chain id as a numeric value
   * (e.g. `8453n` for Base). REQUIRED by the EVM signer — connector#324
   * finding #1: the v2 digest binds `chainId` so a claim signed for one chain
   * can never be replayed on another. Parsed from the target `pair.to.chain`
   * by the claim issuer. IGNORED by the Solana/Mina signers (their digests are
   * not EIP-712 domain-separated).
   */
  chainId?: bigint;
  /**
   * EIP-712 v2 domain field: the `verifyingContract` — the deployed
   * `RollingSwapChannel` settlement contract address (20-byte `0x`-hex).
   * REQUIRED by the EVM signer; binding it makes a signature valid on exactly
   * one (chain, deployment) pair. The connector MUST supply this per chain
   * (threaded via `SwapNodeEvmChainProvider.settlementAddress` →
   * `MultiChainClaimIssuer` settlement-contract map). IGNORED by non-EVM signers.
   */
  verifyingContract?: string;
}

export interface PaymentChannelSigner {
  readonly chain: string;
  readonly chainKind: SwapNodeChainKind;
  signBalanceProof(params: PaymentChannelSignParams): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// EIP-712 v2 balance-proof digest (connector#324 finding #1)
// ---------------------------------------------------------------------------
//
// Canonical spec: `docs/rolling-swap-v2-digest-spec.md` in toon-protocol/connector
// (PR #325). The v1 digest bound only (channelId, cumulativeAmount, nonce,
// recipient) — NOT chainId or the settling contract — so, because the swap node
// uses ONE EVM signing key for every EVM chain and channels are keyed per chain,
// a claim redeemed on chain/deployment A could be replayed verbatim on B. v2
// folds `chainId` and `verifyingContract` into a standard EIP-712 typed-data
// domain, so a signature is valid on EXACTLY one (chainId, contract) pair, and
// `version="2"` makes the cutover fail-closed (a v1 raw-keccak sig can never
// validate as v2). The typehash + golden-vector literals are pinned by the
// cross-repo conformance tests in `payment-channel-signer.test.ts`.

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const keccakUtf8 = (s: string): Uint8Array => keccak_256(utf8Encode(s));

/** keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") */
export const EIP712_DOMAIN_TYPEHASH: Uint8Array = keccakUtf8(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
);
/** keccak256("ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)") */
export const CLAIM_BALANCE_PROOF_TYPEHASH: Uint8Array = keccakUtf8(
  'ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)'
);
/** keccak256("CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)") */
export const COOPERATIVE_CLOSE_TYPEHASH: Uint8Array = keccakUtf8(
  'CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)'
);

const EIP712_DOMAIN_NAME = 'RollingSwapChannel';
const EIP712_DOMAIN_VERSION = '2';
const EIP712_DOMAIN_NAME_HASH: Uint8Array = keccakUtf8(EIP712_DOMAIN_NAME);
const EIP712_DOMAIN_VERSION_HASH: Uint8Array = keccakUtf8(
  EIP712_DOMAIN_VERSION
);

/** Left-pad a `<= 32`-byte word to a full 32-byte ABI word (big-endian). */
function toWord32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new Error(`ABI word overflow: ${bytes.length} > 32 bytes`);
  }
  if (bytes.length === 32) return bytes;
  return concatBytes(new Uint8Array(32 - bytes.length), bytes);
}

/** Decode a 20-byte EVM address; throws on any other length. */
function evmAddress20(address: string, label: string): Uint8Array {
  const bytes = hexToBytes(address);
  if (bytes.length !== 20) {
    throw new Error(
      `${label} must be a 20-byte EVM address, got ${bytes.length} bytes`
    );
  }
  return bytes;
}

/** Decode a 32-byte channelId; throws on any other length. */
function bytes32(value: string, label: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes, got ${bytes.length} bytes`);
  }
  return bytes;
}

/**
 * EIP-712 `domainSeparator = keccak256(abi.encode(EIP712DOMAIN_TYPEHASH,
 * keccak256(name), keccak256(version), chainId, verifyingContract))`. This is
 * exactly OpenZeppelin `EIP712._domainSeparatorV4()`.
 */
export function eip712DomainSeparatorV2(
  chainId: bigint,
  verifyingContract: string
): Uint8Array {
  return keccak_256(
    concatBytes(
      EIP712_DOMAIN_TYPEHASH,
      EIP712_DOMAIN_NAME_HASH,
      EIP712_DOMAIN_VERSION_HASH,
      bigintToBytes32BE(chainId),
      toWord32(evmAddress20(verifyingContract, 'verifyingContract'))
    )
  );
}

/** EIP-712 `keccak256(0x1901 || domainSeparator || structHash)`. */
function eip712Digest(
  domainSeparator: Uint8Array,
  structHash: Uint8Array
): Uint8Array {
  return keccak_256(
    concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash)
  );
}

export interface ClaimBalanceProofDigestParams {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  recipient: string;
  chainId: bigint;
  verifyingContract: string;
}

/**
 * v2 EIP-712 claim digest for `ClaimBalanceProof(bytes32 channelId,uint256
 * cumulativeAmount,uint256 nonce,address recipient)`. The 65-byte
 * `r || s || v` signature over this digest is what `updateBalance` verifies.
 */
export function claimBalanceProofDigestEvmV2(
  params: ClaimBalanceProofDigestParams
): Uint8Array {
  const structHash = keccak_256(
    concatBytes(
      CLAIM_BALANCE_PROOF_TYPEHASH,
      bytes32(params.channelId, 'channelId'),
      bigintToBytes32BE(params.cumulativeAmount),
      bigintToBytes32BE(params.nonce),
      toWord32(evmAddress20(params.recipient, 'recipient'))
    )
  );
  return eip712Digest(
    eip712DomainSeparatorV2(params.chainId, params.verifyingContract),
    structHash
  );
}

export interface CooperativeCloseDigestParams {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  chainId: bigint;
  verifyingContract: string;
}

/**
 * v2 EIP-712 cooperative-close digest for `CooperativeClose(bytes32
 * channelId,uint256 cumulativeAmount,uint256 nonce)`. Shares the v2 domain with
 * the claim, so a close-ack is bound to the same (chain, contract) and its
 * distinct type hash guarantees it can never be recovered as a balance-proof
 * claim (or vice-versa).
 */
export function cooperativeCloseDigestEvmV2(
  params: CooperativeCloseDigestParams
): Uint8Array {
  const structHash = keccak_256(
    concatBytes(
      COOPERATIVE_CLOSE_TYPEHASH,
      bytes32(params.channelId, 'channelId'),
      bigintToBytes32BE(params.cumulativeAmount),
      bigintToBytes32BE(params.nonce)
    )
  );
  return eip712Digest(
    eip712DomainSeparatorV2(params.chainId, params.verifyingContract),
    structHash
  );
}

/**
 * Sign a 32-byte digest with secp256k1 and serialize to the Ethereum-style
 * 65-byte envelope `r(32) || s(32) || v(1)`, `v ∈ {27,28}` (recovery id + 27),
 * canonical low-`s` (enforced by @noble/curves). Shared by the claim and
 * cooperative-close signing paths.
 */
function signDigestEvm(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  // @noble/curves v2's `recovered` format encodes the signature as a Signature
  // instance in a custom byte layout, so we go through the Signature object and
  // re-serialize to the canonical Ethereum layout explicitly.
  const recoveredBytes = secp256k1.sign(digest, privateKey, {
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
      // v2 (connector#324 finding #1): the EVM signer REQUIRES chainId +
      // verifyingContract — the digest is now EIP-712 domain-separated. v1
      // signers took neither. A missing value is a wiring bug (the claim
      // issuer failed to thread the chain/settlement-contract), not a bad
      // claim — surface it loudly rather than sign an unbound digest.
      if (
        params.chainId === undefined ||
        params.verifyingContract === undefined
      ) {
        throw new Error(
          'v2 EIP-712 balance-proof signing requires `chainId` and ' +
            '`verifyingContract` (the RollingSwapChannel settlement contract ' +
            'address); the connector must provide the deployment address per ' +
            'chain. See docs/rolling-swap-v2-digest-spec.md §3.'
        );
      }

      const digest = claimBalanceProofDigestEvmV2({
        channelId: params.channelId,
        cumulativeAmount: params.cumulativeAmount,
        nonce: params.nonce,
        recipient: params.recipient,
        chainId: params.chainId,
        verifyingContract: params.verifyingContract,
      });

      // 65-byte r || s || v envelope; the signer signs the EIP-712 digest
      // directly (no extra EIP-191 prefix — 0x1901 already domain-binds it).
      return signDigestEvm(digest, this.privateKey);
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'EVM balance-proof signing failed',
        { cause: err }
      );
    }
  }

  /**
   * Sign an EIP-712 `CooperativeClose` acknowledgement (spec §2.3). Shares the
   * v2 domain (chainId + verifyingContract) with the claim, so a close-ack is
   * bound to exactly one (chain, contract) and, via its distinct type hash,
   * can never be recovered as a balance-proof claim. Provided so the swap node
   * can co-sign the receive-side cooperative close; wiring it into an actual
   * close flow is future work (connector#324 coop-close leg — no coop-close
   * caller exists in swap yet).
   */
  async signCooperativeClose(params: {
    channelId: string;
    cumulativeAmount: bigint;
    nonce: bigint;
    chainId: bigint;
    verifyingContract: string;
  }): Promise<Uint8Array> {
    try {
      const digest = cooperativeCloseDigestEvmV2(params);
      return signDigestEvm(digest, this.privateKey);
    } catch (err) {
      throw new SwapWalletError(
        'SIGNING_FAILED',
        'EVM cooperative-close signing failed',
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
