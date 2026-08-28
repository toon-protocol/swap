/**
 * NIP-59 gift wrap — the privacy layer every swap message except the public
 * order travels under. A fill from the taker, an advance from the maker: each
 * is a **rumor** (unsigned inner event, {@link SWAP_RUMOR_KIND} in `wire.ts`)
 * sealed by its real author (kind:13, NIP-44 to the counterparty) and wrapped
 * by a throwaway key (kind:1059, NIP-44 again). The relay stores the wrap,
 * which shows a third party only an ephemeral pubkey and a `p` tag.
 *
 * Both directions live here, on `nostr-tools/nip44` + `nostr-tools/pure`
 * primitives (no hand-rolled crypto), because the swap needs two things
 * `nostr-tools/nip59`'s `wrapEvent`/`unwrapEvent` do not give:
 *
 *  - **wrap tags and `created_at` under our control.** A wrap carries a
 *    NIP-40 `expiration` so a finished stream is reaped, and its `created_at`
 *    is the real time (not NIP-59's randomised past), because a party that
 *    resumes drains its inbox with a `since` cursor and a wrap stamped two
 *    days ago would fall outside it. The seal's `created_at` IS randomised
 *    (nothing indexes it), so the only timing a relay observer learns is
 *    "written around now" — which it already knows from the write itself.
 *  - **the seal's pubkey**, verified. `unwrapEvent` discards the seal, but
 *    NIP-59 says authorship is the SEAL's signature, never the wrap's; a
 *    maker binds a session to that pubkey and must never trust a decrypted
 *    field it did not verify.
 */

import {
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
  getConversationKey,
} from 'nostr-tools/nip44';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure';

/** `kind:1059` — the outer gift wrap. */
export const GIFT_WRAP_KIND = 1059;
/** `kind:13` — the inner seal, signed by the real author. */
export const SEAL_KIND = 13;
/** NIP-59 randomises the seal's timestamp up to two days into the past. */
const SEAL_TIMESTAMP_JITTER_SECONDS = 2 * 24 * 60 * 60;

/**
 * Rejectable from the plaintext envelope alone: not an event, not a gift
 * wrap, or not addressed to the identity trying to open it.
 */
export class GiftWrapAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiftWrapAddressError';
  }
}

/**
 * A cryptographic step failed: a NIP-44 layer did not decrypt, a decrypted
 * layer had the wrong shape, the seal's signature did not verify, or the
 * rumor's author/id did not match what the seal proves.
 */
export class GiftWrapDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiftWrapDecryptError';
  }
}

/** A rumor: an unsigned event whose `id` is its hash. */
export type Rumor = UnsignedEvent & { id: string };

export interface UnwrappedGiftWrap {
  rumor: Rumor;
  /**
   * The hex pubkey that signed the kind:13 seal, VERIFIED against the seal's
   * own signature — the real author. Equal to `rumor.pubkey` by construction
   * (a mismatch is refused).
   */
  sealPubkey: string;
  /** The wrap's own id — what a receiver dedupes on and cursors past. */
  wrapId: string;
  /** The wrap's `created_at` (unix seconds) — the relay-visible time. */
  createdAt: number;
}

export interface WrapGiftWrapInput {
  /** What to say: kind, content, tags. `created_at` defaults to now. */
  rumor: {
    kind: number;
    content: string;
    tags?: string[][];
    created_at?: number;
  };
  senderSecretKey: Uint8Array;
  /** Hex x-only pubkey of the recipient. */
  recipientPubkey: string;
  /** NIP-40 expiration (unix seconds) stamped on the wrap; omit for none. */
  expiresAt?: number;
  /** Clock seam (unix ms). */
  now?: () => number;
  /** Randomness seam for the seal's timestamp jitter, in [0, 1). */
  random?: () => number;
}

export interface WrappedGiftWrap {
  wrap: NostrEvent;
  rumor: Rumor;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNostrEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['kind'] === 'number' &&
    typeof e['pubkey'] === 'string' &&
    typeof e['content'] === 'string' &&
    typeof e['created_at'] === 'number' &&
    Array.isArray(e['tags']) &&
    typeof e['id'] === 'string' &&
    typeof e['sig'] === 'string'
  );
}

function isRumorShape(
  value: unknown
): value is UnsignedEvent & { id?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['kind'] === 'number' &&
    typeof e['pubkey'] === 'string' &&
    typeof e['content'] === 'string' &&
    typeof e['created_at'] === 'number' &&
    Array.isArray(e['tags'])
  );
}

