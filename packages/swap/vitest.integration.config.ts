import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Integration-test vitest config for Story 12.8.
 *
 * Mirrors `packages/town/vitest.e2e.config.ts` (AC-15.1).
 *
 * The default `packages/mill/vitest.config.ts` runs ONLY `src/**\/*.test.ts`
 * so these integration tests do not double-execute under `pnpm --filter
 * @toon-protocol/swap test` (AC-15.4).
 *
 * Pool: `forks` — process-per-test isolation matters because each test
 * boots an in-process `MillInstance` + peered `ConnectorNode` pair and
 * binds to ephemeral ports. A shared worker pool would leak handles.
 */
export default defineConfig({
  resolve: {
    alias: {
      // NOTE: Do NOT alias `@toon-protocol/connector` — it is an external
      // dependency resolved via node_modules; there is no local source in
      // this monorepo.
      // Sub-path aliases MUST precede the root alias so they match first.
      '@toon-protocol/core/toon': resolve(__dirname, '../../packages/core/src/toon/index.ts'),
      '@toon-protocol/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@toon-protocol/sdk': resolve(__dirname, '../../packages/sdk/src/index.ts'),
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
