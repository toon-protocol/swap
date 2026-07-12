import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Story 12.10 — Docker-based E2E vitest config.
 *
 * Modeled on `packages/sdk/vitest.e2e.config.ts` (AC-1). Targets
 * `tests/e2e/**\/*.test.ts` and bumps `testTimeout` to 180000ms because
 * Mina lightnet inclusion budgets 60s+ per settlement.
 * `@toon-protocol/{core,sdk,connector}` resolve from node_modules; only
 * `@toon-protocol/swap` is aliased to local source (development loop).
 *
 * Prerequisites: `./scripts/sdk-e2e-infra.sh up` must be running. Tests
 * runtime-skip via `skipIfNotReady()` when infra is down (AC-2) — they do
 * NOT fail locally, but throw under `CI=1` per `skipIfNotReady()` semantics.
 */
export default defineConfig({
  resolve: {
    alias: {
      // NOTE: `@toon-protocol/core`, `@toon-protocol/sdk`, and
      // `@toon-protocol/connector` are external dependencies resolved via
      // node_modules — there is no local source for them in this repo.
      // (Stale post-extraction aliases to sibling `../{core,relay,sdk}/src`
      // were removed with the sdk 2.x migration, issue #45.)
      '@toon-protocol/swap': resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 180000,
    // Serial execution — E2E tests share Docker peers and ports.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
