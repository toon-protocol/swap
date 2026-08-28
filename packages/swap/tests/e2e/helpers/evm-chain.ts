/**
 * EVM side of the taker toolkit: deploy the connector's settlement contracts
 * onto a fresh anvil, open a taker → connector `TokenNetwork` channel with a
 * DERIVED id (connector ADR 0059), sign client-edge claims (client-edge-spec
 * §1.3), and drive the maker's leg-B `RollingSwapChannel`.
 *
 * Everything is `viem`. Contract ABIs/bytecode are the trimmed forge
 * artifacts under `../fixtures/evm/` (see the README there for provenance).
 *
 * ## The two EIP-712 domains, kept apart on purpose
 *
 * - **Leg A (taker pays the connector)** — `TokenNetwork`, domain
 *   `{name:'TokenNetwork', version:'1', chainId, verifyingContract: <TokenNetwork>}`,
 *   struct `BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,
 *   uint256 lockedAmount,bytes32 locksRoot)` — connector
 *   `crates/connector-signer/src/claim_signature.rs`. The claim's
 *   `transferredAmount` is CUMULATIVE and the nonce strictly increases from 1.
 * - **Leg B (maker pays the taker)** — `RollingSwapChannel`, domain
 *   `{name:'RollingSwapChannel', version:'2', chainId, verifyingContract}`,
 *   struct `ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,
 *   uint256 nonce,address recipient)` — signed by the swap maker's
 *   `EvmPaymentChannelSigner` via `@toon-protocol/settlement-digest`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseEventLogs,
  recoverTypedDataAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'evm'
);

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function loadArtifact(name: string): Artifact {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as {
    abi: Abi;
    bytecode: string;
  };
  return { abi: raw.abi, bytecode: raw.bytecode as Hex };
}

export const MOCK_ERC20 = loadArtifact('MockERC20');
export const TOKEN_NETWORK_REGISTRY = loadArtifact('TokenNetworkRegistry');
export const TOKEN_NETWORK = loadArtifact('TokenNetwork');
export const ROLLING_SWAP_CHANNEL = loadArtifact('RollingSwapChannel');

// ---------------------------------------------------------------------------
// Anvil's deterministic accounts (mnemonic "test test … junk")
// ---------------------------------------------------------------------------

/** Account 0 — deployer of `DeployLocal.s.sol`, owner of the mock USDC supply. */
export const ANVIL_ACCOUNT0_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** Account 1 — the taker in the self-check. */
export const ANVIL_ACCOUNT1_KEY: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const ANVIL_ACCOUNT2_ADDRESS: Address =
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
export const ANVIL_ACCOUNT3_ADDRESS: Address =
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

// ---------------------------------------------------------------------------
// Anvil lifecycle (fresh chain — no vendored state; we deploy ourselves)
// ---------------------------------------------------------------------------

export interface FreshAnvil {
  rpcUrl: string;
  chainId: number;
  stop: () => Promise<void>;
}

async function jsonRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/**
 * Spawn an anvil with NO state loaded — the contracts are deployed by
 * {@link deployEvmContracts}, exactly as `DeployLocal.s.sol` would. Distinct
 * from `tests/integration/helpers/rolling-e2e-harness.ts`'s `startAnvil`,
 * which rehydrates a vendored blob of a pre-ADR-0059 `TokenNetwork`.
 */
