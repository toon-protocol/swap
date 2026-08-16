/**
 * Unit tests for the intake meter (issue #152).
 *
 * The wire-level proof — that the maker's real dispatch seam puts each of the
 * four classes on the right row, and that a kind:20032 and a kind:20033
 * arrival differing ONLY by inner rumor kind land on different ones — lives in
 * `swap-node.intake-classification.test.ts`. This file covers the meter's own
 * contract: one record per arrival, honest windows, bounded tables.
 */
import { describe, it, expect } from 'vitest';

import {
  SWAP_INTAKE_EVENT,
  UNCLASSIFIED_REASON,
  createSwapIntakeMeter,
  formatIntakePair,
  intakePairFromTags,
} from './intake-classification.js';
import type { SwapIntakeClass } from './intake-classification.js';

interface Line {
  event: string;
  fields: Record<string, unknown>;
}

function capturing(): {
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  lines: Line[];
} {
  const lines: Line[] = [];
  return {
    logger: {
      info: (event: string, fields?: Record<string, unknown>) => {
        lines.push({ event, fields: fields ?? {} });
      },
    },
    lines,
  };
}

describe('formatIntakePair / intakePairFromTags', () => {
  it('renders a pair as a single from>to token', () => {
    expect(
      formatIntakePair({
        from: { assetCode: 'USDC', chain: 'evm:84532' },
        to: { assetCode: 'USDC', chain: 'solana:devnet' },
      })
    ).toBe('USDC:evm:84532>USDC:solana:devnet');
  });

  it("recovers the pair from a legacy rumor's swap-from/swap-to tags", () => {
    expect(
      intakePairFromTags([
        ['swap-from', 'USDC:evm:84532'],
        ['amount', '1000'],
        ['swap-to', 'USDC:solana:devnet'],
      ])
    ).toBe('USDC:evm:84532>USDC:solana:devnet');
  });

  it('is undefined when either side is missing, and never throws on junk', () => {
    expect(intakePairFromTags([['swap-from', 'USDC:evm:1']])).toBeUndefined();
    expect(intakePairFromTags(undefined)).toBeUndefined();
    expect(intakePairFromTags('not-tags')).toBeUndefined();
    expect(intakePairFromTags([['swap-from'], [1, 2], null])).toBeUndefined();
  });

  it('caps a hostile tag value so one packet cannot flood a log line', () => {
    const pair = intakePairFromTags([
      ['swap-from', 'A'.repeat(5000)],
      ['swap-to', 'USDC:evm:1'],
    ]);
    expect(pair).toBeDefined();
    expect((pair ?? '').length).toBeLessThan(200);
  });
});

describe('swap intake meter — one record per arrival', () => {
  it('emits exactly one swap.intake record, carrying class, peer and pair', () => {
    const { logger, lines } = capturing();
    const meter = createSwapIntakeMeter({ logger });

    const arrival = meter.begin({
      amount: '1000',
      destination: 'g.toon.swap.maker',
      sourceAccount: 'g.toon.relay.client01',
      sourcePeer: 'client01',
    });
    arrival.note({ innerKind: 20032, pair: 'USDC:evm:1>USDC:evm:2' });
    arrival.classify('legacy');
    arrival.finish({ accept: true });

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.event).toBe(SWAP_INTAKE_EVENT);
    expect(line?.fields).toMatchObject({
      class: 'legacy',
      accepted: true,
      innerKind: 20032,
      pair: 'USDC:evm:1>USDC:evm:2',
      peer: 'client01',
      sourceAccount: 'g.toon.relay.client01',
      amount: '1000',
      destination: 'g.toon.swap.maker',
    });
  });

  it('finish() is idempotent — a double call cannot double-count', () => {
    const { logger, lines } = capturing();
    const meter = createSwapIntakeMeter({ logger });
    const arrival = meter.begin({});
    arrival.classify('rolling-rfq');
    arrival.finish({ accept: true });
    arrival.finish({ accept: true });
    expect(lines).toHaveLength(1);
    expect(meter.report().classes['rolling-rfq'].total).toBe(1);
  });

  it('falls back to the ILP source address when no BTP peer id is reported', () => {
    const { logger, lines } = capturing();
    const meter = createSwapIntakeMeter({ logger });
    const arrival = meter.begin({ sourceAccount: 'g.toon.client.sender' });
    arrival.classify('legacy');
    arrival.finish({ accept: false, code: 'T04' });
    expect(lines[0]?.fields['peer']).toBe('g.toon.client.sender');
    expect(meter.report().legacyPeers).toEqual([
      { peer: 'g.toon.client.sender', count: 1, lastAt: expect.any(String) },
    ]);
  });

  it('records an unclassified arrival rather than losing it', () => {
    const { logger, lines } = capturing();
    const meter = createSwapIntakeMeter({ logger });
    meter.begin({}).finish();
    expect(lines[0]?.fields).toMatchObject({
      class: 'refused',
      reason: UNCLASSIFIED_REASON,
      accepted: false,
    });
  });

  it('a logger that throws cannot escape into the packet path', () => {
    const meter = createSwapIntakeMeter({
      logger: {
        info: () => {
          throw new Error('sink is on fire');
        },
      },
    });
    const arrival = meter.begin({});
    arrival.classify('rolling-fill');
    expect(() => arrival.finish({ accept: true })).not.toThrow();
    // The count still landed — the throw happens after the counter bump.
    expect(meter.report().classes['rolling-fill'].total).toBe(1);
  });
});

