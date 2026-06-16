import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Story 12.10 — Docker-based E2E vitest config.
 *
 * Modeled on `packages/sdk/vitest.e2e.config.ts` (AC-1). Targets
 * `tests/e2e/**\/*.test.ts`, bumps `testTimeout` to 180000ms because Mina
 * lightnet inclusion budgets 60s+ per settlement, and wires cross-package
 * aliases so Mill E2E tests can import directly from `@toon-protocol/sdk`
 * and sibling packages WITHOUT a `pnpm build` pass (development loop).
 *
 * Prerequisites: `./scripts/sdk-e2e-infra.sh up` must be running. Tests
 * runtime-skip via `skipIfNotReady()` when infra is down (AC-2) — they do
 * NOT fail locally, but throw under `CI=1` per `skipIfNotReady()` semantics.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Sub-path aliases MUST precede the root alias so they match first.
      '@toon-protocol/core/toon': resolve(
        __dirname,
        '../core/src/toon/index.ts'
      ),
      '@toon-protocol/core/nip34': resolve(
        __dirname,
        '../core/src/nip34/index.ts'
      ),
      '@toon-protocol/core': resolve(__dirname, '../core/src/index.ts'),
      '@toon-protocol/relay': resolve(__dirname, '../relay/src/index.ts'),
      '@toon-protocol/sdk': resolve(__dirname, '../sdk/src/index.ts'),
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
