/**
 * THE proof this package exists for: a cross-chain rolling swap, both
 * directions, through the topology the maker actually ships in —
 *
 *   taker ──POST /ilp (sealed, + leg-A claim)──▶ Rust connector ──HTTP──▶ maker app
 *         ◀─────── FULFILL (sealed leg-B claim) ─┘  X-TOON-Payer/Amount/Chain
 *
 * Real anvil, real `solana-test-validator` running the real payment-channel
 * program, the real `connector` binary (or image) with both settlement
 * backends, and `startSwapNode()` in-process. The taker is the toolkit in
 * `./helpers` — what `toon-client` will do, written against the connector's
 * wire vectors. Every leg-B claim is redeemed ON CHAIN and the recipient's
 * balance is what is asserted; a claim that merely "looks right" proves
 * nothing (that is how swap#164 shipped unredeemable Solana claims for months).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { recoverEvmClaimSigner } from '@toon-protocol/settlement-digest';
import { base58Encode } from '@toon-protocol/sdk';

import { startSwapNode } from '../../src/swap-node.js';
import type { SwapNodeInstance } from '../../src/swap-node.js';
import { deriveSwapNodeKeys } from '../../src/wallet.js';
import { solanaBalanceProofMessage } from '../../src/payment-channel-signer.js';
import { SWAP_WIRE_PROTOCOL, parseSwapWireAnswer } from '../../src/wire.js';
import type { SwapAdvance, SwapQuote, SwapRefusal } from '../../src/wire.js';

import {
  ANVIL_ACCOUNT1_KEY,
  deployEvmContracts,
  erc20Balance,
  evmAddressOf,
  fundEth,
  mintUsdc,
  openMakerRollingChannel,
  openTakerEvmChannel,
  settleRollingSwapChannel,
  signEvmClientClaim,
  startFreshAnvil,
  type EvmDeployment,
  type FreshAnvil,
  type TakerEvmChannel,
} from './helpers/evm-chain.js';
import {
  airdropSol,
  associatedTokenAddress,
  claimFromSolanaChannel,
  closeSolanaChannel,
  keypairFromSeed,
  mintUsdcTo,
  openSolanaChannelAsDepositor,
  seedToHex,
  settleSolanaChannel,
  signSolanaClientClaim,
  splBalance,
  type DepositorSolanaChannel,
} from './helpers/solana-chain.js';
import {
  provisionSplMint,
  startSolanaValidator,
  type ProvisionedOpener,
  type SolanaProvisioning,
  type SolanaValidatorInstance,
} from './helpers/solana-validator.js';
import { startRustConnector, type RustConnectorInstance } from './helpers/rust-connector.js';
import { sendSealedRequest, type SealedRequestOutcome } from './helpers/taker-edge.js';
import {
  ANVIL_CHAIN_ID,
  ANVIL_PORT,
  MAKER_APP_PORT,
  MAKER_APP_URL,
  MAKER_CONNECTOR_CLIENT_EDGE_PORT,
  PEER1_MNEMONIC,
} from './helpers/topology.js';

const USDC = 1_000_000n;
const FILL = 1n * USDC; // the fill route's price = one fill
const FILLS = 3;
const MAKER_ILP = 'g.test.swap.maker';
const EVM_CHAIN = `evm:${ANVIL_CHAIN_ID}`;
const SOL_CHAIN = 'solana:localnet';

const log = (line: string): void => console.log(`[swap e2e] ${line}`);

let anvil: FreshAnvil;
let evm: EvmDeployment;
let validator: SolanaValidatorInstance;
let sol: SolanaProvisioning;
let connector: RustConnectorInstance;
let maker: SwapNodeInstance;
let stateDir: string;
let makerStatePath: string;

// The maker's own identity: one mnemonic → Nostr key + index-2 chain keys.
let makerEvmKey: Hex;
let makerEvmAddress: Address;
let makerSolanaSeed: Uint8Array;
let makerSolanaPubkey: PublicKey;

// The maker's connector: its own settlement identities (what leg A pays).
const connectorEvmKey = `0x${randomBytes(32).toString('hex')}` as Hex;
const connectorSolanaSeed = new Uint8Array(randomBytes(32));
let connectorEvmAddress: Address;
let connectorSolanaPubkey: PublicKey;

// The taker.
const takerEvmKey = ANVIL_ACCOUNT1_KEY;
const takerEvmAddress = evmAddressOf(takerEvmKey);
let takerSol: ProvisionedOpener;
let takerSolPubkey: PublicKey;
let takerEvmChannel: TakerEvmChannel; // leg A for EVM→SOL
let takerSolChannel: DepositorSolanaChannel; // leg A for SOL→EVM

// Leg-B channels the maker pre-opens (operator provisioning).
const EVM_LEG_B_CHANNEL = keccak256(toHex('swap-e2e-leg-b-evm'));
let solLegBChannel: DepositorSolanaChannel; // maker → taker

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  // ---- identities -------------------------------------------------------
  const keys = await deriveSwapNodeKeys({
    mnemonic: PEER1_MNEMONIC,
    chains: ['evm', 'solana'],
  });
  if (!keys.evm || !keys.solana) throw new Error('maker keys missing');
  makerEvmKey = `0x${Buffer.from(keys.evm.privateKey).toString('hex')}` as Hex;
  makerEvmAddress = keys.evm.address as Address;
  makerSolanaSeed = keys.solana.privateKey;
  makerSolanaPubkey = new PublicKey(base58Encode(keys.solana.publicKey));
  connectorEvmAddress = evmAddressOf(connectorEvmKey);
  connectorSolanaPubkey = keypairFromSeed(connectorSolanaSeed).publicKey;

  // ---- chains -----------------------------------------------------------
  log('booting anvil');
  anvil = await startFreshAnvil({ port: ANVIL_PORT, chainId: ANVIL_CHAIN_ID });
  cleanups.push(() => anvil.stop());
  evm = await deployEvmContracts(anvil.rpcUrl);
  log(`evm: usdc=${evm.usdc} tokenNetwork=${evm.tokenNetwork} rolling=${evm.rollingSwapChannel}`);

  log('booting solana-test-validator');
  validator = await startSolanaValidator();
  cleanups.push(() => validator.stop());
  sol = await provisionSplMint(validator.rpcUrl);
  cleanups.push(() => sol.dispose());
  takerSol = sol.openers[0] as ProvisionedOpener;
  takerSolPubkey = keypairFromSeed(takerSol.seed).publicKey;
  log(`solana: mint=${sol.mint} taker=${takerSolPubkey.toBase58()} maker=${makerSolanaPubkey.toBase58()}`);

  // ---- funding ----------------------------------------------------------
  await fundEth(anvil.rpcUrl, connectorEvmAddress, 10n * 10n ** 18n);
  await fundEth(anvil.rpcUrl, makerEvmAddress, 10n * 10n ** 18n);
  await mintUsdc(anvil.rpcUrl, evm.usdc, makerEvmAddress, 100n * USDC);
  await mintUsdc(anvil.rpcUrl, evm.usdc, takerEvmAddress, 100n * USDC);
  await airdropSol(validator.rpcUrl, connectorSolanaPubkey, 10);
  await airdropSol(validator.rpcUrl, makerSolanaPubkey, 10);
  await mintUsdcTo({
    rpcUrl: validator.rpcUrl,
    mint: new PublicKey(sol.mint),
    owner: makerSolanaPubkey,
    amount: 100n * USDC,
  });

  // ---- the maker's leg-B channels (operator provisioning) ---------------
  await openMakerRollingChannel({
    rpcUrl: anvil.rpcUrl,
    rollingSwapChannel: evm.rollingSwapChannel,
    usdc: evm.usdc,
    funderPrivateKey: makerEvmKey,
    channelId: EVM_LEG_B_CHANNEL,
    signer: makerEvmAddress,
    deposit: 10n * USDC,
  });
  solLegBChannel = await openSolanaChannelAsDepositor({
    rpcUrl: validator.rpcUrl,
    programId: validator.programId,
    mint: sol.mint,
    depositorSeed: makerSolanaSeed,
    counterparty: takerSolPubkey,
    amount: 10n * USDC,
    challengeDurationSeconds: 0,
  });
  log(`leg-B channels: evm=${EVM_LEG_B_CHANNEL} solana=${solLegBChannel.channelAccount.toBase58()}`);

  // ---- the maker app ----------------------------------------------------
  stateDir = mkdtempSync(join(tmpdir(), 'swap-e2e-'));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  makerStatePath = join(stateDir, 'maker-state.json');
  maker = await startSwapNode({
    mnemonic: PEER1_MNEMONIC,
    ilpAddress: MAKER_ILP,
    fillAmount: FILL,
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
        rate: '1.0',
      },
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
        to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
        rate: '1.0',
      },
    ],
    chains: ['evm', 'solana'],
    channels: {
      [EVM_CHAIN]: [
        { channelId: EVM_LEG_B_CHANNEL, cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 },
      ],
      [SOL_CHAIN]: [
        {
          channelId: solLegBChannel.channelAccount.toBase58(),
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { [EVM_CHAIN]: 10n * USDC, [SOL_CHAIN]: 10n * USDC },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: EVM_CHAIN,
        rpcUrl: anvil.rpcUrl,
        registryAddress: evm.registry,
        tokenAddress: evm.usdc,
        tokenNetworkAddress: evm.tokenNetwork,
        channelAddress: evm.rollingSwapChannel,
      },
      {
        chainType: 'solana',
        chainId: SOL_CHAIN,
        rpcUrl: validator.rpcUrl,
        programId: validator.programId,
        tokenMint: sol.mint,
      },
    ],
    statePath: makerStatePath,
    reconcileIntervalMs: 0,
    appPort: MAKER_APP_PORT,
    logger: {
      debug: () => undefined,
      info: (...a) => console.log('[maker]', ...a.map((x) => JSON.stringify(x))),
      warn: (...a) => console.warn('[maker]', ...a.map((x) => JSON.stringify(x))),
      error: (...a) => console.error('[maker]', ...a.map((x) => JSON.stringify(x))),
    },
  });
  cleanups.push(() => maker.stop());
  log(`maker up on ${MAKER_APP_URL}: rfq=${maker.rfqDestination} fill=${maker.fillDestination}`);

  // ---- the maker's Rust connector, terminating at the app ----------------
  const connectorState = join(stateDir, 'connector');
  connector = await startRustConnector({
    clientEdgePort: MAKER_CONNECTOR_CLIENT_EDGE_PORT,
    stateDir: connectorState,
    signerKeyHex: randomBytes(32).toString('hex'),
    evm: {
      rpcUrl: anvil.rpcUrl,
      registryAddress: evm.registry,
      tokenAddress: evm.usdc,
      settlementKeyHex: connectorEvmKey,
    },
    solana: {
      rpcUrl: validator.rpcUrl,
      programId: validator.programId,
      tokenMint: sol.mint,
      settlementSeedHex: seedToHex(connectorSolanaSeed),
    },
    routes: [
      { prefix: maker.rfqDestination, handlerUrl: `${MAKER_APP_URL}/swap/rfq`, price: 0 },
      { prefix: maker.fillDestination, handlerUrl: `${MAKER_APP_URL}/swap/fill`, price: FILL },
    ],
  });
  cleanups.push(() => connector.stop());
  log(`connector routes: ${JSON.stringify((await connector.describe() as { routes?: unknown }).routes)}`);

  // ---- the taker's leg-A channels --------------------------------------
  takerEvmChannel = await openTakerEvmChannel({
    rpcUrl: anvil.rpcUrl,
    tokenNetwork: evm.tokenNetwork,
    usdc: evm.usdc,
    takerPrivateKey: takerEvmKey,
    counterparty: connectorEvmAddress,
    deposit: 5n * USDC,
  });
  takerSolChannel = await openSolanaChannelAsDepositor({
    rpcUrl: validator.rpcUrl,
    programId: validator.programId,
    mint: sol.mint,
    depositorSeed: takerSol.seed,
    counterparty: connectorSolanaPubkey,
    amount: 5n * USDC,
  });
  log(`taker leg-A channels: evm=${takerEvmChannel.channelId} solana=${takerSolChannel.channelAccount.toBase58()}`);
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

// ---------------------------------------------------------------------------
// The taker
// ---------------------------------------------------------------------------

function jsonEnvelope(body: unknown) {
  return {
    method: 'POST',
    target: '/',
    headers: [['content-type', 'application/json']] as [string, string][],
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function answerOf(outcome: SealedRequestOutcome): {
  status: number;
  body: SwapQuote | SwapAdvance | SwapRefusal;
} {
  if (outcome.kind !== 'fulfill') {
    const shown = JSON.stringify(outcome, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v
    );
    throw new Error(`expected a FULFILL, got ${shown}\n--- connector log tail ---\n${connector.logTail(4000)}`);
  }
  const text = new TextDecoder().decode(outcome.response.body);
  const parsed = parseSwapWireAnswer(JSON.parse(text));
  if (!parsed.ok) throw new Error(`unparseable maker answer: ${parsed.error}: ${text}`);
  return { status: outcome.response.status, body: parsed.value };
}

async function rfq(pair: { from: string; to: string }, chainRecipient: string) {
  const streamNonce = randomBytes(16).toString('hex');
  const outcome = await sendSealedRequest({
    connectorUrl: connector.url,
    connectorPublicKey: connector.identity.publicKey,
    destination: maker.rfqDestination,
    amount: 0n,
    envelope: jsonEnvelope({
      proto: SWAP_WIRE_PROTOCOL,
      type: 'rfq',
      streamNonce,
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: pair.from },
        to: { assetCode: 'USDC', assetScale: 6, chain: pair.to },
      },
      chainRecipient,
    }),
  });
  const { status, body } = answerOf(outcome);
  expect(status).toBe(200);
  expect(body.type).toBe('quote');
  return { streamNonce, quote: body as SwapQuote };
}

async function fill(streamNonce: string, seq: number, claim: object) {
  const outcome = await sendSealedRequest({
    connectorUrl: connector.url,
    connectorPublicKey: connector.identity.publicKey,
    destination: maker.fillDestination,
    amount: FILL,
    envelope: jsonEnvelope({ proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce, seq }),
    claim,
  });
  return answerOf(outcome);
}

// ---------------------------------------------------------------------------

describe('EVM → Solana: pay leg A on anvil, redeem leg B on the validator', () => {
  let streamNonce: string;
  let quote: SwapQuote;
  let last: SwapAdvance;

  it('RFQ: the quote names the fill route, the price, and the Solana leg-B terms', async () => {
    ({ streamNonce, quote } = await rfq(
      { from: EVM_CHAIN, to: SOL_CHAIN },
      takerSolPubkey.toBase58()
    ));
    expect(quote.fill.destination).toBe(maker.fillDestination);
    expect(quote.fill.amount).toBe(FILL.toString());
    expect(quote.fill.chain).toBe(EVM_CHAIN);
    expect(quote.legB.programId).toBe(validator.programId);
    expect(quote.legB.swapSignerAddress).toBe(makerSolanaPubkey.toBase58());
    expect(quote.legB.token).toBe(sol.mint);
    expect(quote.maxAmount).toBe((10n * USDC).toString());
    log(`quote: rate=${quote.rate} fill=${quote.fill.amount} legB=${JSON.stringify(quote.legB)}`);
  });

  it('an unpaid fill never reaches the maker: the edge answers HTTP 402', async () => {
    const outcome = await sendSealedRequest({
      connectorUrl: connector.url,
      connectorPublicKey: connector.identity.publicKey,
      destination: maker.fillDestination,
      amount: FILL,
      envelope: jsonEnvelope({ proto: SWAP_WIRE_PROTOCOL, type: 'fill', streamNonce, seq: 1 }),
    });
    expect(outcome.kind).toBe('payment-required');
  });

  it(`${FILLS} paid fills, each answered with a cumulative ed25519 leg-B claim`, async () => {
    for (let seq = 1; seq <= FILLS; seq++) {
      const claim = await signEvmClientClaim({
        privateKey: takerEvmKey,
        chainId: ANVIL_CHAIN_ID,
        tokenNetwork: evm.tokenNetwork,
        channelId: takerEvmChannel.channelId,
        nonce: seq,
        transferredAmount: BigInt(seq) * FILL,
        tokenAddress: evm.usdc,
      });
      const { status, body } = await fill(streamNonce, seq, claim);
      expect(status, JSON.stringify(body)).toBe(200);
      const a = body as SwapAdvance;
      expect(a.type).toBe('advance');
      expect(a.seq).toBe(seq);
      expect(a.sourceAmount).toBe(FILL.toString());
      expect(a.targetAmount).toBe(FILL.toString());
      expect(a.cumulativeAmount).toBe((BigInt(seq) * FILL).toString());
      expect(a.nonce).toBe(String(seq));
      expect(a.channelId).toBe(solLegBChannel.channelAccount.toBase58());
      expect(a.recipient).toBe(takerSolPubkey.toBase58());
      // Verify before trusting (R5): the maker's key over the program's bytes.
      const msg = solanaBalanceProofMessage(
        validator.programId,
        a.channelId,
        BigInt(a.nonce),
        BigInt(a.cumulativeAmount)
      );
      expect(
        ed25519.verify(Buffer.from(a.claim, 'base64'), msg, makerSolanaPubkey.toBytes())
      ).toBe(true);
      last = a;
      log(`fill ${seq}: leg-B nonce=${a.nonce} cumulative=${a.cumulativeAmount} on ${a.channelId}`);
    }
    const health = maker.health();
    expect(health.inventoryWindow[`USDC:${SOL_CHAIN}`]?.unsettled).toBe(
      (BigInt(FILLS) * FILL).toString()
    );
  });

  it('the taker redeems the last claim on chain and its USDC ATA grows by the swapped amount', async () => {
    const takerAta = associatedTokenAddress(takerSolPubkey, new PublicKey(sol.mint));
    const before = await splBalance(validator.rpcUrl, takerAta);
    await claimFromSolanaChannel({
      rpcUrl: validator.rpcUrl,
      programId: validator.programId,
      channelAccount: last.channelId,
      feePayerSeed: takerSol.seed,
      claimer: makerSolanaPubkey,
      nonce: BigInt(last.nonce),
      transferredAmount: BigInt(last.cumulativeAmount),
      signature: Buffer.from(last.claim, 'base64'),
    });
    await closeSolanaChannel({
      rpcUrl: validator.rpcUrl,
      programId: validator.programId,
      channelAccount: last.channelId,
      closerSeed: takerSol.seed,
    });
    const sig = await settleSolanaChannel({
      rpcUrl: validator.rpcUrl,
      programId: validator.programId,
      channelAccount: last.channelId,
      callerSeed: takerSol.seed,
    });
    const after = await splBalance(validator.rpcUrl, takerAta);
    expect(after - before).toBe(BigInt(FILLS) * FILL);
    log(`leg B settled ${sig}: taker USDC +${after - before}`);
  });
});

describe('Solana → EVM: pay leg A on the validator, redeem leg B on anvil', () => {
  let streamNonce: string;
  let quote: SwapQuote;
  let last: SwapAdvance;

  it('RFQ: the quote names the EVM leg-B terms (RollingSwapChannel, signer)', async () => {
    ({ streamNonce, quote } = await rfq({ from: SOL_CHAIN, to: EVM_CHAIN }, takerEvmAddress));
    expect(quote.fill.chain).toBe(SOL_CHAIN);
    expect(quote.legB.verifyingContract?.toLowerCase()).toBe(evm.rollingSwapChannel.toLowerCase());
    expect(quote.legB.swapSignerAddress.toLowerCase()).toBe(makerEvmAddress.toLowerCase());
    expect(quote.legB.token?.toLowerCase()).toBe(evm.usdc.toLowerCase());
  });

  it(`${FILLS} paid fills with Solana claims, each answered with a recoverable v2 EIP-712 claim`, async () => {
    for (let seq = 1; seq <= FILLS; seq++) {
      const claim = signSolanaClientClaim({
        seed: takerSol.seed,
        programId: validator.programId,
        channelAccount: takerSolChannel.channelAccount,
        nonce: seq,
        transferredAmount: BigInt(seq) * FILL,
      });
      const { status, body } = await fill(streamNonce, seq, claim);
      expect(status, JSON.stringify(body)).toBe(200);
      const a = body as SwapAdvance;
      expect(a.channelId).toBe(EVM_LEG_B_CHANNEL);
      expect(a.cumulativeAmount).toBe((BigInt(seq) * FILL).toString());
      expect(a.recipient.toLowerCase()).toBe(takerEvmAddress.toLowerCase());
      const recovered = recoverEvmClaimSigner(
        {
          channelId: a.channelId,
          cumulativeAmount: a.cumulativeAmount,
          nonce: a.nonce,
          recipient: a.recipient,
          chainId: BigInt(ANVIL_CHAIN_ID),
          verifyingContract: evm.rollingSwapChannel,
        },
        Uint8Array.from(Buffer.from(a.claim, 'base64'))
      );
      expect(recovered.toLowerCase()).toBe(makerEvmAddress.toLowerCase());
      last = a;
      log(`fill ${seq}: leg-B nonce=${a.nonce} cumulative=${a.cumulativeAmount} on ${a.channelId}`);
    }
  });

  it('a replayed leg-A claim is refused at the edge before the maker is asked', async () => {
    const replay = signSolanaClientClaim({
      seed: takerSol.seed,
      programId: validator.programId,
      channelAccount: takerSolChannel.channelAccount,
      nonce: FILLS,
      transferredAmount: BigInt(FILLS) * FILL,
    });
    const outcome = await sendSealedRequest({
      connectorUrl: connector.url,
      connectorPublicKey: connector.identity.publicKey,
      destination: maker.fillDestination,
      amount: FILL,
      envelope: jsonEnvelope({
        proto: SWAP_WIRE_PROTOCOL,
        type: 'fill',
        streamNonce,
        seq: FILLS + 1,
      }),
      claim: replay,
    });
    expect(outcome.kind).toBe('reject');
    // The maker's session did not move: seq stays at FILLS.
    const sessions = maker.engine.sessionsSnapshot();
    expect(sessions.find((s) => s.streamNonce === streamNonce)?.lastSeq).toBe(FILLS);
  });

  it('the taker redeems the last claim on the RollingSwapChannel and its USDC grows', async () => {
    const before = await erc20Balance(anvil.rpcUrl, evm.usdc, takerEvmAddress);
    const settled = await settleRollingSwapChannel({
      rpcUrl: anvil.rpcUrl,
      rollingSwapChannel: evm.rollingSwapChannel,
      submitterPrivateKey: takerEvmKey,
      channelId: last.channelId as Hex,
      cumulativeAmount: BigInt(last.cumulativeAmount),
      nonce: BigInt(last.nonce),
      recipient: takerEvmAddress,
      signature: Uint8Array.from(Buffer.from(last.claim, 'base64')),
    });
    const after = await erc20Balance(anvil.rpcUrl, evm.usdc, takerEvmAddress);
    expect(after - before).toBe(BigInt(FILLS) * FILL);
    log(`leg B settled ${settled.txHash}: taker USDC +${after - before}`);
  });

  it('the maker observes the redemption from chain truth and recycles the capacity', async () => {
    const before = maker.health().inventoryWindow[`USDC:${EVM_CHAIN}`];
    expect(before?.unsettled).toBe((BigInt(FILLS) * FILL).toString());
    const result = await maker.reconcileInventory();
    log(`reconcile: ${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    const after = maker.health().inventoryWindow[`USDC:${EVM_CHAIN}`];
    expect(after?.unsettled).toBe('0');
    expect(after?.free).toBe((10n * USDC).toString());
  });
});
