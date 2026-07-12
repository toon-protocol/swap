import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Integration-test vitest config for Story 12.8.
 *
 * Mirrors `packages/town/vitest.e2e.config.ts` (AC-15.1).
 *
 * The default `packages/swap/vitest.config.ts` runs ONLY `src/**\/*.test.ts`
 * so these integration tests do not double-execute under `pnpm --filter
 * @toon-protocol/swap test` (AC-15.4).
 *
 * Pool: `forks` — process-per-test isolation matters because each test
 * boots an in-process `SwapNodeInstance` + peered `ConnectorNode` pair and
 * binds to ephemeral ports. A shared worker pool would leak handles.
 */
export default defineConfig({
  resolve: {
    alias: {
      // NOTE: `@toon-protocol/core`, `@toon-protocol/sdk`, and
      // `@toon-protocol/connector` are external dependencies resolved via
      // node_modules — there is no local source for them in this repo.
      // (Stale post-extraction aliases to `../../packages/{core,sdk}/src`
      // were removed with the sdk 2.x migration, issue #45.)
      '@toon-protocol/swap': resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
