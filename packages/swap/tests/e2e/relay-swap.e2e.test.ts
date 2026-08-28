/**
 * THE proof this package exists for: cross-chain rolling swaps through the
 * topology the swap actually ships in —
 *
 *   taker ──gift wrap──▶ relay ◀──gift wrap── maker
 *      (both pay the relay's Rust connector 1 µUSDC per write)
 *
 * Real anvil, real `solana-test-validator` running the real payment-channel
 * program, the real relay, the real `connector` binary (or image) fronting
 * it, `startSwapNode()` and `createTakerRuntime()` in-process. Every leg-B
 * claim is redeemed ON CHAIN and the recipient's balance is what is
 * asserted; a claim that merely "looks right" proves nothing.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Address, Hex } from 'viem';
import { base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from '../../src/swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from '../../src/swap-node.js';
import { createTakerRuntime } from '../../src/taker-runtime.js';
import type { TakerRuntime } from '../../src/taker-runtime.js';
import { deriveSwapNodeKeys } from '../../src/wallet.js';
import type { SwapAdvance } from '../../src/wire.js';

import {
  deployEvmContracts,
  erc20Balance,
  fundEth,
  mintUsdc,
  readTokenNetworkParticipant,
  startFreshAnvil,
  type EvmDeployment,
  type FreshAnvil,
} from './helpers/evm-chain.js';
import {
  airdropSol,
  associatedTokenAddress,
  mintUsdcTo,
  readSolanaChannel,
  splBalance,
} from './helpers/solana-chain.js';
import {
  provisionSplMint,
  startSolanaValidator,
  type SolanaProvisioning,
  type SolanaValidatorInstance,
} from './helpers/solana-validator.js';
import { startRelay, type RelayInstance } from './helpers/relay.js';
import {
  startRustConnector,
  type RustConnectorInstance,
} from './helpers/rust-connector.js';
import {
  ANVIL_CHAIN_ID,
  ANVIL_PORT,
  MAKER_APP_PORT,
  PEER1_MNEMONIC,
  RELAY_CONNECTOR_PORT,
  RELAY_CONNECTOR_URL,
  RELAY_PORT,
  RELAY_URL,
  RELAY_WRITE_PORT,
  RELAY_WRITE_URL,
} from './helpers/topology.js';

const USDC = 1_000_000n;
const FILL = 1n * USDC;
const EVM_CHAIN = `evm:${ANVIL_CHAIN_ID}`;
const SOL_CHAIN = 'solana:localnet';
const TAKER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

const log = (line: string): void => console.log(`[swap e2e] ${line}`);

let anvil: FreshAnvil;
let evm: EvmDeployment;
let validator: SolanaValidatorInstance;
let sol: SolanaProvisioning;
let relay: RelayInstance;
let connector: RustConnectorInstance;
let maker: SwapNodeInstance;
let stateDir: string;
let makerStatePath: string;

let makerEvmAddress: Address;
let makerSolanaPubkey: PublicKey;
let takerEvmAddress: Address;
let takerSolanaPubkey: PublicKey;

const cleanups: (() => Promise<void> | void)[] = [];

function makerConfig(): SwapNodeConfig {
  return {
    mnemonic: PEER1_MNEMONIC,
    chains: ['evm', 'solana'],
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
        rate: '0.99',
      },
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        rate: '1.0',
      },
    ],
    // No pre-opened leg-B channels: the maker opens/deposits on demand.
    channels: { [EVM_CHAIN]: [], [SOL_CHAIN]: [] },
    inventory: { [EVM_CHAIN]: 50n * USDC, [SOL_CHAIN]: 50n * USDC },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: EVM_CHAIN,
        rpcUrl: anvil.rpcUrl,
        registryAddress: evm.registry,
        tokenAddress: evm.usdc,
        tokenNetworkAddress: evm.tokenNetwork,
        channelDeposit: 2n * USDC, // fill 3 must top up
        settlementTimeoutSeconds: 3600,
      },
      {
        chainType: 'solana',
        chainId: SOL_CHAIN,
        rpcUrl: validator.rpcUrl,
        programId: validator.programId,
        tokenMint: sol.mint,
        channelDeposit: 2n * USDC,
        challengeDurationSeconds: 0,
      },
    ],
    relay: {
      readUrl: RELAY_URL,
      connectorUrl: RELAY_CONNECTOR_URL,
      payChain: 'evm',
      rpcUrl: anvil.rpcUrl,
      deposit: 1n * USDC,
      channelStorePath: join(stateDir, 'maker-relay-channels.json'),
    },
    order: {
      fill: { min: FILL, max: 5n * FILL },
      ttlMs: 600_000,
      refreshMs: 300_000,
    },
    quote: { sessionTtlMs: 600_000 },
    statePath: makerStatePath,
    reconcileIntervalMs: 0,
    appPort: MAKER_APP_PORT,
    logger: {
      debug: () => undefined,
      info: (...a) =>
        console.log('[maker]', ...a.map((x) => JSON.stringify(x))),
      warn: (...a) =>
        console.warn('[maker]', ...a.map((x) => JSON.stringify(x))),
      error: (...a) =>
        console.error('[maker]', ...a.map((x) => JSON.stringify(x))),
    },
  };
}

async function takerRuntime(
  opts: {
    statePath?: string;
    answerTimeoutMs?: number;
    maxResends?: number;
  } = {}
): Promise<TakerRuntime> {
  const cfg = makerConfig();
  return createTakerRuntime({
    mnemonic: TAKER_MNEMONIC,
    chains: ['evm', 'solana'],
    chainProviders: (cfg.chainProviders ?? []).map((p) => {
      // The taker never opens leg-B channels; strip the maker's on-demand knob.
      const { channelDeposit: _drop, ...rest } = p as {
        channelDeposit?: unknown;
      } & typeof p;
      return rest as typeof p;
    }),
    relay: {
      readUrl: RELAY_URL,
      connectorUrl: RELAY_CONNECTOR_URL,
      payChain: 'evm',
      rpcUrl: anvil.rpcUrl,
      deposit: 1n * USDC,
      channelStorePath: join(stateDir, 'taker-relay-channels.json'),
    },
    statePath: opts.statePath ?? join(stateDir, 'taker-state.json'),
    logger: {
      info: (...a) =>
        console.log('[taker]', ...a.map((x) => JSON.stringify(x))),
      warn: (...a) =>
        console.warn('[taker]', ...a.map((x) => JSON.stringify(x))),
      error: (...a) =>
        console.error('[taker]', ...a.map((x) => JSON.stringify(x))),
    },
    ...(opts.answerTimeoutMs !== undefined && {
      answerTimeoutMs: opts.answerTimeoutMs,
    }),
    ...(opts.maxResends !== undefined && { maxResends: opts.maxResends }),
  });
}

async function waitFor(
  cond: () => boolean,
  ms: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  const makerKeys = await deriveSwapNodeKeys({
    mnemonic: PEER1_MNEMONIC,
    chains: ['evm', 'solana'],
  });
  const takerKeys = await deriveSwapNodeKeys({
    mnemonic: TAKER_MNEMONIC,
    chains: ['evm', 'solana'],
  });
  if (
    !makerKeys.evm ||
    !makerKeys.solana ||
    !takerKeys.evm ||
    !takerKeys.solana
  )
    throw new Error('keys missing');
  makerEvmAddress = makerKeys.evm.address as Address;
  makerSolanaPubkey = new PublicKey(base58Encode(makerKeys.solana.publicKey));
  takerEvmAddress = takerKeys.evm.address as Address;
  takerSolanaPubkey = new PublicKey(base58Encode(takerKeys.solana.publicKey));

  log('booting anvil');
  anvil = await startFreshAnvil({ port: ANVIL_PORT, chainId: ANVIL_CHAIN_ID });
  cleanups.push(() => anvil.stop());
  evm = await deployEvmContracts(anvil.rpcUrl);
  log(`evm: usdc=${evm.usdc} tokenNetwork=${evm.tokenNetwork}`);

  log('booting solana-test-validator');
  validator = await startSolanaValidator();
  cleanups.push(() => validator.stop());
  sol = await provisionSplMint(validator.rpcUrl);
  cleanups.push(() => sol.dispose());
  log(`solana: mint=${sol.mint} program=${validator.programId}`);

  // ---- funding: both parties pay relay writes on EVM; both hold USDC on both chains ----
  for (const a of [makerEvmAddress, takerEvmAddress]) {
    await fundEth(anvil.rpcUrl, a, 10n * 10n ** 18n);
    await mintUsdc(anvil.rpcUrl, evm.usdc, a, 100n * USDC);
  }
  const relayConnectorKey = randomBytes(32).toString('hex');
  const { privateKeyToAccount } = await import('viem/accounts');
  await fundEth(
    anvil.rpcUrl,
    privateKeyToAccount(`0x${relayConnectorKey}` as Hex).address,
    10n * 10n ** 18n
  );
  for (const p of [makerSolanaPubkey, takerSolanaPubkey]) {
    await airdropSol(validator.rpcUrl, p, 10);
    await mintUsdcTo({
      rpcUrl: validator.rpcUrl,
      mint: new PublicKey(sol.mint),
      owner: p,
      amount: 100n * USDC,
    });
  }

  // ---- the relay and its connector ----
  stateDir = mkdtempSync(join(tmpdir(), 'swap-e2e-'));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  makerStatePath = join(stateDir, 'maker-state.json');
  log('booting relay');
  relay = await startRelay({ wsPort: RELAY_PORT, writePort: RELAY_WRITE_PORT });
  cleanups.push(() => relay.stop());
  log('booting the relay connector');
  connector = await startRustConnector({
    clientEdgePort: RELAY_CONNECTOR_PORT,
    stateDir: join(stateDir, 'connector'),
    signerKeyHex: randomBytes(32).toString('hex'),
    evm: {
      rpcUrl: anvil.rpcUrl,
      registryAddress: evm.registry,
      tokenAddress: evm.usdc,
      settlementKeyHex: relayConnectorKey,
    },
    routes: [{ prefix: 'g.toon.relay', handlerUrl: RELAY_WRITE_URL, price: 1 }],
    // `ToonClient` picks its carriage from the connector's self-description
    // (`GET /ilp`), which only names endpoints a `[node]` section declares.
    extraToml: `[node]\naddresses = ["g.toon.relay"]\nhttp_endpoint = "${RELAY_CONNECTOR_URL}/ilp"`,
  });
  cleanups.push(() => connector.stop());
  log(
    `relay connector: ${JSON.stringify(((await connector.describe()) as { routes?: unknown }).routes)}`
  );

  // ---- the maker ----
  maker = await startSwapNode(makerConfig());
  cleanups.push(() => maker.stop());
  log(
    `maker up: nostr=${maker.nostr.pubkey} evm=${makerEvmAddress} sol=${makerSolanaPubkey.toBase58()}`
  );
}, 300_000);

afterAll(async () => {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      /* best effort */
    }
  }
});

