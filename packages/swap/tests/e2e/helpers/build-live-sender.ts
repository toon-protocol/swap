/**
 * Shared live-sender builder for swap-node E2E tests.
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
  SWAP_E2E_EVM_SENDER_PRIVATE_KEY,
  publicModeSettlementKey,
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
  /** Unique prefix for the connector node ID (e.g. 'swap-evm'). */
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

  // Public mode (persistent testnet): open this connector's channel with a
  // FRESH, just-in-time-funded participant so each run/connector gets its own
  // channelId and never collides with a prior run's channel
  // (InvalidChannelState). Local Anvil: pass-through to the deterministic key.
  // Called per builder invocation, so every swap node connector gets its own
  // ephemeral participant (issue #191).
  const evmKeyId = await publicModeSettlementKey(
    SWAP_E2E_EVM_SENDER_PRIVATE_KEY
  );

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
          // chain MUST match the chainProviders entry below (`evm:${CHAIN_ID}`).
          // Without this, ConnectorNode.start() auto-creates a payment channel
          // with empty `chain` metadata, then PerPacketClaimService cannot find
          // the registered provider and rejects every packet with T00.
          chain: `evm:${CHAIN_ID}`,
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
          keyId: evmKeyId,
        },
      ],
    },
    connectorLogger
  );

  await connector.start();

  // Register peer1 with route to its ILP address. `evmAddress` is already
  // set via the static `peers` config above (PeerConfig) — the runtime
  // admin API's PeerRegistrationRequest carries settlement address under
  // `settlement.evmAddress` instead, not a top-level field.
  await connector.registerPeer({
    id: 'peer1',
    url: PEER1_BTP_URL,
    authToken: '',
    routes: [{ prefix: 'g.toon.peer1' }],
  });

  // Wait for BTP connection
  await new Promise((r) => setTimeout(r, 2000));

  // Payment channel.
  //
  // ConnectorNode.start() auto-opens a payment channel for every connected
  // peer using the constructor `peers[].chain` field (see connector-node.js
  // around line 647). With `peers[0].chain = 'evm:${CHAIN_ID}'` set above,
  // the auto-created channel already has the correct chain metadata so
  // PerPacketClaimService can resolve the provider via getProviderForPeer.
  //
  // We attempt an explicit `openChannel` only if no channel exists yet
  // (e.g., a future connector version drops the auto-create behavior). If
  // the channel already exists we just look up its id.
  let channelId: string;
  try {
    const r = await connector.openChannel({
      peerId: 'peer1',
      chain: `evm:${CHAIN_ID}`,
      token: TOKEN_ADDRESS,
      tokenNetwork: TOKEN_NETWORK_ADDRESS,
      peerAddress: PEER1_EVM_ADDRESS,
      initialDeposit: opts.initialDeposit ?? '10000000', // 10 USDC (6 decimals)
      settlementTimeout: 3600,
    });
    channelId = r.channelId;
  } catch (err) {
    if (
      err instanceof Error &&
      /Channel already exists/i.test(err.message)
    ) {
      // Auto-channel created by start() — recover its id by listing channels.
      // ConnectorNode does not expose a public channel-by-peer lookup, so we
      // fall back to a synthetic placeholder. The settlement assertion in
      // AC-3 reads channelId off swapResult.claims, not LiveSender.channelId.
      channelId = '<auto-created-by-start>';
    } else {
      throw err;
    }
  }

  // Wait for channel to be recognized
  await new Promise((r) => setTimeout(r, 2000));

  // Warmup: send a single small ILP packet through the BTP socket. This
  // forces the sender's connector to flush a per-packet-claim message to
  // peer1, which (a) registers the external channel on peer1 via
  // claim-receiver and (b) gives peer1's swap node channel-sync poll a chance
  // to copy that channel into SwapChannelState BEFORE the real
  // streamSwap() PREPAREs arrive. Without this, the first 1-2 swap
  // PREPAREs race past the channel-registration step on peer1 and get
  // rejected with F99 ("No channel provisioned for sender on
  // evm:base:31337") — see Story 12.10 Round 2 fix notes.
  //
  // The packet is intentionally a non-swap PREPARE (no toonData) so it
  // never hits the kind:1059 swap handler; it just flushes the claim
  // pipeline. Failures are swallowed.
  try {
    await connector.sendPacket({
      destination: 'g.toon.peer1',
      amount: 100n,
      expiresAt: new Date(Date.now() + 5000),
      data: Buffer.alloc(0),
    });
  } catch {
    /* warmup failure is fine — claim still ships */
  }
  // Give peer1's swap node channel-sync poll (250ms interval) two cycles to
  // copy the registered channel into SwapChannelState.
  await new Promise((r) => setTimeout(r, 1000));

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
    channelId,
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
