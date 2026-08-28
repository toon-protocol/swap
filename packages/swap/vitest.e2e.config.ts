import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * End-to-end: the maker behind a REAL Rust connector, against a real anvil
 * and a real `solana-test-validator`. Every suite boots its own infra in
 * `beforeAll` (no globalSetup), so a suite is runnable on its own:
 *
 *   pnpm --filter @toon-protocol/swap test:e2e
 *
 * Needs `anvil`, `solana-test-validator`, `solana`, `spl-token`,
 * `solana-keygen` on PATH and a connector — `SWAP_E2E_CONNECTOR_BIN` (a built
 * `connector` binary) or `SWAP_E2E_CONNECTOR_IMAGE` (a published
 * `ghcr.io/toon-protocol/connector:rust-sha-…` tag, run with docker).
 * See tests/e2e/README.md.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@toon-protocol/swap': resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
  },
});