export async function startFreshAnvil(params: {
  port: number;
  chainId: number;
}): Promise<FreshAnvil> {
  const rpcUrl = `http://127.0.0.1:${params.port}`;
  const child: ChildProcess = spawn(
    'anvil',
    ['--port', String(params.port), '--chain-id', String(params.chainId), '--silent'],
    { stdio: 'ignore' }
  );
  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const id = await jsonRpc<string>(rpcUrl, 'eth_chainId');
      if (parseInt(id, 16) === params.chainId) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`anvil on :${params.port} did not come up in 20s`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { rpcUrl, chainId: params.chainId, stop };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function chainFor(rpcUrl: string, chainId: number): Chain {
  return {
    id: chainId,
    name: `anvil-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export interface EvmClients {
  chainId: number;
  publicClient: PublicClient;
  wallet: (privateKey: Hex) => { client: WalletClient; account: PrivateKeyAccount };
}

const clientCache = new Map<string, Promise<EvmClients>>();

export function evmClients(rpcUrl: string): Promise<EvmClients> {
  let cached = clientCache.get(rpcUrl);
  if (!cached) {
    cached = (async () => {
      const chainId = parseInt(await jsonRpc<string>(rpcUrl, 'eth_chainId'), 16);
      const chain = chainFor(rpcUrl, chainId);
      const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
      return {
        chainId,
        publicClient,
        wallet: (privateKey: Hex) => {
          const account = privateKeyToAccount(privateKey);
          return {
            account,
            client: createWalletClient({ chain, account, transport: http(rpcUrl) }),
          };
        },
      };
    })();
    clientCache.set(rpcUrl, cached);
  }
  return cached;
}

async function sendAndWait(
  clients: EvmClients,
  privateKey: Hex,
  tx: { to: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint }
): Promise<Hex> {
  const { client, account } = clients.wallet(privateKey);
  const hash = await client.writeContract({
    address: tx.to,
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args as unknown[],
    value: tx.value,
    account,
    chain: client.chain,
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${tx.functionName} reverted in ${hash}`);
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Deploy — DeployLocal.s.sol, reproduced
// ---------------------------------------------------------------------------

export interface EvmDeployment {
  chainId: number;
  usdc: Address;
  registry: Address;
  tokenNetwork: Address;
  rollingSwapChannel: Address;
}

/**
 * Reproduce connector `packages/contracts/script/DeployLocal.s.sol` from anvil
 * account 0: MockERC20('USD Coin','USDC',6) → TokenNetworkRegistry →
 * `createTokenNetwork(usdc)` → RollingSwapChannel(usdc, 1 day) → 10k USDC to
 * accounts 2 and 3. On a FRESH anvil this lands at the same deterministic
 * addresses `local/solo/connector.toml` names (`0x5FbDB…` usdc, `0xe7f17…`
 * registry); the returned struct is what to trust either way.
 */
export async function deployEvmContracts(rpcUrl: string): Promise<EvmDeployment> {
  const clients = await evmClients(rpcUrl);
  const { client, account } = clients.wallet(ANVIL_ACCOUNT0_KEY);

  const deploy = async (artifact: Artifact, args: readonly unknown[]): Promise<Address> => {
    const hash = await client.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: args as unknown[],
      account,
      chain: client.chain,
    });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error(`deployment ${hash} failed`);
    }
    return receipt.contractAddress;
  };

  const usdc = await deploy(MOCK_ERC20, ['USD Coin', 'USDC', 6]);
  const registry = await deploy(TOKEN_NETWORK_REGISTRY, []);

  await sendAndWait(clients, ANVIL_ACCOUNT0_KEY, {
    to: registry,
    abi: TOKEN_NETWORK_REGISTRY.abi,
    functionName: 'createTokenNetwork',
    args: [usdc],
  });
  const tokenNetwork = (await clients.publicClient.readContract({
    address: registry,
    abi: TOKEN_NETWORK_REGISTRY.abi,
    functionName: 'getTokenNetwork',
    args: [usdc],
  })) as Address;
  if (BigInt(tokenNetwork) === 0n) {
    throw new Error('registry.getTokenNetwork(usdc) is zero after createTokenNetwork');
  }

  const rollingSwapChannel = await deploy(ROLLING_SWAP_CHANNEL, [usdc, 86_400n]);

  for (const peer of [ANVIL_ACCOUNT2_ADDRESS, ANVIL_ACCOUNT3_ADDRESS]) {
    await sendAndWait(clients, ANVIL_ACCOUNT0_KEY, {
      to: usdc,
      abi: MOCK_ERC20.abi,
      functionName: 'transfer',
      args: [peer, 10_000n * 10n ** 6n],
    });
  }

  return { chainId: clients.chainId, usdc, registry, tokenNetwork, rollingSwapChannel };
}

// ---------------------------------------------------------------------------
// Funding / balances
// ---------------------------------------------------------------------------

/** Send `wei` of ETH from anvil account 0 to `to`. */
export async function fundEth(rpcUrl: string, to: Address, wei: bigint): Promise<void> {
  const clients = await evmClients(rpcUrl);
  const { client, account } = clients.wallet(ANVIL_ACCOUNT0_KEY);
  const hash = await client.sendTransaction({ to, value: wei, account, chain: client.chain });
  await clients.publicClient.waitForTransactionReceipt({ hash });
}

