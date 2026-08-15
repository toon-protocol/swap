/**
 * EVM implementation of {@link ChannelOnChainReader} (issue #113).
 *
 * Reads the LIVE `cumulativePaid` watermark for a `RollingSwapChannel`
 * channel straight off-chain via a raw `eth_call` to the `channels(bytes32)`
 * public-mapping getter Solidity auto-generates for the `Channel` struct
 * (see `tests/integration/fixtures/RollingSwapChannel.sol`). Every call
 * issues a fresh call — the reader caches nothing, matching the "never
 * stale" requirement in `channel-state.ts`'s `ChannelOnChainReader` docs: a
 * rebind decision made on a cached answer could approve stealing a channel
 * that has since accrued an unredeemed claim.
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

import type { ChannelOnChainReader } from './channel-state.js';

/** `channels(bytes32)` 4-byte selector — keccak256("channels(bytes32)")[0:4]. */
const CHANNELS_SELECTOR = keccak_256(
  new TextEncoder().encode('channels(bytes32)')
).slice(0, 4);

/** Word index of `cumulativePaid` in the `Channel` struct's ABI-encoded return. */
const CUMULATIVE_PAID_WORD_INDEX = 3;
const WORD_HEX_LEN = 64; // 32 bytes, 2 hex chars/byte

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

  return {
    async getCumulativePaid({ chain, channelId }) {
      const entry = byChain.get(chain);
      if (!entry) {
        throw new Error(`No EVM chain provider configured for chain '${chain}'`);
      }
      const channelIdBytes = hexToBytes(channelId);
      if (channelIdBytes.length !== 32) {
        throw new Error(
          `channelId must be a 32-byte hex value (got ${channelIdBytes.length} bytes)`
        );
      }
      const calldata = `0x${bytesToHex(CHANNELS_SELECTOR)}${bytesToHex(
        channelIdBytes
      )}`;
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
      const hex = json.result.startsWith('0x')
        ? json.result.slice(2)
        : json.result;
      const wordStart = CUMULATIVE_PAID_WORD_INDEX * WORD_HEX_LEN;
      const word = hex.slice(wordStart, wordStart + WORD_HEX_LEN);
      if (word.length !== WORD_HEX_LEN) {
        throw new Error(
          `channels() response for chain '${chain}' is too short to contain cumulativePaid (got ${hex.length} hex chars)`
        );
      }
      return BigInt(`0x${word}`);
    },
  };
}
