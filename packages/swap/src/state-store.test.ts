/**
 * Issue #46 — swap-node state persistence tests.
 *
 * Covers:
 *   - `JsonFileSwapStateStore` atomic save/load roundtrip + corruption policy
 *   - `PersistentSeenPacketIds` bounding + persistence hook semantics
 *   - `SwapStatePersister` snapshot fidelity
 *   - Crash-recovery through `MultiChainClaimIssuer`:
 *       - restart mid-stream → nonce/cumulative continue monotonically
 *       - write-ahead ordering (persist BEFORE sign)
 *       - write-ahead persist failure → claim refused + full rollback
 *       - signer failure → rollback re-persisted
 *       - crash between debit and FULFILL → recoverable (over-reserved) state
 */
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';

import {
  JsonFileSwapStateStore,
  SwapStatePersister,
  SwapStateStoreError,
  PersistentSeenPacketIds,
  validatePersistedState,
} from './state-store.js';
import type { SwapStateStore, PersistedSwapState } from './state-store.js';
import { MultiChainClaimIssuer } from './claim-issuer.js';
import { SwapInventory } from './inventory.js';
import { SwapChannelState } from './channel-state.js';
import { SwapWalletError } from './errors.js';

const SENDER_PUBKEY = 'b'.repeat(64);
const OTHER_SENDER = 'c'.repeat(64);
const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);