/** Seal and wrap a rumor for `recipientPubkey`. Pure apart from the seams. */
export function wrapGiftWrap(input: WrapGiftWrapInput): WrappedGiftWrap {
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const nowSeconds = Math.floor(now() / 1000);
  const senderPubkey = getPublicKey(input.senderSecretKey);

  const rumorBody: UnsignedEvent = {
    kind: input.rumor.kind,
    pubkey: senderPubkey,
    created_at: input.rumor.created_at ?? nowSeconds,
    tags: input.rumor.tags ?? [],
    content: input.rumor.content,
  };
  const rumor: Rumor = { ...rumorBody, id: getEventHash(rumorBody) };

  const sealKey = getConversationKey(
    input.senderSecretKey,
    input.recipientPubkey
  );
  const seal = finalizeEvent(
    {
      kind: SEAL_KIND,
      created_at:
        nowSeconds - Math.floor(random() * SEAL_TIMESTAMP_JITTER_SECONDS),
      tags: [],
      content: nip44Encrypt(JSON.stringify(rumor), sealKey),
    },
    input.senderSecretKey
  );

  const wrapSecret = generateSecretKey();
  const wrapKey = getConversationKey(wrapSecret, input.recipientPubkey);
  const tags: string[][] = [['p', input.recipientPubkey]];
  if (input.expiresAt !== undefined)
    tags.push(['expiration', String(input.expiresAt)]);
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: nowSeconds,
      tags,
      content: nip44Encrypt(JSON.stringify(seal), wrapKey),
    },
    wrapSecret
  );
  wrapSecret.fill(0);
  return { wrap, rumor };
}

/**
 * Open a gift wrap addressed to `recipientPubkey` with `recipientSecretKey`.
 *
 * @throws {GiftWrapAddressError} malformed, wrong kind, or not addressed to us.
 * @throws {GiftWrapDecryptError} a layer failed, or the seal does not prove
 *   the rumor's author.
 */
export function unwrapGiftWrap(
  recipientSecretKey: Uint8Array,
  recipientPubkey: string,
  wrap: NostrEvent
): UnwrappedGiftWrap {
  if (!isNostrEventShape(wrap)) {
    throw new GiftWrapAddressError(
      'wrap is not a valid Nostr event (kind/pubkey/content/created_at/tags/id/sig required).'
    );
  }
  if (wrap.kind !== GIFT_WRAP_KIND) {
    throw new GiftWrapAddressError(
      `wrap.kind must be ${GIFT_WRAP_KIND} (gift wrap), got ${wrap.kind}.`
    );
  }
  if (!wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === recipientPubkey)) {
    throw new GiftWrapAddressError(
      'gift wrap is not addressed to this identity (no matching "p" tag).'
    );
  }

  let seal: unknown;
  try {
    const wrapKey = getConversationKey(recipientSecretKey, wrap.pubkey);
    seal = JSON.parse(nip44Decrypt(wrap.content, wrapKey));
  } catch (err) {
    throw new GiftWrapDecryptError(
      `failed to decrypt gift wrap (layer 1): ${message(err)}`
    );
  }
  if (!isNostrEventShape(seal) || seal.kind !== SEAL_KIND) {
    throw new GiftWrapDecryptError(
      'decrypted wrap content is not a valid kind:13 seal event.'
    );
  }
  // The seal's signature is the ONLY thing that proves `seal.pubkey` authored
  // the rumor. Anyone who can encrypt to us could otherwise forge the author.
  if (!verifyEvent(seal)) {
    throw new GiftWrapDecryptError(
      'seal signature verification failed — the seal was not validly signed by its claimed pubkey.'
    );
  }

  let rumorRaw: unknown;
  try {
    const sealKey = getConversationKey(recipientSecretKey, seal.pubkey);
    rumorRaw = JSON.parse(nip44Decrypt(seal.content, sealKey));
  } catch (err) {
    throw new GiftWrapDecryptError(
      `failed to decrypt seal (layer 2): ${message(err)}`
    );
  }
  if (!isRumorShape(rumorRaw)) {
    throw new GiftWrapDecryptError(
      'decrypted seal content is not a valid unsigned event (rumor).'
    );
  }
  if (rumorRaw.pubkey !== seal.pubkey) {
    throw new GiftWrapDecryptError(
      'rumor.pubkey does not match the seal that carried it — authorship cannot be proven.'
    );
  }
  const body: UnsignedEvent = {
    kind: rumorRaw.kind,
    pubkey: rumorRaw.pubkey,
    created_at: rumorRaw.created_at,
    tags: rumorRaw.tags,
    content: rumorRaw.content,
  };
  const id = getEventHash(body);
  if (rumorRaw.id !== undefined && rumorRaw.id !== id) {
    throw new GiftWrapDecryptError('rumor.id does not match the rumor body.');
  }
  return {
    rumor: { ...body, id },
    sealPubkey: seal.pubkey,
    wrapId: wrap.id,
    createdAt: wrap.created_at,
  };
}

/** The `expiration` tag on an event, as unix seconds, if it carries one. */
export function eventExpiration(event: {
  tags: string[][];
}): number | undefined {
  const tag = event.tags.find((t) => t[0] === 'expiration');
  if (!tag || tag[1] === undefined || !/^[0-9]+$/.test(tag[1]))
    return undefined;
  return Number(tag[1]);
}
