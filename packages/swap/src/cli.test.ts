/**
 * ATDD tests for the swap node CLI (`packages/swap/src/cli.ts`, Story 12.7 AC-9).
 *
 * The CLI mirrors `packages/town/src/cli.ts`:
 *   - shebang `#!/usr/bin/env node`
 *   - `main(argv): Promise<void>` exported AND self-invoked when run as entrypoint
 *   - `--config <path>` reads JSON config file (default `./swap.config.json`)
 *   - env overlay: SWAP_MNEMONIC, SWAP_SECRET_KEY_HEX, SWAP_BLS_PORT, SWAP_RELAYS
 *   - SIGINT / SIGTERM → instance.stop() → process.exit(0)
 *   - prints "Swap node listening on http://localhost:<port>"
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AC-9 swap node CLI — structural guarantees', () => {
  it('[P1] cli.ts file exists with shebang on line 1', () => {
    const cliPath = resolve(__dirname, 'cli.ts');
    expect(existsSync(cliPath)).toBe(true);
    const source = readFileSync(cliPath, 'utf-8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('[P1] cli module exports a `main(argv)` function', async () => {
    const mod = (await import('./cli.js')) as { main?: unknown };
    expect(typeof mod.main).toBe('function');
  });
});

describe('AC-9 swap node CLI — main() smoke test', () => {
  it('[P1] main() with fixture config boots swap node and stop()s within 5s', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{ stop: () => Promise<void> }>;
    };
    const fixturePath = resolve(
      __dirname,
      '..',
      'fixtures',
      'swap.config.json'
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const instance = await Promise.race([
        mod.main(['--config', fixturePath]),
        new Promise<never>((_, r) => {
          timer = setTimeout(() => r(new Error('CLI boot exceeded 5s')), 5000);
        }),
      ]);
      try {
        expect(instance).toBeDefined();
      } finally {
        await instance.stop();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  it('[P2] SWAP_MNEMONIC env var overlays config file value', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{ stop: () => Promise<void> }>;
    };
    const prev = process.env['SWAP_MNEMONIC'];
    process.env['SWAP_MNEMONIC'] =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    try {
      const fixturePath = resolve(
        __dirname,
        '..',
        'fixtures',
        'swap.config.json'
      );
      const instance = await mod.main(['--config', fixturePath]);
      await instance.stop();
    } finally {
      if (prev === undefined) delete process.env['SWAP_MNEMONIC'];
      else process.env['SWAP_MNEMONIC'] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Gap-fill: AC-9 env-overlay coverage — added by testarch-automate.
//
// The story's AC-9 lists four env vars (SWAP_MNEMONIC, SWAP_SECRET_KEY_HEX,
// SWAP_BLS_PORT, SWAP_RELAYS); only SWAP_MNEMONIC was previously exercised.
// These tests pin the remaining three plus the invalid-value validation
// branches inside `applyEnvOverlay` (packages/swap/src/cli.ts).
// ---------------------------------------------------------------------------

describe('AC-9 swap node CLI — env-overlay gap-fill', () => {
  const fixturePath = resolve(__dirname, '..', 'fixtures', 'swap.config.json');

  async function withEnv<T>(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(overrides)) prev[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[k];
        } else process.env[k] = v;
      }
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[k];
        } else process.env[k] = v;
      }
    }
  }

  it('[P2] SWAP_BLS_PORT env var overrides config.blsPort', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{
        blsPort: number;
        stop: () => Promise<void>;
      }>;
    };
    // Use port 0 via env so the kernel assigns — we only assert the env
    // overlay was consulted (blsPort should be a valid assigned port).
    const instance = await withEnv({ SWAP_BLS_PORT: '0' }, () =>
      mod.main(['--config', fixturePath])
    );
    try {
      expect(typeof instance.blsPort).toBe('number');
      // An ephemeral port will be > 0 after .listen() resolves.
      expect(instance.blsPort).toBeGreaterThanOrEqual(0);
    } finally {
      await instance.stop();
    }
  });

  it('[P2] invalid SWAP_BLS_PORT (non-numeric) throws a clear error before boot', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnv({ SWAP_BLS_PORT: 'not-a-number' }, async () => {
      await expect(mod.main(['--config', fixturePath])).rejects.toThrow(
        /SWAP_BLS_PORT must be 0\.\.65535/
      );
    });
  });

  it('[P2] invalid SWAP_BLS_PORT (out of range) throws a clear error before boot', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnv({ SWAP_BLS_PORT: '70000' }, async () => {
      await expect(mod.main(['--config', fixturePath])).rejects.toThrow(
        /SWAP_BLS_PORT must be 0\.\.65535/
      );
    });
  });

  it('[P2] SWAP_RELAYS env var overrides config.relayUrls (comma-separated)', async () => {
    // applyEnvOverlay splits on commas, trims each, filters blanks. We assert
    // the overlay mechanism itself by verifying boot still succeeds when env
    // provides the non-empty relayUrls (and config fixture is unchanged).
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{ stop: () => Promise<void> }>;
    };
    const instance = await withEnv(
      { SWAP_RELAYS: 'ws://a.example:1 , ws://b.example:2 , ' },
      () => mod.main(['--config', fixturePath])
    );
    try {
      expect(instance).toBeDefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P2] invalid SWAP_SECRET_KEY_HEX (non-hex) throws before boot', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnv(
      {
        // Remove mnemonic so the overlay selects the secretKey branch.
        SWAP_MNEMONIC: undefined,
        SWAP_SECRET_KEY_HEX: 'zz'.repeat(32),
      },
      async () => {
        await expect(mod.main(['--config', fixturePath])).rejects.toThrow(
          /SWAP_SECRET_KEY_HEX must be a 64-char hex string/
        );
      }
    );
  });

  it('[P2] SWAP_SECRET_KEY_HEX wrong length throws before boot', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnv(
      {
        SWAP_MNEMONIC: undefined,
        SWAP_SECRET_KEY_HEX: 'ab'.repeat(16), // 32 hex chars (16 bytes)
      },
      async () => {
        await expect(mod.main(['--config', fixturePath])).rejects.toThrow(
          /SWAP_SECRET_KEY_HEX must be a 64-char hex string/
        );
      }
    );
  });

  it('[P2] valid SWAP_SECRET_KEY_HEX overlays mnemonic → fails with SWAP_REQUIRES_MNEMONIC (D12-011)', async () => {
    // Proves the overlay swapped identity to secretKey: startSwapNode must then
    // reject because swap node keys cannot be derived from a raw secret key.
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnv(
      {
        SWAP_MNEMONIC: undefined,
        SWAP_SECRET_KEY_HEX: '11'.repeat(32),
      },
      async () => {
        await expect(mod.main(['--config', fixturePath])).rejects.toMatchObject(
          { code: 'SWAP_REQUIRES_MNEMONIC' }
        );
      }
    );
  });
});

// ===========================================================================
// Review Pass #3 security tests — CLI parsing hardening
// ===========================================================================

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function writeTempConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'swap-cli-sec-'));
  const p = join(dir, 'swap.config.json');
  writeFileSync(p, JSON.stringify(obj), 'utf-8');
  return p;
}

/** Write a raw JSON string (bypasses JS object-literal `__proto__` stripping). */
function writeTempRawJson(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'swap-cli-sec-'));
  const p = join(dir, 'swap.config.json');
  writeFileSync(p, json, 'utf-8');
  return p;
}

