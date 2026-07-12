/**
 * Issue #46 — `startSwapNode()` persistence wiring tests.
 *
 * Scenarios:
 *   - boot with `statePath` writes an initial snapshot (fail-fast writability)
 *   - restart rehydrates persisted inventory/watermarks; `GET /health`
 *     reflects the rehydrated values, not the config notionals
 *   - persisted channel entries absent from config are restored
 *   - corrupt state file fails boot loudly (STATE_LOAD_FAILED)
 *   - statePath + stateStore together is INVALID_CONFIG
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { startSwapNode, validateConfig } from './swap-node.js';
import type { SwapNodeConfig } from './swap-node.js';
import { JsonFileSwapStateStore } from './state-store.js';
import { SwapNodeStartError } from './errors.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fakeConnector() {
  return {
    close: async () => undefined,
    send: async () => ({ ok: true }),
  };
}

function validConfig(statePath: string): SwapNodeConfig {
  return {
    mnemonic: VALID_MNEMONIC,
    connector: fakeConnector() as unknown as SwapNodeConfig['connector'],
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        rate: '1.0',
      },
    ],
    chains: ['evm'],
    channels: {
      'evm:8453': [
        { channelId: 'c-1', cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 },
      ],
    },
    inventory: { 'evm:8453': 1_000_000n },
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    statePath,
  };
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swap node-boot-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('issue #46 — startSwapNode state persistence', () => {
  it('[P0] boot writes an initial snapshot merging config state', async () => {
    const statePath = join(makeTmpDir(), 'swap-state.json');
    const instance = await startSwapNode(validConfig(statePath));
    try {
      expect(existsSync(statePath)).toBe(true);
      const snap = new JsonFileSwapStateStore(statePath).load()!;
      expect(snap.inventory['USDC:evm:8453'].available).toBe('1000000');
      expect(snap.channels['USDC:evm:8453:c-1'].nonce).toBe('0');
    } finally {
      await instance.stop();
    }
  });

  it('[P0] restart rehydrates persisted state; /health reflects rehydrated inventory (not config)', async () => {
    const statePath = join(makeTmpDir(), 'swap-state.json');

    // Simulate a previous run that spent inventory and advanced watermarks
    // (including a channel that was provisioned dynamically, absent from
    // config) before crashing.
    new JsonFileSwapStateStore(statePath).save({
      version: 1,
      inventory: {
        'USDC:evm:8453': {
          available: '250000',
          total: '1000000',
          updatedAt: 111,
        },
      },
      channels: {
        'USDC:evm:8453:c-1': {
          channelId: 'c-1',
          cumulativeAmount: '750000',
          nonce: '17',
          updatedAt: 111,
        },
        'USDC:evm:8453:c-dynamic': {
          channelId: 'c-dynamic',
          cumulativeAmount: '5',
          nonce: '2',
          updatedAt: 111,
        },
      },
      bindings: {},
      seenPacketIds: ['pkt-replayed'],
    });

    const instance = await startSwapNode(validConfig(statePath));
    try {
      const res = await fetch(`http://127.0.0.1:${instance.blsPort}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        inventory: Record<string, string>;
        inventoryAvailable: Record<string, string>;
      };
      // Persisted values win over the config notional (1000000/1000000).
      expect(body.inventoryAvailable['USDC:evm:8453']).toBe('250000');
      expect(body.inventory['USDC:evm:8453']).toBe('1000000');

      // The boot snapshot must retain the rehydrated watermarks — including
      // the dynamically-provisioned channel not present in config — and the
      // replay reservations.
      const snap = new JsonFileSwapStateStore(statePath).load()!;
      expect(snap.channels['USDC:evm:8453:c-1'].nonce).toBe('17');
      expect(snap.channels['USDC:evm:8453:c-1'].cumulativeAmount).toBe(
        '750000'
      );
      expect(snap.channels['USDC:evm:8453:c-dynamic'].nonce).toBe('2');
      expect(snap.seenPacketIds).toEqual(['pkt-replayed']);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] stop() does not clobber persisted watermarks (no persist of releaseAll zeros)', async () => {
    const statePath = join(makeTmpDir(), 'swap-state.json');
    new JsonFileSwapStateStore(statePath).save({
      version: 1,
      inventory: {},
      channels: {
        'USDC:evm:8453:c-1': {
          channelId: 'c-1',
          cumulativeAmount: '99',
          nonce: '9',
          updatedAt: 1,
        },
      },
      bindings: {},
      seenPacketIds: [],
    });
    const instance = await startSwapNode(validConfig(statePath));
    await instance.stop();
    const snap = new JsonFileSwapStateStore(statePath).load()!;
    // Watermark survives a clean stop — releaseAll() zeros memory only.
    expect(snap.channels['USDC:evm:8453:c-1'].nonce).toBe('9');
    expect(snap.channels['USDC:evm:8453:c-1'].cumulativeAmount).toBe('99');
  });

  it('[P0] corrupt state file fails boot with STATE_LOAD_FAILED (no silent watermark reset)', async () => {
    const statePath = join(makeTmpDir(), 'swap-state.json');
    writeFileSync(statePath, 'not json at all', 'utf-8');
    await expect(startSwapNode(validConfig(statePath))).rejects.toMatchObject({
      name: 'SwapNodeStartError',
      code: 'STATE_LOAD_FAILED',
    });
  });

  it('[P1] statePath + stateStore together is INVALID_CONFIG', () => {
    const cfg = validConfig(join(makeTmpDir(), 's.json'));
    cfg.stateStore = { load: () => null, save: () => undefined };
    expect(() => validateConfig(cfg)).toThrowError(SwapNodeStartError);
    try {
      validateConfig(cfg);
    } catch (err) {
      expect((err as SwapNodeStartError).code).toBe('INVALID_CONFIG');
    }
  });

  it('[P2] empty statePath is INVALID_CONFIG', () => {
    const cfg = validConfig('x');
    cfg.statePath = '';
    expect(() => validateConfig(cfg)).toThrowError(/statePath/);
  });

  it('[P1] without statePath/stateStore, no snapshot file is written (legacy in-memory mode)', async () => {
    const dir = makeTmpDir();
    const cfg = validConfig(join(dir, 'unused.json'));
    delete cfg.statePath;
    const instance = await startSwapNode(cfg);
    try {
      expect(existsSync(join(dir, 'unused.json'))).toBe(false);
    } finally {
      await instance.stop();
    }
  });
});
