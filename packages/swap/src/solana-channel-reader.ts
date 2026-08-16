/**
 * Solana implementation of {@link ChannelOnChainReader} (issue #141).
 *
 * Reads the LIVE cumulative amount this maker has already paid OUT of a
 * Solana payment-channel, straight from the channel PDA's account data via a
 * raw `getAccountInfo` JSON-RPC call. Same contract, same failure policy and
 * same "no chain SDK" stance as `evm-channel-reader.ts`: every call hits the
 * RPC endpoint afresh (nothing is cached — a stale value that OVERSTATES the
 * watermark would approve a rebind that strips an unredeemed claim and would
 * over-recycle inventory), and anything unreadable, unrecognized or
 * ambiguous throws so both callers fail closed.
 *
 * ## Account layout (canonical: `packages/solana-program/src/state.rs` in
 * toon-protocol/connector, mirrored by that repo's
 * `crates/connector-settlement-solana/src/wire.rs`)
 *
 * ```
 *   0.. 8  discriminator — the eight ASCII bytes "pchannel" (NOT an Anchor sighash)
 *   8.. 40 participant_a        Pubkey
 *  40.. 72 participant_b        Pubkey
 *  72..104 token_mint           Pubkey
 * 104..112 deposit_a            u64 LE
 * 112..120 deposit_b            u64 LE
 * 120..128 transferred_amount_a u64 LE   ← A's cumulative paid-out
 * 128..136 transferred_amount_b u64 LE   ← B's cumulative paid-out
 * 136..144 nonce_a              u64 LE
 * 144..152 nonce_b              u64 LE
 * 152..160 challenge_duration   u64 LE
 * 160      state                u8
 * 161..169 close_timestamp      i64 LE
 * 169      bump                 u8
 * (total 178 bytes)
 * ```
 *
 * ## Why `transferred_amount_{a,b}` is the right analogue of EVM `cumulativePaid`
 *
 * The Solana channel is BIDIRECTIONAL — it carries one monotone cumulative
 * per participant, not one per channel. `transferred_amount_a` is the total
 * A has paid out to B, `transferred_amount_b` the reverse; the program's
 * settlement math is `A gets deposit_a − transferred_amount_a +
 * transferred_amount_b` (and symmetrically for B). The maker is the PAYER on
 * leg B, so the slot that corresponds to EVM's single `cumulativePaid` is
 * the maker's OWN slot — hence {@link SolanaChannelReaderProvider.payerPubkey},
 * the maker's own derived Solana address (never operator-configured, so this
 * reader adds no config key). Reading the counterparty's slot instead would
 * count value flowing TOWARD the maker as though the maker's claims had been
 * redeemed, i.e. over-recycle. When `payerPubkey` matches NEITHER participant
 * the read throws rather than picking a side.
 *
 * The program itself enforces the monotonicity the reconciler's watermark
 * relies on: `settle` rejects a proof whose `nonce <= stored_nonce`
 * (`NonceNotMonotonic`) or whose `transferred_amount < stored` value
 * (`TransferredAmountDecreased`), and bounds it by that participant's own
 * deposit.
 *
 * ## Fail-closed cases
 *
 * - **Account missing.** `SettleChannel` CLOSES the channel account (data
 *   and lamports zeroed), so "settled" and "never existed" are
 *   indistinguishable from a missing account. Guessing "fully redeemed" for
 *   a settled channel would over-credit on a typo'd channelId, so a missing
 *   account throws.
 * - **Wrong owner.** The `"pchannel"` discriminator alone is spoofable by
 *   anyone who funds an arbitrary 178-byte account, so the account's `owner`
 *   is compared against the configured `programId` first — mirroring the
 *   connector's own Rust client.
 * - **Short / mis-tagged data, RPC error, unparseable channelId.** All throw.
 */

import { base58Decode, base58Encode } from '@toon-protocol/sdk';

import type { ChannelOnChainReader } from './channel-state.js';

/** ASCII "pchannel" — the channel account's 8-byte discriminator. */
const CHANNEL_DISCRIMINATOR = new TextEncoder().encode('pchannel');
/** Full `ChannelState` account size, incl. 8 trailing reserved bytes. */
const CHANNEL_ACCOUNT_SIZE = 178;
const PARTICIPANT_A_OFFSET = 8;
const PARTICIPANT_B_OFFSET = 40;
const TRANSFERRED_AMOUNT_A_OFFSET = 120;
const TRANSFERRED_AMOUNT_B_OFFSET = 128;
const PUBKEY_LEN = 32;

/** Minimal per-Solana-chain slice this reader needs — see `SwapNodeSolanaChainProvider`. */
export interface SolanaChannelReaderProvider {
  /** Namespaced chain id as used in `SwapPair.to.chain` / channel-state keys (e.g. `solana:devnet`). */
  chainId: string;
  /** Cluster JSON-RPC endpoint (HTTP). */
  rpcUrl: string;
  /** Payment-channel program id (base58) — the expected account owner. */
  programId: string;
  /**
   * The MAKER's own Solana address (base58): the participant whose
   * `transferred_amount_*` slot this reader must read. Derived from the
   * node's own key material by `startSwapNode`, never operator-supplied.
   */
  payerPubkey: string;
}

/** Little-endian u64 at `offset`. */
function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value;
}

