/**
 * Issue #141 — the #113 channel-rebind precondition now works on Solana too.
 *
 * `swap-node.channel-rebind.test.ts` pins the EVM half of this and records
 * that a Solana pair with NO `chainProviders` entry stays "sticky forever"
 * (fails closed). This file pins the other half: WITH a Solana
 * `chainProviders` entry the node wires the real
 * `createSolanaChannelOnChainReader`, so a fresh ephemeral sender can take
 * over a fully-redeemed channel — and still cannot take over one that holds
 * an unredeemed claim.
 *
 * Same seam as the EVM file (`__testHooks.onChannelStateBuilt` + a minimal
 * in-process JSON-RPC server), so this exercises the actual boot-time wiring
 * without a live cluster.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from './swap-node.js';
import type {
  SwapNodeConfig,
  SwapNodeSolanaChainProvider,
} from './swap-node.js';
import type { SwapChannelState } from './channel-state.js';
import { deriveSwapNodeKeys } from './wallet.js';
import { SwapWalletError } from './errors.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SOLANA_CHAIN = 'solana:devnet';
const PROGRAM_ID = base58Encode(new Uint8Array(32).fill(9));
const CHANNEL_ID = base58Encode(new Uint8Array(32).fill(7));
const RAW_COUNTERPARTY = new Uint8Array(32).fill(2);
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

/** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

/** The node's own Solana address — the participant slot the reader reads. */
async function ourSolanaPubkey(): Promise<Uint8Array> {
  const keys = await deriveSwapNodeKeys({
    mnemonic: VALID_MNEMONIC,
    chains: ['solana'],
  });
  return must(keys.solana, 'a derived Solana key').publicKey;
}

/** `getAccountInfo`-only server serving a channel PDA with a fixed watermark. */
async function startFakeSolanaRpc(
  transferredAmountOurs: bigint,
  ourPubkeyBytes: Uint8Array
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number };
      const data = new Uint8Array(178);
      data.set(new TextEncoder().encode('pchannel'), 0);
      data.set(ourPubkeyBytes, 8); // participant_a — us
      data.set(RAW_COUNTERPARTY, 40);
      let v = transferredAmountOurs;
      for (let i = 0; i < 8; i++) {
        data[120 + i] = Number(v & 0xffn); // transferred_amount_a
        v >>= 8n;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: json.id,
          result: {
            context: { slot: 1 },
            value: {
              data: [Buffer.from(data).toString('base64'), 'base64'],
              owner: PROGRAM_ID,
            },
          },
        })
      );
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
  const solanaProvider: SwapNodeSolanaChainProvider = {
    chainType: 'solana',
    chainId: SOLANA_CHAIN,
    rpcUrl,
    programId: PROGRAM_ID,
  };
  const instance = await startSwapNode({
    mnemonic: VALID_MNEMONIC,
    connector: stubConnector(),
    relayUrls: ['ws://localhost:0'],
    blsPort: 0,
    publisher: { publish: async () => undefined },
    chains: ['solana'],
    reconcileIntervalMs: 0,
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
          channelId: CHANNEL_ID,
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [SOLANA_CHAIN]: 1_000_000n },
    chainProviders: [solanaProvider],
    __testHooks: {
      onChannelStateBuilt: (cs) => {
        captured = cs;
      },
    },
  });
  const channelState = must(captured, 'onChannelStateBuilt to have fired');
  return { channelState, stop: () => instance.stop() };
}

describe('startSwapNode wires the #113 rebind reader for Solana too (issue #141)', () => {
  it('[P0] a second ephemeral sender takes over the channel once the first is fully redeemed on-chain', async () => {
    // On-chain transferred_amount (1) covers the first sender's issued
    // watermark (1) — nothing is stranded, so the rebind is safe.
    const rpcUrl = await startFakeSolanaRpc(1n, await ourSolanaPubkey());
    const { channelState, stop } = await bootAndCaptureChannelState(rpcUrl);
    try {
      await channelState.reserve({
        assetCode: 'USDC',
        chain: SOLANA_CHAIN,
        senderPubkey: SENDER_1,
        cumulativeDelta: 1n,
      });

      const second = await channelState.reserve({
        assetCode: 'USDC',
        chain: SOLANA_CHAIN,
        senderPubkey: SENDER_2,
        cumulativeDelta: 1n,
      });

      expect(second.channelId).toBe(CHANNEL_ID);
      // The watermark is NEVER reset on rebind — it is one channel's
      // monotonic ledger (see channel-state.ts).
      expect(second.cumulativeAmount).toBe(2n);
      expect(second.nonce).toBe(2n);
    } finally {
      await stop();
    }
  });

  it('[P0] a second ephemeral sender is refused while the first claim is unredeemed on-chain', async () => {
    // Nothing redeemed: rebinding would let the new sender sweep the old
    // sender's unclaimed delta.
    const rpcUrl = await startFakeSolanaRpc(0n, await ourSolanaPubkey());
    const { channelState, stop } = await bootAndCaptureChannelState(rpcUrl);
    try {
      await channelState.reserve({
        assetCode: 'USDC',
        chain: SOLANA_CHAIN,
        senderPubkey: SENDER_1,
        cumulativeDelta: 5n,
      });

      await expect(
        channelState.reserve({
          assetCode: 'USDC',
          chain: SOLANA_CHAIN,
          senderPubkey: SENDER_2,
          cumulativeDelta: 1n,
        })
      ).rejects.toBeInstanceOf(SwapWalletError);
      await expect(
        channelState.reserve({
          assetCode: 'USDC',
          chain: SOLANA_CHAIN,
          senderPubkey: SENDER_2,
          cumulativeDelta: 1n,
        })
      ).rejects.toThrow(/5 unredeemed/);
    } finally {
      await stop();
    }
  });

  it('[P0] an unreadable chain refuses the rebind (fails closed), it does not approve it', async () => {
    // A server that answers every read with a JSON-RPC error.
    const server = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'cluster unreachable' },
          })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a bound TCP address');
    }
    const { channelState, stop } = await bootAndCaptureChannelState(
      `http://127.0.0.1:${address.port}`
    );
    try {
      await channelState.reserve({
        assetCode: 'USDC',
        chain: SOLANA_CHAIN,
        senderPubkey: SENDER_1,
        cumulativeDelta: 1n,
      });

      await expect(
        channelState.reserve({
          assetCode: 'USDC',
          chain: SOLANA_CHAIN,
          senderPubkey: SENDER_2,
          cumulativeDelta: 1n,
        })
      ).rejects.toThrow(/on-chain read failed/);
    } finally {
      await stop();
    }
  });
});
