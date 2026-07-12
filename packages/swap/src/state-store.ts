/**
 * Swap-node state persistence (issue #46 — rolling-swap prerequisite P2).
 *
 * Everything the swap node hands out to counterparties is derived from three
 * pieces of runtime state that were previously in-memory only:
 *
 *   - `SwapInventory` reserves          (`inventory.ts`, keyed `assetCode:chain`)
 *   - `SwapChannelState` watermarks     (nonce + cumulativeAmount per channel)
 *     and sticky sender→channel bindings
 *   - replay reservations               (the swap handler's `seenPacketIds`)
 *
 * A crash mid-stream would desynchronize the swap node's channel watermark from
 * signed claims already handed to counterparties — the next boot would
 * re-issue nonce 1 on a channel whose counterparty already holds nonce N.
 * The rolling engine (swap#47) keeps many per-packet advances in flight, so
 * durability of these watermarks is a hard prerequisite, not an
 * optimization.
 *
 * ## Persistence model
 *
 * One JSON snapshot file, written atomically (temp file + `fsync` +
 * `rename`) on every state mutation that can leave the process. Writes are
 * SYNCHRONOUS to preserve the swap node's microtask-atomicity invariants
 * (`debit`/`reserve` are sync; a sync persist keeps the
 * reserve→persist→sign ordering un-interleavable). Follows the
 * `JsonFileChannelStore` pattern from toon-client
 * (`packages/client/src/channel/ChannelStore.ts`) with atomic-rename
 * hardening.
 *
 * ## Crash-consistency rules (write-ahead / persist-before-hand-out)
 *
 * 1. **Watermarks are persisted BEFORE a claim can leave the process.**
 *    `MultiChainClaimIssuer.issueClaim` persists immediately after
 *    debit+reserve and BEFORE `signBalanceProof` — so at every instant the
 *    stored watermark is >= the highest watermark embedded in any claim a
 *    counterparty could hold. If the write-ahead persist fails, the
 *    debit+reserve are rolled back and NO claim is issued.
 * 2. **Crash between debit/reserve and FULFILL**: the persisted state may
 *    include reservations for claims that were never delivered (nonce gap,
 *    inventory debited for nothing). This is the deliberate safe side of
 *    the race: on restart the next claim continues monotonically ABOVE the
 *    aborted reservation, and inventory under-reports rather than
 *    over-reports. The aborted amounts are recoverable by the operator via
 *    `SwapInventory.credit` / settlement reconciliation; the swap node never
 *    hands out a claim that is AHEAD of the stored watermark.
 * 3. **Signer-failure rollback** (`claim-issuer.ts`): the in-memory
 *    credit+release rollback is followed by a best-effort persist. If the
 *    process crashes between rollback and persist, the stored state simply
 *    retains the (safe, over-reserved) pre-rollback snapshot — see rule 2.
 * 4. **Replay reservations**: `PersistentSeenPacketIds` persists on every
 *    add/delete (the handler adds BEFORE issuing a claim). After a crash,
 *    a packet whose id was reserved but never fulfilled is rejected as a
 *    duplicate (F04) — fail-closed against double-issuance at the cost of
 *    one retry-liveness edge. When an operator supplies their own
 *    `seenPacketIds` set instead, it is NOT persisted and the accepted
 *    replay window on restart is the full set (bounded by the operator's
 *    own cap; the SDK default is a 10k-entry LRU).
 * 5. **Shutdown does not persist.** `SwapNodeInstance.stop()` zeroes in-memory
 *    reservation bookkeeping (`releaseAll`) for GC; the on-disk snapshot
 *    keeps the last handed-out watermarks and is authoritative on the next
 *    boot.
 *
 * ## Rehydration precedence
 *
 * On `startSwapNode`, persisted entries WIN over config-supplied initial values
 * for any key present in the snapshot (a restart must never reset spent
 * inventory or channel watermarks back to their notional boot values).
 * Config supplies initial values only for keys the snapshot has never seen.
 * To intentionally reset, an operator deletes the state file.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { SwapInventory } from './inventory.js';
import type { SwapChannelState } from './channel-state.js';

// ---------------------------------------------------------------------------
// Persisted shape (all bigints string-encoded to preserve precision)
// ---------------------------------------------------------------------------

export interface PersistedInventoryEntry {
  /** String-encoded bigint. */
  available: string;
  /** String-encoded bigint. */
  total: string;
  updatedAt: number;
}

