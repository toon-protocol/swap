/**
 * `createSolanaChannelOnChainReader` — issue #141.
 *
 * Exercises the real request/decode path against a minimal in-process
 * JSON-RPC server, mirroring `evm-channel-reader.test.ts`: this reader only
 * ever issues a read-only `getAccountInfo`, so a canned response is enough to
 * pin the contract (account layout, payer-side selection, and every
 * fail-closed refusal).
 *
 * The account bytes are hand-encoded here from the canonical layout in
 * toon-protocol/connector `packages/solana-program/src/state.rs` — NOT taken
 * from the reader's own constants — so a silent offset drift fails the suite.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { base58Encode } from '@toon-protocol/sdk';

import { createSolanaChannelOnChainReader } from './solana-channel-reader.js';
import type { ChannelOnChainReader } from './channel-state.js';

const CHAIN = 'solana:devnet';
/** Fixture addresses as raw bytes; their base58 form is derived, never hand-written. */
const RAW = {
  us: new Uint8Array(32).fill(1),
  them: new Uint8Array(32).fill(2),
  stranger: new Uint8Array(32).fill(3),
  mint: new Uint8Array(32).fill(4),
  otherProgram: new Uint8Array(32).fill(5),
  channel: new Uint8Array(32).fill(7),
  program: new Uint8Array(32).fill(9),
} as const;
const PROGRAM_ID = base58Encode(RAW.program);
const CHANNEL_ID = base58Encode(RAW.channel);
/** The maker's own Solana address — the payer side of the channel. */
const US = base58Encode(RAW.us);

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
  params: [string, { encoding?: string; commitment?: string }];
}

/** Boots a JSON-RPC server whose `getAccountInfo` results come from `handler`. */
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

