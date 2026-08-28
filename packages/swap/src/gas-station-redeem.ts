/**
 * Redeem a verified leg-B claim with the **gas station** paying the gas —
 * the path a taker takes on a chain where it holds the token it was paid in
 * but none of that chain's native gas.
 *
 * Both kinds are two-phase NIP-90 jobs through `@toon-protocol/client`'s
 * `sendJob` (the taker's relay client pays the job route):
 *
 *   Solana, kind:5096  quote → `{ feePayer, recentBlockhash, quoteId }`;
 *                      build `[Ed25519SigVerify, ClaimFromChannel]` with the
 *                      station as fee payer — the taker signs NOTHING (the
 *                      claimer is a non-signer; the proof is the precompile
 *                      instruction) — execute → `{ signature }`.
 *   EVM,    kind:5098  quote → `{ forwarder, tokenNetwork, forwarderNonce,
 *                      maxGas, recommendedDeadline, quoteId }`; sign an
 *                      ERC-2771 `ForwardRequest` for `claimFromChannel`
 *                      against the forwarder's own `eip712Domain()`;
 *                      execute → `{ txHash }`.
 *
 * A refusal is a successful job with `status: 'failed'` and a closed-vocabulary
 * `reason`; it surfaces here as {@link GasStationRefusal}. Until
 * toon-protocol/gas-station#18 lands, both stations refuse claims
 * (`channel_op_not_permitted` / `selector_not_whitelisted`) — `SwapTaker`
 * falls back to own-gas when told to.
 */

import { randomBytes } from 'node:crypto';
import { PublicKey, Transaction } from '@solana/web3.js';
import { base58Decode } from '@toon-protocol/sdk';
import { buildJobEvent, sendJob } from '@toon-protocol/client';
import type { JobSender } from '@toon-protocol/client';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { solanaBalanceProofMessage } from './payment-channel-signer.js';
import { claimFromChannelIx, ed25519VerifyIx } from './redeem.js';
import type { SwapNodeChainProvider } from './swap-node.js';
import { parseEvmChainId } from './swap-node.js';
import type { Redeemer } from './swap-taker.js';
import type { TakerSessionState } from './taker-state.js';
import type { SwapNodeKeys } from './wallet.js';

export const SOLANA_GAS_STATION_KIND = 5096;
export const EVM_GAS_STATION_KIND = 5098;
/** The devnet relay connector's route to the gas station. */
export const DEFAULT_GAS_STATION_DESTINATION = 'g.toon.relay.gas';

