/**
 * Tests for Mill `/health` endpoint (AC-8 original + AC-1 Story 21.11 extension).
 *
 * Scenarios:
 *   - `/health` returns JSON body matching MillHealthResponse shape.
 *   - status transitions: starting → ok → stopping → stopped.
 *   - bigint inventory serialized as decimal strings (MAX_SAFE_INTEGER guard).
 *   - swapPairs field matches input config (AC-1).
 *   - inventoryAvailable mirrors available reserves (AC-1).
 *   - single-asset-per-chain chain-only key emitted for both inventory and
 *     inventoryAvailable (AC-1).
 *   - multi-asset-per-chain: no chain-only key to avoid silent overwrite (AC-1).
 */

import { describe, it, expect } from 'vitest';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fakeConnector() {
  return {
    close: async () => undefined,
    send: async () => ({ ok: true }),
  };
}

function validConfig() {
  return {
    mnemonic: VALID_MNEMONIC,
    connector: fakeConnector(),
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
    inventory: { 'evm:8453': 9_007_199_254_740_993n }, // > MAX_SAFE_INTEGER
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
  };
}

/**
 * Config with two swap pairs both targeting different assets on the same EVM
 * chain. Produces two MillInventory entries for evm:8453 (USDC + ETH), so
 * the chain-only convenience key must NOT be emitted (would be ambiguous).
 */
function multiAssetConfig() {
  return {
    mnemonic: VALID_MNEMONIC,
    connector: fakeConnector(),
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:1' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        rate: '1.0',
      },
      {
        from: { assetCode: 'ETH', assetScale: 18, chain: 'evm:1' },
        to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:8453' },
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
  };
}

describe('AC-8 /health endpoint', () => {
  it('[P1] GET /health returns status:"ok" with correct MillHealthResponse shape', async () => {
    const { startMill } = (await import('./mill.js')) as {
      startMill: (c: unknown) => Promise<{
        blsPort: number;
        stop: () => Promise<void>;
      }>;
    };
    const instance = await startMill(validConfig());
    try {
      const res = await fetch(`http://127.0.0.1:${instance.blsPort}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        version: string;
        nodePubkey: string;
        swapPairsCount: number;
        chains: string[];
        uptimeSec: number;
        inventory: Record<string, string>;
        swapPairs: unknown[];
        inventoryAvailable: Record<string, string>;
      };
      expect(body.status).toBe('ok');
      expect(body.nodePubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.swapPairsCount).toBe(1);
      expect(body.chains).toEqual(['evm']);
      expect(typeof body.uptimeSec).toBe('number');
      // AC-1: new fields present
      expect(Array.isArray(body.swapPairs)).toBe(true);
      expect(body.swapPairs).toHaveLength(1);
      expect(body.inventoryAvailable).toBeDefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P1] inventory bigints are serialized as decimal strings (MAX_SAFE_INTEGER guard)', async () => {
    const { startMill } = (await import('./mill.js')) as {
      startMill: (c: unknown) => Promise<{
        blsPort: number;
        stop: () => Promise<void>;
      }>;
    };
    const instance = await startMill(validConfig());
    try {
      const res = await fetch(`http://127.0.0.1:${instance.blsPort}/health`);
      const body = (await res.json()) as { inventory: Record<string, string> };
      // String, NOT number (would lose precision past 2^53).
      expect(typeof body.inventory['evm:8453']).toBe('string');
      expect(body.inventory['evm:8453']).toBe('9007199254740993');
    } finally {
      await instance.stop();
    }
  });

  it('[P2] after stop(), health() reports status:"stopped"', async () => {
    const { startMill } = (await import('./mill.js')) as {
      startMill: (c: unknown) => Promise<{
        stop: () => Promise<void>;
        health: () => { status: string };
      }>;
    };
    const instance = await startMill(validConfig());
    await instance.stop();
    expect(instance.health().status).toBe('stopped');
  });
});

describe('AC-1 swapPairs field in /health', () => {
  it('[P1] swapPairs field matches input config shape', async () => {
    const { startMill } = (await import('./mill.js')) as {
      startMill: (c: unknown) => Promise<{
        blsPort: number;
        stop: () => Promise<void>;
      }>;
    };
    const cfg = validConfig();
    const instance = await startMill(cfg);
    try {
      const res = await fetch(`http://127.0.0.1:${instance.blsPort}/health`);
      const body = (await res.json()) as {
        swapPairs: {
          from: { assetCode: string; chain: string };
          to: { assetCode: string; chain: string };
          rate: string;
        }[];
      };
      expect(body.swapPairs).toHaveLength(1);
      expect(body.swapPairs[0].from.assetCode).toBe('USDC');
      expect(body.swapPairs[0].from.chain).toBe('evm:8453');
      expect(body.swapPairs[0].rate).toBe('1.0');
    } finally {
      await instance.stop();
    }
  });
});

describe('AC-1 inventoryAvailable field in /health', () => {
  it('[P1] single-asset-per-chain: emits assetCode:chain key + chain-only key', async () => {
    const { startMill } = (await import('./mill.js')) as {
      startMill: (c: unknown) => Promise<{
        blsPort: number;
        stop: () => Promise<void>;
      }>;
    };
    const instance = await startMill(validConfig());
    try {
      const res = await fetch(`http://127.0.0.1:${instance.blsPort}/health`);
      const body = (await res.json()) as {
        inventoryAvailable: Record<string, string>;
      };
      // assetCode:chain key
      expect(typeof body.inventoryAvailable['USDC:evm:8453']).toBe('string');
      // chain-only convenience key (single asset on this chain)
      expect(typeof body.inventoryAvailable['evm:8453']).toBe('string');
      // value is string-encoded bigint
      expect(body.inventoryAvailable['USDC:evm:8453']).toBe('9007199254740993');
    } finally {
      await instance.stop();
    }
  });

  it('[P1] multi-asset-per-chain: emits only assetCode:chain keys, no chain-only key', async () => {
    const { startMill } = (await import('./mill.js')) as {
      startMill: (c: unknown) => Promise<{
        blsPort: number;
        stop: () => Promise<void>;
      }>;
    };
    const instance = await startMill(multiAssetConfig());
    try {
      const res = await fetch(`http://127.0.0.1:${instance.blsPort}/health`);
      const body = (await res.json()) as {
        inventoryAvailable: Record<string, string>;
        inventory: Record<string, string>;
      };
      // Both assets get their own key
      expect(typeof body.inventoryAvailable['USDC:evm:8453']).toBe('string');
      expect(typeof body.inventoryAvailable['ETH:evm:8453']).toBe('string');
      // chain-only key must NOT be emitted when multiple assets share the chain
      expect(body.inventoryAvailable['evm:8453']).toBeUndefined();
      expect(body.inventory['evm:8453']).toBeUndefined();
    } finally {
      await instance.stop();
    }
  });
});
