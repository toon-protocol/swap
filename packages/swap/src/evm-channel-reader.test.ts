/**
 * `createEvmChannelOnChainReader` — issue #113.
 *
 * Exercises the real request/decode path against a minimal in-process
 * JSON-RPC server (no anvil/forge needed — this reader only ever issues a
 * read-only `eth_call`, so a canned response is enough to pin the contract).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEvmChannelOnChainReader } from './evm-channel-reader.js';

const CHANNEL_ADDRESS = '0x' + '33'.repeat(20);
const CHAIN = 'evm:31337';
const CHANNEL_ID = '0x' + '01'.repeat(32);
/** keccak256("channels(bytes32)")[0:4] — independently verified against the well-known ERC20 `transfer(address,uint256)` selector `0xa9059cbb` using the same helper. */
const CHANNELS_SELECTOR = '0x7a7ebd7b';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

interface JsonRpcRequest {
  id: number;
  method: string;
  params: [{ to: string; data: string }, string];
}

/** Boots a JSON-RPC server whose `eth_call` responses come from `handler`. */
async function startRpcServer(
  handler: (req: JsonRpcRequest) => unknown
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as JsonRpcRequest;
      try {
        const result = handler(json);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result }));
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: json.id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          })
        );
      }
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

/** Right-pads a hex value (sans `0x`) out to one 32-byte ABI word. */
function word(hex: string): string {
  return hex.toLowerCase().padStart(64, '0');
}

/** Hand-encodes a `Channel` struct return value — no ABI library involved. */
function encodeChannelStruct(fields: {
  signer?: string;
  funder?: string;
  nonce?: bigint;
  cumulativePaid: bigint;
  deposit?: bigint;
  closingAt?: bigint;
  state?: number;
}): string {
  const words = [
    word((fields.signer ?? '0x' + '11'.repeat(20)).replace(/^0x/, '')),
    word((fields.funder ?? '0x' + '22'.repeat(20)).replace(/^0x/, '')),
    word((fields.nonce ?? 3n).toString(16)),
    word(fields.cumulativePaid.toString(16)),
    word((fields.deposit ?? 1_000n).toString(16)),
    word((fields.closingAt ?? 0n).toString(16)),
    word((fields.state ?? 1).toString(16)),
  ];
  return '0x' + words.join('');
}

describe('createEvmChannelOnChainReader (issue #113)', () => {
  it('[P0] decodes cumulativePaid (word index 3) from the channels() getter response', async () => {
    const rpcUrl = await startRpcServer((req) => {
      expect(req.method).toBe('eth_call');
      return encodeChannelStruct({ cumulativePaid: 12_345n });
    });
    const reader = createEvmChannelOnChainReader([
      { chainId: CHAIN, rpcUrl, channelAddress: CHANNEL_ADDRESS },
    ]);

    const cumulativePaid = await reader.getCumulativePaid({
      assetCode: 'ETH',
      chain: CHAIN,
      channelId: CHANNEL_ID,
    });

    expect(cumulativePaid).toBe(12_345n);
  });

  it('[P0] a channel with zero cumulativePaid (never redeemed) decodes to 0n, not a decode error', async () => {
    const rpcUrl = await startRpcServer(() =>
      encodeChannelStruct({ cumulativePaid: 0n })
    );
    const reader = createEvmChannelOnChainReader([
      { chainId: CHAIN, rpcUrl, channelAddress: CHANNEL_ADDRESS },
    ]);

    const cumulativePaid = await reader.getCumulativePaid({
      assetCode: 'ETH',
      chain: CHAIN,
      channelId: CHANNEL_ID,
    });

    expect(cumulativePaid).toBe(0n);
  });

  it('[P0] the eth_call request carries the channels(bytes32) selector and the channelId as calldata', async () => {
    let captured: { to: string; data: string } | undefined;
    const rpcUrl = await startRpcServer((req) => {
      captured = req.params[0];
      return encodeChannelStruct({ cumulativePaid: 1n });
    });
    const reader = createEvmChannelOnChainReader([
      { chainId: CHAIN, rpcUrl, channelAddress: CHANNEL_ADDRESS },
    ]);

    await reader.getCumulativePaid({
      assetCode: 'ETH',
      chain: CHAIN,
      channelId: CHANNEL_ID,
    });

    expect(captured?.to).toBe(CHANNEL_ADDRESS.toLowerCase());
    expect(captured?.data).toBe(
      CHANNELS_SELECTOR + CHANNEL_ID.replace(/^0x/, '')
    );
  });

  it('[P1] rejects for a chain with no configured provider', async () => {
    const reader = createEvmChannelOnChainReader([]);
    await expect(
      reader.getCumulativePaid({
        assetCode: 'ETH',
        chain: 'evm:999',
        channelId: CHANNEL_ID,
      })
    ).rejects.toThrow(/No EVM chain provider configured/);
  });

  it('[P1] rejects when the RPC endpoint returns a JSON-RPC error', async () => {
    const rpcUrl = await startRpcServer(() => {
      throw new Error('execution reverted');
    });
    const reader = createEvmChannelOnChainReader([
      { chainId: CHAIN, rpcUrl, channelAddress: CHANNEL_ADDRESS },
    ]);

    await expect(
      reader.getCumulativePaid({
        assetCode: 'ETH',
        chain: CHAIN,
        channelId: CHANNEL_ID,
      })
    ).rejects.toThrow();
  });

  it('[P1] rejects a malformed (too-short) channels() response instead of decoding garbage', async () => {
    // Only 2 of the expected 7 words — short of word index 3 (cumulativePaid).
    const rpcUrl = await startRpcServer(() => '0x' + 'ab'.repeat(64));
    const reader = createEvmChannelOnChainReader([
      { chainId: CHAIN, rpcUrl, channelAddress: CHANNEL_ADDRESS },
    ]);

    await expect(
      reader.getCumulativePaid({
        assetCode: 'ETH',
        chain: CHAIN,
        channelId: CHANNEL_ID,
      })
    ).rejects.toThrow(/too short/);
  });

  it('[P1] rejects a malformed channelAddress at construction time', () => {
    expect(() =>
      createEvmChannelOnChainReader([
        {
          chainId: CHAIN,
          rpcUrl: 'http://127.0.0.1:1',
          channelAddress: '0xnot-an-address',
        },
      ])
    ).toThrow();
  });

  it('[P2] two chains resolve against their own configured RPC endpoint independently', async () => {
    const rpcUrlA = await startRpcServer(() =>
      encodeChannelStruct({ cumulativePaid: 1n })
    );
    // A second server on a second port for the second chain.
    const rpcUrlB = await startRpcServer(() =>
      encodeChannelStruct({ cumulativePaid: 2n })
    );

    const reader = createEvmChannelOnChainReader([
      { chainId: 'evm:1', rpcUrl: rpcUrlA, channelAddress: CHANNEL_ADDRESS },
      { chainId: 'evm:2', rpcUrl: rpcUrlB, channelAddress: CHANNEL_ADDRESS },
    ]);

    const [a, b] = await Promise.all([
      reader.getCumulativePaid({
        assetCode: 'ETH',
        chain: 'evm:1',
        channelId: CHANNEL_ID,
      }),
      reader.getCumulativePaid({
        assetCode: 'ETH',
        chain: 'evm:2',
        channelId: CHANNEL_ID,
      }),
    ]);
    expect(a).toBe(1n);
    expect(b).toBe(2n);
  });
});
