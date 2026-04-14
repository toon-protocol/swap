/**
 * ATDD RED-phase tests for `startMill()` (Story 12.7).
 *
 * These tests are INTENTIONALLY failing — they describe the behavior
 * `startMill()` must exhibit before Story 12.7's dev implementation begins.
 * Every `it.skip(...)` must be unskipped (and pass) as part of the GREEN phase
 * delivery of story 12.7 per `_bmad-output/implementation-artifacts/12-7-start-mill-scaffold.md`.
 *
 * Scenarios traced to test-design-epic-12.md section 2.7:
 *   - T-055 (P0)  startMill boots, registers swap handler on kind 1059,
 *                 health endpoint responds.                                (AC-4, AC-8, AC-10, R-015)
 *   - T-056 (P0)  startMill derives wallet keys from mnemonic for all
 *                 configured chains.                                        (AC-4 phase 3)
 *   - T-057 (P1)  startMill publishes kind:10032 with swapPairs.            (AC-6)
 *   - T-058 (P1)  Missing mnemonic / secretKey-only path → clear error.    (AC-4 phase 3)
 *   - T-060 (P2)  Graceful shutdown: stop() idempotent, releases state.    (AC-12)
 *
 * Additional AC coverage in this file:
 *   - AC-2 config validation (every INVALID_CONFIG branch)
 *   - AC-3 MillInstance.health() snapshot shape
 *   - AC-5 buildSignerAddresses — multi-chain, missing key, unknown family
 *   - AC-7 ownership-based connector cleanup
 *   - AC-13 no self-cycle with the barrel `./index.js`
 *
 * Red-phase compliance: each top-level describe is marked `describe(...)`.
 * When the dev team implements `startMill()`, they flip `.skip` → `.only` on one
 * describe at a time (classic red → green cycle) and remove `.skip` wholesale
 * once AC coverage is achieved.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect } from 'vitest';

// NOTE: the following imports reference symbols that DO NOT YET EXIST.
// TypeScript will error on these lines until Story 12.7's dev work lands.
// This is the definition of TDD red phase.
//
// We use a type-only import guard so `pnpm --filter @toon-protocol/mill test`
// can still enumerate the skipped specs without the test file exploding at
// collection time. Once `mill.ts` is implemented, change these to real imports.

type StartMillFn = (config: unknown) => Promise<any>;
interface MillInstanceShape {
  identity: { pubkey: string; secretKey: Uint8Array };
  blsPort: number;
  millKeys: unknown;
  stop: () => Promise<void>;
  health: () => {
    status: 'ok' | 'starting' | 'stopping' | 'stopped';
    version: string;
    nodePubkey: string;
    swapPairsCount: number;
    chains: readonly string[];
    uptimeSec: number;
    inventory: Record<string, string>;
  };
  _handlerRegistry?: { get(kind: number): unknown };
}

// Dynamic import so TS doesn't fail at collection time.
async function loadStartMill(): Promise<StartMillFn> {
  const mod = (await import('./mill.js')) as { startMill: StartMillFn };
  return mod.startMill;
}

async function loadMillStartError(): Promise<new (...a: any[]) => Error> {
  const mod = (await import('./errors.js')) as {
    MillStartError: new (...a: any[]) => Error;
  };
  return mod.MillStartError;
}

// ---------------------------------------------------------------------------
// Test fixtures — minimal-yet-valid MillConfig shape.
// Every field here is a placeholder. Dev implementation is expected to
// fail fast on any missing piece; these fixtures describe the HAPPY shape.
// ---------------------------------------------------------------------------

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fakeConnector(): any {
  const calls: string[] = [];
  return {
    _calls: calls,
    close: async () => {
      calls.push('close');
    },
    // Minimum EmbeddableConnectorLike surface startMill needs. Flesh out if
    // the real interface turns out to be larger (see `@toon-protocol/core`).
    send: async () => ({ ok: true }),
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
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
    chains: ['evm'] as const,
    channels: {
      'evm:8453': [
        {
          channelId: 'chan-1',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { 'evm:8453': 1_000_000n },
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    ...overrides,
  };
}

// ===========================================================================
// T-055 / AC-4 / AC-8 / AC-10: boot, handler registration, health
// ===========================================================================

describe('T-055 startMill boots and registers swap handler (AC-4, AC-8, AC-10)', () => {
  it('[P0] returns MillInstance with identity, millKeys, health(), stop()', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      expect(instance).toBeDefined();
      expect(typeof instance.stop).toBe('function');
      expect(typeof instance.health).toBe('function');
      expect(instance.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(instance.identity.secretKey).toBeInstanceOf(Uint8Array);
      expect(instance.identity.secretKey.length).toBe(32);
      expect(instance.millKeys).toBeDefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P0] registers the swap handler on kind 1059 (gift-wrap) — R-015 mitigation', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      // _handlerRegistry is an @internal test-only hook per AC-10.
      const registry = instance._handlerRegistry;
      expect(
        registry,
        'MillInstance must expose _handlerRegistry for AC-10'
      ).toBeDefined();
      const handler = registry!.get(1059);
      expect(typeof handler).toBe('function');
      // Default storage handler (kind:1) must NOT be the swap handler.
      const kind1 = registry!.get(1);
      expect(kind1).not.toBe(handler);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] health() snapshot has status:"ok" and expected shape after boot (AC-8)', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      const h = instance.health();
      expect(h.status).toBe('ok');
      expect(h.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(h.nodePubkey).toBe(instance.identity.pubkey);
      expect(h.swapPairsCount).toBe(1);
      expect(h.chains).toEqual(['evm']);
      expect(typeof h.uptimeSec).toBe('number');
      expect(h.uptimeSec).toBeGreaterThanOrEqual(0);
      // Inventory serialized as bigint → decimal string (MAX_SAFE_INTEGER guard).
      expect(h.inventory['evm:8453']).toBe('1000000');
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// T-056 / AC-4 phase 3: wallet-key derivation
// ===========================================================================

describe('T-056 startMill derives Mill keys from mnemonic for configured chains', () => {
  it('[P0] derives EVM key (0x-prefixed address) when chains:["evm"]', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      const keys = instance.millKeys as { evm?: { address: string } };
      expect(keys.evm).toBeDefined();
      expect(keys.evm!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] derives Solana + EVM keys for multi-chain config', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(
      baseConfig({
        swapPairs: [
          {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            rate: '1.0',
          },
          {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:mainnet' },
            rate: '1.0',
          },
        ],
        chains: ['evm', 'solana'] as const,
        channels: {
          'evm:8453': [
            {
              channelId: 'c-evm',
              cumulativeAmount: 0n,
              nonce: 0n,
              updatedAt: 0,
            },
          ],
          'solana:mainnet': [
            {
              channelId: 'c-sol',
              cumulativeAmount: 0n,
              nonce: 0n,
              updatedAt: 0,
            },
          ],
        },
        inventory: { 'evm:8453': 1_000_000n, 'solana:mainnet': 1_000_000n },
      })
    )) as MillInstanceShape;
    try {
      const keys = instance.millKeys as {
        evm?: { address: string };
        solana?: { publicKey: Uint8Array };
      };
      expect(keys.evm).toBeDefined();
      expect(keys.solana).toBeDefined();
      expect(keys.solana!.publicKey.length).toBeGreaterThan(0);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] Nostr identity pubkey ≠ Mill EVM signer address (D12-011 separation)', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    try {
      const keys = instance.millKeys as { evm?: { address: string } };
      expect(keys.evm!.address.toLowerCase()).not.toBe(
        '0x' + instance.identity.pubkey.slice(0, 40)
      );
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// T-057 / AC-6: kind:10032 publication with swapPairs
// ===========================================================================

describe('T-057 startMill publishes kind:10032 with swapPairs (AC-6)', () => {
  it('[P1] builds IlpPeerInfo event whose content.swapPairs matches config.swapPairs entry-for-entry', async () => {
    // This test requires injection of a spy-able event-builder OR a capture hook.
    // Dev implementation is expected to expose enough seam to assert:
    //   - exactly ONE event built at boot
    //   - content.swapPairs.length === config.swapPairs.length
    //   - deep-equal on each {from,to,rate} entry
    const startMill = await loadStartMill();
    const pairs = [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        rate: '1.0',
      },
    ];
    // TODO(dev): provide an `__testHooks.onPeerInfoBuilt` config field so
    // this test can capture the signed event without reaching into implementation
    // internals. See AC-6 note in 12-7 story.
    const captured: unknown[] = [];
    const instance = (await startMill({
      ...baseConfig({ swapPairs: pairs }),
      __testHooks: { onPeerInfoBuilt: (e: unknown) => captured.push(e) },
    })) as MillInstanceShape;
    try {
      expect(captured.length).toBe(1);
      const evt = captured[0] as { content: string };
      const content = JSON.parse(evt.content) as { swapPairs: typeof pairs };
      expect(content.swapPairs.length).toBe(1);
      expect(content.swapPairs[0]).toEqual(pairs[0]);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] publication failure does NOT abort startup (fire-and-forget)', async () => {
    const startMill = await loadStartMill();
    // Config with knownPeers pointing at unreachable host — publish must
    // WARN-log and still resolve a working MillInstance.
    const instance = (await startMill(
      baseConfig({
        knownPeers: [
          { ilpAddress: 'g.unreachable', btpUrl: 'http://127.0.0.1:1' },
        ],
      })
    )) as MillInstanceShape;
    try {
      expect(instance.health().status).toBe('ok');
    } finally {
      await instance.stop();
    }
  });
});

// ===========================================================================
// T-058 / AC-4 phase 3: missing-mnemonic path
// ===========================================================================

describe('T-058 startMill fails fast on missing mnemonic (AC-2, AC-4 phase 3)', () => {
  it('[P1] throws INVALID_CONFIG when neither mnemonic nor secretKey provided', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const cfg = baseConfig();
    delete (cfg as Record<string, unknown>).mnemonic;
    await expect(startMill(cfg)).rejects.toBeInstanceOf(MillStartError);
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P1] throws INVALID_CONFIG when both mnemonic AND secretKey provided', async () => {
    const startMill = await loadStartMill();
    const MillStartError = await loadMillStartError();
    const cfg = baseConfig({ secretKey: new Uint8Array(32) });
    await expect(startMill(cfg)).rejects.toBeInstanceOf(MillStartError);
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P1] throws MILL_REQUIRES_MNEMONIC when only secretKey is supplied (D12-011)', async () => {
    const startMill = await loadStartMill();
    const cfg = baseConfig({ secretKey: new Uint8Array(32) });
    delete (cfg as Record<string, unknown>).mnemonic;
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: 'MILL_REQUIRES_MNEMONIC',
    });
  });
});

// ===========================================================================
// AC-2: exhaustive config-validation branches
// ===========================================================================

describe('AC-2 MillConfig validation (every INVALID_CONFIG branch)', () => {
  it('[P1] rejects empty swapPairs array', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ swapPairs: [] }))
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P1] rejects missing channel for a referenced pair.to.chain', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ channels: {} as Record<string, never> }))
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('[P1] rejects missing inventory entry for a referenced pair.to.chain', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ inventory: {} as Record<string, never> }))
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('[P2] rejects secretKey that is not 32 bytes', async () => {
    const startMill = await loadStartMill();
    const cfg = baseConfig({ secretKey: new Uint8Array(31) });
    delete (cfg as Record<string, unknown>).mnemonic;
    await expect(startMill(cfg)).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_CONFIG|MILL_REQUIRES_MNEMONIC/),
    });
  });

  it('[P2] rejects empty relayUrls array', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ relayUrls: [] }))
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('[P2] rejects both connector AND connectorUrl present', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ connectorUrl: 'http://localhost:3000' }))
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});

// ===========================================================================
// AC-5: buildSignerAddresses (expose as a named export for unit testability)
// ===========================================================================

describe('AC-5 buildSignerAddresses helper', () => {
  it('[P1] maps evm:* pairs to the derived EVM address', async () => {
    const mod = (await import('./mill.js')) as any;
    const map = mod.buildSignerAddresses(
      [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
          to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
          rate: '1.0',
        },
      ],
      { evm: { address: '0xabc0000000000000000000000000000000000001' } }
    );
    expect(map['evm:8453']).toBe('0xabc0000000000000000000000000000000000001');
  });

  it('[P1] throws MISSING_KEY when pair targets evm but no EVM key was derived', async () => {
    const mod = (await import('./mill.js')) as any;
    expect(() =>
      mod.buildSignerAddresses(
        [
          {
            from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
            rate: '1.0',
          },
        ],
        {}
      )
    ).toThrow(/MISSING_KEY/);
  });

  it('[P1] throws UNSUPPORTED_CHAIN_FAMILY for unknown chain prefix', async () => {
    const mod = (await import('./mill.js')) as any;
    expect(() =>
      mod.buildSignerAddresses(
        [
          {
            from: { assetCode: 'XRP', assetScale: 6, chain: 'ripple:mainnet' },
            to: { assetCode: 'XRP', assetScale: 6, chain: 'ripple:mainnet' },
            rate: '1.0',
          },
        ],
        {}
      )
    ).toThrow(/UNSUPPORTED_CHAIN_FAMILY/);
  });
});

// ===========================================================================
// AC-7: ownership-based connector cleanup
// ===========================================================================

describe('AC-7 connector ownership — caller-supplied connector NOT closed by stop()', () => {
  it('[P1] stop() does NOT call close() on a caller-supplied connector', async () => {
    const startMill = await loadStartMill();
    const connector = fakeConnector();
    const instance = (await startMill(
      baseConfig({ connector })
    )) as MillInstanceShape;
    await instance.stop();
    expect(connector._calls).not.toContain('close');
  });
});

// ===========================================================================
// T-060 / AC-12: graceful shutdown is idempotent
// ===========================================================================

describe('T-060 stop() is idempotent and releases resources (AC-12)', () => {
  it('[P2] calling stop() twice resolves without error', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(baseConfig())) as MillInstanceShape;
    await instance.stop();
    await expect(instance.stop()).resolves.toBeUndefined();
    expect(instance.health().status).toBe('stopped');
  });

  it('[P2] BLS server port is no longer accepting connections after stop()', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(
      baseConfig({ blsPort: 0 })
    )) as MillInstanceShape;
    const port = instance.blsPort;
    await instance.stop();
    // Fetch should error with ECONNREFUSED (or AbortError-via-timeout).
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      })
    ).rejects.toBeDefined();
  });
});

// ===========================================================================
// Review Pass #3 security fixes
// ===========================================================================

describe('Pass-3 security: passphrase rejection (cryptographic correctness)', () => {
  it('[P1] rejects non-empty passphrase with INVALID_CONFIG (SDK fromMnemonic does not support passphrases — derivation would split)', async () => {
    const startMill = await loadStartMill();
    await expect(
      startMill(baseConfig({ passphrase: 'secret-pw' }))
    ).rejects.toMatchObject({
      name: 'MillStartError',
      code: 'INVALID_CONFIG',
    });
  });

  it('[P2] empty-string passphrase is treated as "no passphrase" and accepted', async () => {
    const startMill = await loadStartMill();
    const instance = (await startMill(
      baseConfig({ passphrase: '' })
    )) as MillInstanceShape;
    expect(instance.health().status).toBe('ok');
    await instance.stop();
  });
});

// ===========================================================================
// Story 12.8 AC-11: auto-create embedded ConnectorNode when none supplied
// ===========================================================================

describe('Story 12.8 AC-11 — auto-create embedded ConnectorNode', () => {
  it('[P1] startMill() with no connector + btpServerPort auto-wires ConnectorNode; mill.connector is live', async () => {
    const startMill = await loadStartMill();
    // Use a high, likely-free port to avoid collision.
    const port = 24000 + Math.floor(Math.random() * 1000);
    // Omit the `connector` key entirely — exercising the auto-wire branch.
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      btpServerPort: port,
    })) as MillInstanceShape & {
      connector?: { nodeId?: string };
    };
    try {
      expect(instance.connector).toBeDefined();
      // Distinct from operator-supplied fake (which has `_calls`).
      expect((instance.connector as { _calls?: unknown })._calls).toBeUndefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P1] stop() cleanly tears down the auto-created connector (ownership transfer)', async () => {
    const startMill = await loadStartMill();
    const port = 25000 + Math.floor(Math.random() * 1000);
    const { connector: _ignored, ...withoutConnector } = baseConfig();
    const instance = (await startMill({
      ...withoutConnector,
      btpServerPort: port,
    })) as MillInstanceShape;
    // Idempotent stop — second call is a no-op.
    await instance.stop();
    await instance.stop();
    expect(instance.health().status).toBe('stopped');
  });
});

// ===========================================================================
// Story 12.8 AC-13: publisher injection + rejecting-publisher tolerance
// ===========================================================================

describe('Story 12.8 AC-13 — publisher injection', () => {
  it('[P1] injected publisher.publish() is called with a kind:10032 event', async () => {
    const startMill = await loadStartMill();
    const captured: unknown[] = [];
    const publisher = {
      publish: async (event: unknown): Promise<void> => {
        captured.push(event);
      },
    };
    const instance = (await startMill(
      baseConfig({ publisher })
    )) as MillInstanceShape;
    try {
      // Publish fires after resolve; await one macrotask tick.
      const deadline = Date.now() + 2_000;
      while (captured.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(captured.length).toBe(1);
      const ev = captured[0] as { kind: number; tags: string[][] };
      expect(ev.kind).toBe(10032);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] rejecting publisher does NOT fail startMill() (flaky-relay tolerance, R-8N2)', async () => {
    const startMill = await loadStartMill();
    const publisher = {
      publish: async (): Promise<void> => {
        throw new Error('simulated relay outage');
      },
    };
    // Boot MUST resolve; the per-relay failure is logged, not thrown.
    const instance = (await startMill(
      baseConfig({ publisher })
    )) as MillInstanceShape;
    expect(instance.health().status).toBe('ok');
    await instance.stop();
  });
});
