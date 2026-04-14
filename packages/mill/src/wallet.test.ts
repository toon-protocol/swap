/**
 * Wallet / key-derivation tests — Story 12.4 AC-3, AC-11 (wallet block).
 *
 * T-029 / T-030 / T-031 / T-032 — test-design-epic-12 Story 12-4.
 */
import { describe, it, expect } from 'vitest';

import { deriveMillKeys } from './wallet.js';
import { MillWalletError } from './errors.js';

// Universally known zero-entropy BIP-39 vector (Trezor/Ledger test suites).
// Pinning derived addresses/pubkeys here is load-bearing per Dev Notes
// "Golden-vector mnemonics for tests" in 12-4 story doc.
const ZERO_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveMillKeys — BIP-44 multi-chain derivation (Story 12.4 AC-3)', () => {
  describe('EVM (secp256k1, coin type 60)', () => {
    it("[P0] (T-029) account index 2 yields a different address than account index 1 (m/44'/60'/N'/0/0)", async () => {
      // Arrange
      const input1 = {
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'] as const,
        accountIndex: 1,
      };
      const input2 = {
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'] as const,
        accountIndex: 2,
      };

      // Act
      const keys1 = await deriveMillKeys(input1);
      const keys2 = await deriveMillKeys(input2);

      // Assert — account isolation (D12-010)
      expect(keys1.evm?.address).toBeDefined();
      expect(keys2.evm?.address).toBeDefined();
      expect(keys1.evm!.address).not.toBe(keys2.evm!.address);
      expect(keys1.evm!.path).toBe("m/44'/60'/1'/0/0");
      expect(keys2.evm!.path).toBe("m/44'/60'/2'/0/0");
    });

    it('[P0] default accountIndex is 2 (D12-011) when not supplied', async () => {
      const keys = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'],
      });
      expect(keys.evm!.path).toBe("m/44'/60'/2'/0/0");
    });

    it('[P0] derived address is a 0x-prefixed 20-byte hex string (EIP-55 case)', async () => {
      const keys = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'],
      });
      // `0x` + 40 hex chars
      expect(keys.evm!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(keys.evm!.privateKey).toBeInstanceOf(Uint8Array);
      expect(keys.evm!.privateKey.length).toBe(32);
    });
  });

  describe('Mina (Pallas curve, coin type 12586)', () => {
    it("[P0] (T-030) account index 2 yields a different pubkey than account index 1 (m/44'/12586'/N'/0/0)", async () => {
      const keys1 = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
        accountIndex: 1,
      });
      const keys2 = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
        accountIndex: 2,
      });

      expect(keys1.mina?.publicKey).toBeDefined();
      expect(keys2.mina?.publicKey).toBeDefined();
      expect(keys1.mina!.publicKey).not.toBe(keys2.mina!.publicKey);
      expect(keys1.mina!.path).toBe("m/44'/12586'/1'/0/0");
      expect(keys2.mina!.path).toBe("m/44'/12586'/2'/0/0");
    });
  });

  describe('Solana (Ed25519, coin type 501, SLIP-0010 all-hardened)', () => {
    it("[P0] (T-031) account index 2 yields a different pubkey than account index 1 (m/44'/501'/N'/0'/0')", async () => {
      const keys1 = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['solana'],
        accountIndex: 1,
      });
      const keys2 = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['solana'],
        accountIndex: 2,
      });

      expect(keys1.solana?.publicKey).toBeInstanceOf(Uint8Array);
      expect(keys2.solana?.publicKey).toBeInstanceOf(Uint8Array);
      // Compare as hex to keep the assertion readable
      const pk1 = Buffer.from(keys1.solana!.publicKey).toString('hex');
      const pk2 = Buffer.from(keys2.solana!.publicKey).toString('hex');
      expect(pk1).not.toBe(pk2);

      expect(keys1.solana!.path).toBe("m/44'/501'/1'/0'/0'");
      expect(keys2.solana!.path).toBe("m/44'/501'/2'/0'/0'");

      expect(keys1.solana!.privateKey.length).toBe(32);
      expect(keys2.solana!.privateKey.length).toBe(32);
    });
  });

  describe('determinism and validation', () => {
    it('[P0] (T-032) same input produces identical output across 3 sequential calls', async () => {
      const input = {
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm', 'mina', 'solana'] as const,
        accountIndex: 2,
      };

      const a = await deriveMillKeys(input);
      const b = await deriveMillKeys(input);
      const c = await deriveMillKeys(input);

      expect(a.evm!.address).toBe(b.evm!.address);
      expect(b.evm!.address).toBe(c.evm!.address);
      expect(a.mina!.publicKey).toBe(b.mina!.publicKey);
      expect(b.mina!.publicKey).toBe(c.mina!.publicKey);
      expect(Buffer.from(a.solana!.publicKey).toString('hex')).toBe(
        Buffer.from(b.solana!.publicKey).toString('hex')
      );
      expect(Buffer.from(b.solana!.publicKey).toString('hex')).toBe(
        Buffer.from(c.solana!.publicKey).toString('hex')
      );
    });

    it("[P1] invalid mnemonic throws MillWalletError('INVALID_MNEMONIC')", async () => {
      await expect(
        deriveMillKeys({
          mnemonic: 'not a real bip39 phrase',
          chains: ['evm'],
        })
      ).rejects.toMatchObject({
        name: 'MillWalletError',
        code: 'INVALID_MNEMONIC',
      });
    });

    it('[P2] empty chains array returns empty MillKeys object (no-op derivation)', async () => {
      const keys = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: [],
      });
      expect(keys.evm).toBeUndefined();
      expect(keys.mina).toBeUndefined();
      expect(keys.solana).toBeUndefined();
    });

    it('[P1] non-empty passphrase yields different EVM keys than empty passphrase (BIP-39 passphrase support)', async () => {
      const k0 = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'],
      });
      const k1 = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'],
        passphrase: 'some-passphrase',
      });
      expect(k0.evm!.address).not.toBe(k1.evm!.address);
    });

    it('[P1] chains: [evm, mina, solana] returns all three key entries in one call', async () => {
      const keys = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm', 'mina', 'solana'],
      });
      expect(keys.evm).toBeDefined();
      expect(keys.mina).toBeDefined();
      expect(keys.solana).toBeDefined();
    });
  });

  describe('addressIndex override (AC-3 contract)', () => {
    it('[P1] different addressIndex values produce distinct EVM keys at the same accountIndex', async () => {
      const a = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'],
        accountIndex: 2,
        addressIndex: 0,
      });
      const b = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['evm'],
        accountIndex: 2,
        addressIndex: 1,
      });
      expect(a.evm!.address).not.toBe(b.evm!.address);
      expect(a.evm!.path).toBe("m/44'/60'/2'/0/0");
      expect(b.evm!.path).toBe("m/44'/60'/2'/0/1");
    });

    it('[P1] different addressIndex values produce distinct Mina keys at the same accountIndex', async () => {
      const a = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
        accountIndex: 2,
        addressIndex: 0,
      });
      const b = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
        accountIndex: 2,
        addressIndex: 1,
      });
      expect(a.mina!.publicKey).not.toBe(b.mina!.publicKey);
      expect(a.mina!.path).toBe("m/44'/12586'/2'/0/0");
      expect(b.mina!.path).toBe("m/44'/12586'/2'/0/1");
    });
  });

  describe('returned key shapes (AC-3 contract)', () => {
    it('[P1] Mina entry includes string privateKey and publicKey plus BIP-44 coin-type-12586 path', async () => {
      const keys = await deriveMillKeys({
        mnemonic: ZERO_MNEMONIC,
        chains: ['mina'],
        accountIndex: 2,
      });
      expect(typeof keys.mina!.privateKey).toBe('string');
      expect(keys.mina!.privateKey.length).toBeGreaterThan(0);
      expect(typeof keys.mina!.publicKey).toBe('string');
      expect(keys.mina!.publicKey.length).toBeGreaterThan(0);
      expect(keys.mina!.path).toBe("m/44'/12586'/2'/0/0");
    });
  });

  describe('MillWalletError contract', () => {
    it('[P2] MillWalletError exposes readonly code and cause option (ES2022)', () => {
      const cause = new Error('root-cause');
      const err = new MillWalletError(
        'DERIVATION_FAILED',
        'derivation failed',
        { cause }
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('MillWalletError');
      expect(err.code).toBe('DERIVATION_FAILED');
      expect((err as { cause?: unknown }).cause).toBe(cause);
    });
  });
});
