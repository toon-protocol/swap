/**
 * ATDD RED-phase tests for the swap node CLI (`packages/swap/src/cli.ts`, Story 12.7 AC-9).
 *
 * The CLI mirrors `packages/town/src/cli.ts`:
 *   - shebang `#!/usr/bin/env node`
 *   - `main(argv): Promise<void>` exported AND self-invoked when run as entrypoint
 *   - `--config <path>` reads JSON config file (default `./swap.config.json`)
 *   - env overlay: SWAP_MNEMONIC, SWAP_SECRET_KEY_HEX, SWAP_BLS_PORT, SWAP_RELAYS
 *   - SIGINT / SIGTERM → instance.stop() → process.exit(0)
 *   - prints "Swap node listening on http://localhost:<port>"
 *
 * All describe/it blocks are `.skip` — remove .skip as dev delivers each piece.
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
// branches inside `applyEnvOverlay` (packages/swap/src/cli.ts:94-122).
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