export class GasStationRefusal extends Error {
  readonly reason: string;
  readonly phase: 'quote' | 'execute';
  readonly detail?: string;
  constructor(phase: 'quote' | 'execute', reason: string, detail?: string) {
    super(
      `gas station refused at ${phase}: ${reason}${detail ? ` — ${detail}` : ''}`
    );
    this.name = 'GasStationRefusal';
    this.phase = phase;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Any job receipt: ok or a refusal. */
interface Receipt {
  status?: 'ok' | 'failed';
  phase?: 'quote' | 'execute';
  reason?: string;
  detail?: string;
  [k: string]: unknown;
}

interface SolanaQuote extends Receipt {
  quoteId: string;
  feePayer: string;
  maxLamports: string;
  recentBlockhash: string;
  expiresAt: number;
}

interface EvmQuote extends Receipt {
  quoteId: string;
  relayer: string;
  forwarder: string;
  tokenNetwork: string;
  forwarderNonce: string;
  maxGas: string;
  recommendedDeadline: number;
  expiresAt: number;
}

const TOKEN_NETWORK_CLAIM_ABI = parseAbi([
  'function claimFromChannel(bytes32 channelId, (bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) balanceProof, bytes signature)',
]);
const EIP712_DOMAIN_ABI = parseAbi([
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);
const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const;
const ZERO_LOCKS_ROOT = `0x${'00'.repeat(32)}` as Hex;

export interface ForwarderDomain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Address;
}

export interface GasStationRedeemerConfig {
  /** Pays for the jobs — the taker's relay client. */
  sender: JobSender;
  /** The route that terminates at the gas station (default `g.toon.relay.gas`). */
  destination?: string;
  /** The terminating connector's key when `destination` is forwarded. */
  sealTo?: string | Uint8Array;
  /**
   * The gas station's own connector (e.g. `https://proxy.gas.devnet.toonprotocol.dev/ilp`).
   * When `sealTo` is absent its `GET /ilp` self-description supplies the sealing key — the
   * relay's `g.toon.relay.gas` route is FORWARDED to that node, so a payload sealed to the
   * relay's connector cannot be opened there.
   */
  connectorUrl?: string;
  fetch?: typeof fetch;
  keys: SwapNodeKeys;
  /** Signs the job events (any secp256k1 key; the taker's Nostr key). */
  nostrSecretKey: Uint8Array;
  chainProviders: readonly SwapNodeChainProvider[];
  /** Seam: read a forwarder's EIP-712 domain (default: `eip712Domain()` over the chain's RPC). */
  readForwarderDomain?: (
    rpcUrl: string,
    forwarder: Address
  ) => Promise<ForwarderDomain>;
  timeoutMs?: number;
  idempotencyKey?: () => string;
  logger?: {
    info?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  };
}

async function defaultReadForwarderDomain(
  rpcUrl: string,
  forwarder: Address
): Promise<ForwarderDomain> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const [, name, version, chainId, verifyingContract] =
    await client.readContract({
      address: forwarder,
      abi: EIP712_DOMAIN_ABI,
      functionName: 'eip712Domain',
    });
  return { name, version, chainId, verifyingContract };
}

function refusalOf(
  phase: 'quote' | 'execute',
  r: Receipt
): GasStationRefusal | null {
  if (r.status === 'failed')
    return new GasStationRefusal(phase, r.reason ?? 'unknown', r.detail);
  return null;
}

/** The sealing key of the connector at `connectorUrl` (its `GET /ilp` self-description). */
export async function resolveConnectorSealKey(
  connectorUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(connectorUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET ${connectorUrl} → HTTP ${res.status}`);
  const json = (await res.json()) as { edgeIdentity?: { publicKey?: string } };
  const key = json.edgeIdentity?.publicKey;
  if (typeof key !== 'string' || key.length === 0)
    throw new Error(`${connectorUrl} publishes no edgeIdentity.publicKey`);
  return key;
}

export function createGasStationRedeemer(
  cfg: GasStationRedeemerConfig
): Redeemer {
  const newKey = cfg.idempotencyKey ?? (() => randomBytes(16).toString('hex'));
  const readDomain = cfg.readForwarderDomain ?? defaultReadForwarderDomain;
  let sealTo: string | Uint8Array | undefined = cfg.sealTo;

  async function endpoint() {
    if (sealTo === undefined && cfg.connectorUrl !== undefined) {
      sealTo = await resolveConnectorSealKey(cfg.connectorUrl, cfg.fetch);
    }
    return {
      client: cfg.sender,
      destination: cfg.destination ?? DEFAULT_GAS_STATION_DESTINATION,
      ...(sealTo !== undefined && { sealTo }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
    };
  }

  async function job<T extends Receipt>(
    kind: number,
    phase: 'quote' | 'execute',
    params: Record<string, string>
  ): Promise<T> {
    const event = buildJobEvent({
      kind,
      params: { phase, ...params },
      secretKey: cfg.nostrSecretKey,
    });
    const answer = await sendJob<T>(await endpoint(), event);
    if (!answer.accepted) {
      throw new Error(
        `gas station job (kind ${kind}, ${phase}) was not delivered: ${answer.code} ${answer.message}`
      );
    }
    const refused = refusalOf(phase, answer.receipt);
    if (refused) throw refused;
    return answer.receipt;
  }

  return {
    async redeem(session: Readonly<TakerSessionState>) {
      const received = session.received;
      const claim = session.lastAdvance?.advance.claim;
      if (!received || !claim)
        throw new Error('session holds no verified leg-B claim');
      if (claim.cumulativeAmount !== received.cumulative) {
        throw new Error(
          'the last advance does not match the verified watermark; refusing to redeem'
        );
      }

      if (received.chain.startsWith('solana:')) {
        const provider = cfg.chainProviders.find(
          (p) => p.chainType === 'solana' && p.chainId === received.chain
        );
        if (!provider || provider.chainType !== 'solana')
          throw new Error(`no Solana chain provider for ${received.chain}`);
        const quote = await job<SolanaQuote>(
          SOLANA_GAS_STATION_KIND,
          'quote',
          {}
        );
        const programId = new PublicKey(provider.programId);
        const channelPda = new PublicKey(claim.channelId);
        const claimer = new PublicKey(base58Decode(claim.signer));
        const feePayer = new PublicKey(quote.feePayer);
        const message = solanaBalanceProofMessage(
          provider.programId,
          claim.channelId,
          BigInt(claim.nonce),
          BigInt(claim.cumulativeAmount)
        );
        const tx = new Transaction().add(
          ed25519VerifyIx(
            claimer,
            Uint8Array.from(Buffer.from(claim.signature, 'base64')),
            message
          ),
          claimFromChannelIx({
            programId,
            feePayer,
            claimer,
            channelPda,
            nonce: BigInt(claim.nonce),
            transferredAmount: BigInt(claim.cumulativeAmount),
          })
        );
        tx.feePayer = feePayer;
        tx.recentBlockhash = quote.recentBlockhash;
        // Nobody but the station signs: the claimer is a non-signer and the
        // proof is the precompile instruction.
        const transaction = tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64');
        const done = await job<Receipt & { signature: string }>(
          SOLANA_GAS_STATION_KIND,
          'execute',
          {
            transaction,
            quoteId: quote.quoteId,
            idempotencyKey: newKey(),
          }
        );
        cfg.logger?.info?.('taker.redeem.gas_station.solana', {
          txId: done.signature,
          channelId: claim.channelId,
        });
        return { txId: done.signature };
      }

      const provider = cfg.chainProviders.find(
        (p) => p.chainType === 'evm' && p.chainId === received.chain
      );
      if (!provider || provider.chainType !== 'evm')
        throw new Error(`no EVM chain provider for ${received.chain}`);
      if (!cfg.keys.evm)
        throw new Error(
          `no EVM key to sign the forward request on ${received.chain}`
        );
      const chainId = parseEvmChainId(received.chain);
      const account = privateKeyToAccount(
        `0x${Buffer.from(cfg.keys.evm.privateKey).toString('hex')}` as Hex
      );
      const quote = await job<EvmQuote>(EVM_GAS_STATION_KIND, 'quote', {
        chainId: chainId.toString(),
        from: account.address,
      });
      const data = encodeFunctionData({
        abi: TOKEN_NETWORK_CLAIM_ABI,
        functionName: 'claimFromChannel',
        args: [
          claim.channelId as Hex,
          {
            channelId: claim.channelId as Hex,
            nonce: BigInt(claim.nonce),
            transferredAmount: BigInt(claim.cumulativeAmount),
            lockedAmount: 0n,
            locksRoot: ZERO_LOCKS_ROOT,
          },
          `0x${Buffer.from(claim.signature, 'base64').toString('hex')}` as Hex,
        ],
      });
      const domain = await readDomain(
        provider.rpcUrl,
        quote.forwarder as Address
      );
      const request = {
        from: account.address,
        to: quote.tokenNetwork as Address,
        value: 0n,
        gas: BigInt(quote.maxGas),
        nonce: BigInt(quote.forwarderNonce),
        deadline: quote.recommendedDeadline,
        data,
      };
      const signature = await account.signTypedData({
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: domain.verifyingContract,
        },
        types: FORWARD_REQUEST_TYPES,
        primaryType: 'ForwardRequest',
        message: request,
      });
      const forward = {
        from: request.from,
        to: request.to,
        value: request.value.toString(),
        gas: request.gas.toString(),
        deadline: request.deadline,
        data,
        signature,
      };
      const done = await job<Receipt & { txHash: string }>(
        EVM_GAS_STATION_KIND,
        'execute',
        {
          chainId: chainId.toString(),
          request: Buffer.from(JSON.stringify(forward), 'utf8').toString(
            'base64'
          ),
          quoteId: quote.quoteId,
          idempotencyKey: newKey(),
        }
      );
      cfg.logger?.info?.('taker.redeem.gas_station.evm', {
        txId: done.txHash,
        channelId: claim.channelId,
      });
      return { txId: done.txHash };
    },
  };
}
