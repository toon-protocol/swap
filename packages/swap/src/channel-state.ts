/**
 * `SwapChannelState` — per-channel nonce + cumulativeAmount tracking.
 *
 * Storage is keyed by `${assetCode}:${chain}:${channelId}` (post
 * Story 12.8 AC-12 alignment — previously the lookup side mis-keyed by
 * `senderPubkey`, which could never hit provisioned entries). Operators
 * provision channels at boot (Story 12.7) by channelId; the swap node looks
 * them up at runtime by (asset, chain, channelId) via a sender→channel
 * "sticky binding" that's established on the first `reserve()` for each
 * sender and held for the lifetime of this `SwapChannelState` instance.
 *
 * The sticky-binding policy ("first channel with sufficient capacity")
 * is deliberately minimal — a single sender never migrates to a second
 * channel — so sender⇄channel balance-proof state stays coherent. Two
 * senders with distinct pubkeys bind to distinct channels as long as
 * ≥2 channels were provisioned for that `(asset, chain)` (AC-7).
 *
 * In-memory only; persistence is Story 12.9's concern.
 */

import { SwapWalletError } from './errors.js';

export interface ChannelEntry {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  updatedAt: number;
}

export interface ReleaseLogger {
  warn?: (...a: unknown[]) => void;
}

export interface SwapChannelStateInit {
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

function bindingKey(p: {
  assetCode: string;
  chain: string;
  senderPubkey: string;
}): string {
  return `${p.assetCode}:${p.chain}:${p.senderPubkey}`;
}

export class SwapChannelState {
  /** channelKey() → ChannelEntry */
  private readonly channels = new Map<string, ChannelEntry>();
  /**
   * Story 12.8 AC-12 — sender⇄channel sticky binding map.
   *
   * Populated on first `reserve()` for each unique `(asset, chain, sender)`;
   * looked up on every subsequent `reserve()`/`release()` so balance-proof
   * state stays coherent per sender. Sender pubkeys bind to the first
   * provisioned channel that has not already been claimed by a different
   * sender ("first-available" policy).
   */
  private readonly senderBinding = new Map<string, string>();
  /** Set of channels currently bound to a sender (tracked by stored map-key). */
  private readonly boundChannels = new Set<string>();
  private readonly clock: () => number;
  private readonly logger?: ReleaseLogger;

  constructor(init?: SwapChannelStateInit) {
    this.clock = init?.clock ?? Date.now;
    this.logger = init?.logger;
    if (init) {
      for (const [k, v] of Object.entries(init.channels)) {
        this.channels.set(k, { ...v });
      }
    }
  }

  /**
   * Register a channel at runtime under `${assetCode}:${chain}:${channelId}`.
   *
   * Used by deployments where channels are discovered dynamically (e.g., the
   * Docker SDK entrypoint syncing the connector's channel-manager into the
   * swap node's swap-channel state). Idempotent on the storage key — re-registering
   * the same `(assetCode, chain, channelId)` triple does NOT clobber an
   * already-tracked nonce / cumulativeAmount.
   */
  provisionChannel(p: {
    assetCode: string;
    chain: string;
    channelId: string;
    cumulativeAmount?: bigint;
    nonce?: bigint;
  }): void {
    const key = `${p.assetCode}:${p.chain}:${p.channelId}`;
    if (this.channels.has(key)) return;
    this.channels.set(key, {
      channelId: p.channelId,
      cumulativeAmount: p.cumulativeAmount ?? 0n,
      nonce: p.nonce ?? 0n,
      updatedAt: this.clock(),
    });
  }

  /**
   * Resolve the channel for a given sender, establishing a sticky binding
   * on first use. Returns `null` if no unbound channel is available for
   * this `(asset, chain)`.
   *
   * @internal — exposed for AC-12 test introspection via the swap node.
   */
  resolveChannel(p: {
    assetCode: string;
    chain: string;
    senderPubkey: string;
  }): ChannelEntry | null {
    const bk = bindingKey(p);
    const existing = this.senderBinding.get(bk);
    if (existing) {
      // Binding stores the stored-map key (robust to fixtures that key
      // entries by channelId, senderPubkey, or any other discriminator).
      return this.channels.get(existing) ?? null;
    }
    // First-use: find any provisioned channel for this (asset, chain) that
    // is not already bound to a different sender. We scan the raw stored
    // keys — any key prefixed `${assetCode}:${chain}:` counts, regardless
    // of whether the third segment is the channelId or a legacy
    // senderPubkey. This keeps provisioning callers decoupled from the
    // internal storage-key shape.
    const prefix = `${p.assetCode}:${p.chain}:`;
    for (const [storedKey, entry] of this.channels) {
      if (!storedKey.startsWith(prefix)) continue;
      if (this.boundChannels.has(storedKey)) continue;
      this.senderBinding.set(bk, storedKey);
      this.boundChannels.add(storedKey);
      return entry;
    }
    return null;
  }

  /**
   * Increment nonce by 1, add `cumulativeDelta` to cumulativeAmount,
   * return the new values. Synchronous → microtask atomic.
   */
  reserve(p: ReserveParams): Reservation {
    const entry = this.resolveChannel(p);
    if (!entry) {
      throw new SwapWalletError(
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
    const entry = this.resolveChannel(p);
    if (!entry) {
      this.logger?.warn?.('swap.channelState.release.unknown_channel', {
        assetCode: p.assetCode,
        chain: p.chain,
      });
      return;
    }
    if (entry.nonce <= 0n || entry.cumulativeAmount < p.cumulativeDelta) {
      // Nothing to reverse; defensive. Emit a warn per AC-7 ("no-op + warn log").
      this.logger?.warn?.('swap.channelState.release.noop_would_underflow', {
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
    const entry = this.resolveChannel(p);
    if (!entry) return null;
    return { ...entry };
  }

  /**
   * Story 12.8 AC-12 — introspect the sender⇄channel sticky-binding map.
   * Returns a snapshot copy so callers cannot mutate internal state.
   *
   * @internal — exposed for AC-12 assertions.
   */
  getBindings(): Record<string, string> {
    return Object.fromEntries(this.senderBinding);
  }

  /**
   * Bulk-release all tracked reservations (Story 12.7 AC-3 / AC-12).
   *
   * Resets every channel entry's nonce and cumulativeAmount to zero — used
   * during swap node `stop()` to free reservation state before shutdown. This does
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
    // Story 12.8 AC-12: sticky bindings are shutdown-scoped — clear them so
    // a post-stop() re-boot starts with fresh sender→channel assignments.
    this.senderBinding.clear();
    this.boundChannels.clear();
  }
}
