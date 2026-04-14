/**
 * ATDD RED-phase tests for Mill `/health` endpoint (Story 12.7 AC-8).
 *
 * Scenarios:
 *   - `/health` returns JSON body matching MillHealthResponse shape.
 *   - status transitions: starting → ok → stopping → stopped.
 *   - bigint inventory serialized as decimal strings (MAX_SAFE_INTEGER guard,
 *     Epic 11 retro).
 *
 * All `describe(...)` — flip to live as part of GREEN-phase delivery.
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
      };
      expect(body.status).toBe('ok');
      expect(body.nodePubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.swapPairsCount).toBe(1);
      expect(body.chains).toEqual(['evm']);
      expect(typeof body.uptimeSec).toBe('number');
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