export interface PersistedChannelEntry {
  channelId: string;
  /** String-encoded bigint. */
  cumulativeAmount: string;
  /** String-encoded bigint. */
  nonce: string;
  updatedAt: number;
}

export interface PersistedSwapState {
  /** Schema version — bump on breaking shape changes. */
  version: 1;
  /** `${assetCode}:${chain}` → reserves. */
  inventory: Record<string, PersistedInventoryEntry>;
  /** `${assetCode}:${chain}:${channelId}` → watermark entry. */
  channels: Record<string, PersistedChannelEntry>;
  /** `${assetCode}:${chain}:${senderPubkey}` → stored channel key. */
  bindings: Record<string, string>;
  /** Replay reservations (insertion-ordered, oldest first). */
  seenPacketIds: string[];
}

/** Storage abstraction so tests / future sqlite backends can swap in. */
export interface SwapStateStore {
  /** Returns `null` when no state has ever been persisted. */
  load(): PersistedSwapState | null;
  save(state: PersistedSwapState): void;
}

export type SwapStateStoreErrorCode = 'LOAD_FAILED' | 'SAVE_FAILED';

export class SwapStateStoreError extends Error {
  public readonly code: SwapStateStoreErrorCode;

  constructor(
    code: SwapStateStoreErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'SwapStateStoreError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// JSON-file store (atomic rename)
// ---------------------------------------------------------------------------

/**
 * Reject keys that would pollute `Object.prototype` when the parsed JSON is
 * fanned back out into runtime maps (mirrors the CLI's `assertSafeKey`
 * prototype-pollution guard — `JSON.parse` preserves `__proto__` as an own
 * property).
 */
function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function copyRecord<T>(
  raw: Record<string, T>,
  scope: string,
  validate: (v: T, key: string) => void
): Record<string, T> {
  const out: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const [k, v] of Object.entries(raw)) {
    if (isUnsafeKey(k)) {
      throw new Error(`Unsafe key "${k}" rejected in ${scope}`);
    }
    validate(v, k);
    out[k] = v;
  }
  return out;
}

function assertBigintString(v: unknown, ctx: string): void {
  if (typeof v !== 'string') {
    throw new Error(`${ctx} must be a string-encoded bigint`);
  }
  BigInt(v); // throws SyntaxError on malformed input
}

/**
 * File-backed {@link SwapStateStore}.
 *
 * Durability: `save()` writes the full snapshot to `<path>.tmp`, `fsync`s
 * the file descriptor, then atomically `rename`s over `<path>` (and
 * best-effort `fsync`s the containing directory). A crash mid-write
 * therefore leaves either the previous complete snapshot or the new
 * complete snapshot — never a torn file.
 *
 * Corruption policy: a snapshot that exists but cannot be parsed/validated
 * FAILS `load()` loudly (`SwapStateStoreError('LOAD_FAILED')`) rather than
 * silently booting from config — silently resetting watermarks is exactly
 * the desync this module exists to prevent.
 */
export class JsonFileSwapStateStore implements SwapStateStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new SwapStateStoreError(
        'LOAD_FAILED',
        'JsonFileSwapStateStore requires a non-empty file path'
      );
    }
    this.filePath = filePath;
  }

  load(): PersistedSwapState | null {
    if (!existsSync(this.filePath)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch (err) {
      throw new SwapStateStoreError(
        'LOAD_FAILED',
        `Swap-node state file ${this.filePath} is unreadable or corrupt; refusing to boot with reset watermarks. Restore the file (or delete it to intentionally reset).`,
        { cause: err }
      );
    }
    try {
      return validatePersistedState(raw);
    } catch (err) {
      throw new SwapStateStoreError(
        'LOAD_FAILED',
        `Swap-node state file ${this.filePath} failed validation: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }
  }

  save(state: PersistedSwapState): void {
    const tmpPath = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const json = JSON.stringify(state, null, 2);
      const fd = openSync(tmpPath, 'w');
      try {
        writeSync(fd, json, null, 'utf-8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, this.filePath);
      // Best-effort directory fsync so the rename itself is durable.
      try {
        const dirFd = openSync(dirname(this.filePath), 'r');
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // Not supported on all platforms/filesystems — the file-level fsync
        // above already guarantees snapshot integrity.
      }
    } catch (err) {
      throw new SwapStateStoreError(
        'SAVE_FAILED',
        `Failed to persist swap-node state to ${this.filePath}`,
        { cause: err }
      );
    }
  }
}

/** @internal — exported for direct testing of the validation surface. */
export function validatePersistedState(raw: unknown): PersistedSwapState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('state must be a JSON object');
  }
  const rec = raw as Record<string, unknown>;
  if (rec['version'] !== 1) {
    throw new Error(
      `unsupported state schema version ${JSON.stringify(rec['version'])} (expected 1)`
    );
  }
  const invRaw = rec['inventory'];
  const chanRaw = rec['channels'];
  const bindRaw = rec['bindings'];
  const seenRaw = rec['seenPacketIds'];
  if (typeof invRaw !== 'object' || invRaw === null || Array.isArray(invRaw)) {
    throw new Error('state.inventory must be an object');
  }
  if (
    typeof chanRaw !== 'object' ||
    chanRaw === null ||
    Array.isArray(chanRaw)
  ) {
    throw new Error('state.channels must be an object');
  }
  if (
    typeof bindRaw !== 'object' ||
    bindRaw === null ||
    Array.isArray(bindRaw)
  ) {
    throw new Error('state.bindings must be an object');
  }
  if (!Array.isArray(seenRaw) || seenRaw.some((s) => typeof s !== 'string')) {
    throw new Error('state.seenPacketIds must be an array of strings');
  }

  const inventory = copyRecord(
    invRaw as Record<string, PersistedInventoryEntry>,
    'state.inventory',
    (v, k) => {
      assertBigintString(v?.available, `state.inventory["${k}"].available`);
      assertBigintString(v?.total, `state.inventory["${k}"].total`);
    }
  );
  const channels = copyRecord(
    chanRaw as Record<string, PersistedChannelEntry>,
    'state.channels',
    (v, k) => {
      if (typeof v?.channelId !== 'string' || v.channelId.length === 0) {
        throw new Error(`state.channels["${k}"].channelId must be a string`);
      }
      assertBigintString(
        v.cumulativeAmount,
        `state.channels["${k}"].cumulativeAmount`
      );
      assertBigintString(v.nonce, `state.channels["${k}"].nonce`);
    }
  );
  const bindings = copyRecord(
    bindRaw as Record<string, string>,
    'state.bindings',
    (v, k) => {
      if (typeof v !== 'string') {
        throw new Error(`state.bindings["${k}"] must be a string`);
      }
    }
  );
  return {
    version: 1,
    inventory,
    channels,
    bindings,
    seenPacketIds: [...(seenRaw as string[])],
  };
}

// ---------------------------------------------------------------------------
// Persistent replay-reservation set
// ---------------------------------------------------------------------------

/**
 * Matches the SDK swap-handler's `DEFAULT_SEEN_PACKET_IDS_CAP` so switching
 * from the SDK's in-memory LRU to this persistent set does not change the
 * replay window.
 */
export const DEFAULT_PERSISTED_SEEN_IDS_CAP = 10_000;

/**
 * Bounded, insertion-ordered, persistently-snapshotted replay set.
 *
 * Satisfies the SDK's `SeenPacketIdsLike` contract (`has`/`add`/`delete` +
 * `size`). The swap handler calls `add(packetId)` BEFORE issuing a claim
 * and `delete(packetId)` when the claim path aborts — with `onMutate`
 * wired to `SwapStatePersister.persist`, every reservation hits disk
 * before the corresponding claim can leave the process (crash rule 4).
 */
export class PersistentSeenPacketIds {
  private readonly ids = new Set<string>();
  private readonly cap: number;
  private onMutate?: () => void;

  constructor(
    initial?: Iterable<string>,
    cap = DEFAULT_PERSISTED_SEEN_IDS_CAP
  ) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error('PersistentSeenPacketIds cap must be a positive integer');
    }
    this.cap = cap;
    if (initial) {
      for (const id of initial) {
        this.ids.add(id);
        this.evictIfNeeded();
      }
    }
  }

  /** Wire the persistence hook (called synchronously after add/delete). */
  setOnMutate(fn: () => void): void {
    this.onMutate = fn;
  }

  get size(): number {
    return this.ids.size;
  }

  has(value: string): boolean {
    return this.ids.has(value);
  }

  add(value: string): this {
    if (this.ids.has(value)) return this;
    this.ids.add(value);
    this.evictIfNeeded();
    this.onMutate?.();
    return this;
  }

  delete(value: string): boolean {
    const removed = this.ids.delete(value);
    if (removed) this.onMutate?.();
    return removed;
  }

  /** Snapshot for persistence (insertion order, oldest first). */
  values(): string[] {
    return [...this.ids];
  }

  private evictIfNeeded(): void {
    while (this.ids.size > this.cap) {
      const oldest = this.ids.values().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Persister — snapshots live state into the store
// ---------------------------------------------------------------------------

export interface SwapStatePersisterInit {
  store: SwapStateStore;
  inventory: SwapInventory;
  channelState: SwapChannelState;
  /**
   * When the swap node owns its replay set (no operator-supplied
   * `seenPacketIds`), included in every snapshot. Omitted → snapshots carry
   * an empty list and the replay window resets on restart (documented crash
   * rule 4).
   */
  seenPacketIds?: PersistentSeenPacketIds;
}

/**
 * Assembles a {@link PersistedSwapState} snapshot from the live
 * `SwapInventory` + `SwapChannelState` (+ replay set) and saves it through
 * the configured store. `persist()` is synchronous — see the module
 * docblock for why.
 */
export class SwapStatePersister {
  private readonly store: SwapStateStore;
  private readonly inventory: SwapInventory;
  private readonly channelState: SwapChannelState;
  private readonly seenPacketIds?: PersistentSeenPacketIds;

  constructor(init: SwapStatePersisterInit) {
    this.store = init.store;
    this.inventory = init.inventory;
    this.channelState = init.channelState;
    if (init.seenPacketIds) this.seenPacketIds = init.seenPacketIds;
  }

  persist(): void {
    const inventory: Record<string, PersistedInventoryEntry> = Object.create(
      null
    ) as Record<string, PersistedInventoryEntry>;
    for (const b of this.inventory.snapshot()) {
      inventory[`${b.assetCode}:${b.chain}`] = {
        available: b.available.toString(),
        total: b.total.toString(),
        updatedAt: b.updatedAt,
      };
    }

    const { channels: liveChannels, bindings } = this.channelState.snapshot();
    const channels: Record<string, PersistedChannelEntry> = Object.create(
      null
    ) as Record<string, PersistedChannelEntry>;
    for (const [key, entry] of Object.entries(liveChannels)) {
      channels[key] = {
        channelId: entry.channelId,
        cumulativeAmount: entry.cumulativeAmount.toString(),
        nonce: entry.nonce.toString(),
        updatedAt: entry.updatedAt,
      };
    }

    this.store.save({
      version: 1,
      inventory,
      channels,
      bindings,
      seenPacketIds: this.seenPacketIds?.values() ?? [],
    });
  }
}
