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
 * The sticky-binding policy is "first UNBOUND channel" — deliberately
 * minimal: a single sender never migrates to a second channel, so
 * sender⇄channel balance-proof state stays coherent. Two senders with
 * distinct pubkeys bind to distinct channels as long as ≥2 channels were
 * provisioned for that `(asset, chain)` (AC-7). NOTE (issue #49): binding
 * is NOT capacity-aware — `ChannelEntry` carries no deposit/capacity field
 * to check against, so per-channel headroom cannot be enforced here.
 * Capacity is bounded one level up by the in-flight window
 * (`SwapInventory` budget/reservations); making the binding deposit-aware
 * is future work once channel deposits are tracked in this state.
 *
 * Issue #113 — the "sticky forever" half of this policy assumed a stable
 * long-lived sender identity (a peered daemon). A released client instead
 * mints a FRESH ephemeral `senderPubkey` per swap request, so every request
 * looks like a brand-new sender; with the (common) single-channel
 * deployment, the second request can never bind and `reserve()` throws
 * UNSUPPORTED_CHAIN forever (the binding is persisted — issue #46 — so not
 * even a restart clears it).
 *
 * The FIRST attempt at a fix (idle-timeout reclaim, since replaced) was
 * rejected on review: rolling claims are redeem-later by design, and
 * `RollingSwapChannel`'s `cumulativePaid`/`nonce` are per-CHANNEL, not
 * per-recipient — stealing a channel from an idle-but-unredeemed sender
 * lets the new sender's redeem sweep the old sender's unclaimed delta and
 * `StaleNonce`-void the old claim. Idleness does not imply redemption.
 *
 * The safety condition is on-chain, not temporal: an optional
 * {@link ChannelOnChainReader} (constructor `onChainReader`, wired by
 * `startSwapNode()` from `SwapNodeConfig.chainProviders` — no config knob,
 * on whenever an EVM chain provider is configured) lets `reserve()` rebind
 * a bound-but-unavailable channel to a fresh sender ONLY when the chain's
 * live `cumulativePaid` for that channel is `>=` the off-chain
 * `cumulativeAmount` watermark this state holds — i.e. every claim issued
 * against it so far has already been redeemed or superseded on-chain, so
 * nothing of value is stranded. On rebind the nonce/cumulativeAmount
 * watermark is left exactly as-is (never reset): it is one on-chain
 * channel's monotonic ledger, and the rebind precondition guarantees that
 * ledger carries no unredeemed value belonging to the previous sender — the
 * next claim's delta over that baseline pays only the new recipient. When
 * no bound channel satisfies the precondition (or no reader is configured
 * for the chain), `reserve()` fails closed with an actionable error naming
 * the candidate channel(s) and why each was refused.
 *
 * State is held in memory for microtask-atomic `reserve`/`release`;
 * durability is provided by `SwapStatePersister` (`state-store.ts`, issue
 * #46): `snapshot()` exports channels + bindings, and the constructor's
 * `init.channels` / `init.bindings` rehydrate them on restart so nonce and
 * cumulativeAmount watermarks continue monotonically across process
 * boundaries.
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

/**
 * Issue #113 — read-only accessor for a channel's LIVE on-chain settled
 * watermark, used ONLY to decide whether a bound-but-inactive channel is
 * safe to rebind to a new sender (see the class docblock). Implementations
 * MUST read the chain fresh on every call — a cached/stale answer that
 * understates the on-chain watermark is safe (fails closed, refuses a
 * rebind that was actually fine), but a cached answer that OVERSTATES it
 * could approve a rebind that stripped an unredeemed claim from its
 * rightful recipient, which is exactly the bug this interface exists to
 * prevent.
 */
export interface ChannelOnChainReader {
  getCumulativePaid(params: {
    assetCode: string;
    chain: string;
    channelId: string;
  }): Promise<bigint>;
}

export interface SwapChannelStateInit {
  channels: Record<string, ChannelEntry>;
  clock?: () => number;
  /** Optional logger — `release` emits `warn` when a no-op reversal would drive nonce/cumulative negative (AC-7). */
  logger?: ReleaseLogger;
  /**
   * Issue #46 — rehydrated sticky sender→channel bindings
   * (`${assetCode}:${chain}:${senderPubkey}` → stored channel key), as
   * previously exported by {@link SwapChannelState.snapshot}. Bindings whose
   * target channel key is absent from `channels` are dropped (a dangling
   * binding would otherwise pin its sender to a channel that no longer
   * exists, failing every subsequent `reserve()`).
   */
  bindings?: Record<string, string>;
  /**
   * Issue #113 — optional on-chain reader enabling safety-checked rebind of
   * a bound-but-unavailable channel once no unbound channel remains for a
   * fresh sender's `(asset, chain)` pool. Absent (default) preserves the
   * pre-#113 "sticky forever" behavior — `reserve()` fails closed exactly
   * as before. See the class docblock for the safety condition.
   */
  onChainReader?: ChannelOnChainReader;
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

/** Result of a rebind attempt — see {@link SwapChannelState.reclaimUnredeemedSafeChannel}. */
type ReclaimResult =
  | { entry: ChannelEntry; refusals: never[] }
  | { entry: null; refusals: string[] };

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
  /**
   * Issue #113 — stored keys currently mid-flight through an on-chain
   * rebind check. Guards two concurrent `reserve()` calls (distinct
   * senders racing the same idle pool) from both reading the same
   * candidate as safe and double-assigning it.
   */
  private readonly reclaiming = new Set<string>();
  private readonly clock: () => number;
  private readonly logger?: ReleaseLogger;
  private readonly onChainReader?: ChannelOnChainReader;

  constructor(init?: SwapChannelStateInit) {
    this.clock = init?.clock ?? Date.now;
    this.logger = init?.logger;
    this.onChainReader = init?.onChainReader;
    if (init) {
      for (const [k, v] of Object.entries(init.channels)) {
        this.channels.set(k, { ...v });
      }
      if (init.bindings) {
        for (const [bk, storedKey] of Object.entries(init.bindings)) {
          if (!this.channels.has(storedKey)) continue; // drop dangling binding
          this.senderBinding.set(bk, storedKey);
          this.boundChannels.add(storedKey);
        }
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
   * Resolve the channel for a given sender using ONLY synchronous state: an
   * existing sticky binding, or the first UNBOUND channel in the `(asset,
   * chain)` pool. Returns `null` when neither applies — `reserve()` then
   * falls back to the async on-chain-checked rebind (issue #113).
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
   * Issue #113 — attempt to rebind a bound-but-unavailable channel in the
   * `${assetCode}:${chain}:` pool to `senderPubkey`, when no unbound
   * channel exists. A candidate is safe to rebind only when its LIVE
   * on-chain `cumulativePaid` (read fresh via `onChainReader`, never
   * cached) is `>=` this state's own off-chain `cumulativeAmount`
   * watermark for it — i.e. every claim issued against it has already been
   * redeemed or superseded, so no value is stranded. Candidates are tried
   * in map-iteration order; the first safe one wins. Unsafe/unreadable
   * candidates are recorded in `refusals` so `reserve()` can surface an
   * actionable error.
   *
   * The nonce/cumulativeAmount watermark is NOT reset on a successful
   * rebind — see the class docblock for why that is safe.
   */
  private async reclaimUnredeemedSafeChannel(p: {
    assetCode: string;
    chain: string;
    senderPubkey: string;
  }): Promise<ReclaimResult> {
    if (!this.onChainReader) return { entry: null, refusals: [] };
    const prefix = `${p.assetCode}:${p.chain}:`;
    const bk = bindingKey(p);
    const candidates: { storedKey: string; entry: ChannelEntry }[] = [];
    for (const [storedKey, entry] of this.channels) {
      if (!storedKey.startsWith(prefix)) continue;
      if (!this.boundChannels.has(storedKey)) continue;
      if (this.reclaiming.has(storedKey)) continue;
      candidates.push({ storedKey, entry });
    }
    if (candidates.length === 0) return { entry: null, refusals: [] };
    for (const c of candidates) this.reclaiming.add(c.storedKey);
    try {
      const refusals: string[] = [];
      for (const { storedKey, entry } of candidates) {
        let onChainCumulativePaid: bigint;
        try {
          onChainCumulativePaid = await this.onChainReader.getCumulativePaid({
            assetCode: p.assetCode,
            chain: p.chain,
            channelId: entry.channelId,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.logger?.warn?.('swap.channelState.reclaim.read_failed', {
            channelId: entry.channelId,
            chain: p.chain,
            err,
          });
          refusals.push(
            `${entry.channelId}: on-chain read failed (${detail})`
          );
          continue; // fail closed for this candidate; try the next
        }
        // The off-chain watermark (or the binding itself) may have moved
        // while this read was in flight — re-check LIVE state, not the
        // pre-await snapshot, before trusting the read.
        const current = this.channels.get(storedKey);
        if (!current || !this.boundChannels.has(storedKey)) continue;
        if (onChainCumulativePaid < current.cumulativeAmount) {
          refusals.push(
            `${entry.channelId}: ${(
              current.cumulativeAmount - onChainCumulativePaid
            ).toString()} unredeemed`
          );
          continue;
        }
        this.rebind(bk, storedKey);
        return { entry: current, refusals: [] };
      }
      return { entry: null, refusals };
    } finally {
      for (const c of candidates) this.reclaiming.delete(c.storedKey);
    }
  }

  /** Move `storedKey`'s binding from whichever sender holds it (if any) to `bk`. */
  private rebind(bk: string, storedKey: string): void {
    for (const [existingBk, sk] of this.senderBinding) {
      if (sk === storedKey) {
        this.senderBinding.delete(existingBk);
        break;
      }
    }
    this.senderBinding.set(bk, storedKey);
  }

  /**
   * Increment nonce by 1, add `cumulativeDelta` to cumulativeAmount,
   * return the new values.
   *
   * The common paths (existing binding; first-use bind to an unbound
   * channel) resolve and mutate synchronously, same as before #113. Only
   * the fallback — no unbound channel left, so a bound channel must be
   * safety-checked on-chain before it can be rebound — awaits an RPC read;
   * see {@link reclaimUnredeemedSafeChannel}.
   */
  async reserve(p: ReserveParams): Promise<Reservation> {
    let entry = this.resolveChannel(p);
    if (!entry) {
      const reclaimed = await this.reclaimUnredeemedSafeChannel(p);
      entry = reclaimed.entry;
      if (!entry) {
        throw new SwapWalletError(
          'UNSUPPORTED_CHAIN',
          buildNoChannelMessage(p.chain, reclaimed.refusals)
        );
      }
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
   * drive nonce or cumulativeAmount negative. Never attempts a rebind —
   * release only ever targets a channel `reserve()` already bound earlier
   * in the same request.
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
   * Issue #46 — export the full channel + binding state for persistence.
   * Returns deep copies keyed by the internal stored-map keys; feeding the
   * result back through the constructor (`init.channels` / `init.bindings`)
   * reproduces this instance's watermarks and sticky bindings exactly.
   */
  snapshot(): {
    channels: Record<string, ChannelEntry>;
    bindings: Record<string, string>;
  } {
    const channels: Record<string, ChannelEntry> = Object.create(
      null
    ) as Record<string, ChannelEntry>;
    for (const [k, v] of this.channels) {
      channels[k] = { ...v };
    }
    return { channels, bindings: this.getBindings() };
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

/** Issue #113 — actionable UNSUPPORTED_CHAIN message for a failed reserve(). */
function buildNoChannelMessage(chain: string, refusals: string[]): string {
  const base = `No channel provisioned for sender on ${chain}`;
  if (refusals.length === 0) return base;
  return (
    `${base} — ${refusals.length} bound channel(s) are not safe to rebind ` +
    `(${refusals.join('; ')}). Wait for the sender to redeem, ` +
    `cooperativeClose the channel, or provision another channel in ` +
    `config.channels.`
  );
}
