/**
 * Issue #102 — kind:10032 advertises `tokenNetworks` (the deployed
 * `RollingSwapChannel` address, the EIP-712 `verifyingContract`) and
 * `settlementAddresses` (the swap node's own payout address) for every
 * chain a swap pair targets.
 *
 * Without this a stock client can sign/verify the v2 digest (#101) but
 * still can't reconstruct the EIP-712 domain from the maker's peer-info,
 * and rejects the claim with `MISSING_CHAIN_CONFIG`.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { recoverEvmClaimSigner } from '@toon-protocol/settlement-digest';

import { startSwapNode, parseEvmChainId } from './swap-node.js';
import type {
  SwapNodeConfig,
  SwapNodeEvmChainProvider,
  SwapNodeInstance,
} from './swap-node.js';
import { ROLLING_PROTOCOL } from './rolling-engine.js';
import type { LegBPrepare, RollingAdvancePayload } from './rolling-engine.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const EVM_CHAIN_A = 'evm:8453';
const EVM_CHAIN_B = 'evm:84532';
const SOLANA_CHAIN = 'solana:devnet';
const CHANNEL_ADDRESS_A = '0x' + 'aa'.repeat(20);
const CHANNEL_ADDRESS_B = '0x' + 'bb'.repeat(20);
const STREAM_NONCE = '1f'.repeat(16);
const CHAIN_RECIPIENT = '0x' + '11'.repeat(20);

type SwapNodePair = SwapNodeConfig['swapPairs'][number];
type ChannelEntry = SwapNodeConfig['channels'][string][number];

/** The per-test half of the config; {@link bootAndCapturePeerInfo} supplies the rest. */
type PeerInfoTestConfig = Omit<
  SwapNodeConfig,
  | 'mnemonic'
  | 'connector'
  | 'relayUrls'
  | 'blsPort'
  | 'publisher'
  | '__testHooks'
>;

/** The kind:10032 fields this suite reads back off the built event. */
interface PeerInfoContent {
  tokenNetworks?: Record<string, string>;
  settlementAddresses?: Record<string, string>;
  swapPairs?: SwapNodePair[];
}

type PacketHandlerFn = (request: {
  amount: string;
  destination: string;
  data: string;
  executionCondition?: string;
  expiresAt?: string;
}) => Promise<{ accept: boolean; code?: string; fulfillment?: string }>;

/** Narrow an optional wire field to its value, or fail the test naming it. */
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}

function usdcPair(chain: string): SwapNodePair {
  return {
    from: { assetCode: 'USDC', assetScale: 6, chain },
    to: { assetCode: 'USDC', assetScale: 6, chain },
    rate: '1.0',
  };
}

function channelEntry(channelId: string): ChannelEntry {
  return { channelId, cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 };
}

function evmProvider(
  chainId: string,
  channelAddress: string
): SwapNodeEvmChainProvider {
  return {
    chainType: 'evm',
    chainId,
    rpcUrl: 'http://127.0.0.1:1',
    registryAddress: '0x' + '11'.repeat(20),
    tokenAddress: '0x' + '22'.repeat(20),
    channelAddress,
  };
}

/**
 * No-op connector stub so boot never dials a real embedded connector, plus
 * capture of the packet handler the swap node registers on it.
 */
function stubConnector(): {
  connector: SwapNodeConfig['connector'];
  handler: () => PacketHandlerFn;
} {
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
  };
  return {
    connector: connector as unknown as SwapNodeConfig['connector'],
    handler: () => {
      if (!captured) throw new Error('setPacketHandler was never called');
      return captured;
    },
  };
}

async function bootAndCapturePeerInfo(config: PeerInfoTestConfig): Promise<{
  instance: SwapNodeInstance;
  content: PeerInfoContent;
  handler: () => PacketHandlerFn;
}> {
  const { connector, handler } = stubConnector();
  let captured: { content: string } | undefined;
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector,
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    __testHooks: {
      onPeerInfoBuilt: (event) => {
        captured = event as { content: string };
      },
    },
    ...config,
  });
  if (!captured) throw new Error('onPeerInfoBuilt was never called');
  return {
    instance,
    content: JSON.parse(captured.content) as PeerInfoContent,
    handler,
  };
}

