import { describe, expect, it } from 'vitest';

import { deriveNostrIdentity, nostrIdentityFromSecret } from './nostr-keys.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveNostrIdentity', () => {
  it('is deterministic and lands on the NIP-06 coin type at account 2', () => {
    const a = deriveNostrIdentity({ mnemonic: MNEMONIC });
    const b = deriveNostrIdentity({ mnemonic: MNEMONIC });
    expect(a.path).toBe("m/44'/1237'/2'/0/0");
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.pubkey).toBe(b.pubkey);
    expect(Buffer.from(a.secretKey)).toEqual(Buffer.from(b.secretKey));
  });

  it('changes with the account index and the passphrase', () => {
    const base = deriveNostrIdentity({ mnemonic: MNEMONIC });
    expect(
      deriveNostrIdentity({ mnemonic: MNEMONIC, accountIndex: 3 }).pubkey
    ).not.toBe(base.pubkey);
    expect(
      deriveNostrIdentity({ mnemonic: MNEMONIC, passphrase: 'x' }).pubkey
    ).not.toBe(base.pubkey);
  });

  it('round-trips through nostrIdentityFromSecret', () => {
    const d = deriveNostrIdentity({ mnemonic: MNEMONIC });
    expect(nostrIdentityFromSecret(d.secretKey).pubkey).toBe(d.pubkey);
  });

  it('refuses a bad mnemonic and a bad secret', () => {
    expect(() => deriveNostrIdentity({ mnemonic: 'not a mnemonic' })).toThrow(
      /mnemonic/i
    );
    expect(() => nostrIdentityFromSecret(new Uint8Array(31))).toThrow(
      /32 bytes/
    );
  });
});
