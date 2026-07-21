---
---

Fix root vitest.config.ts, which aliased monorepo packages (core, relay, bls, sdk, client, town, townhouse-web) that no longer exist in this extracted single-package repo, breaking `pnpm test` / `devbox run test` at the root.
