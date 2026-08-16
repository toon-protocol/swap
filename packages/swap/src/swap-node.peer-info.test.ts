/**
 * Issue #102/#133 — kind:10032 advertises, for every chain a swap pair targets:
 *
 * - `settlementAddresses[chain]` — the swap node's own payout address;
 * - `tokenNetworks[chain]` — **leg A**, the deployed `TokenNetwork` a *client*
 *   calls `openChannel(address participant2, uint256 settlementTimeout)` on to
 *   open the channel it pays this maker over;
 * - `swapVerifyingContracts[chain]` — **leg B**, this maker's deployed
 *   `RollingSwapChannel`, the EIP-712 `verifyingContract` its v2 balance-proof
 *   claims are signed under.
 *
 * Without leg B a stock client can sign/verify the v2 digest (#101) but can't
 * reconstruct the EIP-712 domain, and rejects the claim with
 * `MISSING_CHAIN_CONFIG`. With leg B published *as* `tokenNetworks` (the #102
 * regression this suite now pins against) the client's lazy `ensureChannel`
 * calls the wrong ABI on the wrong contract, reverts, and the swap dies before
 * a packet is ever sent — invisibly.
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
/** Leg B — the maker's own `RollingSwapChannel` per chain. */
const CHANNEL_ADDRESS_A = '0x' + 'aa'.repeat(20);
const CHANNEL_ADDRESS_B = '0x' + 'bb'.repeat(20);
/** Leg A — the deployed `TokenNetwork` a client opens its channel against. */
const TOKEN_NETWORK_A = '0x' + 'a1'.repeat(20);
const TOKEN_NETWORK_B = '0x' + 'b1'.repeat(20);
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
  swapVerifyingContracts?: Record<string, string>;
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
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
  channelAddress: string,
  tokenNetworkAddress: string
): SwapNodeEvmChainProvider {
  return {
    chainType: 'evm',
    chainId,
    rpcUrl: 'http://127.0.0.1:1',
    registryAddress: '0x' + '11'.repeat(20),
    tokenAddress: '0x' + '22'.repeat(20),
    tokenNetworkAddress,
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

describe('kind:10032 advertises verifyingContract + payout address (#102/#133)', () => {
  it('[P0] carries tokenNetworks[chain] = the deployed TokenNetwork (leg A), swapVerifyingContracts[chain] = the RollingSwapChannel (leg B), and settlementAddresses[chain] = the derived EVM address, for every chain a pair targets', async () => {
    const { instance, content } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [usdcPair(EVM_CHAIN_A)],
      channels: { [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))] },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n },
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_NETWORK_A),
      ],
    });
    try {
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: TOKEN_NETWORK_A,
      });
      expect(content.swapVerifyingContracts).toEqual({
        [EVM_CHAIN_A]: CHANNEL_ADDRESS_A,
      });
      expect(content.settlementAddresses).toEqual({
        [EVM_CHAIN_A]: instance.swapNodeKeys.evm?.address.toLowerCase(),
      });
    } finally {
      await instance.stop();
    }
  });

  it('[P0] never advertises the RollingSwapChannel as tokenNetworks — a client that opened its leg-A channel there would call the wrong ABI and revert', async () => {
    // The #133 regression guard. `tokenNetworks` is the field
    // `ToonClient.negotiationFromAnnounce` reads and hands to
    // `ChannelManager.ensureChannel` → `TokenNetwork.openChannel(address,uint256)`.
    // `RollingSwapChannel.openChannel` is `(bytes32,address,uint256)`, so
    // publishing it here makes every stock client's swap throw before a packet
    // is sent. The two maps MUST be disjoint in value.
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
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_NETWORK_A),
        evmProvider(EVM_CHAIN_B, CHANNEL_ADDRESS_B, TOKEN_NETWORK_B),
      ],
    });
    try {
      const legA = required(content.tokenNetworks, 'tokenNetworks');
      const legB = required(
        content.swapVerifyingContracts,
        'swapVerifyingContracts'
      );
      expect(Object.keys(legA).sort()).toEqual(Object.keys(legB).sort());
      for (const chain of Object.keys(legA)) {
        expect(legA[chain]).not.toBe(legB[chain]);
      }
      // And neither map ever carries the *token* address (`preferredTokens`'
      // job) — all three are distinct contracts.
      expect(Object.values(legA)).not.toContain('0x' + '22'.repeat(20));
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
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_NETWORK_A),
        evmProvider(EVM_CHAIN_B, CHANNEL_ADDRESS_B, TOKEN_NETWORK_B),
        // A third, unreferenced EVM chain — neither of its addresses may leak
        // into the announce since no swap pair targets it.
        evmProvider('evm:1', '0x' + 'ff'.repeat(20), '0x' + 'fe'.repeat(20)),
      ],
    });
    try {
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: TOKEN_NETWORK_A,
        [EVM_CHAIN_B]: TOKEN_NETWORK_B,
      });
      expect(content.swapVerifyingContracts).toEqual({
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

  it('[P1] settlementAddresses covers non-EVM chains too, but tokenNetworks/swapVerifyingContracts (EVM-specific) do not', async () => {
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
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_NETWORK_A),
      ],
    });
    try {
      expect(content.tokenNetworks).toEqual({
        [EVM_CHAIN_A]: TOKEN_NETWORK_A,
      });
      expect(content.swapVerifyingContracts).toEqual({
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
    // chain key, verifyingContract from swapVerifyingContracts) must recover
    // the maker's advertised payout address from a claim the node really
    // signed — and it must NOT be able to do so from `tokenNetworks`, which
    // now carries leg A.
    const legBCalls: LegBPrepare[] = [];
    const preimage = new Uint8Array(32);
    globalThis.crypto.getRandomValues(preimage);
    const { instance, content, handler } = await bootAndCapturePeerInfo({
      chains: ['evm'],
      swapPairs: [usdcPair(EVM_CHAIN_A)],
      channels: { [EVM_CHAIN_A]: [channelEntry('0x' + 'cd'.repeat(32))] },
      inventory: { [EVM_CHAIN_A]: 1_000_000_000n },
      chainProviders: [
        evmProvider(EVM_CHAIN_A, CHANNEL_ADDRESS_A, TOKEN_NETWORK_A),
      ],
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
      // from its swapPairs, the contract from its swapVerifyingContracts.
      const advertised = required(
        content.swapVerifyingContracts,
        'swapVerifyingContracts'
      );
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
            `swapVerifyingContracts[${chain}]`
          ),
        },
        Buffer.from(advance.claim, 'base64')
      );
      expect(recovered).toBe(
        required(content.settlementAddresses, 'settlementAddresses')[chain]
      );
      // The negative half of the same property: the leg-A address is NOT the
      // domain these claims are signed under, so a verifier that reached for
      // `tokenNetworks` recovers somebody else entirely.
      const legA = required(content.tokenNetworks, 'tokenNetworks');
      const recoveredFromLegA = recoverEvmClaimSigner(
        {
          channelId: required(advance.channelId, 'claim channelId'),
          cumulativeAmount: required(
            advance.cumulativeAmount,
            'claim cumulativeAmount'
          ),
          nonce: required(advance.nonce, 'claim nonce'),
          recipient: required(advance.recipient, 'claim recipient'),
          chainId: parseEvmChainId(chain),
          verifyingContract: required(legA[chain], `tokenNetworks[${chain}]`),
        },
        Buffer.from(advance.claim, 'base64')
      );
      expect(recoveredFromLegA).not.toBe(recovered);
    } finally {
      await instance.stop();
    }
  });
});
