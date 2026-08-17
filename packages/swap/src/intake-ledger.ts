/**
 * Durable intake ledger — ADR 0003's removal gate, issue #171.
 *
 * swap#152 made every arrival classifiable (`swap.intake.arrival`, one line
 * per packet), but the gate that reads it — "no legacy intake observed for N
 * consecutive days" — cannot survive to N days from a log line alone:
 * `swap:release` is auto-on-green, Watchtower recreates the container on
 * every merge, and `docker logs` only ever holds the CURRENT container's
 * stdout. Every recreate resets the observation window to zero.
 *
 * This module turns the reading into a watermark instead of a log-retention
 * accident: a small per-class ledger (count / firstSeenAt / lastSeenAt),
 * persisted on the same durable state volume the maker's inventory and
 * channel watermarks already survive Watchtower recreates on. Exposed
 * read-only at `GET /admin/intake` (`admin-surface.ts`).
 *
 * Deliberately NOT the crash-loud discipline of `JsonFileSwapStateStore`
 * (state-store.ts): a corrupt or missing ledger file is observability
 * evidence, not a crash-consistency watermark whose loss risks a double
 * spend, so `JsonFileIntakeLedgerStore.load()` starts empty rather than
 * throwing, and `IntakeLedger.record()` never lets a persist failure
 * propagate — counting must never be able to fail an arrival.
 *
 * `since` is the ledger's own start time (first boot with no persisted
 * file), carried forward across every subsequent restart even for classes
 * that have never fired. Without it, a fresh ledger's "0 legacy, ever"
 * reads identically to "legacy has been silent for 90 days" — the same
 * false-green issue #171 exists to close.
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

import { SWAP_INTAKE_CLASSES } from './intake-event.js';
import type { SwapIntakeClass } from './intake-event.js';

export interface IntakeLedgerClassEntry {
  count: number;
  /** ms-epoch of this class's first-ever recorded arrival. */
  firstSeenAt: number;
  /** ms-epoch of this class's most recent recorded arrival. */
  lastSeenAt: number;
}

export interface PersistedIntakeLedger {
  version: 1;
  /** ms-epoch this ledger started observing (never regresses across restarts). */
  since: number;
  classes: Partial<Record<SwapIntakeClass, IntakeLedgerClassEntry>>;
}

/** Storage abstraction, mirroring `SwapStateStore` (state-store.ts). */
export interface IntakeLedgerStore {
  /** Returns `null` when nothing has ever been persisted OR the file is unreadable. */
  load(): PersistedIntakeLedger | null;
  save(state: PersistedIntakeLedger): void;
}

function isIntakeClass(v: unknown): v is SwapIntakeClass {
  return (
    typeof v === 'string' &&
    (SWAP_INTAKE_CLASSES as readonly string[]).includes(v)
  );
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @internal — exported for direct testing of the validation surface. */
export function validatePersistedIntakeLedger(
  raw: unknown
): PersistedIntakeLedger {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('intake ledger state must be a JSON object');
  }
  const rec = raw as Record<string, unknown>;
  if (rec['version'] !== 1) {
    throw new Error(
      `unsupported intake ledger schema version ${JSON.stringify(rec['version'])} (expected 1)`
    );
  }
  if (!isFiniteNumber(rec['since'])) {
    throw new Error('intake ledger state.since must be a finite number');
  }
  const classesRaw = rec['classes'];
  if (
    typeof classesRaw !== 'object' ||
    classesRaw === null ||
    Array.isArray(classesRaw)
  ) {
    throw new Error('intake ledger state.classes must be an object');
  }
  const classes: Partial<Record<SwapIntakeClass, IntakeLedgerClassEntry>> = {};
  for (const [k, v] of Object.entries(classesRaw as Record<string, unknown>)) {
    if (!isIntakeClass(k)) {
      throw new Error(`intake ledger state.classes has unknown class "${k}"`);
    }
    const entry = v as Record<string, unknown>;
    if (!isFiniteNumber(entry?.['count']) || entry['count'] < 0) {
      throw new Error(
        `intake ledger state.classes["${k}"].count must be a non-negative number`
      );
    }
    if (!isFiniteNumber(entry?.['firstSeenAt'])) {
      throw new Error(
        `intake ledger state.classes["${k}"].firstSeenAt must be a finite number`
      );
    }
    if (!isFiniteNumber(entry?.['lastSeenAt'])) {
      throw new Error(
        `intake ledger state.classes["${k}"].lastSeenAt must be a finite number`
      );
    }
    classes[k] = {
      count: entry['count'] as number,
      firstSeenAt: entry['firstSeenAt'] as number,
      lastSeenAt: entry['lastSeenAt'] as number,
    };
  }
  return { version: 1, since: rec['since'] as number, classes };
}

/**
 * File-backed {@link IntakeLedgerStore}. Same atomic-rename durability as
 * `JsonFileSwapStateStore` (write `<path>.tmp`, `fsync`, `rename`), but with
 * a tolerant load: a missing or corrupt file returns `null` (start empty)
 * rather than throwing — this ledger is evidence, not a crash-consistency
 * watermark, and must never be able to block boot or a swap.
 */
export class JsonFileIntakeLedgerStore implements IntakeLedgerStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error(
        'JsonFileIntakeLedgerStore requires a non-empty file path'
      );
    }
    this.filePath = filePath;
  }

  load(): PersistedIntakeLedger | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return validatePersistedIntakeLedger(raw);
    } catch {
      // Corrupt/unreadable/invalid — start empty rather than crash the
      // maker (issue #171): this is observability evidence, not a
      // crash-consistency watermark.
      return null;
    }
  }

  save(state: PersistedIntakeLedger): void {
    const tmpPath = `${this.filePath}.tmp`;
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
  }
}

export interface IntakeLedgerInit {
  /** Omitted → in-memory only; counts still accumulate but reset on restart. */
  store?: IntakeLedgerStore;
  clock?: () => number;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * In-memory ledger, optionally backed by an {@link IntakeLedgerStore}.
 * `record()` never throws — a write failure is logged and dropped so
 * counting can never fail an arrival (issue #171 constraint).
 */
export class IntakeLedger {
  private readonly store?: IntakeLedgerStore;
  private readonly clock: () => number;
  private readonly logger?: IntakeLedgerInit['logger'];
  private readonly since: number;
  private readonly classes: Partial<
    Record<SwapIntakeClass, IntakeLedgerClassEntry>
  >;

  constructor(init: IntakeLedgerInit = {}) {
    this.store = init.store;
    this.clock = init.clock ?? Date.now;
    this.logger = init.logger;

    let persisted: PersistedIntakeLedger | null = null;
    if (this.store) {
      try {
        persisted = this.store.load();
      } catch (err) {
        this.logger?.warn?.('swap.intake.ledger_load_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        persisted = null;
      }
    }
    this.since = persisted?.since ?? this.clock();
    this.classes = persisted ? { ...persisted.classes } : {};
  }

  /** Update this class's counters and best-effort persist the new snapshot. */
  record(intakeClass: SwapIntakeClass, at: number = this.clock()): void {
    const existing = this.classes[intakeClass];
    this.classes[intakeClass] = existing
      ? {
          count: existing.count + 1,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: at,
        }
      : { count: 1, firstSeenAt: at, lastSeenAt: at };

    if (!this.store) return;
    try {
      this.store.save(this.snapshot());
    } catch (err) {
      this.logger?.warn?.('swap.intake.ledger_persist_failed', {
        class: intakeClass,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  snapshot(): PersistedIntakeLedger {
    return { version: 1, since: this.since, classes: { ...this.classes } };
  }
}
