/**
 * Taker-toolkit self-check — proves `helpers/{rust-connector,evm-chain,
 * solana-chain,taker-edge}.ts` against a REAL Rust connector binary, a real
 * anvil and a real solana-test-validator, in both roles each chain plays in a
 * swap: leg A (the taker pays the connector) and leg B (the maker pays the
 * taker).
 *
 * Run:
 *   pnpm --filter @toon-protocol/swap exec vitest run \
 *     --config vitest.e2e.config.ts tests/e2e/taker-toolkit.selfcheck.test.ts
 *
 * Needs on PATH: anvil, solana-test-validator, solana, spl-token, solana-keygen;
 * and a built connector at `SWAP_E2E_CONNECTOR_BIN` (default
 * `/home/jonathan/Documents/connector/target/debug/connector`) or an image in
 * `SWAP_E2E_CONNECTOR_IMAGE`.
 *
 * The app behind the priced route is a tiny in-process `node:http` recorder,
 * standing in for the swap maker: what it RECEIVES (path, body, `X-TOON-*`
 * headers) is the maker's contract with the connector, and what it ANSWERS
 * rides home sealed in the FULFILL.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EvmPaymentChannelSigner } from '../../src/payment-channel-signer.js';
import {
  ANVIL_ACCOUNT1_KEY,
  deployEvmContracts,
  erc20Balance,
  evmAddressOf,
  evmClientClaimDigest,
  fundEth,
  mintUsdc,
  openMakerRollingChannel,
  openTakerEvmChannel,
  recoverEvmClientClaimSigner,
  rollingClaimDigestOnChain,
  settleRollingSwapChannel,
  signEvmClientClaim,
  startFreshAnvil,
  type EvmDeployment,
  type FreshAnvil,
  type TakerEvmChannel,
} from './helpers/evm-chain.js';
import {
  startRustConnector,
  type RustConnectorInstance,
} from './helpers/rust-connector.js';
import {
  airdropSol,
  associatedTokenAddress,
  claimFromSolanaChannel,
  closeSolanaChannel,
  keypairFromSeed,
  openSolanaChannelAsDepositor,
  readSolanaChannel,
  seedToHex,
  settleSolanaChannel,
  signSolanaBalanceProof,
  signSolanaClientClaim,
  solanaBalanceProofMessage96,
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
import {
  decodeIlpPrepare,
  describeConnector,
  encodeIlpPrepare,
  fulfillBodyText,
  sendSealedRequest,
  type SealedRequestOutcome,
} from './helpers/taker-edge.js';
import {
  ANVIL_CHAIN_ID,
  ANVIL_PORT,
  MAKER_APP_PORT,
  MAKER_APP_URL,
  RELAY_CONNECTOR_PORT,
} from './helpers/topology.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  readFileSync(
    join(HERE, 'fixtures', 'connector-vectors', 'wire-vectors.json'),
    'utf8'
  )
) as {
  peer_carriage: {
    prepare: {
      prepare: {
        amount: number;
        expires_at: string;
        execution_condition_hex: string;
        destination: string;
        data_hex: string;
      };
      http_body_hex: string;
    };
    claim_evm: { json: string };
    claim_digest_hex: string;
    claim_solana: { json: string; signed_message_hex: string };
  };
};

const USDC = 1_000_000n; // 6 dp
const ROUTE_PRICE = USDC; // 1 USDC per paid request
const PAID_ROUTE = 'g.test.app';
const FREE_ROUTE = 'g.test.app.free';

function log(line: string): void {
  console.log(`[taker-toolkit] ${line}`);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------
// The recording app (stands in for the maker)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function startRecordingApp(
  port: number
): Promise<{ server: Server; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers,
        body,
      });
      const answer = JSON.stringify({
        ok: true,
        path: req.url,
        echo: body.toString('utf8'),
        payer: headers['x-toon-payer'] ?? null,
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-app': 'taker-toolkit',
      });
      res.end(answer);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, requests }));
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let anvil: FreshAnvil;
let evm: EvmDeployment;
let validator: SolanaValidatorInstance;
let sol: SolanaProvisioning;
let app: { server: Server; requests: RecordedRequest[] };
let connector: RustConnectorInstance;
let stateDir: string;

const connectorSignerKey = randomBytes(32);
const connectorEvmKey = `0x${randomBytes(32).toString('hex')}` as Hex;
const connectorSolanaSeed = new Uint8Array(randomBytes(32));
let connectorEvmAddress: Address;
let connectorSolanaPubkey: PublicKey;

const takerEvmKey = ANVIL_ACCOUNT1_KEY;
const takerEvmAddress = evmAddressOf(takerEvmKey);
let takerSol: ProvisionedOpener; // opener 0
let makerSol: ProvisionedOpener; // opener 1 — leg-B Solana payer

let takerEvmChannel: TakerEvmChannel;
let takerSolChannel: DepositorSolanaChannel;

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  // 1. Chains.
  log('booting anvil');
  anvil = await startFreshAnvil({ port: ANVIL_PORT, chainId: ANVIL_CHAIN_ID });
  cleanups.push(() => anvil.stop());
  evm = await deployEvmContracts(anvil.rpcUrl);
  log(
    `evm deployed: usdc=${evm.usdc} registry=${evm.registry} tokenNetwork=${evm.tokenNetwork} rolling=${evm.rollingSwapChannel}`
  );

  log('booting solana-test-validator');
  validator = await startSolanaValidator();
  cleanups.push(() => validator.stop());
  sol = await provisionSplMint(validator.rpcUrl);
  cleanups.push(() => sol.dispose());
  takerSol = sol.openers[0]!;
  makerSol = sol.openers[1]!;
  log(
    `solana mint=${sol.mint} taker=${takerSol.pubkey} makerB=${makerSol.pubkey}`
  );

  // 2. The connector's keys, funded on both chains BEFORE it boots.
  connectorEvmAddress = evmAddressOf(connectorEvmKey);
  connectorSolanaPubkey = keypairFromSeed(connectorSolanaSeed).publicKey;
  await fundEth(anvil.rpcUrl, connectorEvmAddress, 10n * 10n ** 18n);
  await mintUsdc(anvil.rpcUrl, evm.usdc, connectorEvmAddress, 1000n * USDC);
  await airdropSol(validator.rpcUrl, connectorSolanaPubkey, 10);
  log(
    `connector evm=${connectorEvmAddress} solana=${connectorSolanaPubkey.toBase58()}`
  );

  // 3. The app, then the connector in front of it.
  app = await startRecordingApp(MAKER_APP_PORT);
  cleanups.push(() => new Promise<void>((r) => app.server.close(() => r())));

  stateDir = mkdtempSync(join(tmpdir(), 'swap-e2e-connector-state-'));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  connector = await startRustConnector({
    clientEdgePort: RELAY_CONNECTOR_PORT,
    stateDir,
    signerKeyHex: connectorSignerKey.toString('hex'),
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
      {
        prefix: PAID_ROUTE,
        handlerUrl: `${MAKER_APP_URL}/paid/`,
        price: ROUTE_PRICE,
      },
      { prefix: FREE_ROUTE, handlerUrl: `${MAKER_APP_URL}/free/`, price: 0 },
    ],
  });
  cleanups.push(() => connector.stop());
  log(`connector up at ${connector.url} keyId=${connector.identity.keyId}`);

  // 4. Taker channels to the connector — the taker is the depositor on both.
  await mintUsdc(anvil.rpcUrl, evm.usdc, takerEvmAddress, 1000n * USDC);
  takerEvmChannel = await openTakerEvmChannel({
    rpcUrl: anvil.rpcUrl,
    tokenNetwork: evm.tokenNetwork,
    usdc: evm.usdc,
    takerPrivateKey: takerEvmKey,
    counterparty: connectorEvmAddress,
    deposit: 5n * USDC,
  });
  log(
    `taker evm channel ${takerEvmChannel.channelId} deposit=${takerEvmChannel.deposit}`
  );

  takerSolChannel = await openSolanaChannelAsDepositor({
    rpcUrl: validator.rpcUrl,
    programId: validator.programId,
    mint: sol.mint,
    depositorSeed: takerSol.seed,
    counterparty: connectorSolanaPubkey,
    amount: 5n * USDC,
  });
  log(
    `taker solana channel ${takerSolChannel.channelAccount.toBase58()} deposit=${takerSolChannel.deposit}`
  );
}, 240_000);

afterAll(async () => {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      /* best effort */
    }
  }
});