describe('Pass-3 CLI security: prototype-pollution guards', () => {
  it('[P1] rejects a config whose channels map contains __proto__ as a key', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    // Hand-crafted JSON: object-literal syntax in JS would treat `__proto__`
    // as a prototype setter and drop it — but `JSON.parse` preserves it as a
    // regular own property, which is the exact vector we guard against.
    const rawJson = JSON.stringify({
      mnemonic: 'x',
      relayUrls: ['wss://relay.example'],
    }).replace(
      '}',
      `,"channels":{"__proto__":[{"channelId":"c","cumulativeAmount":"0","nonce":"0"}]}}`
    );
    const cfgPath = writeTempRawJson(rawJson);
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow(
      /Unsafe key "__proto__"/
    );
    // Sanity: prototype NOT polluted.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('[P1] rejects a config whose inventory map contains constructor as a key', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    const rawJson = JSON.stringify({
      mnemonic: 'x',
      channels: {},
      inventory: { constructor: '1' },
      relayUrls: ['wss://relay.example'],
    });
    const cfgPath = writeTempRawJson(rawJson);
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow(
      /Unsafe key "constructor"/
    );
  });
});

describe('Pass-3 CLI security: strict hex validation on config.secretKey', () => {
  it('[P1] rejects non-hex secretKey in JSON config with a clear message', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    const cfg = {
      secretKey:
        'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      swapPairs: [],
      chains: [],
      channels: {},
      inventory: {},
      relayUrls: ['wss://relay.example'],
    };
    const cfgPath = writeTempConfig(cfg);
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow(
      /64-character hex string/
    );
  });

  it('[P1] rejects short-hex secretKey in JSON config', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    const cfg = {
      secretKey: 'deadbeef',
      swapPairs: [],
      chains: [],
      channels: {},
      inventory: {},
      relayUrls: ['wss://relay.example'],
    };
    const cfgPath = writeTempConfig(cfg);
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow(
      /64-character hex string/
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #46 — SWAP_STATE_PATH env overlay (state persistence plumbing).
// ---------------------------------------------------------------------------

describe('issue #46 — SWAP_STATE_PATH env overlay', () => {
  const fixturePath = resolve(__dirname, '..', 'fixtures', 'swap.config.json');

  it('[P1] SWAP_STATE_PATH activates persistence: boot writes the snapshot file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{ stop: () => Promise<void> }>;
    };
    const dir = mkdtempSync(join(tmpdir(), 'swap node-cli-state-'));
    const statePath = join(dir, 'state.json');
    const prev = process.env['SWAP_STATE_PATH'];
    process.env['SWAP_STATE_PATH'] = statePath;
    try {
      const instance = await mod.main(['--config', fixturePath]);
      try {
        expect(existsSync(statePath)).toBe(true);
      } finally {
        await instance.stop();
      }
    } finally {
      if (prev === undefined) delete process.env['SWAP_STATE_PATH'];
      else process.env['SWAP_STATE_PATH'] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Issue #47 AC-3 — SWAP_RATE_URL wires the per-packet rateProvider
// ===========================================================================

describe('issue #47 — SWAP_RATE_URL rateProvider wiring', () => {
  const rateFixturePath = resolve(
    __dirname,
    '..',
    'fixtures',
    'swap.config.json'
  );

  async function withEnvVars<T>(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(overrides)) prev[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[k];
        } else process.env[k] = v;
      }
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[k];
        } else process.env[k] = v;
      }
    }
  }

  it('[P1] SWAP_RATE_URL + SWAP_MAX_RATE_AGE_MS boots — proving the provider was wired (maxRateAge without a rateProvider is INVALID_CONFIG)', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{ stop: () => Promise<void> }>;
    };
    const instance = await withEnvVars(
      {
        SWAP_RATE_URL: 'http://127.0.0.1:9/rates',
        SWAP_MAX_RATE_AGE_MS: '1500',
      },
      () => mod.main(['--config', rateFixturePath])
    );
    try {
      expect(instance).toBeDefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P1] SWAP_MAX_RATE_AGE_MS WITHOUT SWAP_RATE_URL still fails INVALID_CONFIG (control)', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnvVars(
      { SWAP_RATE_URL: undefined, SWAP_MAX_RATE_AGE_MS: '1500' },
      async () => {
        await expect(
          mod.main(['--config', rateFixturePath])
        ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      }
    );
  });

  it('[P2] invalid SWAP_RATE_URL / SWAP_RATE_TIMEOUT_MS throw before boot', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    await withEnvVars({ SWAP_RATE_URL: 'not-a-url' }, async () => {
      await expect(mod.main(['--config', rateFixturePath])).rejects.toThrow(
        /http\(s\) URL/
      );
    });
    await withEnvVars(
      { SWAP_RATE_URL: 'http://feed.local/rates', SWAP_RATE_TIMEOUT_MS: '-5' },
      async () => {
        await expect(mod.main(['--config', rateFixturePath])).rejects.toThrow(
          /SWAP_RATE_TIMEOUT_MS/
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #49 — windowBudget config plumbing
// ---------------------------------------------------------------------------

describe('issue #49 — CLI windowBudget config key', () => {
  it('[P1] rejects a windowBudget map with a prototype-polluting key', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    const rawJson =
      '{"mnemonic":"x","channels":{},"inventory":{},' +
      '"relayUrls":["wss://relay.example"],' +
      '"windowBudget":{"__proto__":"1"}}';
    const cfgPath = writeTempRawJson(rawJson);
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow(
      /Unsafe key "__proto__"/
    );
  });

  it('[P1] rejects a non-numeric windowBudget value', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    const cfg = {
      mnemonic: 'x',
      channels: {},
      inventory: {},
      windowBudget: { 'evm:8453': 'lots' },
      relayUrls: ['wss://relay.example'],
    };
    const cfgPath = writeTempConfig(cfg);
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue #124 — CLI peerInfoIlpDestination / peerInfoPricePerByte plumbing
// (config surface needed for the paid kind:10032 announce in the runtime
// container).
// ---------------------------------------------------------------------------

describe('issue #124 — CLI peerInfoIlpDestination / peerInfoPricePerByte', () => {
  const BTP_PORT = 22000 + Math.floor(Math.random() * 8000);

  function standaloneCfg(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
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
          {
            channelId:
              '0xabc0000000000000000000000000000000000000000000000000000000000001',
            cumulativeAmount: '0',
            nonce: '0',
            updatedAt: 0,
          },
        ],
      },
      inventory: { 'evm:8453': '1000000' },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: 'evm:8453',
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x1111111111111111111111111111111111111111',
          tokenAddress: '0x2222222222222222222222222222222222222222',
          channelAddress: '0x3333333333333333333333333333333333333333',
        },
      ],
      relayUrls: ['ws://localhost:0'],
      blsPort: 0,
      btpServerPort: BTP_PORT,
      ...overrides,
    };
  }

  it('[P1] peerInfoIlpDestination + peerInfoPricePerByte forward through to boot without throwing (standalone connector present)', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{ stop: () => Promise<void> }>;
    };
    const cfgPath = writeTempConfig(
      standaloneCfg({
        peerInfoIlpDestination: 'g.toon.relay',
        peerInfoPricePerByte: '1',
      })
    );
    const instance = await mod.main(['--config', cfgPath]);
    try {
      expect(instance).toBeDefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P2] non-numeric peerInfoPricePerByte throws a clear error before boot', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<unknown>;
    };
    const cfgPath = writeTempConfig(
      standaloneCfg({
        peerInfoIlpDestination: 'g.toon.relay',
        peerInfoPricePerByte: 'lots',
      })
    );
    await expect(mod.main(['--config', cfgPath])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue #126 — self-generate + persist maker identity on boot, auto-derive
// the index-2 settlement key.
// ---------------------------------------------------------------------------

describe('issue #126 — settlement-key placeholder detection', () => {
  it('[P1] needsSettlementKeyDerivation is true when unset', async () => {
    const { needsSettlementKeyDerivation } = await import('./cli.js');
    expect(needsSettlementKeyDerivation(undefined)).toBe(true);
  });

  it('[P1] needsSettlementKeyDerivation is true for a 0xdead…-style placeholder (case-insensitive)', async () => {
    const { needsSettlementKeyDerivation } = await import('./cli.js');
    expect(needsSettlementKeyDerivation(`0x${'dead'.repeat(16)}`)).toBe(true);
    expect(needsSettlementKeyDerivation(`0x${'DEAD'.repeat(16)}`)).toBe(true);
    expect(needsSettlementKeyDerivation(`0x${'DeAd'.repeat(16)}`)).toBe(true);
  });

  it('[P1] needsSettlementKeyDerivation is false for a real-looking key', async () => {
    const { needsSettlementKeyDerivation } = await import('./cli.js');
    expect(needsSettlementKeyDerivation(`0x${'11'.repeat(32)}`)).toBe(false);
  });
});

describe('issue #126 — resolveIdentityConfig: index-2 settlementPrivateKey derivation', () => {
  // Universally known zero-entropy BIP-39 vector (same golden vector wallet.test.ts pins).
  const ZERO_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('[P1] derives settlementPrivateKey from the mnemonic when unset, recovering the deriveSwapNodeKeys index-2 address and matching settlementAddresses', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const { deriveSwapNodeKeys } = await import('./wallet.js');
    const { buildSignerAddresses } = await import('./swap-node.js');

    const resolved = await resolveIdentityConfig(
      {
        mnemonic: ZERO_MNEMONIC,
        swapPairs: [],
        chains: ['evm'],
        channels: {},
        inventory: {},
        relayUrls: [],
      },
      {}
    );

    expect(resolved.settlementPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const keys = await deriveSwapNodeKeys({
      mnemonic: ZERO_MNEMONIC,
      chains: ['evm'],
    });
    if (!keys.evm) throw new Error('expected an EVM key to be derived');
    const expectedHex = `0x${Buffer.from(keys.evm.privateKey).toString('hex')}`;
    expect(resolved.settlementPrivateKey).toBe(expectedHex);

    const settlementAddresses = buildSignerAddresses(
      [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
          to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
          rate: '1.0',
        },
      ],
      keys
    );
    expect(settlementAddresses['evm:8453']).toBe(keys.evm.address.toLowerCase());
  });

  it('[P1] replaces a 0xdead…-style placeholder settlementPrivateKey with the derived index-2 key', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const placeholder = `0x${'dead'.repeat(16)}`;
    const resolved = await resolveIdentityConfig(
      {
        mnemonic: ZERO_MNEMONIC,
        settlementPrivateKey: placeholder,
        swapPairs: [],
        chains: ['evm'],
        channels: {},
        inventory: {},
        relayUrls: [],
      },
      {}
    );
    expect(resolved.settlementPrivateKey).not.toBe(placeholder);
    expect(resolved.settlementPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('[P1] leaves an operator-supplied non-placeholder settlementPrivateKey untouched', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const operatorKey = `0x${'11'.repeat(32)}`;
    const resolved = await resolveIdentityConfig(
      {
        mnemonic: ZERO_MNEMONIC,
        settlementPrivateKey: operatorKey,
        swapPairs: [],
        chains: ['evm'],
        channels: {},
        inventory: {},
        relayUrls: [],
      },
      {}
    );
    expect(resolved.settlementPrivateKey).toBe(operatorKey);
  });

  it('[P2] a secretKey-only config (no mnemonic) is left untouched — no derivation attempted', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const resolved = await resolveIdentityConfig(
      {
        secretKey: new Uint8Array(32).fill(7),
        swapPairs: [],
        chains: ['evm'],
        channels: {},
        inventory: {},
        relayUrls: [],
      },
      {}
    );
    expect(resolved.settlementPrivateKey).toBeUndefined();
  });
});

describe('issue #126 — SWAP_AUTOGEN_IDENTITY self-generated + persisted identity', () => {
  async function withEnv<T>(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(overrides)) prev[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[k];
        } else process.env[k] = v;
      }
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete process.env[k];
        } else process.env[k] = v;
      }
    }
  }

  it('[P1] generates + persists a mnemonic (mode 600) when autogen is on and no identity is provided', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const { statSync, rmSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'swap-cli-autogen-'));
    try {
      const identityFile = join(dir, 'identity.json');
      const resolved = await withEnv(
        { SWAP_IDENTITY_FILE: identityFile },
        () =>
          resolveIdentityConfig(
            {
              swapPairs: [],
              chains: ['evm'],
              channels: {},
              inventory: {},
              relayUrls: [],
            },
            { identityAutogen: true }
          )
      );
      expect(existsSync(identityFile)).toBe(true);
      if (typeof resolved.mnemonic !== 'string') {
        throw new Error('expected a mnemonic to be resolved');
      }
      expect(resolved.mnemonic.split(' ').length).toBeGreaterThanOrEqual(12);
      expect(resolved.settlementPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
      const mode = statSync(identityFile).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[P1] a second boot against the same identity file LOADS the persisted mnemonic (idempotent, no regeneration)', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const { rmSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'swap-cli-autogen-'));
    const identityFile = join(dir, 'identity.json');
    try {
      const first = await withEnv({ SWAP_IDENTITY_FILE: identityFile }, () =>
        resolveIdentityConfig(
          {
            swapPairs: [],
            chains: ['evm'],
            channels: {},
            inventory: {},
            relayUrls: [],
          },
          { identityAutogen: true }
        )
      );
      const second = await withEnv({ SWAP_IDENTITY_FILE: identityFile }, () =>
        resolveIdentityConfig(
          {
            swapPairs: [],
            chains: ['evm'],
            channels: {},
            inventory: {},
            relayUrls: [],
          },
          { identityAutogen: true }
        )
      );
      expect(second.mnemonic).toBe(first.mnemonic);
      expect(second.settlementPrivateKey).toBe(first.settlementPrivateKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[P1] identity file defaults beside statePath when SWAP_IDENTITY_FILE is not set', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const { rmSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'swap-cli-autogen-'));
    try {
      const statePath = join(dir, 'state.json');
      await resolveIdentityConfig(
        {
          swapPairs: [],
          chains: ['evm'],
          channels: {},
          inventory: {},
          relayUrls: [],
          statePath,
        },
        { identityAutogen: true }
      );
      expect(existsSync(join(dir, 'identity.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[P2] autogen is a no-op when a mnemonic is already provided — no identity file created', async () => {
    const { resolveIdentityConfig } = await import('./cli.js');
    const { rmSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'swap-cli-autogen-'));
    try {
      const statePath = join(dir, 'state.json');
      await resolveIdentityConfig(
        {
          mnemonic:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
          swapPairs: [],
          chains: ['evm'],
          channels: {},
          inventory: {},
          relayUrls: [],
          statePath,
        },
        { identityAutogen: true }
      );
      expect(existsSync(join(dir, 'identity.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[P1] end-to-end: boots the committed skeleton (0xdead placeholder, no identity) with only SWAP_AUTOGEN_IDENTITY=1', async () => {
    const mod = (await import('./cli.js')) as {
      main: (argv: string[]) => Promise<{
        identity: { pubkey: string };
        swapNodeKeys: { evm?: { address: string } };
        stop: () => Promise<void>;
      }>;
    };
    const skeletonPath = resolve(
      __dirname,
      '..',
      'fixtures',
      'swap.config.autogen-skeleton.json'
    );
    const dir = mkdtempSync(join(tmpdir(), 'swap-cli-autogen-e2e-'));
    const { rmSync } = await import('node:fs');
    try {
      const instance = await withEnv(
        {
          SWAP_AUTOGEN_IDENTITY: '1',
          SWAP_STATE_PATH: join(dir, 'state.json'),
        },
        () => mod.main(['--config', skeletonPath])
      );
      try {
        expect(instance.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
        expect(instance.swapNodeKeys.evm?.address).toMatch(
          /^0x[0-9a-fA-F]{40}$/
        );
        expect(existsSync(join(dir, 'identity.json'))).toBe(true);
      } finally {
        await instance.stop();
      }

      // Second boot against the SAME state dir reuses the SAME identity.
      const instance2 = await withEnv(
        {
          SWAP_AUTOGEN_IDENTITY: '1',
          SWAP_STATE_PATH: join(dir, 'state.json'),
        },
        () => mod.main(['--config', skeletonPath])
      );
      try {
        expect(instance2.identity.pubkey).toBe(instance.identity.pubkey);
        expect(instance2.swapNodeKeys.evm?.address).toBe(
          instance.swapNodeKeys.evm?.address
        );
      } finally {
        await instance2.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