/** `MockERC20.mint` is deliberately ungated — anyone can mint the mock. */
export async function mintUsdc(
  rpcUrl: string,
  usdc: Address,
  to: Address,
  amount: bigint
): Promise<void> {
  const clients = await evmClients(rpcUrl);
  await sendAndWait(clients, ANVIL_ACCOUNT0_KEY, {
    to: usdc,
    abi: MOCK_ERC20.abi,
    functionName: 'mint',
    args: [to, amount],
  });
}

export async function erc20Balance(
  rpcUrl: string,
  token: Address,
  owner: Address
): Promise<bigint> {
  const clients = await evmClients(rpcUrl);
  return (await clients.publicClient.readContract({
    address: token,
    abi: MOCK_ERC20.abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

export function evmAddressOf(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

// ---------------------------------------------------------------------------
// Leg A — TokenNetwork channel, ADR 0059 derived id
// ---------------------------------------------------------------------------

/** Sort two addresses the way `TokenNetwork.openChannel` does (`sender < participant2`). */
export function sortParticipants(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/**
 * `keccak256(abi.encodePacked(p1, p2, epoch))` with participants sorted —
 * `TokenNetwork.sol` `openChannel`, connector ADR 0059. Anyone holding the
 * pair can compute it; no event log needed.
 */
export function deriveEvmChannelId(a: Address, b: Address, epoch: bigint): Hex {
  const [p1, p2] = sortParticipants(a, b);
  return keccak256(encodePacked(['address', 'address', 'uint256'], [p1, p2, epoch]));
}

export async function readChannelEpoch(
  rpcUrl: string,
  tokenNetwork: Address,
  a: Address,
  b: Address
): Promise<bigint> {
  const clients = await evmClients(rpcUrl);
  const [p1, p2] = sortParticipants(a, b);
  return (await clients.publicClient.readContract({
    address: tokenNetwork,
    abi: TOKEN_NETWORK.abi,
    functionName: 'channelEpoch',
    args: [p1, p2],
  })) as bigint;
}

export interface TakerEvmChannel {
  channelId: Hex;
  taker: Address;
  counterparty: Address;
  tokenNetwork: Address;
  chainId: number;
  deposit: bigint;
}

/**
 * Open (or reuse) the taker's channel to `counterparty` on `tokenNetwork`,
 * then `approve` + `setTotalDeposit(channelId, taker, deposit)` so the taker's
 * side holds `deposit`. The taker is the DEPOSITOR: the connector's claim gate
 * bounds a claim's cumulative amount by the counterparty's on-chain deposit
 * (client-edge-spec §1.3 step 5), and `Deposit` credits by signer on both
 * chains (connector #1118).
 */
export async function openTakerEvmChannel(params: {
  rpcUrl: string;
  tokenNetwork: Address;
  usdc: Address;
  takerPrivateKey: Hex;
  counterparty: Address;
  deposit: bigint;
  settlementTimeoutSeconds?: bigint;
}): Promise<TakerEvmChannel> {
  const clients = await evmClients(params.rpcUrl);
  const taker = evmAddressOf(params.takerPrivateKey);
  const counterparty = getAddress(params.counterparty);
  const epoch = await readChannelEpoch(params.rpcUrl, params.tokenNetwork, taker, counterparty);
  const channelId = deriveEvmChannelId(taker, counterparty, epoch);

  const existing = (await clients.publicClient.readContract({
    address: params.tokenNetwork,
    abi: TOKEN_NETWORK.abi,
    functionName: 'channels',
    args: [channelId],
  })) as readonly [bigint, number, bigint, bigint, Address, Address];
  const state = existing[1];
  if (state === 0) {
    const hash = await sendAndWait(clients, params.takerPrivateKey, {
      to: params.tokenNetwork,
      abi: TOKEN_NETWORK.abi,
      functionName: 'openChannel',
      args: [counterparty, params.settlementTimeoutSeconds ?? 3600n],
    });
    const receipt = await clients.publicClient.getTransactionReceipt({ hash });
    const opened = parseEventLogs({
      abi: TOKEN_NETWORK.abi,
      eventName: 'ChannelOpened',
      logs: receipt.logs,
    });
    const emitted = (opened[0]?.args as { channelId?: Hex } | undefined)?.channelId;
    if (!emitted || emitted.toLowerCase() !== channelId.toLowerCase()) {
      throw new Error(
        `ChannelOpened emitted ${String(emitted)} but ADR 0059 derivation gave ${channelId} ` +
          `(pair ${taker}/${counterparty}, epoch ${epoch})`
      );
    }
  } else if (state !== 1) {
    throw new Error(
      `channel ${channelId} between ${taker} and ${counterparty} is in state ${state} (not Opened)`
    );
  }

  await sendAndWait(clients, params.takerPrivateKey, {
    to: params.usdc,
    abi: MOCK_ERC20.abi,
    functionName: 'approve',
    args: [params.tokenNetwork, params.deposit],
  });
  await sendAndWait(clients, params.takerPrivateKey, {
    to: params.tokenNetwork,
    abi: TOKEN_NETWORK.abi,
    functionName: 'setTotalDeposit',
    args: [channelId, taker, params.deposit],
  });

  return {
    channelId,
    taker,
    counterparty,
    tokenNetwork: params.tokenNetwork,
    chainId: clients.chainId,
    deposit: params.deposit,
  };
}

// ---------------------------------------------------------------------------
// Leg A — the client-edge claim (spec §1.3, `blockchain: 'evm'`)
// ---------------------------------------------------------------------------

const BALANCE_PROOF_TYPES = {
  BalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'transferredAmount', type: 'uint256' },
    { name: 'lockedAmount', type: 'uint256' },
    { name: 'locksRoot', type: 'bytes32' },
  ],
} as const;

export const ZERO_LOCKS_ROOT: Hex = `0x${'00'.repeat(32)}`;

export interface EvmClientClaim {
  version: '1.0';
  blockchain: 'evm';
  messageId: string;
  timestamp: string;
  senderId: string;
  channelId: Hex;
  nonce: number;
  transferredAmount: string;
  lockedAmount: '0';
  locksRoot: Hex;
  signature: Hex;
  signerAddress: Address;
  chainId: number;
  tokenNetworkAddress: Address;
  tokenAddress?: Address;
}

export interface EvmClaimFields {
  chainId: number;
  tokenNetwork: Address;
  channelId: Hex;
  nonce: bigint;
  transferredAmount: bigint;
}

function balanceProofTypedData(f: EvmClaimFields) {
  return {
    domain: {
      name: 'TokenNetwork',
      version: '1',
      chainId: BigInt(f.chainId),
      verifyingContract: f.tokenNetwork,
    },
    types: BALANCE_PROOF_TYPES,
    primaryType: 'BalanceProof' as const,
    message: {
      channelId: f.channelId,
      nonce: f.nonce,
      transferredAmount: f.transferredAmount,
      lockedAmount: 0n,
      locksRoot: ZERO_LOCKS_ROOT,
    },
  };
}

/** The EIP-712 digest a `TokenNetwork` claim signs — checkable against `vectors/wire-vectors.json`'s `peer_carriage.claim_digest_hex`. */
export function evmClientClaimDigest(f: EvmClaimFields): Hex {
  return hashTypedData(balanceProofTypedData(f));
}

export function recoverEvmClientClaimSigner(f: EvmClaimFields, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...balanceProofTypedData(f), signature });
}

/**
 * Build a spec §1.3 `evm` claim, signed EIP-712 by `privateKey` over the
 * `TokenNetwork` domain. `transferredAmount` is CUMULATIVE; `nonce` must
 * strictly advance the connector's watermark for this channel. The optional
 * domain fields (`chainId`, `tokenNetworkAddress`) ride the wire but carry
 * no authority — the connector reads both off its own channel record.
 */
export async function signEvmClientClaim(params: {
  privateKey: Hex;
  chainId: number;
  tokenNetwork: Address;
  channelId: Hex;
  nonce: bigint | number;
  transferredAmount: bigint;
  tokenAddress?: Address;
  messageId?: string;
  timestamp?: string;
  senderId?: string;
}): Promise<EvmClientClaim> {
  const account = privateKeyToAccount(params.privateKey);
  const fields: EvmClaimFields = {
    chainId: params.chainId,
    tokenNetwork: params.tokenNetwork,
    channelId: params.channelId,
    nonce: BigInt(params.nonce),
    transferredAmount: params.transferredAmount,
  };
  const signature = await account.signTypedData(balanceProofTypedData(fields));
  const claim: EvmClientClaim = {
    version: '1.0',
    blockchain: 'evm',
    messageId: params.messageId ?? `swap-e2e:evm:${params.channelId}:${String(params.nonce)}`,
    timestamp: params.timestamp ?? new Date().toISOString(),
    senderId: params.senderId ?? account.address.toLowerCase(),
    channelId: params.channelId.toLowerCase() as Hex,
    nonce: Number(params.nonce),
    transferredAmount: params.transferredAmount.toString(),
    lockedAmount: '0',
    locksRoot: ZERO_LOCKS_ROOT,
    signature,
    signerAddress: account.address.toLowerCase() as Address,
    chainId: params.chainId,
    tokenNetworkAddress: params.tokenNetwork,
  };
  if (params.tokenAddress) claim.tokenAddress = params.tokenAddress;
  return claim;
}

// ---------------------------------------------------------------------------
// Leg B — RollingSwapChannel (maker pays the taker)
// ---------------------------------------------------------------------------

/**
 * `RollingSwapChannel.openChannel(channelId, signer, deposit)` from the
 * funder, after `approve`. The channel id is CALLER-CHOSEN here (it mirrors
 * the swap node's provisioned id), unlike `TokenNetwork`'s derived one.
 */
export async function openMakerRollingChannel(params: {
  rpcUrl: string;
  rollingSwapChannel: Address;
  usdc: Address;
  funderPrivateKey: Hex;
  channelId: Hex;
  signer: Address;
  deposit: bigint;
}): Promise<Hex> {
  const clients = await evmClients(params.rpcUrl);
  await sendAndWait(clients, params.funderPrivateKey, {
    to: params.usdc,
    abi: MOCK_ERC20.abi,
    functionName: 'approve',
    args: [params.rollingSwapChannel, params.deposit],
  });
  return sendAndWait(clients, params.funderPrivateKey, {
    to: params.rollingSwapChannel,
    abi: ROLLING_SWAP_CHANNEL.abi,
    functionName: 'openChannel',
    args: [params.channelId, params.signer, params.deposit],
  });
}

export interface RollingSettlement {
  txHash: Hex;
  cumulativeAmount: bigint;
  nonce: bigint;
  recipient: Address;
}

/**
 * `RollingSwapChannel.updateBalance(channelId, cumulative, nonce, recipient, sig)`
 * — callable by ANYONE (the contract binds `recipient` into the digest, so
 * the submitter cannot redirect the payout); the taker submits its own.
 * `signature` is the maker's 65-byte `r||s||v` over the v2 EIP-712 digest.
 */
export async function settleRollingSwapChannel(params: {
  rpcUrl: string;
  rollingSwapChannel: Address;
  submitterPrivateKey: Hex;
  channelId: Hex;
  cumulativeAmount: bigint;
  nonce: bigint;
  recipient: Address;
  signature: Uint8Array | Hex;
}): Promise<RollingSettlement> {
  const clients = await evmClients(params.rpcUrl);
  const sig: Hex =
    typeof params.signature === 'string'
      ? params.signature
      : (`0x${Buffer.from(params.signature).toString('hex')}` as Hex);
  const txHash = await sendAndWait(clients, params.submitterPrivateKey, {
    to: params.rollingSwapChannel,
    abi: ROLLING_SWAP_CHANNEL.abi,
    functionName: 'updateBalance',
    args: [params.channelId, params.cumulativeAmount, params.nonce, params.recipient, sig],
  });
  const receipt = await clients.publicClient.getTransactionReceipt({ hash: txHash });
  const settled = parseEventLogs({
    abi: ROLLING_SWAP_CHANNEL.abi,
    eventName: 'SettlementSucceeded',
    logs: receipt.logs,
  });
  const args = settled[0]?.args as
    | { cumulativeAmount: bigint; nonce: bigint; recipient: Address }
    | undefined;
  if (!args) throw new Error(`updateBalance ${txHash} emitted no SettlementSucceeded`);
  return { txHash, ...args };
}

/** `RollingSwapChannel.claimDigest` view — cross-check a maker-side digest against the deployed contract. */
export async function rollingClaimDigestOnChain(params: {
  rpcUrl: string;
  rollingSwapChannel: Address;
  channelId: Hex;
  cumulativeAmount: bigint;
  nonce: bigint;
  recipient: Address;
}): Promise<Hex> {
  const clients = await evmClients(params.rpcUrl);
  return (await clients.publicClient.readContract({
    address: params.rollingSwapChannel,
    abi: ROLLING_SWAP_CHANNEL.abi,
    functionName: 'claimDigest',
    args: [params.channelId, params.cumulativeAmount, params.nonce, params.recipient],
  })) as Hex;
}
