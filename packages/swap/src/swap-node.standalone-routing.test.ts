/**
 * Issue #111 — standalone `startSwapNode` (btpServerPort mode, no
 * `connector`/`connectorUrl`) must wire a self-route for its own
 * `ilpAddress`. Without it, `ConnectorNode`'s routing table has no entry
 * for the node's own prefix, and `PacketHandler.handlePreparePacket`
 * F02-rejects every inbound packet addressed at the maker itself before
 * local dispatch ever runs — the standalone mode was unusable as shipped.
 *
 * This boots a REAL `ConnectorNode` (no fakes — a fake connector would
 * bypass the routing table entirely and couldn't have caught this) and
 * asserts its routing table resolves the node's own `ilpAddress` to
 * itself, mirroring the embedded-with-parent branch's existing self-route.
 */

import { describe, it, expect } from 'vitest';
import type { ConnectorNode } from '@toon-protocol/connector';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig } from './swap-node.js';

const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Ephemeral-range BTP port; singleFork-free suite so keep it randomized. */
const BTP_PORT = 20000 + Math.floor(Math.random() * 20000);

const ILP_ADDRESS = 'g.toon.swap.issue111-fixture';
/** Pinned so the self-route's `nextHop` has a known expected value. */
const NODE_ID = 'toon-swap-issue111-fixture';

function buildStandaloneConfig(): SwapNodeConfig {
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
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:8453',
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        tokenNetworkAddress: '0x' + '44'.repeat(20),
        channelAddress: '0x' + '33'.repeat(20),
      },
    ],
    relayUrls: ['ws://127.0.0.1:1'],
    blsPort: 0,
    // Standalone mode: no `connector`, no `connectorUrl` — just btpServerPort.
    btpServerPort: BTP_PORT,
    ilpAddress: ILP_ADDRESS,
    nodeId: NODE_ID,
  };
}

describe('standalone startSwapNode routing (issue #111)', () => {
  it('[P0] wires a self-route so packets addressed at its own ilpAddress resolve', async () => {
    const instance = await startSwapNode(buildStandaloneConfig());
    try {
      expect(instance.connector).toBeDefined();
      const connector = instance.connector as unknown as ConnectorNode;

      // Before the fix, routes: [] meant getNextHop() returned null here
      // and every inbound packet at our own address was F02-rejected.
      // `nextHop === nodeId` is what PacketHandler treats as local delivery
      // (packet-handler.js: `nextHop === this.nodeId || nextHop === 'local'`),
      // so a route pointing anywhere else would dodge the F02 without ever
      // reaching the swap handler.
      expect(connector.routingTable.getNextHop(ILP_ADDRESS)).toBe(NODE_ID);

      expect(connector.getRoutingTable()).toContainEqual(
        expect.objectContaining({ prefix: ILP_ADDRESS, nextHop: NODE_ID })
      );
    } finally {
      await instance.stop();
    }
  }, 20_000);
});
