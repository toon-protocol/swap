/**
 * Boot a real TOON relay (`@toon-protocol/relay`'s `relay` bin) for the E2E
 * harness — the mailbox both swap parties talk through. Free NIP-01 reads
 * on `--relay-port`, `POST /write` on `--bls-port`; the Rust connector's
 * `g.toon.relay` route terminates at that write endpoint and is what makes
 * a write cost 1 µUSDC.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);

export interface StartRelayOptions {
  wsPort: number;
  writePort: number;
  /** Override `SWAP_E2E_RELAY_BIN` (default: the installed `@toon-protocol/relay` cli). */
  binary?: string;
  bootTimeoutMs?: number;
}

export interface RelayInstance {
  wsUrl: string;
  writeUrl: string;
  healthUrl: string;
  logTail: (bytes?: number) => string;
  stop: () => Promise<void>;
}

function resolveRelayBin(explicit?: string): string {
  const fromEnv = explicit ?? process.env['SWAP_E2E_RELAY_BIN'];
  if (fromEnv) return fromEnv;
  // The package is ESM-only behind a conditional `exports` map (so neither
  // `require.resolve` nor vitest's `import.meta` can name its bin); walk the
  // node_modules lookup dirs for the bin file directly.
  const dirs = require.resolve.paths('@toon-protocol/relay') ?? [];
  for (const dir of dirs) {
    const candidate = join(dir, '@toon-protocol', 'relay', 'dist', 'cli.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    '@toon-protocol/relay is not installed (pnpm install), or set SWAP_E2E_RELAY_BIN to a built relay cli'
  );
}

export async function startRelay(
  opts: StartRelayOptions
): Promise<RelayInstance> {
  const bin = resolveRelayBin(opts.binary);
  const dataDir = mkdtempSync(join(tmpdir(), 'swap-e2e-relay-'));
  const logPath = join(dataDir, 'relay.log');
  const log: WriteStream = createWriteStream(logPath, { flags: 'a' });
  const healthUrl = `http://127.0.0.1:${opts.writePort}/health`;

  try {
    const stale = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    throw new Error(
      `port ${opts.writePort} already serves a relay (GET /health → ${stale.status}); stop it first`
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('port ')) throw err;
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [
      bin,
      '--secret-key',
      randomBytes(32).toString('hex'),
      '--relay-port',
      String(opts.wsPort),
      '--bls-port',
      String(opts.writePort),
      '--host',
      '127.0.0.1',
      '--write-host',
      '127.0.0.1',
      '--data-dir',
      join(dataDir, 'data'),
      '--log-writes',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let exited: { code: number | null; signal: string | null } | null = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  const logTail = (bytes = 8192): string => {
    try {
      const all = readFileSync(logPath, 'utf8');
      return all.length > bytes ? all.slice(all.length - bytes) : all;
    } catch {
      return '';
    }
  };
  const stop = async (): Promise<void> => {
    if (exited === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && exited === null; i++)
        await new Promise((r) => setTimeout(r, 100));
      if (exited === null) child.kill('SIGKILL');
    }
    log.end();
    rmSync(dataDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + (opts.bootTimeoutMs ?? 60_000);
  for (;;) {
    if (exited !== null) {
      const tail = logTail();
      await stop();
      throw new Error(
        `relay exited during startup (${JSON.stringify(exited)})\n--- log tail ---\n${tail}`
      );
    }
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) {
      const tail = logTail();
      await stop();
      throw new Error(
        `relay did not answer ${healthUrl} in time\n--- log tail ---\n${tail}`
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    wsUrl: `ws://127.0.0.1:${opts.wsPort}`,
    writeUrl: `http://127.0.0.1:${opts.writePort}/write`,
    healthUrl,
    logTail,
    stop,
  };
}
