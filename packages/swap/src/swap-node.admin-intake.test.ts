/**
 * Issue #171 (ADR 0003's removal gate) — `GET /admin/intake` + durability
 * across a restart.
 *
 * swap#152 emitted `swap.intake.arrival` log lines, but the gate reads
 * "no legacy for N consecutive days" and a log line dies with the
 * container on every `swap:release` Watchtower recreate. These tests boot
 * a real `startSwapNode()`, drive real packets through the connector-facing
 * handler (matching `swap-node.intake.test.ts`), and assert on the
 * PERSISTED read surface rather than the log — including across a
 * simulated restart, which is the whole point of the ledger.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { wrapSwapPacketToToon } from '@toon-protocol/sdk';
import type { UnsignedEvent } from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';
import { ROLLING_RFQ_REQUEST_KIND } from './rolling-rfq.js';
import type { AdminIntakeReport } from './admin-surface.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN = 'evm:8453';
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swap-intake-admin-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface PacketRequest {
  amount: string;
  destination: string;
  data: string;
}
interface PacketResponse {
  accept: boolean;
}
type PacketHandlerFn = (
  request: PacketRequest,
  sourcePeer?: string
) => Promise<PacketResponse>;

async function bootNode(overrides?: Partial<SwapNodeConfig>): Promise<{
  instance: SwapNodeInstance;
  handler: PacketHandlerFn;
}> {
  let captured: PacketHandlerFn | undefined;
  const connector = {
    sendPacket: async () => ({
      type: 'reject' as const,
      code: 'F02',
      message: 'no route (fixture)',
    }),
    registerPeer: async () => undefined,
    removePeer: async () => undefined,
    setPacketHandler: (h: unknown) => {
      captured = h as PacketHandlerFn;
    },
    close: async () => undefined,
  } as unknown as SwapNodeConfig['connector'];

  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector,
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        rate: '1.0',
        minAmount: '1000',
        maxAmount: '25000000',
      },
    ],
    chains: ['evm'],
    channels: {
      [CHAIN]: [
        {
          channelId: '0x' + 'cd'.repeat(32),
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [CHAIN]: 1_000_000_000n },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: CHAIN,
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        tokenNetworkAddress: '0x' + '44'.repeat(20),
        channelAddress: '0x' + '33'.repeat(20),
      },
    ],
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    ...overrides,
  });
  if (!captured) throw new Error('setPacketHandler was never called');
  return { instance, handler: captured };
}

function senderKeys(): { secretKey: Uint8Array; pubkey: string } {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

function legacySwapDataB64(
  senderSecretKey: Uint8Array,
  makerPubkey: string
): string {
  const rumor = {
    kind: 20032,
    content: '',
    tags: [
      ['swap-from', `USDC:${CHAIN}`],
      ['swap-to', `USDC:${CHAIN}`],
      ['chain-recipient', CHAIN_RECIPIENT],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: '',
  } as unknown as UnsignedEvent;
  const { ilpPrepare } = wrapSwapPacketToToon({
    rumor,
    senderSecretKey,
    recipientPubkey: makerPubkey,
    destination: 'g.toon.swap.x',
    amount: 1000n,
  });
  return ilpPrepare.data;
}

function rfqDataB64(senderSecretKey: Uint8Array, makerPubkey: string): string {
  const rumor = {
    kind: ROLLING_RFQ_REQUEST_KIND,
    content: JSON.stringify({
      proto: 'rolling/1',
      type: 'rfq',
      streamNonce: '2a'.repeat(16),
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
      },
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: 'g.toon.client.sender01',
    }),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: '',
  } as unknown as UnsignedEvent;
  const { ilpPrepare } = wrapSwapPacketToToon({
    rumor,
    senderSecretKey,
    recipientPubkey: makerPubkey,
    destination: 'g.toon.swap.x',
    amount: 1000n,
  });
  return ilpPrepare.data;
}

async function fetchIntake(instance: SwapNodeInstance): Promise<AdminIntakeReport> {
  const res = await fetch(`http://127.0.0.1:${instance.blsPort}/admin/intake`);
  expect(res.status).toBe(200);
  return (await res.json()) as AdminIntakeReport;
}

describe('GET /admin/intake', () => {
  it('[P0] a fresh boot reports all four classes at zero, with `since` set', async () => {
    const { instance } = await bootNode();
    try {
      const report = await fetchIntake(instance);
      expect(report.classes.map((c) => c.class).sort()).toEqual(
        ['legacy', 'refused', 'rolling-fill', 'rolling-rfq'].sort()
      );
      for (const c of report.classes) {
        expect(c.count).toBe(0);
        expect(c.firstSeenAt).toBeUndefined();
        expect(c.lastSeenAt).toBeUndefined();
      }
      expect(report.since).toBeLessThanOrEqual(report.generatedAt);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a legacy arrival is reflected in the read surface, not just the log', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, instance.identity.pubkey),
      });
      const report = await fetchIntake(instance);
      const legacy = report.classes.find((c) => c.class === 'legacy');
      expect(legacy?.count).toBe(1);
      expect(legacy?.firstSeenAt).toBe(legacy?.lastSeenAt);
      const rfq = report.classes.find((c) => c.class === 'rolling-rfq');
      expect(rfq?.count).toBe(0);
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a rolling-rfq arrival (classified inside rolling-rfq.ts) also lands in the ledger', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      const res = await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: rfqDataB64(sender.secretKey, instance.identity.pubkey),
      });
      expect(res.accept).toBe(true);
      const report = await fetchIntake(instance);
      const rfq = report.classes.find((c) => c.class === 'rolling-rfq');
      expect(rfq?.count).toBe(1);
    } finally {
      await instance.stop();
    }
  });
});

describe('issue #171 — intake ledger durability across a restart', () => {
  it('[P0] defaults beside statePath, and counts + `since` survive a simulated Watchtower recreate', async () => {
    const dir = makeTmpDir();
    const statePath = join(dir, 'swap-state.json');
    const sender = senderKeys();

    const first = await bootNode({ statePath });
    let firstReport: AdminIntakeReport;
    try {
      await first.handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, first.instance.identity.pubkey),
      });
      firstReport = await fetchIntake(first.instance);
      expect(firstReport.classes.find((c) => c.class === 'legacy')?.count).toBe(1);
    } finally {
      await first.instance.stop();
    }

    // The default ledger path lands beside statePath, on the same durable
    // volume — not a location a Watchtower recreate wipes.
    expect(existsSync(join(dir, 'intake-ledger.json'))).toBe(true);

    // A fresh process, same statePath — exactly what a container recreate is.
    const second = await bootNode({ statePath });
    try {
      const secondReport = await fetchIntake(second.instance);
      const legacy = secondReport.classes.find((c) => c.class === 'legacy');
      expect(legacy?.count).toBe(1);
      expect(legacy?.lastSeenAt).toBe(firstReport.classes.find((c) => c.class === 'legacy')?.lastSeenAt);
      expect(secondReport.since).toBe(firstReport.since);

      await second.handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, second.instance.identity.pubkey),
      });
      const thirdReport = await fetchIntake(second.instance);
      expect(thirdReport.classes.find((c) => c.class === 'legacy')?.count).toBe(2);
    } finally {
      await second.instance.stop();
    }
  });

  it('[P1] an explicit intakeLedgerPath overrides the statePath-relative default', async () => {
    const dir = makeTmpDir();
    const statePath = join(dir, 'swap-state.json');
    const intakeLedgerPath = join(dir, 'custom', 'ledger.json');

    const { instance } = await bootNode({ statePath, intakeLedgerPath });
    try {
      expect(existsSync(intakeLedgerPath)).toBe(false); // nothing recorded yet
    } finally {
      await instance.stop();
    }

    const sender = senderKeys();
    const second = await bootNode({ statePath, intakeLedgerPath });
    try {
      await second.handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, second.instance.identity.pubkey),
      });
      expect(existsSync(intakeLedgerPath)).toBe(true);
      expect(existsSync(join(dir, 'intake-ledger.json'))).toBe(false);
    } finally {
      await second.instance.stop();
    }
  });

  it('[P0] a corrupt intake-ledger file starts empty rather than crash the maker (contrast statePath)', async () => {
    const dir = makeTmpDir();
    const statePath = join(dir, 'swap-state.json');
    const ledgerPath = join(dir, 'intake-ledger.json');
    writeFileSync(ledgerPath, '{ not json', 'utf-8');

    const { instance } = await bootNode({ statePath });
    try {
      const report = await fetchIntake(instance);
      expect(report.classes.every((c) => c.count === 0)).toBe(true);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] a ledger write failure never rejects a swap (record() is best-effort)', async () => {
    const dir = makeTmpDir();
    // Point the ledger at a path whose parent cannot be created (a file
    // occupying where a directory needs to go), forcing every save() to
    // throw — the swap must still be accepted.
    const blockerFile = join(dir, 'blocker');
    writeFileSync(blockerFile, 'x', 'utf-8');
    const intakeLedgerPath = join(blockerFile, 'intake-ledger.json');

    const sender = senderKeys();
    const { instance, handler } = await bootNode({ intakeLedgerPath });
    try {
      const res = await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, instance.identity.pubkey),
      });
      expect(res.accept).toBe(true);
    } finally {
      await instance.stop();
    }
  });

  it('[P1] with no statePath and no intakeLedgerPath, the ledger still counts in-memory', async () => {
    const sender = senderKeys();
    const { instance, handler } = await bootNode();
    try {
      await handler({
        amount: '1000',
        destination: 'g.toon.swap.x',
        data: legacySwapDataB64(sender.secretKey, instance.identity.pubkey),
      });
      const report = await fetchIntake(instance);
      expect(report.classes.find((c) => c.class === 'legacy')?.count).toBe(1);
    } finally {
      await instance.stop();
    }
  });
});