describe('relay-mediated rolling swap', () => {
  it('the maker publishes one order per pair and a taker reads them off the relay', async () => {
    const rt = await takerRuntime();
    try {
      rt.taker.listOrders();
      await waitFor(
        () => rt.taker.ordersReady() && rt.taker.listOrders().length === 2,
        15_000,
        'two orders'
      );
      const orders = rt.taker.listOrders();
      expect(orders.every((o) => o.makerPubkey === maker.nostr.pubkey)).toBe(
        true
      );
      const evmToSol = orders.find(
        (o) => o.order.pair.from.chain === EVM_CHAIN
      )!;
      expect(evmToSol.order.legA).toMatchObject({
        chain: EVM_CHAIN,
        verifyingContract: evm.tokenNetwork,
        token: evm.usdc,
      });
      expect(evmToSol.order.legB).toMatchObject({
        chain: SOL_CHAIN,
        programId: validator.programId,
        token: sol.mint,
      });
      expect(evmToSol.order.fill).toEqual({
        min: FILL.toString(),
        max: (5n * FILL).toString(),
      });
      expect(maker.maker?.health().writes.ok).toBeGreaterThanOrEqual(2);
    } finally {
      await rt.stop();
    }
  });

  it(`EVM→Solana: three fills, the maker funds leg B on demand, and the taker is paid on chain after claim → close → settle`, async () => {
    const rt = await takerRuntime();
    try {
      rt.taker.listOrders();
      await waitFor(
        () =>
          rt.taker
            .listOrders()
            .some((o) => o.order.pair.from.chain === EVM_CHAIN),
        15_000,
        'the EVM→SOL order'
      );
      const listing = rt.taker
        .listOrders()
        .find((o) => o.order.pair.from.chain === EVM_CHAIN)!;
      const session = await rt.taker.accept(listing, {
        size: 3n * FILL,
        delta: FILL,
      });
      const advances: SwapAdvance[] = [];
      const done = await rt.taker.run(session.streamNonce, {
        onFill: (a) => {
          advances.push(a);
        },
      });
      expect(done.status).toBe('done');
      expect(advances.map((a) => a.claim.cumulativeAmount)).toEqual([
        '990000',
        '1980000',
        '2970000',
      ]);

      // Leg A landed: the maker holds the taker's EVM claim, cumulative 3 USDC.
      const inbound =
        maker.maker!.health().inbound[`${EVM_CHAIN}:${done.legA.channelId}`];
      expect(inbound).toMatchObject({
        cumulative: (3n * FILL).toString(),
        seq: 3,
      });

      // Leg B on chain: the maker deposited (and topped up) its side of the (maker, taker) PDA.
      const pda = new PublicKey(advances[2]!.claim.channelId);
      const onChain = await readSolanaChannel(validator.rpcUrl, pda);
      expect(onChain).not.toBeNull();
      const makerIsA = onChain!.participantA.equals(makerSolanaPubkey);
      expect(
        makerIsA ? onChain!.depositA : onChain!.depositB
      ).toBeGreaterThanOrEqual(2_970_000n);

      // Redeem: record the claim, close, settle (challenge 0) → the taker's ATA grows by 2.97 USDC.
      const ata = associatedTokenAddress(
        takerSolanaPubkey,
        new PublicKey(sol.mint)
      );
      const before = await splBalance(validator.rpcUrl, ata);
      await rt.taker.redeem(session.streamNonce);
      const afterClaim = await readSolanaChannel(validator.rpcUrl, pda);
      expect(
        makerIsA
          ? afterClaim!.transferredAmountA
          : afterClaim!.transferredAmountB
      ).toBe(2_970_000n);
      await rt.settler.close(rt.taker.session(session.streamNonce)!);
      await rt.settler.settle(rt.taker.session(session.streamNonce)!);
      expect((await splBalance(validator.rpcUrl, ata)) - before).toBe(
        2_970_000n
      );
    } finally {
      await rt.stop();
    }
  }, 180_000);

  it('Solana→EVM: two fills, the maker opens the TokenNetwork channel on demand, claimFromChannel pays the taker', async () => {
    const rt = await takerRuntime();
    try {
      rt.taker.listOrders();
      await waitFor(
        () =>
          rt.taker
            .listOrders()
            .some((o) => o.order.pair.from.chain === SOL_CHAIN),
        15_000,
        'the SOL→EVM order'
      );
      const listing = rt.taker
        .listOrders()
        .find((o) => o.order.pair.from.chain === SOL_CHAIN)!;
      const session = await rt.taker.accept(listing, {
        size: 2n * FILL,
        delta: FILL,
      });
      const advances: SwapAdvance[] = [];
      const done = await rt.taker.run(session.streamNonce, {
        onFill: (a) => {
          advances.push(a);
        },
      });
      expect(done.status).toBe('done');
      expect(advances.map((a) => a.claim.cumulativeAmount)).toEqual([
        '1000000',
        '2000000',
      ]);

      const channelId = advances[1]!.claim.channelId as Hex;
      const makerSlot = await readTokenNetworkParticipant({
        rpcUrl: anvil.rpcUrl,
        tokenNetwork: evm.tokenNetwork,
        channelId,
        participant: makerEvmAddress,
      });
      expect(makerSlot.deposit).toBeGreaterThanOrEqual(2n * USDC);

      const before = await erc20Balance(
        anvil.rpcUrl,
        evm.usdc,
        takerEvmAddress
      );
      const { txId } = await rt.taker.redeem(session.streamNonce);
      expect(txId).toMatch(/^0x/);
      expect(
        (await erc20Balance(anvil.rpcUrl, evm.usdc, takerEvmAddress)) - before
      ).toBe(2n * USDC);
      const after = await readTokenNetworkParticipant({
        rpcUrl: anvil.rpcUrl,
        tokenNetwork: evm.tokenNetwork,
        channelId,
        participant: makerEvmAddress,
      });
      expect(after.transferredAmount).toBe(2n * USDC);
    } finally {
      await rt.stop();
    }
  }, 180_000);

  it('a taker that stops before reading an answer resumes from disk through the relay’s history', async () => {
    // The taker's own disk — the same state file every session in this suite uses.
    const statePath = join(stateDir, 'taker-state.json');
    const first = await takerRuntime({ statePath });
    let session;
    try {
      first.taker.listOrders();
      await waitFor(
        () =>
          first.taker
            .listOrders()
            .some((o) => o.order.pair.from.chain === EVM_CHAIN),
        15_000,
        'the order'
      );
      const listing = first.taker
        .listOrders()
        .find((o) => o.order.pair.from.chain === EVM_CHAIN)!;
      session = await first.taker.accept(listing, {
        size: 2n * FILL,
        delta: FILL,
      });
      // Starve the stream: publish fill 1, give the answer no time, give up.
      await expect(
        first.taker.run(session.streamNonce, {
          answerTimeoutMs: 1,
          maxResends: 1,
        })
      ).rejects.toThrow(/no_answer/);
    } finally {
      await first.stop();
    }
    // The maker answered fill 1 into the relay; nobody read it.
    await waitFor(
      () => maker.engine.sessionFor(session!.streamNonce)?.lastSeq === 1,
      30_000,
      'the maker to answer fill 1'
    );

    const second = await takerRuntime({ statePath });
    try {
      const resumed = await second.taker.resume(session!.streamNonce);
      expect(resumed.status).toBe('done');
      expect(resumed.lastAdvance?.seq).toBe(2);
      expect(maker.engine.sessionFor(session!.streamNonce)?.lastSeq).toBe(2);
    } finally {
      await second.stop();
    }
  }, 180_000);

  it('a maker restarted from its state file continues a stream at the right leg-B nonce', async () => {
    const rt = await takerRuntime();
    try {
      rt.taker.listOrders();
      await waitFor(
        () =>
          rt.taker
            .listOrders()
            .some((o) => o.order.pair.from.chain === EVM_CHAIN),
        15_000,
        'the order'
      );
      const listing = rt.taker
        .listOrders()
        .find((o) => o.order.pair.from.chain === EVM_CHAIN)!;
      const session = await rt.taker.accept(listing, {
        size: 2n * FILL,
        delta: FILL,
      });
      const advances: SwapAdvance[] = [];
      let restarted = false;
      const done = await rt.taker.run(session.streamNonce, {
        onFill: async (a) => {
          advances.push(a);
          if (!restarted) {
            restarted = true;
            await maker.stop();
            maker = await startSwapNode(makerConfig());
          }
        },
      });
      expect(done.status).toBe('done');
      expect(advances).toHaveLength(2);
      expect(BigInt(advances[1]!.claim.nonce)).toBeGreaterThan(
        BigInt(advances[0]!.claim.nonce)
      );
      expect(advances[1]!.claim.channelId).toBe(advances[0]!.claim.channelId);
    } finally {
      await rt.stop();
    }
  }, 180_000);
});