function writeU64LE(data: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 0; i < 8; i++) {
    data[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/**
 * Hand-encodes a `ChannelState` account image (178 bytes), offsets straight
 * from `packages/solana-program/src/state.rs`.
 */
function encodeChannelAccount(fields: {
  participantA?: Uint8Array;
  participantB?: Uint8Array;
  transferredAmountA?: bigint;
  transferredAmountB?: bigint;
  discriminator?: string;
  size?: number;
}): string {
  const full = new Uint8Array(178);
  const data = full;
  data.set(
    new TextEncoder().encode(fields.discriminator ?? 'pchannel').slice(0, 8),
    0
  );
  data.set(fields.participantA ?? RAW.us, 8);
  data.set(fields.participantB ?? RAW.them, 40);
  data.set(RAW.mint, 72);
  writeU64LE(data, 104, 1_000_000n); // deposit_a
  writeU64LE(data, 112, 1_000_000n); // deposit_b
  writeU64LE(data, 120, fields.transferredAmountA ?? 0n);
  writeU64LE(data, 128, fields.transferredAmountB ?? 0n);
  writeU64LE(data, 136, 3n); // nonce_a
  writeU64LE(data, 144, 0n); // nonce_b
  writeU64LE(data, 152, 3600n); // challenge_duration
  data[160] = 0; // state = Opened
  data[169] = 255; // bump
  // `size` truncates the finished image — that is what a short/garbage
  // account looks like on the wire.
  return Buffer.from(full.slice(0, fields.size ?? full.length)).toString(
    'base64'
  );
}

/** The `{ value: … }` envelope `getAccountInfo` wraps an account in. */
function accountInfo(base64: string, owner = PROGRAM_ID): unknown {
  return {
    context: { slot: 1 },
    value: {
      data: [base64, 'base64'],
      executable: false,
      lamports: 2_000_000,
      owner,
      rentEpoch: 0,
    },
  };
}

function reader(rpcUrl: string, payerPubkey = US): ChannelOnChainReader {
  return createSolanaChannelOnChainReader([
    { chainId: CHAIN, rpcUrl, programId: PROGRAM_ID, payerPubkey },
  ]);
}

function read(r: ChannelOnChainReader): Promise<bigint> {
  return r.getCumulativePaid({
    assetCode: 'USDC',
    chain: CHAIN,
    channelId: CHANNEL_ID,
  });
}

describe('createSolanaChannelOnChainReader (issue #141)', () => {
  it('[P0] decodes OUR transferred_amount when this node is participant A', async () => {
    const rpcUrl = await startRpcServer((req) => {
      expect(req.method).toBe('getAccountInfo');
      return accountInfo(
        encodeChannelAccount({
          participantA: RAW.us,
          participantB: RAW.them,
          transferredAmountA: 5_010_000n,
          // The counterparty's slot is deliberately larger: reading the
          // wrong side would over-recycle, so the test would catch it.
          transferredAmountB: 999_999_999n,
        })
      );
    });

    await expect(read(reader(rpcUrl))).resolves.toBe(5_010_000n);
  });

  it('[P0] decodes OUR transferred_amount when this node is participant B (not just slot A)', async () => {
    const rpcUrl = await startRpcServer(() =>
      accountInfo(
        encodeChannelAccount({
          participantA: RAW.them,
          participantB: RAW.us,
          transferredAmountA: 999_999_999n,
          transferredAmountB: 4_000n,
        })
      )
    );

    await expect(read(reader(rpcUrl))).resolves.toBe(4_000n);
  });

  it('[P0] a channel with nothing redeemed decodes to 0n, not a decode error', async () => {
    const rpcUrl = await startRpcServer(() =>
      accountInfo(encodeChannelAccount({ transferredAmountA: 0n }))
    );

    await expect(read(reader(rpcUrl))).resolves.toBe(0n);
  });

  it('[P0] reads the chain FRESH on every call — nothing is cached', async () => {
    const chain = { transferredAmountA: 0n };
    let calls = 0;
    const rpcUrl = await startRpcServer(() => {
      calls += 1;
      return accountInfo(encodeChannelAccount(chain));
    });
    const r = reader(rpcUrl);

    expect(await read(r)).toBe(0n);
    chain.transferredAmountA = 7_777n;
    expect(await read(r)).toBe(7_777n);
    expect(calls).toBe(2);
  });

  it('[P0] the request is a base64/confirmed getAccountInfo for the channel PDA', async () => {
    let captured: JsonRpcRequest | undefined;
    const rpcUrl = await startRpcServer((req) => {
      captured = req;
      return accountInfo(encodeChannelAccount({}));
    });

    await read(reader(rpcUrl));

    expect(captured?.method).toBe('getAccountInfo');
    expect(captured?.params[0]).toBe(CHANNEL_ID);
    expect(captured?.params[1]).toEqual({
      encoding: 'base64',
      commitment: 'confirmed',
    });
  });

  it('[P0] refuses when this node is NEITHER participant instead of picking a side', async () => {
    const rpcUrl = await startRpcServer(() =>
      accountInfo(
        encodeChannelAccount({
          participantA: RAW.them,
          participantB: RAW.stranger,
          transferredAmountA: 1n,
          transferredAmountB: 2n,
        })
      )
    );

    await expect(read(reader(rpcUrl))).rejects.toThrow(/neither participant/);
  });

  it('[P0] refuses a MISSING account (never opened, or settled-and-closed) rather than reading it as fully redeemed', async () => {
    const rpcUrl = await startRpcServer(() => ({
      context: { slot: 1 },
      value: null,
    }));

    await expect(read(reader(rpcUrl))).rejects.toThrow(/does not exist/);
  });

  it('[P1] refuses an account owned by some other program (a spoofed "pchannel" blob)', async () => {
    const rpcUrl = await startRpcServer(() =>
      accountInfo(
        encodeChannelAccount({ transferredAmountA: 10n }),
        base58Encode(RAW.otherProgram)
      )
    );

    await expect(read(reader(rpcUrl))).rejects.toThrow(/is owned by/);
  });

  it('[P1] refuses an account without the "pchannel" discriminator', async () => {
    const rpcUrl = await startRpcServer(() =>
      accountInfo(
        encodeChannelAccount({
          discriminator: 'notachan',
          transferredAmountA: 10n,
        })
      )
    );

    await expect(read(reader(rpcUrl))).rejects.toThrow(/discriminator/);
  });

  it('[P1] refuses truncated account data instead of decoding garbage', async () => {
    const rpcUrl = await startRpcServer(() =>
      accountInfo(encodeChannelAccount({ size: 100 }))
    );

    await expect(read(reader(rpcUrl))).rejects.toThrow(/too short/);
  });

  it('[P1] refuses account data in an unrecognized encoding', async () => {
    const rpcUrl = await startRpcServer(() => ({
      context: { slot: 1 },
      value: { data: { parsed: {} }, owner: PROGRAM_ID },
    }));

    await expect(read(reader(rpcUrl))).rejects.toThrow(/unrecognized format/);
  });

  it('[P1] rejects for a chain with no configured provider', async () => {
    const r = createSolanaChannelOnChainReader([]);
    await expect(
      r.getCumulativePaid({
        assetCode: 'USDC',
        chain: CHAIN,
        channelId: CHANNEL_ID,
      })
    ).rejects.toThrow(/No Solana chain provider configured/);
  });

  it('[P1] rejects when the RPC endpoint returns a JSON-RPC error', async () => {
    const rpcUrl = await startRpcServer(() => {
      throw new Error('node is behind');
    });

    await expect(read(reader(rpcUrl))).rejects.toThrow(/node is behind/);
  });

  it('[P1] rejects a channelId that is not a 32-byte base58 address, before any RPC', async () => {
    let calls = 0;
    const rpcUrl = await startRpcServer(() => {
      calls += 1;
      return accountInfo(encodeChannelAccount({}));
    });
    const r = reader(rpcUrl);

    await expect(
      r.getCumulativePaid({
        assetCode: 'USDC',
        chain: CHAIN,
        channelId: '0x' + '01'.repeat(32),
      })
    ).rejects.toThrow(/base58|32-byte/);
    expect(calls).toBe(0);
  });

  it('[P1] rejects a malformed programId / payer address at construction time', () => {
    expect(() =>
      createSolanaChannelOnChainReader([
        {
          chainId: CHAIN,
          rpcUrl: 'http://127.0.0.1:1',
          programId: 'not a program',
          payerPubkey: US,
        },
      ])
    ).toThrow();
    expect(() =>
      createSolanaChannelOnChainReader([
        {
          chainId: CHAIN,
          rpcUrl: 'http://127.0.0.1:1',
          programId: PROGRAM_ID,
          payerPubkey: base58Encode(new Uint8Array(16).fill(1)),
        },
      ])
    ).toThrow(/32-byte/);
  });

  it('[P2] two chains resolve against their own configured RPC endpoint independently', async () => {
    const rpcUrlA = await startRpcServer(() =>
      accountInfo(encodeChannelAccount({ transferredAmountA: 1n }))
    );
    const rpcUrlB = await startRpcServer(() =>
      accountInfo(encodeChannelAccount({ transferredAmountA: 2n }))
    );
    const r = createSolanaChannelOnChainReader([
      {
        chainId: 'solana:devnet',
        rpcUrl: rpcUrlA,
        programId: PROGRAM_ID,
        payerPubkey: US,
      },
      {
        chainId: 'solana:mainnet',
        rpcUrl: rpcUrlB,
        programId: PROGRAM_ID,
        payerPubkey: US,
      },
    ]);

    const [a, b] = await Promise.all([
      r.getCumulativePaid({
        assetCode: 'USDC',
        chain: 'solana:devnet',
        channelId: CHANNEL_ID,
      }),
      r.getCumulativePaid({
        assetCode: 'USDC',
        chain: 'solana:mainnet',
        channelId: CHANNEL_ID,
      }),
    ]);
    expect(a).toBe(1n);
    expect(b).toBe(2n);
  });
});
