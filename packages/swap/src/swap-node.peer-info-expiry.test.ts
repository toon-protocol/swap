/**
 * A kind:10032 announce with no NIP-40 `expiration` tag is permanent litter.
 *
 * kind:10032 is a REPLACEABLE event: a relay keeps the latest one per author
 * forever, and the only retraction path is a newer event signed by the same
 * key. When that key is gone the advertisement can never be replaced, never be
 * NIP-09-deleted, and never be aged out — it just keeps telling every client
 * that some dead node terminates a destination at some dead BTP endpoint. The
 * live example this suite exists for is devnet's `b23599a6…` /
 * `g.toon.swap.sol`, published by this very code path from a throwaway rig,
 * advertising a `ws://127.0.0.1:3401` loopback literal, and unretractable by
 * anyone.
 *
 * The fix is two inseparable halves, and this suite pins both:
 *
 *  1. the announce carries `["expiration", created_at + ttl]`, so a relay
 *     enforcing NIP-40 (relay#137) stops serving it once this node stops; and
 *  2. a refresh loop republishes well inside that window, so a node that is
 *     still ALIVE never expires out of discovery. Half 1 without half 2 would
 *     be a self-inflicted outage: one publish at boot, then silence.
 */
import { describe, it, expect } from 'vitest';

import { startSwapNode } from './swap-node.js';
import type {
  SwapNodeConfig,
  SwapNodeEvmChainProvider,
  SwapNodeInstance,
} from './swap-node.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const EVM_CHAIN = 'evm:8453';

/** The fleet-wide `[announce] ttl_secs` default this publisher now matches. */
const FLEET_TTL_SECONDS = 600;

interface CapturedEvent {
  id: string;
  created_at: number;
  tags: string[][];
  content: string;
}

function evmProvider(): SwapNodeEvmChainProvider {
  return {
    chainType: 'evm',
    chainId: EVM_CHAIN,
    rpcUrl: 'http://127.0.0.1:1',
    registryAddress: '0x' + '11'.repeat(20),
    tokenAddress: '0x' + '22'.repeat(20),
    tokenNetworkAddress: '0x' + 'a1'.repeat(20),
    channelAddress: '0x' + 'aa'.repeat(20),
  };
}

/** No-op connector stub so boot never dials a real embedded connector. */
function stubConnector(): SwapNodeConfig['connector'] {
  return {
    sendPacket: async () => ({
      type: 'reject' as const,
      code: 'F02',
      message: 'no route (fixture)',
    }),
    registerPeer: async () => undefined,
    removePeer: async () => undefined,
    setPacketHandler: () => undefined,
    close: async () => undefined,
  } as unknown as SwapNodeConfig['connector'];
}

/**
 * Boot a swap node with a capturing publisher.
 *
 * Captures off `publisher.publish` rather than the `onPeerInfoBuilt` test hook
 * because the thing under test is what actually reaches the relay, and because
 * `waitForPublishes` needs to observe every ROUND, not just the first.
 */
async function bootCapturing(overrides: Partial<SwapNodeConfig> = {}): Promise<{
  instance: SwapNodeInstance;
  published: CapturedEvent[];
  waitForPublishes: (n: number) => Promise<void>;
}> {
  const published: CapturedEvent[] = [];
  let notify: (() => void) | undefined;

  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector: stubConnector(),
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    chains: ['evm'],
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        rate: '1.0',
      },
    ],
    channels: {
      [EVM_CHAIN]: [
        {
          channelId: '0x' + 'cd'.repeat(32),
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [EVM_CHAIN]: 1_000_000_000n },
    chainProviders: [evmProvider()],
    publisher: {
      publish: async (event: unknown) => {
        published.push(event as CapturedEvent);
        notify?.();
      },
    },
    ...overrides,
  });

  return {
    instance,
    published,
    waitForPublishes: (n: number) =>
      new Promise<void>((resolve, reject) => {
        const check = (): boolean => {
          if (published.length >= n) {
            notify = undefined;
            clearTimeout(timer);
            resolve();
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          notify = undefined;
          reject(
            new Error(
              `expected ${n} kind:10032 publishes, saw ${published.length}`
            )
          );
        }, 15_000);
        notify = check;
        check();
      }),
  };
}

/** The NIP-40 `expiration` tag value, or `undefined` when there is none. */
function expirationOf(event: CapturedEvent): number | undefined {
  const tag = event.tags.find((t) => t[0] === 'expiration');
  return tag?.[1] === undefined ? undefined : Number(tag[1]);
}

