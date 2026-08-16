/**
 * `createChannelOnChainReader` — issue #141's family dispatch.
 *
 * The two consumers (`SwapChannelState`'s #113 rebind precondition and
 * `SwapInventoryReconciler`'s recycle pass) share ONE reader object, so the
 * dispatch is what makes both work per family. These tests pin: each family
 * reaches its own endpoint, Mina refuses with the documented chain fact
 * rather than approximating, and a maker with no readable family gets
 * `undefined` (reconciler stays honestly disabled) instead of a reader that
 * answers nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { base58Encode } from '@toon-protocol/sdk';

import {
  composeChannelOnChainReaders,
  createChannelOnChainReader,
  MINA_UNREADABLE_REASON,
} from './channel-reader.js';
import type { ChannelOnChainReader } from './channel-state.js';

const EVM_CHAIN = 'evm:8453';
const SOLANA_CHAIN = 'solana:devnet';
const MINA_CHAIN = 'mina:devnet';
const EVM_CHANNEL_ID = '0x' + '01'.repeat(32);
const CHANNEL_ADDRESS = '0x' + 'aa'.repeat(20);
const RAW_US = new Uint8Array(32).fill(1);
const RAW_THEM = new Uint8Array(32).fill(2);
const RAW_PROGRAM = new Uint8Array(32).fill(9);
const US = base58Encode(RAW_US);
const PROGRAM_ID = base58Encode(RAW_PROGRAM);
const SOLANA_CHANNEL_ID = base58Encode(new Uint8Array(32).fill(7));

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

async function startRpcServer(
  handler: (method: string) => unknown
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const json = JSON.parse(body) as { id: number; method: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: json.id,
          result: handler(json.method),
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

/** `channels(bytes32)` return with `cumulativePaid` (word 3) set. */
function evmChannelsResult(cumulativePaid: bigint): string {
  const word = (hex: string) => hex.toLowerCase().padStart(64, '0');
  return (
    '0x' +
    [
      word('11'.repeat(20)),
      word('22'.repeat(20)),
      word('3'),
      word(cumulativePaid.toString(16)),
      word('0'),
      word('0'),
      word('1'),
    ].join('')
  );
}

/** A `getAccountInfo` envelope for a channel PDA where WE are participant A. */
function solanaAccountResult(transferredAmountA: bigint): unknown {
  const data = new Uint8Array(178);
  data.set(new TextEncoder().encode('pchannel'), 0);
  data.set(RAW_US, 8);
  data.set(RAW_THEM, 40);
  let v = transferredAmountA;
  for (let i = 0; i < 8; i++) {
    data[120 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return {
    context: { slot: 1 },
    value: {
      data: [Buffer.from(data).toString('base64'), 'base64'],
      owner: PROGRAM_ID,
    },
  };
}

/** Non-null narrowing without `!` (the repo's eslint gate forbids it). */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

describe('createChannelOnChainReader (issue #141)', () => {
  it('[P0] routes an evm:* read to the EVM endpoint and a solana:* read to the Solana endpoint', async () => {
    const evmRpc = await startRpcServer((method) => {
      expect(method).toBe('eth_call');
      return evmChannelsResult(1_111n);
    });
    const solanaRpc = await startRpcServer((method) => {
      expect(method).toBe('getAccountInfo');
      return solanaAccountResult(2_222n);
    });
    const reader = must(
      createChannelOnChainReader({
        evm: [
          {
            chainId: EVM_CHAIN,
            rpcUrl: evmRpc,
            channelAddress: CHANNEL_ADDRESS,
          },
        ],
        solana: [
          {
            chainId: SOLANA_CHAIN,
            rpcUrl: solanaRpc,
            programId: PROGRAM_ID,
            payerPubkey: US,
          },
        ],
      }),
      'a composed reader'
    );

    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: EVM_CHAIN,
        channelId: EVM_CHANNEL_ID,
      })
    ).resolves.toBe(1_111n);
    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: SOLANA_CHAIN,
        channelId: SOLANA_CHANNEL_ID,
      })
    ).resolves.toBe(2_222n);
  });

  it('[P0] a mina:* read REFUSES with the chain fact — never an approximation', async () => {
    const evmRpc = await startRpcServer(() => evmChannelsResult(0n));
    const reader = must(
      createChannelOnChainReader({
        evm: [
          {
            chainId: EVM_CHAIN,
            rpcUrl: evmRpc,
            channelAddress: CHANNEL_ADDRESS,
          },
        ],
      }),
      'a composed reader'
    );

    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: MINA_CHAIN,
        channelId: 'B62qm...',
      })
    ).rejects.toThrow(MINA_UNREADABLE_REASON);
  });

  it('[P0] a maker with only mina providers gets NO reader at all (reconciler stays honestly disabled)', () => {
    expect(createChannelOnChainReader({})).toBeUndefined();
    expect(createChannelOnChainReader({ evm: [], solana: [] })).toBeUndefined();
  });

  it('[P1] a chain of a family with no configured provider fails closed', async () => {
    const solanaRpc = await startRpcServer(() => solanaAccountResult(0n));
    const reader = must(
      createChannelOnChainReader({
        solana: [
          {
            chainId: SOLANA_CHAIN,
            rpcUrl: solanaRpc,
            programId: PROGRAM_ID,
            payerPubkey: US,
          },
        ],
      }),
      'a composed reader'
    );

    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: EVM_CHAIN,
        channelId: EVM_CHANNEL_ID,
      })
    ).rejects.toThrow(/No EVM chain provider configured/);
    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: 'solana:mainnet',
        channelId: SOLANA_CHANNEL_ID,
      })
    ).rejects.toThrow(/No Solana chain provider configured/);
  });

  it('[P1] an unknown chain family fails closed rather than defaulting to a reader', async () => {
    const solanaRpc = await startRpcServer(() => solanaAccountResult(0n));
    const reader = must(
      createChannelOnChainReader({
        solana: [
          {
            chainId: SOLANA_CHAIN,
            rpcUrl: solanaRpc,
            programId: PROGRAM_ID,
            payerPubkey: US,
          },
        ],
      }),
      'a composed reader'
    );

    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: 'bitcoin:main',
        channelId: 'whatever',
      })
    ).rejects.toThrow(/unknown chain family/);
  });
});

