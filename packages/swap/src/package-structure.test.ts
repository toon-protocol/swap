/**
 * ATDD RED-phase tests for Mill package structure (Story 12.7 AC-1, AC-13).
 *
 * Mirrors `packages/town/src/package-structure.test.ts`.
 * Each describe is `.skip` until Story 12.7 lands — these are the
 * publishability + export-surface guarantees the operator-facing
 * `startMill()` API depends on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function repoRoot(): string {
  return resolve(__dirname, '..', '..', '..');
}
function millPackagePath(): string {
  return resolve(repoRoot(), 'packages', 'mill', 'package.json');
}
function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('AC-1 package.json declares Mill CLI bin + runtime deps', () => {
  it('[P1] bin.toon-swap points at ./dist/cli.js', () => {
    const pkg = readJson(millPackagePath());
    const bin = pkg['bin'] as Record<string, string> | undefined;
    expect(bin).toBeDefined();
    expect(bin!['toon-swap']).toBe('./dist/cli.js');
  });

  it('[P1] @toon-protocol/sdk is in dependencies (moved from devDependencies)', () => {
    const pkg = readJson(millPackagePath());
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    expect(deps!['@toon-protocol/sdk']).toBeDefined();
  });

  it('[P1] adds @toon-protocol/connector, hono, @hono/node-server, nostr-tools to dependencies', () => {
    const pkg = readJson(millPackagePath());
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    expect(deps!['@toon-protocol/connector']).toBeDefined();
    expect(deps!['hono']).toBeDefined();
    expect(deps!['@hono/node-server']).toBeDefined();
    expect(deps!['nostr-tools']).toBeDefined();
  });

  it('[P2] tsup.config.ts registers both src/index.ts AND src/cli.ts entries', () => {
    const tsupPath = resolve(repoRoot(), 'packages', 'mill', 'tsup.config.ts');
    expect(existsSync(tsupPath)).toBe(true);
    const src = readFileSync(tsupPath, 'utf-8');
    expect(src).toContain('index.ts');
    expect(src).toContain('cli.ts');
  });
});

describe('AC-1 index.ts export surface', () => {
  it('[P0] exports startMill (function)', async () => {
    const mod = (await import('./index.js')) as { startMill?: unknown };
    expect(typeof mod.startMill).toBe('function');
  });

  it('[P0] re-exports createSwapHandler from @toon-protocol/sdk', async () => {
    const mod = (await import('./index.js')) as { createSwapHandler?: unknown };
    expect(typeof mod.createSwapHandler).toBe('function');
  });

  it('[P1] exports MillStartError class', async () => {
    const mod = (await import('./index.js')) as { MillStartError?: unknown };
    expect(typeof mod.MillStartError).toBe('function');
  });

  it('[P1] preserves Story 12.4 exports (deriveMillKeys, MillInventory, MultiChainClaimIssuer)', async () => {
    const mod = (await import('./index.js')) as {
      deriveMillKeys?: unknown;
      MillInventory?: unknown;
      MultiChainClaimIssuer?: unknown;
    };
    expect(typeof mod.deriveMillKeys).toBe('function');
    expect(typeof mod.MillInventory).toBe('function');
    expect(typeof mod.MultiChainClaimIssuer).toBe('function');
  });
});

describe('AC-13 no circular import between mill.ts and index.ts', () => {
  it('[P2] source src/mill.ts does not import from ./index.js (cycle guard)', () => {
    // Tsup bundles mill.ts into a shared chunk so there is no standalone
    // `dist/mill.js`. Assert the guarantee at the SOURCE level instead — a
    // cycle can only be introduced by importing the barrel from mill.ts.
    const srcMill = resolve(repoRoot(), 'packages', 'mill', 'src', 'mill.ts');
    expect(existsSync(srcMill)).toBe(true);
    const src = readFileSync(srcMill, 'utf-8');
    expect(src).not.toMatch(/from\s+["']\.\/index\.js?["']/);
    expect(src).not.toMatch(/require\(\s*["']\.\/index\.js?["']\s*\)/);
  });
});
