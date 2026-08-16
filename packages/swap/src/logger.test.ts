/**
 * swap#136 — the process-level logger, and the CLI wiring that installs it.
 *
 * The root cause of "the maker refused every swap and wrote NOTHING" was not
 * a missing log statement: `swap-node.ts` and the SDK swap handler both had
 * one. It was that `cli.ts` — the entrypoint `deploy/swap/Dockerfile` runs —
 * never supplied `config.logger`, so `startSwapNode()` installed
 * `noopLogger()` and every one of those statements was a no-op. These tests
 * pin the entrypoint wiring so the regression cannot come back silently.
 */
import { describe, it, expect } from 'vitest';

import {
  createConsoleLogger,
  resolveLogLevel,
  buildLogRecord,
  DEFAULT_SWAP_LOG_LEVEL,
  type SwapLogLevel,
} from './logger.js';
import { installDefaultLogger } from './cli.js';
import type { SwapNodeConfig } from './swap-node.js';

function capture(level?: SwapLogLevel): {
  logger: ReturnType<typeof createConsoleLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createConsoleLogger({
    ...(level !== undefined && { level }),
    write: (_at, line) => lines.push(line),
    now: () => 1_700_000_000_000,
  });
  return { logger, lines };
}

/** Narrowing accessor — the gate forbids `!` (no-non-null-assertion). */
function parseLine(lines: string[], index = 0): Record<string, unknown> {
  const line = lines[index];
  if (line === undefined) throw new Error(`no log line at index ${index}`);
  return JSON.parse(line) as Record<string, unknown>;
}

function lineAt(lines: string[], index = 0): string {
  const line = lines[index];
  if (line === undefined) throw new Error(`no log line at index ${index}`);
  return line;
}

describe('swap#136 — cli.ts installs a real logger (the no-op was the defect)', () => {
  it('[P0] installDefaultLogger() gives a config with no logger a working one', () => {
    const config = installDefaultLogger({} as SwapNodeConfig);
    expect(config.logger).toBeDefined();
    for (const method of ['debug', 'info', 'warn', 'error'] as const) {
      expect(typeof config.logger?.[method]).toBe('function');
    }
  });

  it('[P0] an operator-supplied logger is never overridden', () => {
    const mine = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    expect(
      installDefaultLogger({ logger: mine } as SwapNodeConfig).logger
    ).toBe(mine);
  });

  it('[P0] the installed logger actually emits — destructured methods included', () => {
    const { logger, lines } = capture();
    // swap-node.ts forwards `{ warn: logger.warn }` into the SDK handler and
    // the rate guard; a `this`-bound method would break there.
    const { warn } = logger;
    warn('swap.claim.refused', { reason: 'channel_unredeemed' });
    expect(lines).toHaveLength(1);
    expect(parseLine(lines)).toMatchObject({
      level: 'warn',
      event: 'swap.claim.refused',
      reason: 'channel_unredeemed',
    });
  });
});

describe('createConsoleLogger', () => {
  it('[P0] accepts BOTH call shapes in play', () => {
    const { logger, lines } = capture('debug');
    // this repo's shape
    logger.warn('swap.event', { a: 1 });
    // the SDK's shape (`logger.error({ event, error })`)
    logger.error({ event: 'swap_handler.issuer_failed', error: 'boom' });
    expect(parseLine(lines)).toMatchObject({ event: 'swap.event', a: 1 });
    expect(parseLine(lines, 1)).toMatchObject({
      event: 'swap_handler.issuer_failed',
      error: 'boom',
    });
  });

  it('[P0] bigints serialize (raw JSON.stringify throws, and every swap number is a bigint)', () => {
    const { logger, lines } = capture();
    logger.warn('swap.claim.refused', {
      unredeemed: 1_000n,
      nested: { cumulative: 15_000_000n },
    });
    expect(parseLine(lines)).toMatchObject({
      unredeemed: '1000',
      nested: { cumulative: '15000000' },
    });
  });

  it('[P1] Errors are reduced to { name, message } — no stacks (signer-material policy)', () => {
    const { logger, lines } = capture();
    logger.error('swap.boom', { err: new TypeError('nope') });
    const record = parseLine(lines) as { err: Record<string, unknown> };
    expect(record.err).toEqual({ name: 'TypeError', message: 'nope' });
    expect(lineAt(lines)).not.toContain('at ');
  });

  it('[P1] byte arrays and cycles never take the process down', () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() =>
      logger.warn('swap.weird', { key: new Uint8Array(32), cyclic })
    ).not.toThrow();
    expect(lineAt(lines)).toContain('<bytes 32>');
    expect(lineAt(lines)).toContain('[circular]');
  });

  it('[P1] a repeated sibling object is NOT reported as a cycle', () => {
    const { logger, lines } = capture();
    const shared = { id: 7 };
    logger.warn('swap.shared', { a: shared, b: shared });
    expect(parseLine(lines)).toMatchObject({ a: { id: 7 }, b: { id: 7 } });
  });

  it('[P1] a throwing sink is swallowed', () => {
    const logger = createConsoleLogger({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => logger.error('swap.boom', {})).not.toThrow();
  });

  it('[P0] level filtering: default drops debug, keeps warn/error', () => {
    const { logger, lines } = capture(DEFAULT_SWAP_LOG_LEVEL);
    logger.debug('swap.debug', {});
    logger.info('swap.info', {});
    logger.warn('swap.warn', {});
    logger.error('swap.error', {});
    expect(
      lines.map((l) => (JSON.parse(l) as { event: string }).event)
    ).toEqual(['swap.info', 'swap.warn', 'swap.error']);
  });

  it('[P1] `silent` emits nothing at all', () => {
    const { logger, lines } = capture('silent');
    logger.error('swap.error', {});
    expect(lines).toEqual([]);
  });

  it('[P0] SWAP_LOG_LEVEL is optional and degrades safely — never a required key', () => {
    expect(resolveLogLevel(undefined)).toBe(DEFAULT_SWAP_LOG_LEVEL);
    expect(resolveLogLevel('')).toBe(DEFAULT_SWAP_LOG_LEVEL);
    expect(resolveLogLevel('LOUD')).toBe(DEFAULT_SWAP_LOG_LEVEL);
    expect(resolveLogLevel(' DEBUG ')).toBe('debug');
    expect(resolveLogLevel('error')).toBe('error');
  });

  it('[P1] buildLogRecord stamps ts + level and keeps the first string as `event`', () => {
    const record = buildLogRecord(
      'warn',
      ['swap.event', { a: 1 }, 'trailing'],
      '2026-08-16T00:00:00.000Z'
    );
    expect(record).toMatchObject({
      ts: '2026-08-16T00:00:00.000Z',
      level: 'warn',
      event: 'swap.event',
      a: 1,
      extra: ['trailing'],
    });
  });
});