describe('kind:10032 carries a NIP-40 expiration and is refreshed inside it', () => {
  it('[P0] stamps the fleet-convention 600s TTL by default — no config key required to stop publishing permanent litter', async () => {
    const { instance, published, waitForPublishes } = await bootCapturing();
    try {
      await waitForPublishes(1);
      const event = published[0] as CapturedEvent;
      // The whole defect in one assertion: this tag used to be absent.
      expect(expirationOf(event)).toBe(event.created_at + FLEET_TTL_SECONDS);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] honours an explicit peerInfoTtlSeconds', async () => {
    const { instance, published, waitForPublishes } = await bootCapturing({
      peerInfoTtlSeconds: 1800,
    });
    try {
      await waitForPublishes(1);
      const event = published[0] as CapturedEvent;
      expect(expirationOf(event)).toBe(event.created_at + 1800);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] republishes on the refresh interval with a FRESH expiration — a live node must not expire out of discovery between its own announces', async () => {
    // The republish must re-SIGN, not re-send: a cached event carries a fixed
    // `created_at + ttl`, so resending it lets the expiry recede into the past
    // however often the loop runs — and the node silently drops out of
    // discovery while still cheerfully publishing.
    //
    // 700ms, not the 10ms the other cases use, precisely so the third round
    // lands at least one WHOLE SECOND after the first: `created_at` has
    // second granularity, so a re-signed event within the same second is
    // legitimately byte-identical and would prove nothing.
    const { instance, published, waitForPublishes } = await bootCapturing({
      peerInfoTtlSeconds: 600,
      peerInfoRefreshIntervalMs: 700,
    });
    try {
      await waitForPublishes(3);
      const [first, , third] = published as [
        CapturedEvent,
        CapturedEvent,
        CapturedEvent,
      ];
      expect(third.created_at).toBeGreaterThan(first.created_at);
      expect(third.id).not.toBe(first.id);
      // Every round's expiry is measured from ITS OWN publish time, so the
      // window keeps sliding forward for as long as this node is alive.
      for (const event of published) {
        expect(expirationOf(event)).toBe(event.created_at + 600);
      }
    } finally {
      await instance.stop();
    }
  });

  it('[P0] stop() ends the refresh loop — a stopped node must stop renewing its own liveness signal, or the TTL means nothing', async () => {
    const { instance, published, waitForPublishes } = await bootCapturing({
      peerInfoRefreshIntervalMs: 10,
    });
    await waitForPublishes(3);
    await instance.stop();
    const afterStop = published.length;
    // Long enough for many refresh intervals to have elapsed.
    await new Promise((r) => setTimeout(r, 200));
    expect(published.length).toBe(afterStop);
  });

  it('[P0] peerInfoTtlSeconds <= 0 is the documented never-expires escape hatch, and is the only way back to the old behaviour', async () => {
    const { instance, published, waitForPublishes } = await bootCapturing({
      peerInfoTtlSeconds: 0,
    });
    try {
      await waitForPublishes(1);
      expect(expirationOf(published[0] as CapturedEvent)).toBeUndefined();
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a non-positive peerInfoRefreshIntervalMs publishes once and never again — opt-in, for a deployment where another publisher on this identity owns the refresh', async () => {
    const { instance, published, waitForPublishes } = await bootCapturing({
      peerInfoRefreshIntervalMs: 0,
    });
    try {
      await waitForPublishes(1);
      await new Promise((r) => setTimeout(r, 200));
      expect(published.length).toBe(1);
      // Still expiring: the TTL is independent of who refreshes it.
      expect(expirationOf(published[0] as CapturedEvent)).toBe(
        (published[0] as CapturedEvent).created_at + FLEET_TTL_SECONDS
      );
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a refresh interval longer than the TTL is reported at error — the one misconfiguration that is worse than the litter this TTL exists to stop', async () => {
    const errors: string[] = [];
    const { instance, waitForPublishes } = await bootCapturing({
      peerInfoTtlSeconds: 10,
      peerInfoRefreshIntervalMs: 60_000,
      logger: {
        error: (msg: string) => {
          errors.push(msg);
        },
      } as unknown as SwapNodeConfig['logger'],
    });
    try {
      await waitForPublishes(1);
      expect(errors).toContain('swap.peerInfo.refresh_slower_than_ttl');
    } finally {
      await instance.stop();
    }
  });

  it('[P0] boots with neither key set — the TTL must never become a required config key, because this fleet auto-deploys on green main', async () => {
    const { instance, published, waitForPublishes } = await bootCapturing();
    try {
      await waitForPublishes(1);
      expect(published.length).toBeGreaterThan(0);
    } finally {
      await instance.stop();
    }
  });
});
