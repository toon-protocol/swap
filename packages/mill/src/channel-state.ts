/**
 * `MillChannelState` — per-channel nonce + cumulativeAmount tracking
 * (Story 12.4 AC-7).
 *
 * Keyed by `${assetCode}:${chain}:${senderPubkey}`. Operator provisions
 * channels out of band (Story 12.7); this module tracks the monotonic
 * nonce and cumulativeAmount only. In-memory only — persistence is
 * explicitly deferred (Story 12.8 E2E).
 */

import { MillWalletError } from './errors.js';

export interface ChannelEntry {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  updatedAt: number;
}

export interface ReleaseLogger {
  warn?: (...a: unknown[]) => void;
}

export interface MillChannelStateInit {
  channels: Record<string, ChannelEntry>;
  clock?: () => number;
  /** Optional logger — `release` emits `warn` when a no-op reversal would drive nonce/cumulative negative (AC-7). */
  logger?: ReleaseLogger;
}

export interface ReserveParams {
  assetCode: string;
  chain: string;
  senderPubkey: string;
  cumulativeDelta: bigint;
}

export interface Reservation {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
}

function key(p: {
  assetCode: string;
  chain: string;
  senderPubkey: string;
}): string {
  return `${p.assetCode}:${p.chain}:${p.senderPubkey}`;
}

export class MillChannelState {
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly clock: () => number;
  private readonly logger?: ReleaseLogger;

  constructor(init?: MillChannelStateInit) {
    this.clock = init?.clock ?? Date.now;
    this.logger = init?.logger;
    if (init) {
      for (const [k, v] of Object.entries(init.channels)) {
        this.channels.set(k, { ...v });
      }
    }
  }

  /**
   * Increment nonce by 1, add `cumulativeDelta` to cumulativeAmount,
   * return the new values. Synchronous → microtask atomic.
   */
  reserve(p: ReserveParams): Reservation {
    const k = key(p);
    const entry = this.channels.get(k);
    if (!entry) {
      throw new MillWalletError(
        'UNSUPPORTED_CHAIN',
        `No channel provisioned for sender on ${p.chain}`
      );
    }
    entry.nonce += 1n;
    entry.cumulativeAmount += p.cumulativeDelta;
    entry.updatedAt = this.clock();
    return {
      channelId: entry.channelId,
      cumulativeAmount: entry.cumulativeAmount,
      nonce: entry.nonce,
    };
  }

  /**
   * Best-effort reversal of the last reservation. No-op if it would
   * drive nonce or cumulativeAmount negative.
   */
  release(p: ReserveParams): void {
    const k = key(p);
    const entry = this.channels.get(k);
    if (!entry) {
      this.logger?.warn?.('mill.channelState.release.unknown_channel', {
        assetCode: p.assetCode,
        chain: p.chain,
      });
      return;
    }
    if (entry.nonce <= 0n || entry.cumulativeAmount < p.cumulativeDelta) {
      // Nothing to reverse; defensive. Emit a warn per AC-7 ("no-op + warn log").
      this.logger?.warn?.('mill.channelState.release.noop_would_underflow', {
        assetCode: p.assetCode,
        chain: p.chain,
        nonce: entry.nonce.toString(),
        cumulativeAmount: entry.cumulativeAmount.toString(),
        delta: p.cumulativeDelta.toString(),
      });
      return;
    }
    entry.nonce -= 1n;
    entry.cumulativeAmount -= p.cumulativeDelta;
    entry.updatedAt = this.clock();
  }

  get(p: {
    assetCode: string;
    chain: string;
    senderPubkey: string;
  }): ChannelEntry | null {
    const entry = this.channels.get(key(p));
    if (!entry) return null;
    return { ...entry };
  }

  /**
   * Bulk-release all tracked reservations (Story 12.7 AC-3 / AC-12).
   *
   * Resets every channel entry's nonce and cumulativeAmount to zero — used
   * during Mill `stop()` to free reservation state before shutdown. This does
   * NOT reverse signed claims already emitted; it simply clears in-memory
   * reservation bookkeeping so GC can reclaim the map.
   */
  releaseAll(): void {
    const now = this.clock();
    for (const entry of this.channels.values()) {
      entry.nonce = 0n;
      entry.cumulativeAmount = 0n;
      entry.updatedAt = now;
    }
  }
}
