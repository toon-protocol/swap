/**
 * Shared live-sender builder for Mill E2E tests.
 *
 * Extracts the duplicated ConnectorNode + StreamSwapClient wiring that was
 * repeated across all four E2E test files (EVM, Solana, Mina, pair-matrix).
 * Each caller passes a unique port pair and optional overrides; the builder
 * returns a ready-to-use sender with an open BTP connection and payment channel.
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { StreamSwapParams } from '@toon-protocol/sdk';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';

import {
  PEER1_BTP_URL,
  PEER1_EVM_ADDRESS,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  REGISTRY_ADDRESS,
  CHAIN_ID,
  ANVIL_RPC,
  MILL_E2E_EVM_SENDER_PRIVATE_KEY,
} from './infra-gate.js';

export type StreamSwapClient = StreamSwapParams['client'];

export interface LiveSender {
  connector: ConnectorNode;
  client: StreamSwapClient;
  senderSecretKey: Uint8Array;
  senderPubkey: string;
  channelId: string;
  close: () => Promise<void>;
}

export interface BuildLiveSenderOptions {
  /** Unique prefix for the connector node ID (e.g. 'mill-evm'). */
  nodeIdPrefix: string;
  /** BTP server port — must be unique per test file to avoid conflicts. */
  btpServerPort: number;
  /** Health check port — must be unique per test file. */
  healthCheckPort: number;
  /** Logger name for the connector. */
  loggerName: string;
  /** Initial EVM deposit in smallest units (default: '10000000' = 10 USDC). */
  initialDeposit?: string;
}

/**
 * Build a live sender wired to peer1's BTP endpoint. Creates a ConnectorNode,
 * registers peer1 as a peer, opens a payment channel, and returns a
 * StreamSwapClient-compatible handle.
 *
 * Callers MUST call `sender.close()` in afterAll to release the BTP connection.
 */
export async function buildLiveSender(
  opts: BuildLiveSenderOptions
): Promise<LiveSender> {
  const senderSecretKey = generateSecretKey();
  const senderPubkey = getPublicKey(senderSecretKey);

  const connectorLogger = createLogger(opts.loggerName, 'warn');
  const connector = new ConnectorNode(
    {
      nodeId: `${opts.nodeIdPrefix}-${senderPubkey.slice(0, 8)}`,
      btpServerPort: opts.btpServerPort,
      healthCheckPort: opts.healthCheckPort,
      environment: 'development' as const,
      deploymentMode: 'embedded' as const,
      peers: [
        {
          id: 'peer1',
          url: PEER1_BTP_URL,
          authToken: '',
          evmAddress: PEER1_EVM_ADDRESS,
        },
      ],
      routes: [],
      localDelivery: { enabled: false },
      chainProviders: [
        {
          chainType: 'evm' as const,
          chainId: `evm:${CHAIN_ID}`,
          rpcUrl: ANVIL_RPC,
          registryAddress: REGISTRY_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          keyId: MILL_E2E_EVM_SENDER_PRIVATE_KEY,
        },
      ],
    },
    connectorLogger
  );

  await connector.start();

  // Register peer1 with route to its ILP address
  await connector.registerPeer({
    id: 'peer1',
    evmAddress: PEER1_EVM_ADDRESS,
    url: PEER1_BTP_URL,
    authToken: '',
    routes: [{ prefix: 'g.toon.peer1' }],
  });

  // Wait for BTP connection
  await new Promise((r) => setTimeout(r, 2000));

  // Open payment channel
  const result = await connector.openChannel({
    peerId: 'peer1',
    chain: `eip155:${CHAIN_ID}`,
    token: TOKEN_ADDRESS,
    tokenNetwork: TOKEN_NETWORK_ADDRESS,
    peerAddress: PEER1_EVM_ADDRESS,
    initialDeposit: opts.initialDeposit ?? '10000000', // 10 USDC (6 decimals)
    settlementTimeout: 3600,
  });

  // Wait for channel to be recognized
  await new Promise((r) => setTimeout(r, 2000));

  // Build StreamSwapClient shim that bridges connector.sendPacket() into the
  // StreamSwapClient interface expected by streamSwap().
  const client: StreamSwapClient = {
    async sendSwapPacket(params: {
      destination: string;
      amount: bigint;
      toonData: Uint8Array;
      timeout?: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claim?: any;
    }) {
      const expiresAt = new Date(Date.now() + (params.timeout ?? 30000));
      const ilpResult = await connector.sendPacket({
        destination: params.destination,
        amount: params.amount,
        expiresAt,
        data: Buffer.from(params.toonData),
      });

      if (ilpResult.type === 13) {
        // FULFILL (PacketType.FULFILL = 13) -- accepted
        const dataStr = ilpResult.data
          ? ilpResult.data.toString('base64')
          : undefined;
        return { accepted: true, data: dataStr };
      }
      // REJECT
      return {
        accepted: false,
        code: (ilpResult as { code?: string }).code ?? 'F00',
        message: (ilpResult as { message?: string }).message ?? 'rejected',
      };
    },
    getPublicKey() {
      return senderPubkey;
    },
  };

  return {
    connector,
    client,
    senderSecretKey,
    senderPubkey,
    channelId: result.channelId,
    close: async () => {
      try {
        await connector.stop();
      } catch {
        // Swallow — connector may already be disconnected (e.g., peer
        // went down during the test). Callers rely on close() resolving
        // so afterAll drain delays and Mina account releases execute.
      }
    },
  };
}