/** Base58 that MUST decode to a 32-byte Solana address, or throw. */
function decodeAddress(value: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value);
  } catch (err) {
    throw new Error(
      `${what} is not valid base58 (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (bytes.length !== PUBKEY_LEN) {
    throw new Error(
      `${what} must be a 32-byte base58 Solana address (got ${bytes.length} bytes)`
    );
  }
  return bytes;
}

/**
 * `getAccountInfo` returns `data` as `[base64, "base64"]`. Accept the bare
 * string form too (some RPC proxies flatten it) and reject anything else
 * rather than decoding whatever happens to be there.
 */
function decodeAccountData(data: unknown, channelId: string): Uint8Array {
  const base64 =
    typeof data === 'string'
      ? data
      : Array.isArray(data) && typeof data[0] === 'string'
        ? data[0]
        : undefined;
  if (base64 === undefined) {
    throw new Error(
      `getAccountInfo(${channelId}) returned account data in an unrecognized format (expected base64)`
    );
  }
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

/**
 * Pull the maker's cumulative paid-out amount from a decoded channel
 * account. Throws when the account is not a channel of the expected program
 * shape, or when the maker is not one of its two participants.
 */
export function decodeSolanaCumulativePaid(
  data: Uint8Array,
  payerPubkey: string,
  channelId: string
): bigint {
  if (data.length < CHANNEL_ACCOUNT_SIZE) {
    throw new Error(
      `channel account ${channelId} is too short to be a payment channel (expected ${CHANNEL_ACCOUNT_SIZE} bytes, got ${data.length})`
    );
  }
  for (let i = 0; i < CHANNEL_DISCRIMINATOR.length; i++) {
    if (data[i] !== CHANNEL_DISCRIMINATOR[i]) {
      throw new Error(
        `channel account ${channelId} does not carry the "pchannel" discriminator`
      );
    }
  }
  const participantA = base58Encode(
    data.slice(PARTICIPANT_A_OFFSET, PARTICIPANT_A_OFFSET + PUBKEY_LEN)
  );
  const participantB = base58Encode(
    data.slice(PARTICIPANT_B_OFFSET, PARTICIPANT_B_OFFSET + PUBKEY_LEN)
  );
  if (payerPubkey === participantA) {
    return readU64LE(data, TRANSFERRED_AMOUNT_A_OFFSET);
  }
  if (payerPubkey === participantB) {
    return readU64LE(data, TRANSFERRED_AMOUNT_B_OFFSET);
  }
  throw new Error(
    `this node (${payerPubkey}) is neither participant of channel ${channelId} (participants ${participantA}, ${participantB}) — refusing to guess which side's transferred_amount is ours`
  );
}

/**
 * Build a {@link ChannelOnChainReader} that issues one raw `getAccountInfo`
 * per configured Solana chain. A call for a chain with no matching provider,
 * for a channel account that is absent / wrongly owned / malformed, or for a
 * channel this node is not a participant of, throws — every caller treats a
 * throw as "unsafe", i.e. fails closed.
 */
export function createSolanaChannelOnChainReader(
  providers: readonly SolanaChannelReaderProvider[]
): ChannelOnChainReader {
  const byChain = new Map<
    string,
    { rpcUrl: string; programId: string; payerPubkey: string }
  >();
  for (const p of providers) {
    decodeAddress(
      p.programId,
      `chainProviders[chainId=${p.chainId}].programId`
    );
    decodeAddress(
      p.payerPubkey,
      `chainProviders[chainId=${p.chainId}] payer address`
    );
    byChain.set(p.chainId, {
      rpcUrl: p.rpcUrl,
      programId: p.programId,
      payerPubkey: p.payerPubkey,
    });
  }

  return {
    async getCumulativePaid({ chain, channelId }) {
      const entry = byChain.get(chain);
      if (!entry) {
        throw new Error(
          `No Solana chain provider configured for chain '${chain}'`
        );
      }
      // A Solana channelId IS the channel PDA's base58 address (the
      // connector's `ChannelId` for this family) — no derivation, but it
      // must still be a well-formed 32-byte address before it reaches the
      // RPC.
      decodeAddress(channelId, `channelId '${channelId}' on chain '${chain}'`);

      const response = await fetch(entry.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [channelId, { encoding: 'base64', commitment: 'confirmed' }],
        }),
      });
      const json = (await response.json()) as {
        result?: { value?: { data?: unknown; owner?: string } | null };
        error?: { message?: string };
      };
      if (json.error) {
        throw new Error(
          `getAccountInfo(${channelId}) on chain '${chain}' failed: ${
            json.error.message ?? JSON.stringify(json.error)
          }`
        );
      }
      if (!json.result || json.result.value === undefined) {
        throw new Error(
          `getAccountInfo(${channelId}) on chain '${chain}' returned no result`
        );
      }
      const value = json.result.value;
      if (value === null) {
        // `SettleChannel` closes the account, so this is ALSO what a fully
        // settled channel looks like — but it is equally what a typo'd or
        // never-opened channelId looks like, and crediting the difference
        // would be an over-credit. Refuse.
        throw new Error(
          `channel account ${channelId} does not exist on chain '${chain}' (never opened, or already settled and closed by the program) — capacity stays blocked rather than guessing it was fully redeemed`
        );
      }
      if (value.owner !== entry.programId) {
        throw new Error(
          `channel account ${channelId} on chain '${chain}' is owned by ${
            value.owner ?? 'an unknown program'
          }, not the configured payment-channel program ${entry.programId}`
        );
      }
      const data = decodeAccountData(value.data, channelId);
      return decodeSolanaCumulativePaid(data, entry.payerPubkey, channelId);
    },
  };
}
