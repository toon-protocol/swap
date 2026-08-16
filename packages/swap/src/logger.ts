/**
 * Console-backed structured logger for the swap-node entrypoint (swap#136).
 *
 * ## Why this exists
 *
 * `startSwapNode()` falls back to `noopLogger()` when `config.logger` is
 * absent, and `cli.ts` — the entrypoint the published Docker image runs
 * (`ENTRYPOINT ["node", "dist/cli.js"]`) — never supplied one. Every
 * `logger.warn?.(...)` in the swap node AND the logger handed to the SDK's
 * `createSwapHandler` therefore went into the void: a maker that refused
 * every swap after the first wrote NOTHING to `docker logs`, and the whole
 * diagnosis had to be reconstructed from the client's bare
 * `T00 Internal error`. The no-op default is fine for embedders (a library
 * must not print uninvited); the bug was that the *process* entrypoint never
 * replaced it.
 *
 * ## Shape
 *
 * One JSON object per line, so `docker logs` output is greppable and
 * machine-parseable. Both call conventions in play are accepted:
 *
 *   - this repo's:   `warn('swap.event.name', { field: 1 })`
 *   - the SDK's:     `warn({ event: 'swap_handler.issuer_failed', error })`
 *
 * ## Level
 *
 * `SWAP_LOG_LEVEL` (`debug|info|warn|error|silent`, default `info`). An env
 * knob, deliberately NOT a config key: `swap:release` auto-deploys on green
 * main, and a newly *required* config key crash-looped the live maker once
 * already (swap#134). Unknown/absent values degrade to the default.
 *
 * ## Safety
 *
 * Serialization never throws and never escapes a log call:
 *   - `bigint` → decimal string (raw `JSON.stringify` throws on bigint, and
 *     essentially every interesting swap field is a bigint);
 *   - `Error` → `{ name, message }` only — same policy as `errSummary()` in
 *     `swap-node.ts`: stacks can capture surrounding closure state including
 *     signer-key-derived intermediates;
 *   - `Uint8Array` → `<bytes n>` (claims and keys never get printed);
 *   - cycles → `'[circular]'`;
 *   - anything still failing → a minimal fallback record.
 */

import type { SwapNodeLogger } from './swap-node.js';

export type SwapLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<SwapLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Level used when `SWAP_LOG_LEVEL` is unset or unrecognised. */
export const DEFAULT_SWAP_LOG_LEVEL: SwapLogLevel = 'info';

/** Env var read by {@link createConsoleLogger}. Optional — never required. */
export const SWAP_LOG_LEVEL_ENV = 'SWAP_LOG_LEVEL';

/** Cap on one serialized record, so a fat payload cannot flood the log. */
const MAX_LINE_CHARS = 4096;

export function resolveLogLevel(raw: string | undefined): SwapLogLevel {
  const candidate = (raw ?? '').trim().toLowerCase();
  return candidate in LEVEL_RANK
    ? (candidate as SwapLogLevel)
    : DEFAULT_SWAP_LOG_LEVEL;
}

export interface ConsoleLoggerOptions {
  /** Defaults to `resolveLogLevel(process.env.SWAP_LOG_LEVEL)`. */
  level?: SwapLogLevel;
  /** Sink seam (tests). Defaults to stdout for debug/info, stderr for warn/error. */
  write?: (level: SwapLogLevel, line: string) => void;
  /** Clock seam (tests). */
  now?: () => number;
}

/** Log-safe replacement for one value. Recursive; cycle- and bigint-aware. */
function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Uint8Array) return `<bytes ${value.length}>`;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, seen);
    }
    return out;
  } finally {
    // Ancestors only — a value repeated in sibling positions is not a cycle.
    seen.delete(value);
  }
}

/** Fold a logger call's varargs into one flat record. */
export function buildLogRecord(
  level: SwapLogLevel,
  args: readonly unknown[],
  isoTimestamp: string
): Record<string, unknown> {
  const record: Record<string, unknown> = { ts: isoTimestamp, level };
  const seen = new WeakSet<object>();
  const extras: unknown[] = [];

  for (const arg of args) {
    if (typeof arg === 'string') {
      // First string is the event name (this repo's convention); the SDK
      // passes no bare strings at all.
      if (record['event'] === undefined) record['event'] = arg;
      else extras.push(arg);
      continue;
    }
    const clean = sanitize(arg, seen);
    if (clean !== null && typeof clean === 'object' && !Array.isArray(clean)) {
      // An SDK-style `{ event: '…' }` fills the same `event` slot a bare
      // string would have.
      Object.assign(record, clean);
      continue;
    }
    extras.push(clean);
  }
  if (extras.length > 0) record['extra'] = extras;
  return record;
}

function defaultWrite(level: SwapLogLevel, line: string): void {
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/**
 * Build a {@link SwapNodeLogger} that writes one JSON line per record.
 *
 * Accepts both the `(event, fields)` and the `({ event, … })` call shapes,
 * and each returned method is a standalone arrow function so it survives the
 * `{ warn: logger.warn }` destructuring the swap node does when it forwards
 * the logger into the SDK handler and the rate guard.
 */
export function createConsoleLogger(
  options: ConsoleLoggerOptions = {}
): SwapNodeLogger {
  const level =
    options.level ?? resolveLogLevel(process.env[SWAP_LOG_LEVEL_ENV]);
  const threshold = LEVEL_RANK[level];
  const write = options.write ?? defaultWrite;
  const now = options.now ?? Date.now;

  const emit =
    (at: SwapLogLevel) =>
    (...args: unknown[]): void => {
      if (LEVEL_RANK[at] < threshold) return;
      let line: string;
      try {
        line = JSON.stringify(
          buildLogRecord(at, args, new Date(now()).toISOString())
        );
        if (line.length > MAX_LINE_CHARS) {
          line = line.slice(0, MAX_LINE_CHARS - 16) + '…","truncated":true}';
        }
      } catch {
        line = JSON.stringify({ level: at, event: 'swap.log.unserializable' });
      }
      try {
        write(at, line);
      } catch {
        // A logger must never take the node down.
      }
    };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}
