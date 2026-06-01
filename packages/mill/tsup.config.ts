import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/wallet.ts` is a dedicated entry so consumers (e.g. townhouse) can
  // import the pure key-derivation (`deriveMillKeys`) via `@toon-protocol/mill/wallet`
  // WITHOUT pulling in the server barrel (startMill/hono/sdk/connector). It only
  // depends on light crypto (@scure, @noble, ed25519-hd-key), so it inlines cheaply.
  entry: ['src/index.ts', 'src/cli.ts', 'src/wallet.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
});