/**
 * `ChannelOnChainReader` grows OPTIONAL capabilities (swap#142's
 * `getFundingPosition`, EVM-only, backs `POST /admin/inventory/deposit`). A
 * dispatcher that returned a fixed object literal would silently drop any
 * capability it did not name — the route would go dark on every chain,
 * fail-closed but unexplained — and would drop the NEXT one the same way. The
 * dispatch is therefore built from the union of the families' actual
 * callables; these tests pin that shape, not one field name.
 */
describe('composeChannelOnChainReaders forwards every capability, not a fixed list', () => {
  /** A stub family reader carrying an extra, optional capability. */
  function stubReader(
    label: string,
    extras: Record<string, ChannelRead> = {}
  ): ChannelOnChainReader {
    return {
      getCumulativePaid: async () => 1n,
      ...extras,
      // Recorded so a test can prove which family actually served the call.
      whichFamily: async () => label,
    } as unknown as ChannelOnChainReader;
  }

  type ChannelRead = (params: {
    assetCode: string;
    chain: string;
    channelId: string;
  }) => Promise<unknown>;

  /** Call an optional capability off the composed reader without `as any`. */
  function callCapability(
    reader: ChannelOnChainReader,
    capability: string,
    chain: string
  ): Promise<unknown> {
    const method = (reader as unknown as Record<string, ChannelRead>)[
      capability
    ];
    if (typeof method !== 'function') {
      throw new Error(`composed reader does not expose '${capability}'`);
    }
    return method({ assetCode: 'USDC', chain, channelId: 'c' });
  }

  function must<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`expected ${what}`);
    return value;
  }

  it('[P0] an EVM-only optional capability survives the dispatcher and reaches the EVM reader', async () => {
    const reader = must(
      composeChannelOnChainReaders({
        evm: stubReader('evm', {
          getFundingPosition: async () => ({
            cumulativePaid: 7n,
            deposit: 100n,
          }),
        }),
        solana: stubReader('solana'),
      }),
      'a composed reader'
    );

    expect(
      typeof (reader as unknown as Record<string, unknown>)[
        'getFundingPosition'
      ]
    ).toBe('function');
    await expect(
      callCapability(reader, 'getFundingPosition', EVM_CHAIN)
    ).resolves.toEqual({ cumulativePaid: 7n, deposit: 100n });
  });

  it('[P0] a family whose reader lacks the capability fails closed with a named reason', async () => {
    const reader = must(
      composeChannelOnChainReaders({
        evm: stubReader('evm', { getFundingPosition: async () => ({}) }),
        solana: stubReader('solana'),
      }),
      'a composed reader'
    );

    await expect(
      callCapability(reader, 'getFundingPosition', SOLANA_CHAIN)
    ).rejects.toThrow(/Solana channel reader has no 'getFundingPosition'/);
    await expect(
      callCapability(reader, 'getFundingPosition', MINA_CHAIN)
    ).rejects.toThrow(MINA_UNREADABLE_REASON);
  });

  it('[P0] a capability NO family implements is not invented — the composed reader simply does not expose it', () => {
    const reader = must(
      composeChannelOnChainReaders({ solana: stubReader('solana') }),
      'a composed reader'
    );

    expect(
      (reader as unknown as Record<string, unknown>)['getFundingPosition']
    ).toBeUndefined();
  });

  it('[P1] the dispatch routes each capability to the RIGHT family, not just the first one', async () => {
    const reader = must(
      composeChannelOnChainReaders({
        evm: stubReader('evm'),
        solana: stubReader('solana'),
      }),
      'a composed reader'
    );

    await expect(
      callCapability(reader, 'whichFamily', EVM_CHAIN)
    ).resolves.toBe('evm');
    await expect(
      callCapability(reader, 'whichFamily', SOLANA_CHAIN)
    ).resolves.toBe('solana');
  });

  it("[P1] a class-based reader's prototype methods are forwarded too", async () => {
    class ClassReader {
      async getCumulativePaid(): Promise<bigint> {
        return 3n;
      }
      async getFundingPosition(): Promise<{ deposit: bigint }> {
        return { deposit: 42n };
      }
    }
    const reader = must(
      composeChannelOnChainReaders({
        evm: new ClassReader() as unknown as ChannelOnChainReader,
      }),
      'a composed reader'
    );

    await expect(
      reader.getCumulativePaid({
        assetCode: 'USDC',
        chain: EVM_CHAIN,
        channelId: 'c',
      })
    ).resolves.toBe(3n);
    await expect(
      callCapability(reader, 'getFundingPosition', EVM_CHAIN)
    ).resolves.toEqual({ deposit: 42n });
  });
});