const PAIR_USDC_TO_ETH: SwapPair = {
  from: { assetCode: 'USDC', chain: 'evm:base:8453', assetScale: 6 },
  to: { assetCode: 'ETH', chain: 'evm:base:8453', assetScale: 18 },
  rate: '0.0005',
};

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swap-state-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function sampleState(): PersistedSwapState {
  return {
    version: 2,
    inventory: {
      'ETH:evm:base:8453': {
        available: '9007199254740993', // > MAX_SAFE_INTEGER (precision guard)
        total: '9007199254740995',
        unsettled: '18000000000000001',
        windowBudget: '20000000000000000',
        updatedAt: 123,
      },
    },
    channels: {
      'ETH:evm:base:8453:0xchan': {
        channelId: '0xchan',
        cumulativeAmount: '18446744073709551617',
        nonce: '42',
        updatedAt: 456,
      },
    },
    bindings: {
      [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: 'ETH:evm:base:8453:0xchan',
    },
    seenPacketIds: ['pkt-1', 'pkt-2'],
    // Issue #49 — in-flight window reservations + settled watermarks.
    reservations: {
      'rsv-1': {
        key: 'ETH:evm:base:8453',
        amount: '400000000000001',
        expiresAt: 1_800_000_000_000,
      },
    },
    settledWatermarks: {
      'ETH:evm:base:8453:0xchan': '9000000000000000',
    },
  };
}

/** A pre-#49 (v1) snapshot — must remain loadable with defaults. */
function sampleV1State(): Record<string, unknown> {
  const { reservations, settledWatermarks, ...rest } = sampleState();
  void reservations;
  void settledWatermarks;
  const inventory = {
    'ETH:evm:base:8453': {
      available: '9007199254740993',
      total: '9007199254740995',
      updatedAt: 123,
    },
  };
  return { ...rest, inventory, version: 1 };
}

/** Fresh live state + persister wired to a store, for crash-recovery tests. */
function makeLiveSwapNode(
  store: SwapStateStore,
  persisted?: PersistedSwapState | null
) {
  const inventory = new SwapInventory({
    balances: persisted
      ? Object.fromEntries(
          Object.entries(persisted.inventory).map(([k, v]) => [
            k,
            {
              available: BigInt(v.available),
              total: BigInt(v.total),
              updatedAt: v.updatedAt,
            },
          ])
        )
      : { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
  });
  const channelState = new SwapChannelState({
    channels: persisted
      ? Object.fromEntries(
          Object.entries(persisted.channels).map(([k, v]) => [
            k,
            {
              channelId: v.channelId,
              cumulativeAmount: BigInt(v.cumulativeAmount),
              nonce: BigInt(v.nonce),
              updatedAt: v.updatedAt,
            },
          ])
        )
      : {
          'ETH:evm:base:8453:chan-a': {
            channelId: 'chan-a',
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
          'ETH:evm:base:8453:chan-b': {
            channelId: 'chan-b',
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        },
    ...(persisted && { bindings: persisted.bindings }),
  });
  const persister = new SwapStatePersister({ store, inventory, channelState });
  const signer = {
    chain: 'evm:base:8453',
    chainKind: 'evm' as const,
    signBalanceProof: vi.fn(async () => new Uint8Array([0x01])),
  };
  const issuer = new MultiChainClaimIssuer({
    inventory,
    signers: { 'evm:base:8453': signer },
    channelState,
    persistState: () => persister.persist(),
  });
  return { inventory, channelState, persister, signer, issuer };
}

function issueParams(senderPubkey = SENDER_PUBKEY, targetAmount = 50n) {
  return {
    sourceAmount: 100_000n,
    targetAmount,
    pair: PAIR_USDC_TO_ETH,
    senderPubkey,
    chainRecipient: FIXTURE_EVM_RECIPIENT,
    rumor: {
      pubkey: senderPubkey,
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: '',
    },
  };
}

// ---------------------------------------------------------------------------
// JsonFileSwapStateStore
// ---------------------------------------------------------------------------

describe('JsonFileSwapStateStore', () => {
  it('[P0] save → load roundtrips the exact state (bigint-precision safe)', () => {
    const path = join(makeTmpDir(), 'state.json');
    const store = new JsonFileSwapStateStore(path);
    const state = sampleState();
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  it('[P1] load() returns null when no state file exists', () => {
    const store = new JsonFileSwapStateStore(join(makeTmpDir(), 'absent.json'));
    expect(store.load()).toBeNull();
  });

  it('[P1] save() creates missing parent directories and leaves no .tmp behind', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'nested', 'deeper', 'state.json');
    const store = new JsonFileSwapStateStore(path);
    store.save(sampleState());
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('[P0] corrupt JSON fails load() loudly (LOAD_FAILED), never silently resets', () => {
    const path = join(makeTmpDir(), 'state.json');
    writeFileSync(path, '{ this is not json', 'utf-8');
    const store = new JsonFileSwapStateStore(path);
    expect(() => store.load()).toThrowError(SwapStateStoreError);
    try {
      store.load();
    } catch (err) {
      expect((err as SwapStateStoreError).code).toBe('LOAD_FAILED');
    }
  });

  it('[P1] unsupported schema version fails load()', () => {
    const path = join(makeTmpDir(), 'state.json');
    writeFileSync(
      path,
      JSON.stringify({ ...sampleState(), version: 99 }),
      'utf-8'
    );
    const store = new JsonFileSwapStateStore(path);
    expect(() => store.load()).toThrowError(/version/);
  });

  it('[P0] (#49) v1 snapshots load with window fields defaulted (reservations/watermarks empty, unsettled absent)', () => {
    const path = join(makeTmpDir(), 'state.json');
    writeFileSync(path, JSON.stringify(sampleV1State()), 'utf-8');
    const store = new JsonFileSwapStateStore(path);
    const loaded = store.load()!;
    expect(loaded.version).toBe(2);
    expect(loaded.reservations).toEqual({});
    expect(loaded.settledWatermarks).toEqual({});
    expect(loaded.inventory['ETH:evm:base:8453']!.available).toBe(
      '9007199254740993'
    );
    expect(loaded.inventory['ETH:evm:base:8453']!.unsettled).toBeUndefined();
  });

  it('[P1] (#49) malformed reservations / settledWatermarks fail load()', () => {
    const path = join(makeTmpDir(), 'state.json');
    const badAmount = sampleState();
    badAmount.reservations['rsv-1']!.amount = 'not-a-bigint';
    writeFileSync(path, JSON.stringify(badAmount), 'utf-8');
    expect(() => new JsonFileSwapStateStore(path).load()).toThrowError(
      SwapStateStoreError
    );

    const badWm = sampleState();
    (badWm.settledWatermarks as Record<string, unknown>)['k'] = 12;
    writeFileSync(path, JSON.stringify(badWm), 'utf-8');
    expect(() => new JsonFileSwapStateStore(path).load()).toThrowError(
      SwapStateStoreError
    );

    const badExpiry = sampleState();
    (badExpiry.reservations['rsv-1'] as unknown as Record<string, unknown>)[
      'expiresAt'
    ] = 'soon';
    writeFileSync(path, JSON.stringify(badExpiry), 'utf-8');
    expect(() => new JsonFileSwapStateStore(path).load()).toThrowError(
      /expiresAt/
    );
  });

  it('[P1] malformed bigint strings fail load()', () => {
    const path = join(makeTmpDir(), 'state.json');
    const bad = sampleState();
    bad.inventory['ETH:evm:base:8453'].available = 'not-a-bigint';
    writeFileSync(path, JSON.stringify(bad), 'utf-8');
    const store = new JsonFileSwapStateStore(path);
    expect(() => store.load()).toThrowError(SwapStateStoreError);
  });

  it('[P2] prototype-polluting keys are rejected on load', () => {
    expect(() =>
      validatePersistedState({
        ...sampleState(),
        bindings: JSON.parse('{"__proto__": "x"}') as Record<string, string>,
      })
    ).toThrowError(/Unsafe key/);
  });

  it('[P1] save() over an existing snapshot replaces it atomically (last write wins)', () => {
    const path = join(makeTmpDir(), 'state.json');
    const store = new JsonFileSwapStateStore(path);
    store.save(sampleState());
    const next = sampleState();
    next.channels['ETH:evm:base:8453:0xchan'].nonce = '43';
    store.save(next);
    const loaded = store.load()!;
    expect(loaded.channels['ETH:evm:base:8453:0xchan'].nonce).toBe('43');
    // File on disk is a single complete JSON document.
    expect(() => JSON.parse(readFileSync(path, 'utf-8'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PersistentSeenPacketIds
// ---------------------------------------------------------------------------

describe('PersistentSeenPacketIds', () => {
  it('[P1] behaves as a Set-like: has/add/delete/size', () => {
    const set = new PersistentSeenPacketIds();
    expect(set.has('a')).toBe(false);
    set.add('a');
    expect(set.has('a')).toBe(true);
    expect(set.size).toBe(1);
    expect(set.delete('a')).toBe(true);
    expect(set.delete('a')).toBe(false);
    expect(set.size).toBe(0);
  });

  it('[P1] evicts oldest entries beyond the cap (bounded replay window)', () => {
    const set = new PersistentSeenPacketIds([], 3);
    set.add('a').add('b').add('c').add('d');
    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false); // oldest evicted
    expect(set.has('d')).toBe(true);
    expect(set.values()).toEqual(['b', 'c', 'd']);
  });

  it('[P0] onMutate fires synchronously on add and delete, not on duplicate add', () => {
    const set = new PersistentSeenPacketIds();
    const persists: string[][] = [];
    set.setOnMutate(() => persists.push(set.values()));
    set.add('pkt-1');
    set.add('pkt-1'); // duplicate — no persist
    set.delete('pkt-1');
    expect(persists).toEqual([['pkt-1'], []]);
  });

  it('[P1] rehydrates from a persisted list, preserving order', () => {
    const set = new PersistentSeenPacketIds(['x', 'y']);
    expect(set.has('x')).toBe(true);
    expect(set.values()).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// SwapStatePersister — snapshot fidelity
// ---------------------------------------------------------------------------

describe('SwapStatePersister', () => {
  it('[P0] persists live inventory + channel watermarks + bindings + replay set', () => {
    const path = join(makeTmpDir(), 'state.json');
    const store = new JsonFileSwapStateStore(path);
    const { inventory, channelState, persister } = makeLiveSwapNode(store);
    // Drive some state: a reservation binds the sender and advances watermark.
    channelState.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
      cumulativeDelta: 7n,
    });
    inventory.debit('ETH', 'evm:base:8453', 7n);
    const seen = new PersistentSeenPacketIds(['pkt-9']);
    const withSeen = new SwapStatePersister({
      store,
      inventory,
      channelState,
      seenPacketIds: seen,
    });
    withSeen.persist();

    const loaded = store.load()!;
    expect(loaded.inventory['ETH:evm:base:8453'].available).toBe('993');
    expect(loaded.inventory['ETH:evm:base:8453'].total).toBe('1000');
    expect(loaded.channels['ETH:evm:base:8453:chan-a']).toMatchObject({
      channelId: 'chan-a',
      cumulativeAmount: '7',
      nonce: '1',
    });
    expect(loaded.bindings[`ETH:evm:base:8453:${SENDER_PUBKEY}`]).toBe(
      'ETH:evm:base:8453:chan-a'
    );
    expect(loaded.seenPacketIds).toEqual(['pkt-9']);
    expect(persister).toBeDefined();
  });

  it('[P0] (#49) persists in-flight reservations, unsettled liability, and settled watermarks', () => {
    const path = join(makeTmpDir(), 'state.json');
    const store = new JsonFileSwapStateStore(path);
    const { inventory, channelState, persister } = makeLiveSwapNode(store);
    void channelState;

    const a = inventory.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      amount: 5n,
      id: 'rsv-a',
    });
    inventory.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      amount: 3n,
      id: 'rsv-b',
    });
    inventory.commitReservation({
      reservationId: 'rsv-b',
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      amount: 3n,
    });
    inventory.recordSettlement({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      channelId: 'chan-a',
      cumulativeAmount: 1n,
    });
    persister.persist();

    const loaded = store.load()!;
    expect(loaded.inventory['ETH:evm:base:8453']!.unsettled).toBe('2');
    expect(loaded.reservations).toEqual({
      'rsv-a': {
        key: 'ETH:evm:base:8453',
        amount: '5',
        expiresAt: a.expiresAt,
      },
    });
    expect(loaded.settledWatermarks).toEqual({
      'ETH:evm:base:8453:chan-a': '1',
    });
  });
});

// ---------------------------------------------------------------------------
// SwapChannelState — binding rehydration
// ---------------------------------------------------------------------------

describe('SwapChannelState binding rehydration', () => {
  it('[P0] restored bindings keep a sender pinned to its pre-restart channel', () => {
    const channels = {
      'ETH:evm:base:8453:chan-a': {
        channelId: 'chan-a',
        cumulativeAmount: 100n,
        nonce: 3n,
        updatedAt: 1,
      },
      'ETH:evm:base:8453:chan-b': {
        channelId: 'chan-b',
        cumulativeAmount: 0n,
        nonce: 0n,
        updatedAt: 1,
      },
    };
    // Pre-restart, the sender was bound to chan-b (NOT the first-scanned one).
    const restored = new SwapChannelState({
      channels,
      bindings: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: 'ETH:evm:base:8453:chan-b',
      },
    });
    const r = restored.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
      cumulativeDelta: 5n,
    });
    expect(r.channelId).toBe('chan-b');
    expect(r.nonce).toBe(1n);
    // A NEW sender cannot steal the restored-bound channel.
    const r2 = restored.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: OTHER_SENDER,
      cumulativeDelta: 5n,
    });
    expect(r2.channelId).toBe('chan-a');
  });

  it('[P2] dangling bindings (channel key absent) are dropped on rehydration', () => {
    const state = new SwapChannelState({
      channels: {
        'ETH:evm:base:8453:chan-a': {
          channelId: 'chan-a',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
      bindings: {
        [`ETH:evm:base:8453:${SENDER_PUBKEY}`]: 'ETH:evm:base:8453:GONE',
      },
    });
    // Sender re-binds to an available channel instead of failing forever.
    const r = state.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
      cumulativeDelta: 1n,
    });
    expect(r.channelId).toBe('chan-a');
  });

  it('[P1] snapshot() → constructor roundtrip reproduces watermarks + bindings', () => {
    const state = new SwapChannelState({
      channels: {
        'ETH:evm:base:8453:chan-a': {
          channelId: 'chan-a',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    state.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
      cumulativeDelta: 9n,
    });
    const snap = state.snapshot();
    const clone = new SwapChannelState({
      channels: snap.channels,
      bindings: snap.bindings,
    });
    expect(clone.snapshot()).toEqual(snap);
    const r = clone.reserve({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
      cumulativeDelta: 1n,
    });
    expect(r.nonce).toBe(2n);
    expect(r.cumulativeAmount).toBe(10n);
  });
});

// ---------------------------------------------------------------------------
// Crash-recovery through the claim issuer
// ---------------------------------------------------------------------------

describe('issue #46 — crash recovery through MultiChainClaimIssuer', () => {
  it('[P0] restart mid-stream: nonce/cumulative continue monotonically from the persisted watermark', async () => {
    const path = join(makeTmpDir(), 'state.json');
    const store = new JsonFileSwapStateStore(path);

    // Boot 1: issue two claims, then "crash" (drop all in-memory objects).
    const boot1 = makeLiveSwapNode(store);
    const c1 = await boot1.issuer.issueClaim(issueParams(SENDER_PUBKEY, 50n));
    const c2 = await boot1.issuer.issueClaim(issueParams(SENDER_PUBKEY, 30n));
    expect(c1.claim).toBeInstanceOf(Uint8Array);
    expect(c2.claim).toBeInstanceOf(Uint8Array);
    const preCrash = boot1.channelState.get({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(preCrash.nonce).toBe(2n);
    expect(preCrash.cumulativeAmount).toBe(80n);

    // Boot 2: rehydrate purely from the persisted snapshot.
    const boot2 = makeLiveSwapNode(store, store.load());
    const r3 = await boot2.issuer.issueClaim(issueParams(SENDER_PUBKEY, 20n));
    expect(r3.claim).toBeInstanceOf(Uint8Array);
    const post = boot2.channelState.get({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
    })!;
    // No watermark reset: continues 2n → 3n, 80n → 100n.
    expect(post.nonce).toBe(3n);
    expect(post.cumulativeAmount).toBe(100n);
    // Sticky binding survived: same channel as before the crash.
    expect(post.channelId).toBe(preCrash.channelId);
    // Inventory survived the restart too: 1000 - 50 - 30 - 20.
    expect(boot2.inventory.get('ETH', 'evm:base:8453')!.available).toBe(900n);
  });

  it('[P0] write-ahead ordering: watermark is persisted BEFORE the balance proof is signed', async () => {
    const order: string[] = [];
    const store: SwapStateStore = {
      load: () => null,
      save: () => {
        order.push('persist');
      },
    };
    const swapNode = makeLiveSwapNode(store);
    swapNode.signer.signBalanceProof.mockImplementation(async () => {
      order.push('sign');
      return new Uint8Array([0x01]);
    });
    await swapNode.issuer.issueClaim(issueParams());
    expect(order).toEqual(['persist', 'sign']);
  });

  it('[P0] write-ahead persist failure: claim refused (PERSISTENCE_FAILED) and debit+reservation rolled back', async () => {
    const store: SwapStateStore = {
      load: () => null,
      save: () => {
        throw new Error('disk full');
      },
    };
    const swapNode = makeLiveSwapNode(store);
    await expect(
      swapNode.issuer.issueClaim(issueParams())
    ).rejects.toMatchObject({
      name: 'SwapWalletError',
      code: 'PERSISTENCE_FAILED',
    });
    // Nothing was handed out, so state must be fully reversed.
    expect(swapNode.signer.signBalanceProof).not.toHaveBeenCalled();
    expect(swapNode.inventory.get('ETH', 'evm:base:8453')!.available).toBe(
      1_000n
    );
    const entry = swapNode.channelState.get({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(0n);
    expect(entry.cumulativeAmount).toBe(0n);
  });

  it('[P0] signer failure: rollback is re-persisted (disk matches the reversed state)', async () => {
    const path = join(makeTmpDir(), 'state.json');
    const store = new JsonFileSwapStateStore(path);
    const swapNode = makeLiveSwapNode(store);
    swapNode.signer.signBalanceProof.mockRejectedValueOnce(
      new Error('hsm down')
    );
    await expect(
      swapNode.issuer.issueClaim(issueParams())
    ).rejects.toBeInstanceOf(SwapWalletError);
    const loaded = store.load()!;
    expect(loaded.inventory['ETH:evm:base:8453'].available).toBe('1000');
    expect(loaded.channels['ETH:evm:base:8453:chan-a'].nonce).toBe('0');
    expect(loaded.channels['ETH:evm:base:8453:chan-a'].cumulativeAmount).toBe(
      '0'
    );
  });

  it('[P0] crash between debit and FULFILL: restored state is over-reserved (never behind a handed-out claim) and stays monotone', async () => {
    const path = join(makeTmpDir(), 'state.json');
    const realStore = new JsonFileSwapStateStore(path);
    // Store wrapper that fails every save AFTER the first (the write-ahead
    // succeeds; the rollback persist fails → simulates a crash after the
    // reservation hit disk but before FULFILL/rollback could be recorded).
    let saves = 0;
    const store: SwapStateStore = {
      load: () => realStore.load(),
      save: (s) => {
        saves += 1;
        if (saves > 1) throw new Error('crashed');
        realStore.save(s);
      },
    };
    const swapNode = makeLiveSwapNode(store);
    swapNode.signer.signBalanceProof.mockRejectedValueOnce(
      new Error('process died mid-sign')
    );
    await expect(
      swapNode.issuer.issueClaim(issueParams())
    ).rejects.toBeInstanceOf(SwapWalletError);

    // Disk kept the write-ahead (over-reserved) snapshot: nonce 1, debit 50 —
    // ahead of any claim a counterparty could hold (none was delivered).
    const persisted = realStore.load()!;
    expect(persisted.channels['ETH:evm:base:8453:chan-a'].nonce).toBe('1');
    expect(persisted.inventory['ETH:evm:base:8453'].available).toBe('950');

    // Recovery: reboot from that snapshot; the next claim continues ABOVE the
    // aborted reservation — monotone, no possible watermark regression.
    const boot2 = makeLiveSwapNode(realStore, realStore.load());
    const r = await boot2.issuer.issueClaim(issueParams(SENDER_PUBKEY, 10n));
    expect(r.claim).toBeInstanceOf(Uint8Array);
    const entry = boot2.channelState.get({
      assetCode: 'ETH',
      chain: 'evm:base:8453',
      senderPubkey: SENDER_PUBKEY,
    })!;
    expect(entry.nonce).toBe(2n);
    expect(entry.cumulativeAmount).toBe(60n);
  });

  it('[P1] without a persistState hook the issuer behaves exactly as before (no persistence calls)', async () => {
    const inventory = new SwapInventory({
      balances: { 'ETH:evm:base:8453': { available: 1_000n, total: 1_000n } },
    });
    const channelState = new SwapChannelState({
      channels: {
        'ETH:evm:base:8453:chan-a': {
          channelId: 'chan-a',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      },
    });
    const issuer = new MultiChainClaimIssuer({
      inventory,
      signers: {
        'evm:base:8453': {
          chain: 'evm:base:8453',
          chainKind: 'evm' as const,
          signBalanceProof: vi.fn(async () => new Uint8Array([0x01])),
        },
      },
      channelState,
    });
    const result = await issuer.issueClaim(issueParams());
    expect(result.claim).toBeInstanceOf(Uint8Array);
  });
});
