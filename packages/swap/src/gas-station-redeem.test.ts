import { describe, expect, it } from 'vitest';
import { Transaction } from '@solana/web3.js';
import { base58Encode } from '@toon-protocol/sdk';
import type { SendResult } from '@toon-protocol/client';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';

import {
  createGasStationRedeemer,
  GasStationRefusal,
} from './gas-station-redeem.js';
import { SwapTaker } from './swap-taker.js';
import { InMemoryTakerStateStore } from './taker-state.js';
import type { TakerSessionState } from './taker-state.js';
import { deriveNostrIdentity } from './nostr-keys.js';
import type { SwapNodeKeys } from './wallet.js';
import type { SwapNodeChainProvider } from './swap-node.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const nostr = deriveNostrIdentity({ mnemonic: MNEMONIC });
const evmKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const evmAddress = privateKeyToAccount(`0x${'11'.repeat(32)}`).address;
const solSeed = Uint8Array.from(Buffer.from('33'.repeat(32), 'hex'));
const keys: SwapNodeKeys = {
  evm: { privateKey: evmKey, address: evmAddress, path: 'x' },
  solana: {
    privateKey: solSeed,
    publicKey: ed25519.getPublicKey(solSeed),
    path: 'y',
  },
};
const PROGRAM_ID = base58Encode(
  Uint8Array.from(Buffer.from('55'.repeat(32), 'hex'))
);
const MAKER_SOL = base58Encode(
  Uint8Array.from(Buffer.from('44'.repeat(32), 'hex'))
);
const STATION = base58Encode(
  Uint8Array.from(Buffer.from('77'.repeat(32), 'hex'))
);
const PDA = base58Encode(Uint8Array.from(Buffer.from('88'.repeat(32), 'hex')));
const providers: SwapNodeChainProvider[] = [
  {
    chainType: 'solana',
    chainId: 'solana:devnet',
    rpcUrl: 'http://127.0.0.1:1',
    programId: PROGRAM_ID,
    tokenMint: base58Encode(
      Uint8Array.from(Buffer.from('66'.repeat(32), 'hex'))
    ),
  },
  {
    chainType: 'evm',
    chainId: 'evm:84532',
    rpcUrl: 'http://127.0.0.1:1',
    registryAddress: '0x' + '11'.repeat(20),
    tokenAddress: '0x' + '22'.repeat(20),
    tokenNetworkAddress: '0x' + '44'.repeat(20),
  },
];