describe('swap intake meter — the report', () => {
  it('counts per class, splitting accepted from rejected', () => {
    const meter = createSwapIntakeMeter({});
    const drive = (cls: SwapIntakeClass, accept: boolean): void => {
      const a = meter.begin({ sourcePeer: 'peer-a' });
      a.classify(cls);
      a.finish({ accept });
    };
    drive('legacy', true);
    drive('legacy', false);
    drive('rolling-rfq', true);
    drive('rolling-fill', true);

    const report = meter.report();
    expect(report.total).toBe(4);
    expect(report.classes.legacy).toMatchObject({
      total: 2,
      accepted: 1,
      rejected: 1,
    });
    expect(report.classes['rolling-rfq'].total).toBe(1);
    expect(report.classes['rolling-fill'].total).toBe(1);
    expect(report.classes.refused.total).toBe(0);
    expect(report.classes.refused.lastAt).toBeNull();
    // "Who is still on legacy" — the whole point of the stage.
    expect(report.legacyPeers).toEqual([
      { peer: 'peer-a', count: 2, lastAt: expect.any(String) },
    ]);
  });

  it('tallies refusal reasons and omits the ones that never fired', () => {
    const meter = createSwapIntakeMeter({});
    for (const reason of ['condition_required', 'condition_required']) {
      const a = meter.begin({});
      a.classify('refused', { reason });
      a.finish({ accept: false, code: 'F99' });
    }
    expect(meter.report().reasons).toEqual({ condition_required: 2 });
  });

  it('makes an in-process reset visible: since/windowSec bound every count', () => {
    let clock = 1_000_000;
    const meter = createSwapIntakeMeter({ now: () => clock });
    clock += 3_600_000;
    const report = meter.report();
    expect(report.since).toBe(new Date(1_000_000).toISOString());
    expect(report.windowSec).toBe(3600);
    // The note has to say plainly that a Watchtower recreate zeroes these.
    expect(report.note).toMatch(/in-process/);
    expect(report.note).toMatch(/swap\.intake/);
  });

  it('bounds the legacy-peer table and says so when it stops growing', () => {
    const meter = createSwapIntakeMeter({ maxTrackedPeers: 2 });
    for (const peer of ['a', 'b', 'c', 'd']) {
      const arrival = meter.begin({ sourcePeer: peer });
      arrival.classify('legacy');
      arrival.finish({ accept: true });
    }
    const report = meter.report();
    expect(report.legacyPeers).toHaveLength(2);
    expect(report.legacyPeersTruncated).toBe(true);
    // Every arrival is still counted — only the per-peer attribution is capped.
    expect(report.classes.legacy.total).toBe(4);
  });

  it('never attributes a peer to a non-legacy class table', () => {
    const meter = createSwapIntakeMeter({});
    const arrival = meter.begin({ sourcePeer: 'rolling-peer' });
    arrival.classify('rolling-fill');
    arrival.finish({ accept: true });
    expect(meter.report().legacyPeers).toEqual([]);
  });
});