function appHeaders(req: RecordedRequest) {
  return {
    payer: req.headers['x-toon-payer'],
    amount: req.headers['x-toon-amount'],
    chain: req.headers['x-toon-chain'],
  };
}

async function send(
  destination: string,
  body: string,
  claim?: object,
  amount: bigint = ROUTE_PRICE
): Promise<SealedRequestOutcome> {
  return sendSealedRequest({
    connectorUrl: connector.url,
    connectorPublicKey: connector.identity.publicKey,
    destination,
    amount,
    envelope: {
      method: 'POST',
      target: '/',
      headers: [['content-type', 'text/plain']],
      body: new TextEncoder().encode(body),
    },
    claim,
  });
}

// ---------------------------------------------------------------------------
// 0. Vectors — the normative bytes, before any network
// ---------------------------------------------------------------------------

describe('wire vectors (connector vectors/wire-vectors.json)', () => {
  it('PREPARE encoder reproduces peer_carriage.prepare.http_body_hex', () => {
    const v = VECTORS.peer_carriage.prepare;
    const bytes = encodeIlpPrepare({
      amount: BigInt(v.prepare.amount),
      expiresAt: new Date(v.prepare.expires_at),
      executionCondition: Uint8Array.from(
        Buffer.from(v.prepare.execution_condition_hex, 'hex')
      ),
      destination: v.prepare.destination,
      data: Uint8Array.from(Buffer.from(v.prepare.data_hex, 'hex')),
    });
    expect(hex(bytes)).toBe(v.http_body_hex);
    const back = decodeIlpPrepare(bytes);
    expect(back.destination).toBe(v.prepare.destination);
    expect(back.amount).toBe(BigInt(v.prepare.amount));
  });

  it('EVM claim digest reproduces claim_digest_hex and recovers signerAddress', async () => {
    const c = JSON.parse(VECTORS.peer_carriage.claim_evm.json) as {
      chainId: number;
      tokenNetworkAddress: Address;
      channelId: Hex;
      nonce: number;
      transferredAmount: string;
      signature: Hex;
      signerAddress: Address;
    };
    const fields = {
      chainId: c.chainId,
      tokenNetwork: c.tokenNetworkAddress,
      channelId: c.channelId,
      nonce: BigInt(c.nonce),
      transferredAmount: BigInt(c.transferredAmount),
    };
    expect(evmClientClaimDigest(fields).slice(2)).toBe(
      VECTORS.peer_carriage.claim_digest_hex
    );
    // The vector's `v` is libsecp256k1's raw {0,1}; viem wants {27,28}.
    const raw = Buffer.from(c.signature.slice(2), 'hex');
    if (raw[64]! < 27) raw[64] = raw[64]! + 27;
    const signer = await recoverEvmClientClaimSigner(
      fields,
      `0x${raw.toString('hex')}` as Hex
    );
    expect(signer.toLowerCase()).toBe(c.signerAddress.toLowerCase());
  });

  it('Solana 96-byte balance proof reproduces claim_solana.signed_message_hex', () => {
    const c = JSON.parse(VECTORS.peer_carriage.claim_solana.json) as {
      programId: string;
      channelAccount: string;
      nonce: number;
      transferredAmount: string;
    };
    const msg = solanaBalanceProofMessage96({
      programId: c.programId,
      channelAccount: c.channelAccount,
      nonce: c.nonce,
      transferredAmount: BigInt(c.transferredAmount),
    });
    expect(hex(msg)).toBe(
      VECTORS.peer_carriage.claim_solana.signed_message_hex
    );
  });
});