describe('kind:10032 advertises verifyingContract + payout address (#102)', () => {
  it('[P0] carries tokenNetworks[chain] = the configured RollingSwapChannel address and settlementAddresses[chain] = the derived EVM address, for every chain a pair targets', async () => {
    const { instance, content } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [usdcPair(EVM_CHAIN_A)],
      channels: { [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))] },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n },
      chainProviders: [evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A)],
    });
    try {
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: CHANNEL_ADDRESS_A,
      });
      expect(content.settlementAddresses).toEqual({
        [EVM_CHAIN_A]: instance.swapNodeKeys.evm?.address.toLowerCase(),
      });
    } finally {
      await instance.stop();
    }
  });

  it('[P0] advertises a distinct tokenNetworks entry per distinct EVM chain, and excludes chains no pair targets', async () => {
    const { instance, content } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [usdcPair(EVM_CHAIN_A), usdcPair(EVM_CHAIN_B)],
      channels: {
        [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))],
        [EVM_CHAIN_B]: [channelEntry('0x' + 'ef'.repeat(32))],
      },
      inventory: {
        [EVM_CHAIN_A]: 1_000_000_000n,
        [EVM_CHAIN_B]: 1_000_000_000n,
      },
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A),
        evmProvider(EVM_CHAIN_B, CHANNEL_ADDRESS_B),
        // A third, unreferenced EVM chain — its channelAddress MUST NOT leak
        // into tokenNetworks since no swap pair targets it.
        evmProvider('evm:1', '0x' + 'ff'.repeat(20)),
      ],
    });
    try {
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: CHANNEL_ADDRESS_A,
        [EVM_CHAIN_B]: CHANNEL_ADDRESS_B,
      });
      // Byte-identical to the chain key form the same announce's swapPairs
      // carry (the key the signer binds into the EIP-712 domain) — the
      // advertised key is never renamed or normalized.
      expect(Object.keys(content.tokenNetworks ?? {}).sort()).toEqual(
        (content.swapPairs ?? []).map((p) => p.to.chain).sort()
      );
    } finally {
      await instance.stop();
    }
  });

  it('[P1] settlementAddresses covers non-EVM chains too, but tokenNetworks (EVM-specific) does not', async () => {
    const { instance, content } = await bootAndCapturePeerInfo({
      chains: ['evm', 'solana'],
      swapPairs: [usdcPair(EVM_CHAIN_A), usdcPair(SOLANA_CHAIN)],
      channels: {
        [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))],
        [SOLANA_CHAIN]: [channelEntry('11'.repeat(32))],
      },
      inventory: {
        [EVM_CHAIN_A]: 1_000_000_000n,
        [SOLANA_CHAIN]: 1_000_000_000n,
      },
      chainProviders: [evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A)],
    });
    try {
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: CHANNEL_ADDRESS_A,
      });
      expect(content.settlementAddresses).toEqual({
        [EVM_CHAIN_A]: instance.swapNodeKeys.evm?.address.toLowerCase(),
        [SOLANA_CHAIN]: expect.any(String),
      });
    } finally {
      await instance.stop();
    }
  });

  it('[P0] a real leg-B claim recovers to settlementAddresses[chain] under the EIP-712 domain reconstructed from the announce alone', async () => {
    // The end-to-end form of the "advertised key == signed key" property: a
    // client that only ever sees this announce (chainId parsed out of the
    // chain key, verifyingContract from tokenNetworks) must recover the
    // maker's advertised payout address from a claim the node really signed.
    const legBCalls: LegBPrepare[] = [];
    const preimage = new Uint8Array(32);
    globalThis.crypto.getRandomValues(preimage);
    const { instance, content, handler } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [usdcPair(EVM_CHAIN_A)],
      channels: { [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))] },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n },
      chainProviders: [evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A)],
      rollingLegBSender: async (prepare) => {
        legBCalls.push(prepare);
        return { type: 'fulfill', fulfillment: preimage };
      },
    });
    try {
      instance.registerRollingSession({
        streamNonce: STREAM_NONCE,
        pair: usdcPair(EVM_CHAIN_A),
        chainRecipient: CHAIN_RECIPIENT,
        senderIlpAddress: 'g.toon.client.sender01',
        senderPubkey: 'e'.repeat(64),
      });
      const res = await handler()({
        amount: '250000',
        destination: 'g.toon.swap.x',
        data: Buffer.from(
          JSON.stringify({
            proto: ROLLING_PROTOCOL,
            type: 'fill',
            streamNonce: STREAM_NONCE,
            seq: 1,
          }),
          'utf8'
        ).toString('base64'),
        executionCondition: Buffer.from(sha256(preimage)).toString('base64'),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(res.accept).toBe(true);

      const prepare = required(legBCalls[0], 'leg-B prepare');
      const advance = JSON.parse(
        prepare.data.toString('utf8')
      ) as RollingAdvancePayload;
      // Everything the verifier needs comes off the announce: the chain key
      // from its swapPairs, the contract from its tokenNetworks.
      const advertised = required(content.tokenNetworks, 'tokenNetworks');
      const pairs = required(content.swapPairs, 'swapPairs');
      const chain = required(pairs[0], 'swapPairs[0]').to.chain;
      const recovered = recoverEvmClaimSigner(
        {
          channelId: required(advance.channelId, 'claim channelId'),
          cumulativeAmount: required(
            advance.cumulativeAmount,
            'claim cumulativeAmount'
          ),
          nonce: required(advance.nonce, 'claim nonce'),
          recipient: required(advance.recipient, 'claim recipient'),
          chainId: parseEvmChainId(chain),
          verifyingContract: required(
            advertised[chain],
            `tokenNetworks[${chain}]`
          ),
        },
        Buffer.from(advance.claim, 'base64')
      );
      expect(recovered).toBe(
        required(content.settlementAddresses, 'settlementAddresses')[chain]
      );
    } finally {
      await instance.stop();
    }
  });
});
