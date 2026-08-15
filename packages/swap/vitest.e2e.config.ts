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
 * Prerequisites (swap#104): none for the EVM leg — `globalSetup` boots a
 * self-contained Anvil + relay + peer1 harness in-process (requires only
 * `anvil` on PATH, devbox-pinned). Solana/Mina need operator-supplied infra
 * — see `tests/e2e/README.md`. Tests runtime-skip via `skipIfNotReady()`
 * when infra is down (AC-2) — they do NOT fail locally, but throw under
 * `CI=1` when the self-contained EVM core itself failed to boot (a real
 * regression this harness owns) per `skipIfNotReady()`'s semantics.
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
    globalSetup: ['./tests/e2e/global-setup.ts'],
    // Serial execution — E2E tests share the booted Anvil/relay/peer1 infra
    // and its ports. `isolate: false` so infra-gate.ts's readiness cache
    // (and its module-level connections) are shared across suite files
    // instead of being re-probed fresh per file.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    isolate: false,
  },
});
