/**
 * Issue #171 — durable intake ledger tests.
 *
 * Covers:
 *   - `JsonFileIntakeLedgerStore` atomic save/load roundtrip
 *   - tolerant load: missing/corrupt/invalid file starts empty, never throws
 *   - `IntakeLedger` counting, `since` semantics, and best-effort persist
 */
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import {
  JsonFileIntakeLedgerStore,
  IntakeLedger,
  validatePersistedIntakeLedger,
} from './intake-ledger.js';
import type {
  IntakeLedgerStore,
  PersistedIntakeLedger,
} from './intake-ledger.js';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swap-intake-ledger-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('JsonFileIntakeLedgerStore', () => {
  it('[P0] save → load roundtrips the exact state', () => {
    const dir = makeTmpDir();
    const store = new JsonFileIntakeLedgerStore(
      join(dir, 'intake-ledger.json')
    );
    const state: PersistedIntakeLedger = {
      version: 1,
      since: 1000,
      classes: {
        legacy: { count: 3, firstSeenAt: 1000, lastSeenAt: 5000 },
        'rolling-rfq': { count: 1, firstSeenAt: 2000, lastSeenAt: 2000 },
      },
    };
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  it('[P1] load() returns null when no file exists', () => {
    const dir = makeTmpDir();
    const store = new JsonFileIntakeLedgerStore(join(dir, 'nope.json'));
    expect(store.load()).toBeNull();
  });

  it('[P0] corrupt JSON starts empty (load() returns null), never throws', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'intake-ledger.json');
    writeFileSync(path, '{ not json', 'utf-8');
    const store = new JsonFileIntakeLedgerStore(path);
    expect(store.load()).toBeNull();
  });

  it('[P0] a file with an unknown class returns null (start empty) rather than throwing', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'intake-ledger.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        since: 1,
        classes: { bogus: { count: 1, firstSeenAt: 1, lastSeenAt: 1 } },
      }),
      'utf-8'
    );
    const store = new JsonFileIntakeLedgerStore(path);
    expect(store.load()).toBeNull();
  });

  it('[P1] save() creates missing parent directories and leaves no .tmp behind', () => {
    const dir = makeTmpDir();
    const nested = join(dir, 'a', 'b', 'intake-ledger.json');
    const store = new JsonFileIntakeLedgerStore(nested);
    store.save({ version: 1, since: 1, classes: {} });
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(`${nested}.tmp`)).toBe(false);
  });

  it('[P1] save() over an existing snapshot replaces it atomically (last write wins)', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'intake-ledger.json');
    const store = new JsonFileIntakeLedgerStore(path);
    store.save({ version: 1, since: 1, classes: {} });
    store.save({
      version: 1,
      since: 1,
      classes: { legacy: { count: 1, firstSeenAt: 5, lastSeenAt: 5 } },
    });
    expect(store.load()).toEqual({
      version: 1,
      since: 1,
      classes: { legacy: { count: 1, firstSeenAt: 5, lastSeenAt: 5 } },
    });
  });
});

describe('validatePersistedIntakeLedger', () => {
  it('[P2] rejects a non-object, an unsupported version, and a non-finite since', () => {
    expect(() => validatePersistedIntakeLedger(null)).toThrow();
    expect(() =>
      validatePersistedIntakeLedger({ version: 2, since: 1, classes: {} })
    ).toThrow();
    expect(() =>
      validatePersistedIntakeLedger({ version: 1, since: 'nope', classes: {} })
    ).toThrow();
  });
});

describe('IntakeLedger', () => {
  it('[P0] first record() sets both firstSeenAt and lastSeenAt; subsequent records advance only lastSeenAt', () => {
    const ledger = new IntakeLedger();
    ledger.record('legacy', 100);
    ledger.record('legacy', 200);
    ledger.record('legacy', 300);
    const snap = ledger.snapshot();
    expect(snap.classes['legacy']).toEqual({
      count: 3,
      firstSeenAt: 100,
      lastSeenAt: 300,
    });
  });

  it('[P0] classes are independent — recording one class never touches another', () => {
    const ledger = new IntakeLedger();
    ledger.record('legacy', 100);
    ledger.record('rolling-rfq', 200);
    const snap = ledger.snapshot();
    expect(snap.classes['legacy']).toEqual({
      count: 1,
      firstSeenAt: 100,
      lastSeenAt: 100,
    });
    expect(snap.classes['rolling-rfq']).toEqual({
      count: 1,
      firstSeenAt: 200,
      lastSeenAt: 200,
    });
    expect(snap.classes['rolling-fill']).toBeUndefined();
    expect(snap.classes['refused']).toBeUndefined();
  });

  it('[P0] `since` defaults to the clock at construction when nothing is persisted', () => {
    const ledger = new IntakeLedger({ clock: () => 42_000 });
    expect(ledger.snapshot().since).toBe(42_000);
  });

  it('[P0] `since` carries forward from a persisted ledger, even across a class that has never fired', () => {
    const dir = makeTmpDir();
    const store = new JsonFileIntakeLedgerStore(
      join(dir, 'intake-ledger.json')
    );
    store.save({ version: 1, since: 1_000, classes: {} });

    const ledger = new IntakeLedger({ store, clock: () => 999_999 });
    expect(ledger.snapshot().since).toBe(1_000);
    expect(ledger.snapshot().classes['legacy']).toBeUndefined();
  });

  it('[P0] restart rehydrates counts, and `since` never regresses — a fresh boot does not reset the observation window', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'intake-ledger.json');

    const first = new IntakeLedger({
      store: new JsonFileIntakeLedgerStore(path),
      clock: () => 1_000,
    });
    first.record('legacy', 1_000);
    first.record('legacy', 2_000);

    // Simulate a Watchtower recreate: fresh process, same durable path.
    const second = new IntakeLedger({
      store: new JsonFileIntakeLedgerStore(path),
      clock: () => 50_000,
    });
    expect(second.snapshot()).toEqual({
      version: 1,
      since: 1_000,
      classes: { legacy: { count: 2, firstSeenAt: 1_000, lastSeenAt: 2_000 } },
    });

    second.record('legacy', 60_000);
    expect(second.snapshot().classes['legacy']).toEqual({
      count: 3,
      firstSeenAt: 1_000,
      lastSeenAt: 60_000,
    });
  });

  it('[P0] a save() failure is caught and dropped — record() never throws', () => {
    const failing: IntakeLedgerStore = {
      load: () => null,
      save: () => {
        throw new Error('disk full');
      },
    };
    const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
    const ledger = new IntakeLedger({
      store: failing,
      logger: { warn: (message, meta) => warnings.push({ message, meta }) },
    });
    expect(() => ledger.record('legacy', 1)).not.toThrow();
    expect(ledger.snapshot().classes['legacy']).toEqual({
      count: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('swap.intake.ledger_persist_failed');
  });

  it('[P1] a load() failure at construction is caught and dropped — starts empty', () => {
    const failing: IntakeLedgerStore = {
      load: () => {
        throw new Error('permission denied');
      },
      save: () => undefined,
    };
    const warnings: string[] = [];
    const ledger = new IntakeLedger({
      store: failing,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(ledger.snapshot().classes).toEqual({});
    expect(warnings).toContain('swap.intake.ledger_load_failed');
  });

  it('[P2] without a store, counts still accumulate in-memory (no persistence, no crash)', () => {
    const ledger = new IntakeLedger();
    ledger.record('refused', 1);
    ledger.record('refused', 2);
    expect(ledger.snapshot().classes['refused']).toEqual({
      count: 2,
      firstSeenAt: 1,
      lastSeenAt: 2,
    });
  });
});
