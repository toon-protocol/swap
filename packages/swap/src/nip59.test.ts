import { describe, expect, it } from 'vitest';
import { unwrapEvent } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';

import {
  GIFT_WRAP_KIND,
  GiftWrapAddressError,
  GiftWrapDecryptError,
  SEAL_KIND,
  eventExpiration,
  unwrapGiftWrap,
  wrapGiftWrap,
} from './nip59.js';

const sender = generateSecretKey();
const recipient = generateSecretKey();
const recipientPub = getPublicKey(recipient);
const NOW = 1_800_000_000_000;

function wrapOne(overrides: Partial<Parameters<typeof wrapGiftWrap>[0]> = {}) {
  return wrapGiftWrap({
    rumor: { kind: 20036, content: '{"type":"fill"}', tags: [['t', 'x']] },
    senderSecretKey: sender,
    recipientPubkey: recipientPub,
    expiresAt: 1_800_003_600,
    now: () => NOW,
    random: () => 0.5,
    ...overrides,
  });
}

describe('wrapGiftWrap / unwrapGiftWrap', () => {
  it('round-trips and proves the author from the seal', () => {
    const { wrap, rumor } = wrapOne();
    expect(wrap.kind).toBe(GIFT_WRAP_KIND);
    expect(wrap.pubkey).not.toBe(getPublicKey(sender)); // throwaway wrap key
    expect(wrap.created_at).toBe(NOW / 1000); // real time, for `since` cursors
    expect(wrap.tags).toContainEqual(['p', recipientPub]);
    expect(eventExpiration(wrap)).toBe(1_800_003_600);

    const opened = unwrapGiftWrap(recipient, recipientPub, wrap);
    expect(opened.sealPubkey).toBe(getPublicKey(sender));
    expect(opened.rumor).toEqual(rumor);
    expect(opened.rumor.pubkey).toBe(getPublicKey(sender));
    expect(opened.wrapId).toBe(wrap.id);
    expect(opened.createdAt).toBe(wrap.created_at);
  });

  it('is readable by nostr-tools/nip59 (interop)', () => {
    const { wrap, rumor } = wrapOne();
    const theirs = unwrapEvent(wrap, recipient);
    expect(theirs.content).toBe(rumor.content);
    expect(theirs.kind).toBe(rumor.kind);
    expect(theirs.pubkey).toBe(rumor.pubkey);
  });

  it('omits the expiration tag when none is asked for', () => {
    const { wrap } = wrapOne({ expiresAt: undefined });
    expect(eventExpiration(wrap)).toBeUndefined();
  });

  it('refuses a wrap not addressed to us, or of the wrong kind', () => {
    const { wrap } = wrapOne();
    const other = generateSecretKey();
    expect(() => unwrapGiftWrap(other, getPublicKey(other), wrap)).toThrow(
      GiftWrapAddressError
    );
    expect(() =>
      unwrapGiftWrap(recipient, recipientPub, { ...wrap, kind: 1 })
    ).toThrow(GiftWrapAddressError);
  });

  it('refuses a wrap addressed to us but encrypted to someone else', () => {
    const other = generateSecretKey();
    const { wrap } = wrapOne({ recipientPubkey: getPublicKey(other) });
    const forged = { ...wrap, tags: [['p', recipientPub]] };
    expect(() => unwrapGiftWrap(recipient, recipientPub, forged)).toThrow(
      GiftWrapDecryptError
    );
  });

  it('refuses a rumor whose pubkey is not the seal signer', () => {
    // Seal signed by `sender`, rumor claiming to be from `impostor`.
    const impostor = getPublicKey(generateSecretKey());
    const rumor = {
      kind: 20036,
      pubkey: impostor,
      created_at: 1,
      tags: [],
      content: 'x',
    };
    const seal = finalizeEvent(
      {
        kind: SEAL_KIND,
        created_at: 1,
        tags: [],
        content: nip44Encrypt(
          JSON.stringify(rumor),
          getConversationKey(sender, recipientPub)
        ),
      },
      sender
    );
    const wrapSecret = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: GIFT_WRAP_KIND,
        created_at: 1,
        tags: [['p', recipientPub]],
        content: nip44Encrypt(
          JSON.stringify(seal),
          getConversationKey(wrapSecret, recipientPub)
        ),
      },
      wrapSecret
    );
    expect(() => unwrapGiftWrap(recipient, recipientPub, wrap)).toThrow(
      /rumor.pubkey/
    );
  });
});
