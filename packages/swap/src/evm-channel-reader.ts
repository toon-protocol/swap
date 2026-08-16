/**
 * EVM implementation of {@link ChannelOnChainReader} (issue #113).
 *
 * Reads the LIVE `cumulativePaid` watermark for a `RollingSwapChannel`
 * channel directly from the chain via a raw `eth_call` to the
 * `channels(bytes32)` public-mapping getter Solidity auto-generates for the
 * `Channel` struct (see `tests/integration/fixtures/RollingSwapChannel.sol`).
 * Every call hits the RPC endpoint afresh — the reader caches nothing,
 * matching the "never stale" requirement in `channel-state.ts`'s
 * `ChannelOnChainReader` docs: a rebind decision made on a cached answer
 * could approve stealing a channel that has since accrued an unredeemed
 * claim.
 *
 * Hand-rolled (selector + fixed-offset word decode) rather than pulling in
 * an ABI/RPC client library: every `Channel` field is a static (non-dynamic)
 * type, so the whole struct is 7 fixed 32-byte words and `cumulativePaid`
 * (word index 3) can be read directly with no general ABI decoder. Mirrors
 * `payment-channel-signer.ts`'s "this package does NOT take a hard dep on
 * [a chain SDK]" stance, and reuses the same `keccak_256` /
 * `hexToBytes` primitives `@toon-protocol/settlement-digest` and this
 * package's own signer already depend on.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hexToBytes } from '@toon-protocol/sdk';

import type {
  ChannelFundingPosition,
  ChannelOnChainReader,
} from './channel-state.js';

/** `channels(bytes32)` 4-byte selector — keccak256("channels(bytes32)")[0:4]. */
const CHANNELS_SELECTOR = keccak_256(
  new TextEncoder().encode('channels(bytes32)')
).slice(0, 4);

/**
 * Word indices in the `Channel` struct's ABI-encoded return.
 * `struct Channel { address signer; address funder; uint256 nonce;
 *   uint256 cumulativePaid; uint256 deposit; uint64 closingAt;
 *   ChannelState state; }` — all static types, so a flat run of 32-byte words.
 */
const CUMULATIVE_PAID_WORD_INDEX = 3;
/** swap#142 — `deposit`, the REMAINING un-paid-out deposit (word 4). */
const DEPOSIT_WORD_INDEX = 4;
const WORD_HEX_LEN = 64; // 32 bytes, 2 hex chars/byte

/** `channels(bytes32)` calldata: 4-byte selector followed by the 32-byte channelId. */
function encodeChannelsCall(channelId: string): string {
  const channelIdBytes = hexToBytes(channelId);
  if (channelIdBytes.length !== 32) {
    throw new Error(
      `channelId must be a 32-byte hex value (got ${channelIdBytes.length} bytes)`
    );
  }
  return `0x${bytesToHex(CHANNELS_SELECTOR)}${bytesToHex(channelIdBytes)}`;
}

/**
 * Pull one uint256 word out of a `channels()` return value. Every `Channel`
 * field is a static type, so the struct is a flat run of 32-byte words and
 * the field sits at a fixed offset — no general ABI decoder needed.
 */
function decodeWord(
  resultHex: string,
  chain: string,
  wordIndex: number,
  fieldName: string
): bigint {
  const hex = resultHex.startsWith('0x') ? resultHex.slice(2) : resultHex;
  const wordStart = wordIndex * WORD_HEX_LEN;
  const word = hex.slice(wordStart, wordStart + WORD_HEX_LEN);
  if (word.length !== WORD_HEX_LEN) {
    throw new Error(
      `channels() response for chain '${chain}' is too short to contain ${fieldName} (got ${hex.length} hex chars)`
    );
  }
  return BigInt(`0x${word}`);
}

function decodeCumulativePaid(resultHex: string, chain: string): bigint {
  return decodeWord(
    resultHex,
    chain,
    CUMULATIVE_PAID_WORD_INDEX,
    'cumulativePaid'
  );
}

/**
 * swap#142 — both capital words from ONE response, so they are necessarily
 * from the same block. Reading them with two `eth_call`s could straddle a
 * redemption and overstate `cumulativePaid + deposit`; see
 * `ChannelFundingPosition`.
 */
function decodeFundingPosition(
  resultHex: string,
  chain: string
): ChannelFundingPosition {
  return {
    cumulativePaid: decodeCumulativePaid(resultHex, chain),
    deposit: decodeWord(resultHex, chain, DEPOSIT_WORD_INDEX, 'deposit'),
  };
}

/** Minimal per-EVM-chain slice this reader needs — see `SwapNodeEvmChainProvider`. */
export interface EvmChannelReaderProvider {
  /** Namespaced chain id as used in `SwapPair.to.chain` / channel-state keys (e.g. `evm:base:8453`). */
  chainId: string;
  /** JSON-RPC endpoint URL. */
  rpcUrl: string;
  /** Deployed `RollingSwapChannel` address on this chain. */
  channelAddress: string;
}

/**
 * Build a {@link ChannelOnChainReader} that issues a raw `eth_call` per
 * configured EVM chain. A `getCumulativePaid` call for a chain with no
 * matching provider (or a malformed response) throws — the caller
 * (`SwapChannelState`'s reclaim path) treats any throw as "unsafe to
 * rebind", i.e. fails closed.
 */
export function createEvmChannelOnChainReader(
  providers: readonly EvmChannelReaderProvider[]
): ChannelOnChainReader {
  const byChain = new Map<string, { rpcUrl: string; address: string }>();
  for (const p of providers) {
    const addressBytes = hexToBytes(p.channelAddress);
    if (addressBytes.length !== 20) {
      throw new Error(
        `chainProviders[chainId=${p.chainId}].channelAddress must be a 20-byte hex address (got ${addressBytes.length} bytes)`
      );
    }
    byChain.set(p.chainId, {
      rpcUrl: p.rpcUrl,
      address: `0x${bytesToHex(addressBytes)}`,
    });
  }

  /** One `eth_call` to `channels(channelId)`; returns the raw hex result. */
  async function callChannels(
    chain: string,
    channelId: string
  ): Promise<string> {
    const entry = byChain.get(chain);
    if (!entry) {
      throw new Error(`No EVM chain provider configured for chain '${chain}'`);
    }
    const calldata = encodeChannelsCall(channelId);
    const response = await fetch(entry.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: entry.address, data: calldata }, 'latest'],
      }),
    });
    const json = (await response.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (json.error) {
      throw new Error(
        `eth_call to channels(${channelId}) on chain '${chain}' failed: ${
          json.error.message ?? JSON.stringify(json.error)
        }`
      );
    }
    if (typeof json.result !== 'string') {
      throw new Error(
        `eth_call to channels(${channelId}) on chain '${chain}' returned no result`
      );
    }
    return json.result;
  }

  return {
    async getCumulativePaid({ chain, channelId }) {
      return decodeCumulativePaid(await callChannels(chain, channelId), chain);
    },
    // swap#142 — ONE call, both words: `cumulativePaid` and `deposit` are
    // decoded from the same response and therefore the same block.
    async getFundingPosition({ chain, channelId }) {
      return decodeFundingPosition(await callChannels(chain, channelId), chain);
    },
  };
}