// ---------------------------------------------------------------------------
// Leg A — the taker pays the connector's client edge
// ---------------------------------------------------------------------------

describe('leg A: sealed requests to the Rust connector client edge', () => {
  it('connector describes itself', async () => {
    const id = await describeConnector(connector.url);
    expect(id.publicKey).toBe(connector.identity.publicKey);
    const desc = await connector.describe();
    expect(desc).toBeTruthy();
    log(`self-description keys: ${Object.keys(desc as object).join(',')}`);
  });

  it('(a) free route: FULFILL, app body decoded, no X-TOON headers', async () => {
    const before = app.requests.length;
    const out = await send(FREE_ROUTE, 'hello free', undefined, 0n);
    expect(out.kind, JSON.stringify(out)).toBe('fulfill');
    if (out.kind !== 'fulfill') return;
    expect(out.response.status).toBe(200);
    const json = JSON.parse(fulfillBodyText(out)) as {
      ok: boolean;
      path: string;
      echo: string;
    };
    expect(json.ok).toBe(true);
    expect(json.echo).toBe('hello free');
    expect(json.path).toBe('/free/');
    expect(
      out.response.headers.some(([k]) => k.toLowerCase() === 'x-app')
    ).toBe(true);
    expect(app.requests.length).toBe(before + 1);
    const seen = appHeaders(app.requests[before]!);
    expect(seen.payer).toBeUndefined();
    expect(seen.amount).toBeUndefined();
    expect(seen.chain).toBeUndefined();
    log('(a) free route fulfilled; app saw no X-TOON headers');
  });

  it('(b) paid EVM claim nonce 1 / cumulative 1 USDC: FULFILL with X-TOON attribution', async () => {
    const before = app.requests.length;
    const claim = await signEvmClientClaim({
      privateKey: takerEvmKey,
      chainId: evm.chainId,
      tokenNetwork: evm.tokenNetwork,
      channelId: takerEvmChannel.channelId,
      nonce: 1,
      transferredAmount: 1n * ROUTE_PRICE,
      tokenAddress: evm.usdc,
    });
    const out = await send(PAID_ROUTE, 'paid evm 1', claim);
    expect(
      out.kind,
      JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    ).toBe('fulfill');
    if (out.kind !== 'fulfill') return;
    const json = JSON.parse(fulfillBodyText(out)) as {
      echo: string;
      path: string;
      payer: string;
    };
    expect(json.echo).toBe('paid evm 1');
    expect(json.path).toBe('/paid/');
    expect(app.requests.length).toBe(before + 1);
    const seen = appHeaders(app.requests[before]!);
    expect(seen.payer).toBe(`evm:${takerEvmChannel.channelId.toLowerCase()}`);
    expect(seen.amount).toBe(ROUTE_PRICE.toString());
    expect(seen.chain).toBe('evm');
    log(`(b) evm nonce 1 fulfilled; X-TOON-Payer=${seen.payer}`);
  });

  it('(c) paid EVM claim nonce 2 / cumulative 2 USDC: FULFILL', async () => {
    const before = app.requests.length;
    const claim = await signEvmClientClaim({
      privateKey: takerEvmKey,
      chainId: evm.chainId,
      tokenNetwork: evm.tokenNetwork,
      channelId: takerEvmChannel.channelId,
      nonce: 2,
      transferredAmount: 2n * ROUTE_PRICE,
    });
    const out = await send(PAID_ROUTE, 'paid evm 2', claim);
    expect(
      out.kind,
      JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    ).toBe('fulfill');
    expect(app.requests.length).toBe(before + 1);
    const seen = appHeaders(app.requests[before]!);
    expect(seen.payer).toBe(`evm:${takerEvmChannel.channelId.toLowerCase()}`);
    expect(seen.amount).toBe(ROUTE_PRICE.toString());
    log('(c) evm nonce 2 fulfilled');
  });

  it('(c2) a replayed nonce is a REJECT, never delivered', async () => {
    const before = app.requests.length;
    const claim = await signEvmClientClaim({
      privateKey: takerEvmKey,
      chainId: evm.chainId,
      tokenNetwork: evm.tokenNetwork,
      channelId: takerEvmChannel.channelId,
      nonce: 2,
      transferredAmount: 3n * ROUTE_PRICE,
    });
    const out = await send(PAID_ROUTE, 'replay', claim);
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') return;
    expect(out.code.startsWith('F')).toBe(true);
    expect(app.requests.length).toBe(before);
    log(
      `(c2) replayed nonce → REJECT ${out.code} "${out.message}" origin=${out.origin} cost=${String(out.accumulatedCost)}`
    );
  });

  it('(d) paid Solana claim: FULFILL with X-TOON-Chain solana', async () => {
    const before = app.requests.length;
    const claim = signSolanaClientClaim({
      seed: takerSol.seed,
      programId: validator.programId,
      channelAccount: takerSolChannel.channelAccount,
      nonce: 1,
      transferredAmount: ROUTE_PRICE,
    });
    const out = await send(PAID_ROUTE, 'paid solana 1', claim);
    expect(
      out.kind,
      JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    ).toBe('fulfill');
    if (out.kind !== 'fulfill') return;
    expect(JSON.parse(fulfillBodyText(out)).echo).toBe('paid solana 1');
    expect(app.requests.length).toBe(before + 1);
    const seen = appHeaders(app.requests[before]!);
    expect(seen.payer).toBe(
      `solana:${takerSolChannel.channelAccount.toBase58()}`
    );
    expect(seen.amount).toBe(ROUTE_PRICE.toString());
    expect(seen.chain).toBe('solana');
    log(`(d) solana nonce 1 fulfilled; X-TOON-Payer=${seen.payer}`);
  });

  it('(e) unpaid request to the priced route: HTTP 402 x402 terms (spec §1.4), app untouched', async () => {
    const before = app.requests.length;
    const out = await send(PAID_ROUTE, 'unpaid');
    expect(out.kind).toBe('payment-required');
    if (out.kind !== 'payment-required') return;
    const terms = out.terms as {
      x402Version: number;
      accepts: { amount: string; scheme: string }[];
    };
    expect(terms.x402Version).toBe(2);
    expect(terms.accepts[0]?.scheme).toBe('toon-channel');
    expect(terms.accepts[0]?.amount).toBe(ROUTE_PRICE.toString());
    expect(app.requests.length).toBe(before);
    log(`(e) unpaid → 402, accepts[0].amount=${terms.accepts[0]?.amount}`);
  });
});

