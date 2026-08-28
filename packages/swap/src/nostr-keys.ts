/**
 * The swap client's Nostr identity — the key that signs orders, seals
 * gift-wrapped fills, and is the `p` a counterparty addresses replies to.
 *
 * Derived from the same mnemonic as the chain keys (`wallet.ts`), on the
 * Nostr coin type (`1237`, NIP-06) at the swap's account index (2 by default
 * — the same slot the chain keys use, so one mnemonic yields one coherent
 * identity across the relay plane and both chains). The relay verifies BIP-340
 * Schnorr on every stored write, so this is a secp256k1 key and its x-only
 * pubkey, exactly what `nostr-tools/pure` expects.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getPublicKey } from 'nostr-tools/pure';

import { SwapWalletError } from './errors.js';

/** NIP-06 / SLIP-44 coin type for Nostr. */
export const NOSTR_COIN_TYPE = 1237;
/** Same default account index as `deriveSwapNodeKeys` (D12-011). */
export const DEFAULT_NOSTR_ACCOUNT_INDEX = 2;

export interface NostrIdentity {
  /** 32-byte secp256k1 secret. */
  secretKey: Uint8Array;
  /** 64-char lowercase hex x-only public key. */
  pubkey: string;
  /** The BIP-32 path it came from, or `'raw'` for an imported secret. */
  path: string;
}

export interface DeriveNostrIdentityInput {
  mnemonic: string;
  passphrase?: string;
  accountIndex?: number;
  addressIndex?: number;
}

const MAX_BIP32_INDEX = 0x7fffffff;

export function deriveNostrIdentity(
  input: DeriveNostrIdentityInput
): NostrIdentity {
  const {
    mnemonic,
    passphrase,
    accountIndex = DEFAULT_NOSTR_ACCOUNT_INDEX,
    addressIndex = 0,
  } = input;
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new SwapWalletError('INVALID_MNEMONIC', 'Invalid BIP-39 mnemonic');
  }
  for (const [name, value] of [
    ['accountIndex', accountIndex],
    ['addressIndex', addressIndex],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_BIP32_INDEX) {
      throw new SwapWalletError(
        'DERIVATION_FAILED',
        `Invalid ${name}: ${String(value)}`
      );
    }
  }
  const path = `m/44'/${NOSTR_COIN_TYPE}'/${accountIndex}'/0/${addressIndex}`;
  const seed = mnemonicToSeedSync(mnemonic, passphrase ?? '');
  try {
    const hd = HDKey.fromMasterSeed(seed).derive(path);
    if (!hd.privateKey) {
      throw new SwapWalletError(
        'DERIVATION_FAILED',
        `Nostr private key missing at ${path}`
      );
    }
    const secretKey = new Uint8Array(hd.privateKey);
    return { secretKey, pubkey: getPublicKey(secretKey), path };
  } finally {
    seed.fill(0);
  }
}

/** Wrap an already-held 32-byte secret as an identity. */
export function nostrIdentityFromSecret(secretKey: Uint8Array): NostrIdentity {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new SwapWalletError(
      'DERIVATION_FAILED',
      'Nostr secret key must be 32 bytes'
    );
  }
  return { secretKey, pubkey: getPublicKey(secretKey), path: 'raw' };
}
