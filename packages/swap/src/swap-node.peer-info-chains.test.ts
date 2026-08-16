/**
 * Issue #114 — kind:10032 advertises `supportedChains` (the chains of the
 * advertised pairs' to-legs) and `preferredTokens` (settlement-token address
 * per chain, from `chainProviders`).
 *
 * Without these a stock client's apex onboarding hard-fails at
 * `addApex`: "Apex announced no supportedChains — cannot settle" (found
 * during the toon-meta#394 T6 devnet proof, swap#105).
 */
import { describe, it, expect } from 'vitest';

import { startSwapNode } from './swap-node.js';
import type {
  SwapNodeConfig,
  SwapNodeEvmChainProvider,
  SwapNodeSolanaChainProvider,
} from './swap-node.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const EVM_CHAIN_A = 'evm:8453';
const EVM_CHAIN_B = 'evm:84532';
const SOLANA_CHAIN = 'solana:devnet';
const CHANNEL_ADDRESS_A = '0x' + 'aa'.repeat(20);
const CHANNEL_ADDRESS_B = '0x' + 'bb'.repeat(20);
const TOKEN_ADDRESS_A = '0x' + '22'.repeat(20);
const TOKEN_ADDRESS_B = '0x' + '33'.repeat(20);
const SOLANA_TOKEN_MINT = 'So11111111111111111111111111111111111111112';

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
  supportedChains?: string[];
  preferredTokens?: Record<string, string>;
  swapPairs?: SwapNodePair[];
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
  channelAddress: string,
  tokenAddress: string
): SwapNodeEvmChainProvider {
  return {
    chainType: 'evm',
    chainId,
    rpcUrl: 'http://127.0.0.1:1',
    registryAddress: '0x' + '11'.repeat(20),
    tokenAddress,
    // Leg A — distinct from the leg-B `channelAddress` (issue #133).
    tokenNetworkAddress: '0x' + '44'.repeat(20),
    channelAddress,
  };
}

function solanaProvider(
  chainId: string,
  tokenMint?: string
): SwapNodeSolanaChainProvider {
  return {
    chainType: 'solana',
    chainId,
    rpcUrl: 'http://127.0.0.1:2',
    programId: '11111111111111111111111111111111',
    ...(tokenMint !== undefined && { tokenMint }),
  };
}

/**
 * No-op connector stub so boot never dials a real embedded connector.
 */
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
  config: PeerInfoTestConfig
): Promise<PeerInfoContent> {
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
    ...config,
  });
  try {
    if (!captured) throw new Error('onPeerInfoBuilt was never called');
    return JSON.parse(captured.content) as PeerInfoContent;
  } finally {
    await instance.stop();
  }
}

describe('kind:10032 advertises supportedChains + preferredTokens (#114)', () => {
  it('[P0] supportedChains covers every distinct pair.to.chain', async () => {
    const content = await bootAndCapturePeerInfo({
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
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_ADDRESS_A),
        evmProvider(EVM_CHAIN_B, CHANNEL_ADDRESS_B, TOKEN_ADDRESS_B),
      ],
    });
    expect(content.supportedChains?.slice().sort()).toEqual(
      [EVM_CHAIN_A, EVM_CHAIN_B].sort()
    );
  });

  it('[P0] preferredTokens[chain] = the chainProviders tokenAddress for every EVM chain a pair targets, excluding chains no pair targets', async () => {
    const content = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [usdcPair(EVM_CHAIN_A)],
      channels: { [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))] },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n },
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_ADDRESS_A),
        // A second, unreferenced EVM chain — its tokenAddress MUST NOT leak
        // into preferredTokens since no swap pair targets it.
        evmProvider(EVM_CHAIN_B, CHANNEL_ADDRESS_B, TOKEN_ADDRESS_B),
      ],
    });
    expect(content.preferredTokens).toEqual({
      [EVM_CHAIN_A]: TOKEN_ADDRESS_A,
    });
  });

  it('[P1] preferredTokens includes a non-EVM chain when its chainProviders entry names a token, and supportedChains still covers it either way', async () => {
    const content = await bootAndCapturePeerInfo({
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
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_ADDRESS_A),
        solanaProvider(SOLANA_CHAIN, SOLANA_TOKEN_MINT),
      ],
    });
    expect(content.supportedChains?.slice().sort()).toEqual(
      [EVM_CHAIN_A, SOLANA_CHAIN].sort()
    );
    expect(content.preferredTokens).toEqual({
      [EVM_CHAIN_A]: TOKEN_ADDRESS_A,
      [SOLANA_CHAIN]: SOLANA_TOKEN_MINT,
    });
  });

  it('[P1] a non-EVM chain with no chainProviders entry is still in supportedChains but absent from preferredTokens', async () => {
    const content = await bootAndCapturePeerInfo({
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
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_ADDRESS_A),
      ],
    });
    expect(content.supportedChains?.slice().sort()).toEqual(
      [EVM_CHAIN_A, SOLANA_CHAIN].sort()
    );
    expect(content.preferredTokens).toEqual({
      [EVM_CHAIN_A]: TOKEN_ADDRESS_A,
    });
  });

  it('[P1] a non-EVM chain whose chainProviders entry names no token (native asset) is still in supportedChains but absent from preferredTokens', async () => {
    const content = await bootAndCapturePeerInfo({
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
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_ADDRESS_A),
        solanaProvider(SOLANA_CHAIN),
      ],
    });
    expect(content.supportedChains?.slice().sort()).toEqual(
      [EVM_CHAIN_A, SOLANA_CHAIN].sort()
    );
    expect(content.preferredTokens).toEqual({
      [EVM_CHAIN_A]: TOKEN_ADDRESS_A,
    });
  });
});
