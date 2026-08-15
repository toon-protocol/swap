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

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from './swap-node.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const EVM_CHAIN_A = 'evm:8453';
const EVM_CHAIN_B = 'evm:84532';
const SOLANA_CHAIN = 'solana:devnet';
const CHANNEL_ADDRESS_A = '0x' + 'aa'.repeat(20);
const CHANNEL_ADDRESS_B = '0x' + 'bb'.repeat(20);

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

async function bootAndCapturePeerInfo(
  overrides: Partial<SwapNodeConfig>
): Promise<{ instance: SwapNodeInstance; event: { content: string } }> {
  let captured: { content: string } | undefined;
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector: stubConnector(),
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    __testHooks: {
      onPeerInfoBuilt: (event) => {
        captured = event as { content: string };
      },
    },
    ...overrides,
  } as SwapNodeConfig);
  if (!captured) throw new Error('onPeerInfoBuilt was never called');
  return { instance, event: captured };
}

describe('kind:10032 advertises verifyingContract + payout address (#102)', () => {
  it('[P0] carries tokenNetworks[chain] = the configured RollingSwapChannel address and settlementAddresses[chain] = the derived EVM address, for every chain a pair targets', async () => {
    const { instance, event } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_A },
          to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_A },
          rate: '1.0',
        },
      ],
      channels: {
        [EVM_CHAIN_A]: [
          {
            channelId: '0x' + 'cd'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: EVM_CHAIN_A,
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x' + '11'.repeat(20),
          tokenAddress: '0x' + '22'.repeat(20),
          channelAddress: CHANNEL_ADDRESS_A,
        },
      ],
    });
    try {
      const content = JSON.parse(event.content) as {
        tokenNetworks?: Record<string, string>;
        settlementAddresses?: Record<string, string>;
      };
      expect(content.tokenNetworks).toEqual({ [EVM_CHAIN_A]: CHANNEL_ADDRESS_A });
      expect(content.settlementAddresses).toEqual({
        [EVM_CHAIN_A]: instance.swapNodeKeys.evm?.address.toLowerCase(),
      });
    } finally {
      await instance.stop();
    }
  });

  it('[P0] advertises a distinct tokenNetworks entry per distinct EVM chain, and excludes chains no pair targets', async () => {
    const { instance, event } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_A },
          to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_A },
          rate: '1.0',
        },
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_B },
          to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_B },
          rate: '1.0',
        },
      ],
      channels: {
        [EVM_CHAIN_A]: [
          {
            channelId: '0x' + 'cd'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
        [EVM_CHAIN_B]: [
          {
            channelId: '0x' + 'ef'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n, [EVM_CHAIN_B]: 1_000_000_000n },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: EVM_CHAIN_A,
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x' + '11'.repeat(20),
          tokenAddress: '0x' + '22'.repeat(20),
          channelAddress: CHANNEL_ADDRESS_A,
        },
        {
          chainType: 'evm',
          chainId: EVM_CHAIN_B,
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x' + '33'.repeat(20),
          tokenAddress: '0x' + '44'.repeat(20),
          channelAddress: CHANNEL_ADDRESS_B,
        },
        // A third, unreferenced EVM chain — its channelAddress MUST NOT leak
        // into tokenNetworks since no swap pair targets it.
        {
          chainType: 'evm',
          chainId: 'evm:1',
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x' + '55'.repeat(20),
          tokenAddress: '0x' + '66'.repeat(20),
          channelAddress: '0x' + 'ff'.repeat(20),
        },
      ],
    });
    try {
      const content = JSON.parse(event.content) as {
        tokenNetworks?: Record<string, string>;
        settlementAddresses?: Record<string, string>;
      };
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: CHANNEL_ADDRESS_A,
        [EVM_CHAIN_B]: CHANNEL_ADDRESS_B,
      });
      // Byte-identical to the chain key form used in swapPairs (the same key
      // the signer binds into the EIP-712 domain) — not renamed/normalized.
      expect(Object.keys(content.tokenNetworks ?? {}).sort()).toEqual(
        [EVM_CHAIN_A, EVM_CHAIN_B].sort()
      );
    } finally {
      await instance.stop();
    }
  });

  it('[P1] settlementAddresses covers non-EVM chains too, but tokenNetworks (EVM-specific) does not', async () => {
    const { instance, event } = await bootAndCapturePeerInfo({
      chains: ['evm', 'solana'],
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_A },
          to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN_A },
          rate: '1.0',
        },
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: SOLANA_CHAIN },
          to: { assetCode: 'USDC', assetScale: 6, chain: SOLANA_CHAIN },
          rate: '1.0',
        },
      ],
      channels: {
        [EVM_CHAIN_A]: [
          {
            channelId: '0x' + 'cd'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
        [SOLANA_CHAIN]: [
          {
            channelId: '11'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n, [SOLANA_CHAIN]: 1_000_000_000n },
      chainProviders: [
        {
          chainType: 'evm',
          chainId: EVM_CHAIN_A,
          rpcUrl: 'http://127.0.0.1:1',
          registryAddress: '0x' + '11'.repeat(20),
          tokenAddress: '0x' + '22'.repeat(20),
          channelAddress: CHANNEL_ADDRESS_A,
        },
      ],
    });
    try {
      const content = JSON.parse(event.content) as {
        tokenNetworks?: Record<string, string>;
        settlementAddresses?: Record<string, string>;
      };
      expect(content.tokenNetworks).toEqual({ [EVM_CHAIN_A]: CHANNEL_ADDRESS_A });
      expect(content.settlementAddresses).toEqual({
        [EVM_CHAIN_A]: instance.swapNodeKeys.evm?.address.toLowerCase(),
        [SOLANA_CHAIN]: expect.any(String),
      });
    } finally {
      await instance.stop();
    }
  });
});
