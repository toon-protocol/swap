/**
 * Issue #113 — `startSwapNode()` wires an on-chain-safety-checked rebind
 * reader automatically whenever an EVM `chainProviders` entry is configured
 * (no separate opt-in knob — see `channel-state.ts`'s docblock and
 * `evm-channel-reader.ts`).
 *
 * Drives the real `createEvmChannelOnChainReader` against a minimal
 * in-process JSON-RPC server (see `evm-channel-reader.test.ts`) through the
 * `__testHooks.onChannelStateBuilt` seam, so this exercises the actual
 * boot-time wiring in `swap-node.ts` end-to-end without needing a live
 * anvil/forge chain or a full connector/BTP round-trip.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

import { startSwapNode } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeEvmChainProvider } from './swap-node.js';
import type { SwapChannelState } from './channel-state.js';
import { SwapWalletError } from './errors.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EVM_CHAIN = 'evm:8453';
const SOLANA_CHAIN = 'solana:devnet';
const CHANNEL_ADDRESS = '0x' + 'aa'.repeat(20);
const CHANNEL_ID = '0x' + '01'.repeat(32);
const SENDER_1 = 'a'.repeat(64);
const SENDER_2 = 'b'.repeat(64);

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

/** Right-pads a hex value (sans `0x`) out to one 32-byte ABI word. */
function word(hex: string): string {
  return hex.toLowerCase().padStart(64, '0');
}

/** A fake `eth_call`-only JSON-RPC server whose `channels()` answer is `cumulativePaid`. */
async function startFakeChainRpc(cumulativePaid: bigint): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number };
      // Hand-encoded Channel struct (signer, funder, nonce, cumulativePaid,
      // deposit, closingAt, state) — see evm-channel-reader.test.ts.
      const result =
        '0x' +
        [
          word('11'.repeat(20)),
          word('22'.repeat(20)),
          word(3n.toString(16)),
          word(cumulativePaid.toString(16)),
          word(1_000n.toString(16)),
          word(0n.toString(16)),
          word((1).toString(16)),
        ].join('');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

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

async function bootAndCaptureChannelState(
  rpcUrl: string
): Promise<{ channelState: SwapChannelState; stop: () => Promise<void> }> {
  let captured: SwapChannelState | undefined;
  const evmProvider: SwapNodeEvmChainProvider = {
    chainType: 'evm',
    chainId: EVM_CHAIN,
    rpcUrl,
    registryAddress: '0x' + '33'.repeat(20),
    tokenAddress: '0x' + '44'.repeat(20),
    tokenNetworkAddress: '0x' + '55'.repeat(20),
    channelAddress: CHANNEL_ADDRESS,
  };
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector: stubConnector(),
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
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
          channelId: CHANNEL_ID,
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [EVM_CHAIN]: 1_000_000n },
    chainProviders: [evmProvider],
    __testHooks: {
      onChannelStateBuilt: (cs) => {
        captured = cs;
      },
    },
  });
  if (!captured) throw new Error('onChannelStateBuilt was never called');
  return { channelState: captured, stop: () => instance.stop() };
}

describe('startSwapNode wires the issue #113 on-chain rebind reader (no opt-in knob)', () => {
  it('[P0] the reported repro: a second ephemeral sender succeeds once the first is fully redeemed on-chain', async () => {
    const rpcUrl = await startFakeChainRpc(1n);
    const { channelState, stop } = await bootAndCaptureChannelState(rpcUrl);
    try {
      await channelState.reserve({
        assetCode: 'USDC',
        chain: EVM_CHAIN,
        senderPubkey: SENDER_1,
        cumulativeDelta: 1n,
      });
      const r2 = await channelState.reserve({
        assetCode: 'USDC',
        chain: EVM_CHAIN,
        senderPubkey: SENDER_2,
        cumulativeDelta: 1n,
      });
      expect(r2.channelId).toBe(CHANNEL_ID);
    } finally {
      await stop();
    }
  });

  it('[P0] a second ephemeral sender is still refused while the first claim is unredeemed on-chain', async () => {
    const rpcUrl = await startFakeChainRpc(0n);
    const { channelState, stop } = await bootAndCaptureChannelState(rpcUrl);
    try {
      await channelState.reserve({
        assetCode: 'USDC',
        chain: EVM_CHAIN,
        senderPubkey: SENDER_1,
        cumulativeDelta: 1n,
      });
      await expect(
        channelState.reserve({
          assetCode: 'USDC',
          chain: EVM_CHAIN,
          senderPubkey: SENDER_2,
          cumulativeDelta: 1n,
        })
      ).rejects.toBeInstanceOf(SwapWalletError);
    } finally {
      await stop();
    }
  });

  it('[P1] a chain family with no on-chain reader implementation (Solana) still fails closed — pre-#113 "sticky forever" behavior preserved', async () => {
    // No `chainProviders` entry is required to boot a Solana-only pair
    // (unlike EVM, since #101), so this also proves the reader is scoped
    // to EVM chains only, not wired unconditionally for every chain.
    let captured: SwapChannelState | undefined;
    const instance = await startSwapNode({
      mnemonic: VALID_MNEMONIC,
      connector: stubConnector(),
      relayUrls: ['ws://localhost:0'],
      blsPort: 0,
      publisher: { publish: async () => undefined },
      chains: ['solana'],
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: SOLANA_CHAIN },
          to: { assetCode: 'USDC', assetScale: 6, chain: SOLANA_CHAIN },
          rate: '1.0',
        },
      ],
      channels: {
        [SOLANA_CHAIN]: [
          {
            channelId: '11'.repeat(32),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          },
        ],
      },
      inventory: { [SOLANA_CHAIN]: 1_000_000n },
      // No chainProviders at all.
      __testHooks: {
        onChannelStateBuilt: (cs) => {
          captured = cs;
        },
      },
    });
    try {
      if (!captured) throw new Error('onChannelStateBuilt was never called');
      await captured.reserve({
        assetCode: 'USDC',
        chain: SOLANA_CHAIN,
        senderPubkey: SENDER_1,
        cumulativeDelta: 1n,
      });
      await expect(
        captured.reserve({
          assetCode: 'USDC',
          chain: SOLANA_CHAIN,
          senderPubkey: SENDER_2,
          cumulativeDelta: 1n,
        })
      ).rejects.toBeInstanceOf(SwapWalletError);
    } finally {
      await instance.stop();
    }
  });
});