function session(
  chain: string,
  channelId: string,
  signer: string
): TakerSessionState {
  const claim = {
    chain,
    channelId,
    nonce: '3',
    cumulativeAmount: '2970000',
    signature: Buffer.alloc(chain.startsWith('evm') ? 65 : 64, 9).toString(
      'base64'
    ),
    signer,
  };
  return {
    streamNonce: 'ab'.repeat(16),
    orderId: 'o',
    makerPubkey: 'm',
    order: {} as never,
    quote: null,
    size: '3000000',
    delta: '1000000',
    chainRecipient: 'r',
    payerAddress: 'p',
    legA: { chain: 'x', channelId: null, nonce: '0', cumulative: '0' },
    lastFill: null,
    lastAdvance: {
      seq: 3,
      eventId: 'e',
      advance: {
        proto: 'rolling/3',
        type: 'advance',
        streamNonce: 'ab'.repeat(16),
        seq: 3,
        claim,
        recipient: 'r',
        rate: '0.99',
        rateTimestamp: 1,
        sourceAmount: '1',
        targetAmount: '1',
        legB: { chain, swapSignerAddress: signer },
      },
    },
    lastRefusal: null,
    received: { chain, channelId, nonce: '3', cumulative: '2970000', signer },
    credit: '0',
    status: 'done',
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A gas station behind a paid route: answers job events with `{accept:true, result}`. */
function station(
  answer: (kind: number, params: Record<string, string>) => unknown
) {
  const jobs: { kind: number; params: Record<string, string> }[] = [];
  const sender = {
    async send(
      _destination: string,
      request?: { body?: unknown }
    ): Promise<SendResult> {
      const event = (
        request?.body as { event: { kind: number; tags: string[][] } }
      ).event;
      const params: Record<string, string> = {};
      for (const t of event.tags)
        if (t[0] === 'param' && t[1] && t[2] !== undefined) params[t[1]] = t[2];
      jobs.push({ kind: event.kind, params });
      const body = JSON.stringify({
        accept: true,
        result: answer(event.kind, params),
      });
      return {
        fulfilled: true,
        transport: 'http',
        status: 200,
        headers: [],
        body: new TextEncoder().encode(body),
        text: () => body,
        json: <T>() => JSON.parse(body) as T,
        fulfillment: new Uint8Array(32),
      } as unknown as SendResult;
    },
  };
  return { sender, jobs };
}

describe('createGasStationRedeemer', () => {
  it('Solana: builds [ed25519, ClaimFromChannel] with the station as fee payer and no taker signature', async () => {
    let executed: Transaction | undefined;
    const st = station((kind, params) => {
      expect(kind).toBe(5096);
      if (params['phase'] === 'quote') {
        return {
          job: 'gas-station',
          phase: 'quote',
          status: 'ok',
          network: 'devnet',
          quoteId: 'q1',
          feePayer: STATION,
          maxLamports: '10000',
          recentBlockhash: base58Encode(
            Uint8Array.from(Buffer.from('99'.repeat(32), 'hex'))
          ),
          expiresAt: 1,
        };
      }
      executed = Transaction.from(
        Buffer.from(params['transaction']!, 'base64')
      );
      expect(params['quoteId']).toBe('q1');
      expect(params['idempotencyKey']).toMatch(/^[0-9a-f]{32}$/);
      return {
        job: 'gas-station',
        phase: 'execute',
        status: 'ok',
        network: 'devnet',
        quoteId: 'q1',
        idempotencyKey: params['idempotencyKey'],
        signature: 'SIG',
        slot: null,
        feeLamportsActual: null,
      };
    });
    const r = createGasStationRedeemer({
      sender: st.sender,
      keys,
      nostrSecretKey: nostr.secretKey,
      chainProviders: providers,
    });
    const out = await r.redeem(session('solana:devnet', PDA, MAKER_SOL));
    expect(out.txId).toBe('SIG');
    expect(st.jobs.map((j) => j.params['phase'])).toEqual(['quote', 'execute']);
    expect(executed?.feePayer?.toBase58()).toBe(STATION);
    expect(executed?.instructions).toHaveLength(2);
    expect(executed?.instructions[0]?.programId.toBase58()).toBe(
      'Ed25519SigVerify111111111111111111111111111'
    );
    expect(executed?.instructions[1]?.programId.toBase58()).toBe(PROGRAM_ID);
    const claimIx = executed!.instructions[1]!;
    expect(claimIx.keys[0]?.pubkey.toBase58()).toBe(STATION);
    expect(claimIx.keys[1]?.pubkey.toBase58()).toBe(MAKER_SOL);
    expect(claimIx.keys[1]?.isSigner).toBe(false);
    expect(claimIx.keys[2]?.pubkey.toBase58()).toBe(PDA);
    expect(claimIx.data.readUInt32LE(0)).toBe(6); // ClaimFromChannel
    expect(claimIx.data.readBigUInt64LE(8)).toBe(3n);
    expect(claimIx.data.readBigUInt64LE(16)).toBe(2_970_000n);
    expect(executed?.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it('EVM: signs an ERC-2771 ForwardRequest for claimFromChannel that recovers to the taker', async () => {
    const forwarder = ('0x' + 'f0'.repeat(20)) as Hex;
    const domain = {
      name: 'TOONForwarder',
      version: '1',
      chainId: 84532n,
      verifyingContract: forwarder,
    };
    let request: Record<string, string | number> | undefined;
    const st = station((kind, params) => {
      expect(kind).toBe(5098);
      expect(params['chainId']).toBe('84532');
      if (params['phase'] === 'quote') {
        expect(params['from']).toBe(evmAddress);
        return {
          job: 'evm-gas-station',
          phase: 'quote',
          status: 'ok',
          chainId: 84532,
          quoteId: 'q2',
          relayer: '0x' + 'aa'.repeat(20),
          forwarder,
          tokenNetwork: '0x' + '44'.repeat(20),
          forwarderNonce: '7',
          maxGas: '250000',
          recommendedDeadline: 1_900_000_000,
          expiresAt: 1,
        };
      }
      request = JSON.parse(
        Buffer.from(params['request']!, 'base64').toString('utf8')
      ) as Record<string, string | number>;
      return {
        job: 'evm-gas-station',
        phase: 'execute',
        status: 'ok',
        chainId: 84532,
        txHash: '0xhash',
        blockNumber: 1,
        gasUsed: '1',
        effectiveGasPriceWei: '1',
      };
    });
    const r = createGasStationRedeemer({
      sender: st.sender,
      keys,
      nostrSecretKey: nostr.secretKey,
      chainProviders: providers,
      readForwarderDomain: async (_rpc, f) => {
        expect(f).toBe(forwarder);
        return domain;
      },
    });
    const out = await r.redeem(
      session('evm:84532', '0x' + '12'.repeat(32), evmAddress)
    );
    expect(out.txId).toBe('0xhash');
    expect(request).toMatchObject({
      from: evmAddress,
      to: '0x' + '44'.repeat(20),
      value: '0',
      gas: '250000',
      deadline: 1_900_000_000,
    });
    expect(String(request!['data'])).toMatch(/^0x/);
    const recovered = await recoverTypedDataAddress({
      domain,
      types: {
        ForwardRequest: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'gas', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint48' },
          { name: 'data', type: 'bytes' },
        ],
      },
      primaryType: 'ForwardRequest',
      message: {
        from: evmAddress,
        to: request!['to'] as Hex,
        value: 0n,
        gas: 250000n,
        nonce: 7n,
        deadline: 1_900_000_000,
        data: request!['data'] as Hex,
      },
      signature: request!['signature'] as Hex,
    });
    expect(recovered.toLowerCase()).toBe(evmAddress.toLowerCase());
  });

  it('a station refusal is a GasStationRefusal, and SwapTaker falls back to own gas when allowed', async () => {
    const st = station(() => ({
      job: 'gas-station',
      phase: 'quote',
      status: 'failed',
      network: 'devnet',
      reason: 'channel_op_not_permitted',
      detail: 'ClaimFromChannel is not deposit/close/settle',
    }));
    const gs = createGasStationRedeemer({
      sender: st.sender,
      keys,
      nostrSecretKey: nostr.secretKey,
      chainProviders: providers,
    });
    await expect(
      gs.redeem(session('solana:devnet', PDA, MAKER_SOL))
    ).rejects.toThrow(GasStationRefusal);

    const store = new InMemoryTakerStateStore();
    const s = session('solana:devnet', PDA, MAKER_SOL);
    store.save({
      version: 1,
      sessions: { [s.streamNonce]: s },
      channels: {},
      inbound: {},
      relayCursor: 0,
      seenEventIds: [],
    });
    const own = { redeem: async () => ({ txId: 'OWN' }) };
    const reader = {
      start() {},
      close() {},
      subscribe: () => 'x',
      isConnected: () => true,
      hasReachedEose: () => true,
    };
    const taker = new SwapTaker({
      nostr,
      keys,
      reader,
      writer: {
        destination: 'g',
        publish: async (e) => ({
          ok: true as const,
          eventId: e.id,
          status: 200,
        }),
      },
      slotReader: {} as never,
      chainProviders: providers,
      store,
      redeemer: own,
      gasStationRedeemer: gs,
    });
    const fallback = await taker.redeem(s.streamNonce, { via: 'gas-station' });
    expect(fallback).toEqual({ txId: 'OWN', via: 'own' });
    await expect(
      taker.redeem(s.streamNonce, { via: 'gas-station', fallback: false })
    ).rejects.toThrow(/gas_station_refused/);
    expect(taker.session(s.streamNonce)?.redeemed?.txId).toBe('OWN');
  });
});
