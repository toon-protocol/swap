/**
 * Issue #45 — sdk 2.x / connector 3.20.x migration: embedded child-connector
 * boot smoke test.
 *
 * The dependency bump (sdk ^0.5 → ^2, connector ^3.10 → ^3.20) had no
 * runtime coverage of the `connectorUrl` auto-create path: the integration
 * fixture injects a fake connector, and the docker E2E harness cannot run in
 * this repo (see docs/sdk-2x-migration.md). This test boots a REAL
 * `ConnectorNode` from the installed `@toon-protocol/connector` and pins the
 * three load-bearing behaviors of the child boot:
 *
 *   1. The parent peer config (`relation: 'parent'`, self-route + default-up
 *      route) is accepted by the connector constructor — a rename or schema
 *      change there would fire `swap.connector.auto_create_failed` and the
 *      swap node would silently boot connectorless.
 *   2. The `setPacketHandler` local-delivery seam still exists on the real
 *      connector (`swap.connector.packet_handler_wired`); without it inbound
 *      kind:1059 swap packets can never reach the swap handler.
 *   3. Boot MUST NOT abort when the parent is unreachable (R-8N2 — the BTP
 *      dial retries in the background), and `stop()` tears the auto-created
 *      connector down cleanly.
 */

import { describe, it, expect } from 'vitest';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig } from './swap-node.js';

const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Ephemeral-range BTP port; singleFork-free suite so keep it randomized. */
const BTP_PORT = 20000 + Math.floor(Math.random() * 20000);

function buildConfig(events: string[]): SwapNodeConfig {
  return {
    mnemonic: FIXTURE_MNEMONIC,
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
        rate: '1.0',
      },
    ],
    chains: ['evm'],
    channels: {
      'evm:8453': [
        {
          channelId: '0x' + 'ab'.repeat(31) + '01',
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { 'evm:8453': 1_000_000n },
    relayUrls: ['ws://127.0.0.1:1'],
    blsPort: 0,
    // Unreachable parent: nothing listens on port 1. Boot must still succeed.
    connectorUrl: 'ws://127.0.0.1:1',
    parentPeerId: 'apex',
    btpServerPort: BTP_PORT,
    logger: {
      debug: (event) => {
        if (typeof event === 'string') events.push(event);
      },
      info: (event) => {
        if (typeof event === 'string') events.push(event);
      },
      warn: (event) => {
        if (typeof event === 'string') events.push(event);
      },
      error: (event) => {
        if (typeof event === 'string') events.push(event);
      },
    },
  };
}

describe('embedded child-connector boot (connector migration smoke, #45)', () => {
  it('[P0] auto-creates a real ConnectorNode with a parent peer and survives an unreachable parent', async () => {
    const events: string[] = [];
    const instance = await startSwapNode(buildConfig(events));
    try {
      // The auto-create path accepted the parent-peer + routes config on the
      // REAL installed connector (no constructor rejection).
      expect(events).toContain('swap.connector.embedded_with_parent');
      expect(events).not.toContain('swap.connector.auto_create_failed');

      // The local-delivery seam is intact on the real connector.
      expect(events).toContain('swap.connector.packet_handler_wired');
      expect(events).not.toContain('swap.connector.packet_handler_unavailable');

      // R-8N2: connector .start() resolved despite the dead parent.
      expect(events).toContain('swap.connector.started');
      expect(events).not.toContain('swap.connector.start_failed');

      expect(instance.connector).toBeDefined();
      expect(typeof instance.connector?.setPacketHandler).toBe('function');
    } finally {
      await instance.stop();
    }
  }, 20_000);
});
