/**
 * Settlement event payload — Story D3.
 *
 * When a Mill-issued claim is settled on-chain, the Mill emits a
 * `SettlementEvent` describing the on-chain transaction. Downstream
 * consumers (the townhouse-web earnings aggregator, story D4) read
 * `txHash` + `chain` to render block-explorer deeplinks.
 *
 * @module
 * @since D3
 */

/**
 * Chain family for a settlement event. `'evm'` covers all EVM chains
 * (mainnet, Base, Arbitrum, Optimism, etc.) since the txHash format is
 * identical across them. Mina is not currently emitted as a discriminator
 * — it is reserved for a future story when Mina settlement lands.
 */
export type SettlementChain = 'evm' | 'solana';

/**
 * Settlement event emitted by the Mill when a claim is settled on-chain.
 *
 * Field semantics:
 * - `txHash`: the on-chain transaction identifier.
 *   - For `chain === 'evm'`: lowercase 0x-prefixed 32-byte hex string
 *     (matches viem's default; e.g. `'0xabc123...'`).
 *   - For `chain === 'solana'`: base58-encoded transaction signature
 *     (Solana's conventional `signature` is the cross-chain analogue of
 *     an EVM txHash; we reuse the field name `txHash` for consumer-side
 *     consistency).
 * - `chain`: the chain family that the settlement landed on.
 * - `channelId`: the payment-channel identifier on the target chain
 *   (lowercase 0x-prefixed for EVM, base58 for Solana).
 * - `cumulativeAmount`: cumulative target-asset amount settled (decimal
 *   string, target micro-units).
 * - `nonce`: balance-proof nonce settled (decimal string).
 * - `recipient`: the chain-specific payout address (the sender's address).
 * - `settledAt`: ms-epoch timestamp the Mill recorded the settlement.
 *
 * @stable — D4 earnings aggregator depends on `txHash` + `chain`.
 * @since D3
 */
export interface SettlementEvent {
  /**
   * On-chain transaction identifier. EVM: lowercase 0x-prefixed hex.
   * Solana: base58-encoded signature. See module docs for cross-chain
   * naming rationale.
   */
  txHash: string;
  /** Chain family discriminator. */
  chain: SettlementChain;
  /** Payment-channel identifier on the target chain. */
  channelId: string;
  /** Cumulative settled amount (target micro-units, decimal string). */
  cumulativeAmount: string;
  /** Balance-proof nonce (decimal string). */
  nonce: string;
  /** Chain-specific payout address (sender). */
  recipient: string;
  /** ms-epoch the Mill recorded the settlement. */
  settledAt: number;
}

/**
 * Parameters accepted by {@link buildSettlementEvent}. Mirrors
 * {@link SettlementEvent} except `settledAt` defaults to `Date.now()`.
 */
export interface BuildSettlementEventParams {
  txHash: string;
  chain: SettlementChain;
  channelId: string;
  cumulativeAmount: string | bigint;
  nonce: string | bigint;
  recipient: string;
  /** Optional override for `settledAt` (ms-epoch). Defaults to `Date.now()`. */
  settledAt?: number;
}

const EVM_TX_HASH_REGEX = /^0x[0-9a-f]{64}$/;
const SOLANA_BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Construct a {@link SettlementEvent}, normalizing chain-specific
 * conventions:
 * - EVM `txHash` is lowercased (matches viem) and validated as 32-byte
 *   0x-prefixed hex.
 * - Solana `txHash` is validated as base58 (length 64–88 covers all
 *   real-world signatures; full base58 decode is deferred to consumers).
 *
 * @throws {Error} if `txHash` does not match the expected format for
 *   the supplied `chain`.
 * @since D3
 */
export function buildSettlementEvent(
  params: BuildSettlementEventParams
): SettlementEvent {
  const { chain, channelId, recipient } = params;

  if (chain !== 'evm' && chain !== 'solana') {
    throw new Error(
      `buildSettlementEvent: unsupported chain '${String(chain)}'`
    );
  }
  if (typeof params.txHash !== 'string' || params.txHash.length === 0) {
    throw new Error('buildSettlementEvent: txHash is required');
  }
  if (typeof channelId !== 'string' || channelId.length === 0) {
    throw new Error('buildSettlementEvent: channelId is required');
  }
  if (typeof recipient !== 'string' || recipient.length === 0) {
    throw new Error('buildSettlementEvent: recipient is required');
  }

  let txHash: string;
  if (chain === 'evm') {
    txHash = params.txHash.toLowerCase();
    if (!EVM_TX_HASH_REGEX.test(txHash)) {
      throw new Error(
        `buildSettlementEvent: EVM txHash must be 0x-prefixed 32-byte hex, got '${params.txHash}'`
      );
    }
  } else {
    txHash = params.txHash;
    if (
      !SOLANA_BASE58_REGEX.test(txHash) ||
      txHash.length < 64 ||
      txHash.length > 96
    ) {
      throw new Error(
        `buildSettlementEvent: Solana txHash must be base58 (64–96 chars), got length=${txHash.length}`
      );
    }
  }

  const cumulativeAmount =
    typeof params.cumulativeAmount === 'bigint'
      ? params.cumulativeAmount.toString()
      : params.cumulativeAmount;
  const nonce =
    typeof params.nonce === 'bigint' ? params.nonce.toString() : params.nonce;

  return {
    txHash,
    chain,
    channelId,
    cumulativeAmount,
    nonce,
    recipient,
    settledAt: params.settledAt ?? Date.now(),
  };
}
