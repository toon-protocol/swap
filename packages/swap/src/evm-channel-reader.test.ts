/**
 * The maker's EVM chain-truth reader against `TokenNetwork.participants`.
 *
 * `participants(bytes32 channelId, address participant)` returns the maker's
 * own `(deposit, nonce, transferredAmount)`. `transferredAmount` is what the
 * counterparty has claimed on chain — the redeemed leg-B watermark — and
 * `deposit` is the total ever placed, so the funding position reports the
 * remaining deposit as `deposit − transferredAmount`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { createEvmChannelOnChainReader } from './evm-channel-reader.js';

const PARTICIPANTS_SELECTOR =
  '0x' +
  bytesToHex(
    keccak_256(new TextEncoder().encode('participants(bytes32,address)')).slice(0, 4)
  );
const TOKEN_NETWORK = '0x' + '33'.repeat(20);
const MAKER = '0x' + '55'.repeat(20);
const CHANNEL_ID = '0x' + 'ab'.repeat(32);
const CHAIN = 'evm:8453';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))
  );
});

const word = (v: bigint): string => v.toString(16).padStart(64, '0');
const participantsResult = (p: {
  deposit: bigint;
  nonce: bigint;
  transferred: bigint;
}): string => '0x' + [word(p.deposit), word(p.nonce), word(p.transferred)].join('');

async function startRpc(
  answer: (req: { method: string; params: unknown[] }) => unknown
): Promise<{ url: string; calls: { method: string; params: unknown[] }[] }> {
  const calls: { method: string; params: unknown[] }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: json.method, params: json.params });
      const result = answer(json);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          result instanceof Error
            ? { jsonrpc: '2.0', id: json.id, error: { message: result.message } }
            : { jsonrpc: '2.0', id: json.id, result }
        )
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

const reader = (rpcUrl: string, chain = CHAIN) =>
  createEvmChannelOnChainReader([
    { chainId: chain, rpcUrl, tokenNetworkAddress: TOKEN_NETWORK, makerAddress: MAKER },
  ]);

describe('createEvmChannelOnChainReader (TokenNetwork participants)', () => {
  it('[P0] decodes transferredAmount (word 2) as cumulativePaid', async () => {
    const rpc = await startRpc(() =>
      participantsResult({ deposit: 5_000_000n, nonce: 3n, transferred: 1_234n })
    );
    await expect(
      reader(rpc.url).getCumulativePaid({ assetCode: 'USDC', chain: CHAIN, channelId: CHANNEL_ID })
    ).resolves.toBe(1_234n);
  });

  it('[P0] a never-redeemed channel decodes to 0n, not a decode error', async () => {
    const rpc = await startRpc(() =>
      participantsResult({ deposit: 5_000_000n, nonce: 0n, transferred: 0n })
    );
    await expect(
      reader(rpc.url).getCumulativePaid({ assetCode: 'USDC', chain: CHAIN, channelId: CHANNEL_ID })
    ).resolves.toBe(0n);
  });

  it('[P0] the eth_call carries participants(bytes32,address) with the channelId and the MAKER address', async () => {
    const rpc = await startRpc(() =>
      participantsResult({ deposit: 0n, nonce: 0n, transferred: 0n })
    );
    await reader(rpc.url).getCumulativePaid({ assetCode: 'USDC', chain: CHAIN, channelId: CHANNEL_ID });
    const call = rpc.calls[0];
    expect(call?.method).toBe('eth_call');
    const tx = (call?.params as [{ to: string; data: string }])[0];
    expect(tx.to.toLowerCase()).toBe(TOKEN_NETWORK);
    expect(tx.data).toBe(
      PARTICIPANTS_SELECTOR + CHANNEL_ID.slice(2) + '00'.repeat(12) + MAKER.slice(2)
    );
  });

  it('[P1] rejects for a chain with no configured provider', async () => {
    const rpc = await startRpc(() => participantsResult({ deposit: 0n, nonce: 0n, transferred: 0n }));
    await expect(
      reader(rpc.url).getCumulativePaid({ assetCode: 'USDC', chain: 'evm:1', channelId: CHANNEL_ID })
    ).rejects.toThrow(/No EVM chain provider/);
  });

  it('[P1] rejects when the RPC endpoint returns a JSON-RPC error', async () => {
    const rpc = await startRpc(() => new Error('execution reverted'));
    await expect(
      reader(rpc.url).getCumulativePaid({ assetCode: 'USDC', chain: CHAIN, channelId: CHANNEL_ID })
    ).rejects.toThrow(/execution reverted/);
  });

  it('[P1] rejects a too-short response instead of decoding garbage', async () => {
    const rpc = await startRpc(() => '0x' + word(1n));
    await expect(
      reader(rpc.url).getCumulativePaid({ assetCode: 'USDC', chain: CHAIN, channelId: CHANNEL_ID })
    ).rejects.toThrow(/too short/);
  });

  it('[P1] rejects a malformed tokenNetworkAddress or maker address at construction', () => {
    expect(() =>
      createEvmChannelOnChainReader([
        { chainId: CHAIN, rpcUrl: 'http://127.0.0.1:1', tokenNetworkAddress: '0x1234', makerAddress: MAKER },
      ])
    ).toThrow(/tokenNetworkAddress/);
    expect(() =>
      createEvmChannelOnChainReader([
        { chainId: CHAIN, rpcUrl: 'http://127.0.0.1:1', tokenNetworkAddress: TOKEN_NETWORK, makerAddress: '0x12' },
      ])
    ).toThrow(/maker address/);
  });
});

describe('createEvmChannelOnChainReader.getFundingPosition', () => {
  it('[P0] reports remaining deposit = deposit − transferred, so funded = total placed', async () => {
    const rpc = await startRpc(() =>
      participantsResult({ deposit: 15_000_000n, nonce: 7n, transferred: 1_000n })
    );
    const position = await reader(rpc.url).getFundingPosition?.({
      assetCode: 'USDC',
      chain: CHAIN,
      channelId: CHANNEL_ID,
    });
    expect(position).toEqual({ cumulativePaid: 1_000n, deposit: 14_999_000n });
    expect(rpc.calls.length).toBe(1);
  });
});
