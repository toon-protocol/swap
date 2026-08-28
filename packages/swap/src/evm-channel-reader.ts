/**
 * The maker's EVM chain-truth reader: the LIVE `transferredAmount` and
 * `deposit` of the maker's own participant slot on a `TokenNetwork` channel,
 * via a raw `eth_call` to the `participants(bytes32,address)` public-mapping
 * getter. `transferredAmount` is what the counterparty has already claimed on
 * chain — the redeemed leg-B watermark the rebind and recycle rules compare
 * against. Hand-rolled (selector + fixed-offset word decode) so this reader
 * carries no ABI machinery.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hexToBytes } from '@toon-protocol/sdk';

import type {
  ChannelFundingPosition,
  ChannelOnChainReader,
} from './channel-state.js';

/** `channels(bytes32)` 4-byte selector — keccak256("channels(bytes32)")[0:4]. */
/** `participants(bytes32,address)` 4-byte selector — keccak256(...)[0:4]. */
const PARTICIPANTS_SELECTOR = keccak_256(
  new TextEncoder().encode('participants(bytes32,address)')
).slice(0, 4);

/**
 * `TokenNetwork.participants(channelId, maker)` returns the maker's own
 * `ParticipantState`: `(deposit, nonce, transferredAmount)`. `transferredAmount`
 * is the cumulative the counterparty has already claimed on chain — the
 * maker's redeemed leg-B watermark — and `deposit` is the TOTAL the maker has
 * ever placed (it does not fall on a claim; `claimedAmounts` does the netting
 * at settlement).
 */
const DEPOSIT_WORD_INDEX = 0;
const TRANSFERRED_WORD_INDEX = 2;
const WORD_HEX_LEN = 64;

function encodeParticipantsCall(channelId: string, participant: string): string {
  const channelIdBytes = hexToBytes(channelId);
  if (channelIdBytes.length !== 32) {
    throw new Error(
      `channelId must be a 32-byte hex value (got ${channelIdBytes.length} bytes)`
    );
  }
  const participantBytes = hexToBytes(participant);
  if (participantBytes.length !== 20) {
    throw new Error(`participant must be a 20-byte hex address`);
  }
  return `0x${bytesToHex(PARTICIPANTS_SELECTOR)}${bytesToHex(channelIdBytes)}${'00'.repeat(12)}${bytesToHex(participantBytes)}`;
}

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
      `participants() response for chain '${chain}' is too short to contain ${fieldName} (got ${hex.length} hex chars)`
    );
  }
  return BigInt(`0x${word}`);
}

function decodeCumulativePaid(resultHex: string, chain: string): bigint {
  return decodeWord(resultHex, chain, TRANSFERRED_WORD_INDEX, 'transferredAmount');
}

/**
 * `funded = cumulativePaid + deposit` must equal the capital the maker has
 * placed (see `ChannelFundingPosition`). On `TokenNetwork` the placed total
 * is `deposit` itself, so the *remaining* deposit reported here is
 * `deposit − transferredAmount`.
 */
function decodeFundingPosition(
  resultHex: string,
  chain: string
): ChannelFundingPosition {
  const total = decodeWord(resultHex, chain, DEPOSIT_WORD_INDEX, 'deposit');
  const paid = decodeCumulativePaid(resultHex, chain);
  return { cumulativePaid: paid, deposit: total > paid ? total - paid : 0n };
}

export interface EvmChannelReaderProvider {
  /** Namespaced chain id as used in `SwapPair.to.chain` / channel-state keys (e.g. `evm:base:8453`). */
  chainId: string;
  /** JSON-RPC endpoint URL. */
  rpcUrl: string;
  /** Deployed `TokenNetwork` address on this chain — where leg-B channels live. */
  tokenNetworkAddress: string;
  /** The maker's own EVM address: the participant slot to read. */
  makerAddress: string;
}

export function createEvmChannelOnChainReader(
  providers: readonly EvmChannelReaderProvider[]
): ChannelOnChainReader {
  const byChain = new Map<
    string,
    { rpcUrl: string; address: string; maker: string }
  >();
  for (const p of providers) {
    const addressBytes = hexToBytes(p.tokenNetworkAddress);
    if (addressBytes.length !== 20) {
      throw new Error(
        `chainProviders[chainId=${p.chainId}].tokenNetworkAddress must be a 20-byte hex address (got ${addressBytes.length} bytes)`
      );
    }
    const makerBytes = hexToBytes(p.makerAddress);
    if (makerBytes.length !== 20) {
      throw new Error(
        `chainProviders[chainId=${p.chainId}] maker address must be a 20-byte hex address`
      );
    }
    byChain.set(p.chainId, {
      rpcUrl: p.rpcUrl,
      address: `0x${bytesToHex(addressBytes)}`,
      maker: `0x${bytesToHex(makerBytes)}`,
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
    const calldata = encodeParticipantsCall(channelId, entry.maker);
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
        `eth_call to participants(${channelId}) on chain '${chain}' failed: ${
          json.error.message ?? JSON.stringify(json.error)
        }`
      );
    }
    if (typeof json.result !== 'string') {
      throw new Error(
        `eth_call to participants(${channelId}) on chain '${chain}' returned no result`
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