// ---------------------------------------------------------------------------
// Leg B — the maker pays the taker
// ---------------------------------------------------------------------------

describe('leg B: the maker pays the taker on the target chain', () => {
  it('(f) EVM: RollingSwapChannel updateBalance with a v2 claim signed by EvmPaymentChannelSigner', async () => {
    const channelId = keccak256(toHex('swap-e2e-toolkit-leg-b-evm'));
    const deposit = 3n * USDC;
    await openMakerRollingChannel({
      rpcUrl: anvil.rpcUrl,
      rollingSwapChannel: evm.rollingSwapChannel,
      usdc: evm.usdc,
      funderPrivateKey: connectorEvmKey,
      channelId,
      signer: connectorEvmAddress,
      deposit,
    });

    const signer = new EvmPaymentChannelSigner({
      chain: `evm:base:${evm.chainId}`,
      privateKey: Uint8Array.from(Buffer.from(connectorEvmKey.slice(2), 'hex')),
      chainId: BigInt(evm.chainId),
      verifyingContract: evm.rollingSwapChannel,
    });
    const cumulativeAmount = 1n * USDC;
    const nonce = 1n;
    const signature = await signer.signBalanceProof({
      channelId,
      cumulativeAmount,
      nonce,
      recipient: takerEvmAddress,
    });

    // Belt and braces: the deployed contract's own digest view agrees with
    // the digest the swap signer signed (settlement-digest's v2 preimage).
    const onChain = await rollingClaimDigestOnChain({
      rpcUrl: anvil.rpcUrl,
      rollingSwapChannel: evm.rollingSwapChannel,
      channelId,
      cumulativeAmount,
      nonce,
      recipient: takerEvmAddress,
    });
    expect(onChain).toMatch(/^0x[0-9a-f]{64}$/);

    const before = await erc20Balance(anvil.rpcUrl, evm.usdc, takerEvmAddress);
    const settled = await settleRollingSwapChannel({
      rpcUrl: anvil.rpcUrl,
      rollingSwapChannel: evm.rollingSwapChannel,
      submitterPrivateKey: takerEvmKey,
      channelId,
      cumulativeAmount,
      nonce,
      recipient: takerEvmAddress,
      signature,
    });
    const after = await erc20Balance(anvil.rpcUrl, evm.usdc, takerEvmAddress);
    expect(after - before).toBe(cumulativeAmount);
    expect(settled.recipient.toLowerCase()).toBe(takerEvmAddress.toLowerCase());
    log(
      `(f) rolling updateBalance ${settled.txHash}: taker USDC +${after - before}`
    );
  });

  it('(g) Solana: maker-signed 96-byte proof, ClaimFromChannel by the taker, payout at settlement', async () => {
    const programId = new PublicKey(validator.programId);
    const mint = new PublicKey(sol.mint);
    const taker = keypairFromSeed(takerSol.seed).publicKey;
    const maker = keypairFromSeed(makerSol.seed).publicKey;
    const takerAta = associatedTokenAddress(taker, mint);

    // The maker opens + funds the channel as depositor. challengeDuration 0
    // so settlement can follow the close in the same run.
    const ch = await openSolanaChannelAsDepositor({
      rpcUrl: validator.rpcUrl,
      programId,
      mint,
      depositorSeed: makerSol.seed,
      counterparty: taker,
      amount: 2n * USDC,
      challengeDurationSeconds: 0,
    });
    expect(ch.deposit).toBe(2n * USDC);

    // Signed HERE, not by packages/swap/src (being rewritten): the same 96
    // bytes the program's precompile check rebuilds.
    const amount = 1n * USDC;
    const { signature, message } = signSolanaBalanceProof(makerSol.seed, {
      programId,
      channelAccount: ch.channelAccount,
      nonce: 1,
      transferredAmount: amount,
    });
    expect(message.length).toBe(96);

    const before = await splBalance(validator.rpcUrl, takerAta);
    const claimSig = await claimFromSolanaChannel({
      rpcUrl: validator.rpcUrl,
      programId,
      channelAccount: ch.channelAccount,
      feePayerSeed: takerSol.seed,
      claimer: maker,
      nonce: 1,
      transferredAmount: amount,
      signature,
    });
    const state = await readSolanaChannel(validator.rpcUrl, ch.channelAccount);
    expect(state).not.toBeNull();
    const makerIsA = state!.participantA.equals(maker);
    expect(
      makerIsA ? state!.transferredAmountA : state!.transferredAmountB
    ).toBe(amount);
    expect(makerIsA ? state!.nonceA : state!.nonceB).toBe(1n);
    // ClaimFromChannel records; it does not move tokens (see solana-chain.ts).
    expect(await splBalance(validator.rpcUrl, takerAta)).toBe(before);
    log(
      `(g) ClaimFromChannel ${claimSig}: recorded nonce=1 amount=${amount} on the maker's slot`
    );

    await closeSolanaChannel({
      rpcUrl: validator.rpcUrl,
      programId,
      channelAccount: ch.channelAccount,
      closerSeed: takerSol.seed,
    });
    const settleSig = await settleSolanaChannel({
      rpcUrl: validator.rpcUrl,
      programId,
      channelAccount: ch.channelAccount,
      callerSeed: takerSol.seed,
    });
    const after = await splBalance(validator.rpcUrl, takerAta);
    expect(after - before).toBe(amount);
    expect(
      await readSolanaChannel(validator.rpcUrl, ch.channelAccount)
    ).toBeNull();
    log(`(g) settle ${settleSig}: taker USDC ATA +${after - before}`);
  });
});
