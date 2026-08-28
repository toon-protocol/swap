/**
 * Inbound claim verification — the check a swap party runs on every claim
 * its counterparty sends, before counting it as value received.
 *
 * On the relay-mediated swap nobody verifies for you: the connector charges
 * carriage for the wrap and never opens it (payload opacity), so the maker
 * checks the taker's leg-A claim itself and the taker checks the maker's
 * leg-B claim itself — with this one function, over the same two message
 * formats the parties SIGN with (`tokenNetworkBalanceProofDigest`,
 * `solanaBalanceProofMessage`), so signer and verifier cannot drift.
 *
 * The ladder, cheapest first, every rung fail-closed and result-shaped:
 *
 *   1. shape        — decimal bigints, a signature of the right length, a
 *                     signer in the chain's address format
 *   2. chain        — the claim is for the chain the session pinned
 *   3. signer       — equals the counterparty bound at accept; a message
 *                     never rotates it
 *   4. signature    — over the chain's standard balance-proof message, BEFORE
 *                     any chain read, so an unsigned stranger costs nothing
 *   5. channel id   — re-derived from the two participants (ADR 0059), never
 *                     taken from the claim
 *   6. monotonic    — nonce and cumulative strictly above my inbound
 *                     watermark; a missing watermark is SEEDED from the
 *                     counterparty's on-chain slot, so a claim I already
 *                     redeemed is not new value
 *   7. delta        — `cumulative − watermark` within `[expectedDelta, maxDelta]`
 *   8. cover        — the counterparty's on-chain deposit covers the
 *                     cumulative and the channel is Opened; cached, re-read
 *                     only when the cumulative outgrows the cache or it ages
 *
 * Chain reads are the one cost a counterparty can impose. They happen only
 * after rung 4, are cached on the watermark, and go through a per-counterparty
 * {@link ReadBudget}; over budget is a refusal, never a wait.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode } from '@toon-protocol/sdk';
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  recoverAddress,
  type Hex,
} from 'viem';

import { deriveEvmChannelId } from './evm-leg-b-channel.js';
import {
  solanaBalanceProofMessage,
  tokenNetworkBalanceProofDigest,
} from './payment-channel-signer.js';
import { decodeSolanaChannelAccount } from './solana-leg-b-channel.js';
import type { SolanaChannelAccount } from './solana-leg-b-channel.js';
import { deriveSolanaChannelPda } from './solana-pda.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A claim as it rides the wire (`SwapClaim` in `wire.ts` is this shape). */
export interface InboundClaim {
  chain: string;
  channelId: string;
  nonce: string;
  cumulativeAmount: string;
  /** base64 — 65 bytes `r‖s‖v` on EVM, 64-byte Ed25519 on Solana. */
  signature: string;
  /** The signing party's on-chain address (EVM hex / Solana base58). */
  signer: string;
}

/** What a session pins about the channel at accept/quote time. */
export type ChannelFacts =
  | {
      family: 'evm';
      chain: string;
      chainId: bigint;
      tokenNetwork: string;
      /** This party's own address. */
      self: string;
      /** The counterparty's address — the only signer accepted. */
      counterparty: string;
    }
  | {
      family: 'solana';
      chain: string;
      programId: string;
      mint: string;
      self: string;
      counterparty: string;
    };

/** My inbound watermark for one channel, plus what the chain last said. */
export interface InboundWatermark {
  nonce: bigint;
  cumulative: bigint;
  /** The counterparty's deposit as last read, and when (unix ms). */
  deposit?: bigint;
  depositReadAt?: number;
  /** EVM: the pair's channel epoch as last read. */
  epoch?: bigint;
}

export interface CounterpartySlot {
  /** `opened` is the only state a claim is accepted in. */
  state: 'opened' | 'closed' | 'settled' | 'missing';
  deposit: bigint;
  nonce: bigint;
  transferredAmount: bigint;
}

/** The chain reads the ladder may need; injectable so tests need no chain. */
export interface ChannelSlotReader {
  evmEpoch(facts: Extract<ChannelFacts, { family: 'evm' }>): Promise<bigint>;
  evmSlot(
    facts: Extract<ChannelFacts, { family: 'evm' }>,
    channelId: string,
    participant: string
  ): Promise<CounterpartySlot>;
  solanaChannel(
    facts: Extract<ChannelFacts, { family: 'solana' }>,
    channelId: string
  ): Promise<SolanaChannelAccount | null>;
}

/** Bounds how many chain reads one counterparty can cause. */
export interface ReadBudget {
  /** Take one read if the budget allows it. */
  tryAcquire(): boolean;
}

export interface VerifyInboundClaimInput {
  claim: InboundClaim;
  facts: ChannelFacts;
  /** The least this claim must advance my cumulative by (base units). */
  expectedDelta: bigint;
  /** The most it may advance by, if bounded. */
  maxDelta?: bigint;
  watermark: InboundWatermark | null;
  reader: ChannelSlotReader;
  budget?: ReadBudget;
  /** Re-read the deposit when the cached reading is older than this. Default 60 s. */
  rereadMs?: number;
  now?: () => number;
}

export type InboundClaimRejectionCode =
  | 'MALFORMED_CLAIM'
  | 'CHAIN_MISMATCH'
  | 'SIGNER_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'CHANNEL_MISMATCH'
  | 'NON_MONOTONIC_NONCE'
  | 'NON_MONOTONIC_CUMULATIVE'
  | 'CUMULATIVE_SHORTFALL'
  | 'DELTA_TOO_LARGE'
  | 'CHANNEL_NOT_OPEN'
  | 'DEPOSIT_SHORTFALL'
  | 'RATE_LIMITED'
  | 'CHAIN_READ_FAILED';

export type VerifyInboundClaimResult =
  | {
      ok: true;
      nonce: bigint;
      cumulative: bigint;
      /** How much this claim advanced my watermark — the value received. */
      delta: bigint;
      deposit: bigint;
      /** The watermark to persist if the claim is accepted. */
      watermark: InboundWatermark;
      chainReads: number;
    }
  | {
      ok: false;
      code: InboundClaimRejectionCode;
      message: string;
      /** Whether the same claim could pass later (a transient read failure). */
      retry: boolean;
      chainReads: number;
    };

const DEFAULT_REREAD_MS = 60_000;
const DECIMAL_RE = /^[0-9]+$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_CHANNEL_RE = /^0x[0-9a-fA-F]{64}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function reject(
  code: InboundClaimRejectionCode,
  message: string,
  chainReads: number,
  retry = false
): VerifyInboundClaimResult {
  return { ok: false, code, message, retry, chainReads };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export async function verifyInboundClaim(
  input: VerifyInboundClaimInput
): Promise<VerifyInboundClaimResult> {
  const { claim, facts, reader } = input;
  const now = input.now ?? Date.now;
  const rereadMs = input.rereadMs ?? DEFAULT_REREAD_MS;
  let chainReads = 0;
  const acquire = (): boolean => {
    if (input.budget && !input.budget.tryAcquire()) return false;
    chainReads += 1;
    return true;
  };

  // 1. shape
  if (
    !DECIMAL_RE.test(claim.nonce) ||
    !DECIMAL_RE.test(claim.cumulativeAmount)
  ) {
    return reject(
      'MALFORMED_CLAIM',
      'nonce and cumulativeAmount must be decimal integers',
      chainReads
    );
  }
  const nonce = BigInt(claim.nonce);
  const cumulative = BigInt(claim.cumulativeAmount);
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(claim.signature, 'base64'));
  } catch {
    return reject('MALFORMED_CLAIM', 'signature is not base64', chainReads);
  }
  if (facts.family === 'evm') {
    if (signature.length !== 65) {
      return reject(
        'MALFORMED_CLAIM',
        `EVM signature must be 65 bytes (got ${signature.length})`,
        chainReads
      );
    }
    if (!EVM_ADDRESS_RE.test(claim.signer)) {
      return reject(
        'MALFORMED_CLAIM',
        'signer must be a 0x-prefixed 20-byte address',
        chainReads
      );
    }
    if (!EVM_CHANNEL_RE.test(claim.channelId)) {
      return reject(
        'MALFORMED_CLAIM',
        'channelId must be a 0x-prefixed 32-byte hex value',
        chainReads
      );
    }
  } else {
    if (signature.length !== 64) {
      return reject(
        'MALFORMED_CLAIM',
        `Solana signature must be 64 bytes (got ${signature.length})`,
        chainReads
      );
    }
    if (!BASE58_RE.test(claim.signer) || !BASE58_RE.test(claim.channelId)) {
      return reject(
        'MALFORMED_CLAIM',
        'signer and channelId must be base58 Solana addresses',
        chainReads
      );
    }
  }

  // 2. chain
  if (claim.chain !== facts.chain) {
    return reject(
      'CHAIN_MISMATCH',
      `claim is for ${claim.chain}; this session is on ${facts.chain}`,
      chainReads
    );
  }

  // 3. signer — the bound counterparty, and nothing a message says
  const sameSigner =
    facts.family === 'evm'
      ? claim.signer.toLowerCase() === facts.counterparty.toLowerCase()
      : claim.signer === facts.counterparty;
  if (!sameSigner) {
    return reject(
      'SIGNER_MISMATCH',
      'claim signer is not the counterparty bound to this session',
      chainReads
    );
  }

  // 4. signature — before any chain read
  try {
    if (facts.family === 'evm') {
      const digest = tokenNetworkBalanceProofDigest({
        chainId: facts.chainId,
        tokenNetworkAddress: facts.tokenNetwork,
        channelId: claim.channelId,
        nonce,
        transferredAmount: cumulative,
      });
      const recovered = await recoverAddress({
        hash: `0x${Buffer.from(digest).toString('hex')}` as Hex,
        signature: `0x${Buffer.from(signature).toString('hex')}` as Hex,
      });
      if (recovered.toLowerCase() !== facts.counterparty.toLowerCase()) {
        return reject(
          'SIGNATURE_INVALID',
          'signature does not recover to the counterparty',
          chainReads
        );
      }
    } else {
      const message = solanaBalanceProofMessage(
        facts.programId,
        claim.channelId,
        nonce,
        cumulative
      );
      if (
        !ed25519.verify(signature, message, base58Decode(facts.counterparty))
      ) {
        return reject(
          'SIGNATURE_INVALID',
          'Ed25519 signature does not verify for the counterparty',
          chainReads
        );
      }
    }
  } catch (err) {
    return reject(
      'SIGNATURE_INVALID',
      `signature check failed: ${errMsg(err)}`,
      chainReads
    );
  }

  // 5. channel id — derived from the participants, never trusted
  const watermark: InboundWatermark = input.watermark
    ? { ...input.watermark }
    : { nonce: -1n, cumulative: -1n };
  const seeded = input.watermark !== null;
  let expectedChannelId: string;
  if (facts.family === 'evm') {
    if (watermark.epoch === undefined) {
      if (!acquire())
        return reject(
          'RATE_LIMITED',
          'chain-read budget exhausted for this counterparty',
          chainReads
        );
      try {
        watermark.epoch = await reader.evmEpoch(facts);
      } catch (err) {
        return reject(
          'CHAIN_READ_FAILED',
          `channelEpoch read failed: ${errMsg(err)}`,
          chainReads,
          true
        );
      }
    }
    expectedChannelId = deriveEvmChannelId(
      facts.self as Hex,
      facts.counterparty as Hex,
      watermark.epoch
    ).toLowerCase();
    if (claim.channelId.toLowerCase() !== expectedChannelId) {
      return reject(
        'CHANNEL_MISMATCH',
        `claim names channel ${claim.channelId}; the pair's channel is ${expectedChannelId}`,
        chainReads
      );
    }
  } else {
    expectedChannelId = deriveSolanaChannelPda({
      participantA: facts.self,
      participantB: facts.counterparty,
      mint: facts.mint,
      programId: facts.programId,
    });
    if (claim.channelId !== expectedChannelId) {
      return reject(
        'CHANNEL_MISMATCH',
        `claim names channel ${claim.channelId}; the pair's channel is ${expectedChannelId}`,
        chainReads
      );
    }
  }

  // Read the counterparty's slot when the watermark must be seeded, or the
  // cached deposit cannot cover this claim, or the cache is stale.
  const cacheFresh =
    watermark.deposit !== undefined &&
    watermark.depositReadAt !== undefined &&
    now() - watermark.depositReadAt < rereadMs;
  const needSlot =
    !seeded || !cacheFresh || (watermark.deposit ?? 0n) < cumulative;
  let slot: CounterpartySlot | null = null;
  if (needSlot) {
    if (!acquire())
      return reject(
        'RATE_LIMITED',
        'chain-read budget exhausted for this counterparty',
        chainReads
      );
    try {
      slot = await readCounterpartySlot(reader, facts, expectedChannelId);
    } catch (err) {
      return reject(
        'CHAIN_READ_FAILED',
        `channel read failed: ${errMsg(err)}`,
        chainReads,
        true
      );
    }
    if (!seeded) {
      // Seed from what the chain already credited: those claims are spent.
      watermark.nonce = slot.nonce;
      watermark.cumulative = slot.transferredAmount;
    }
    watermark.deposit = slot.deposit;
    watermark.depositReadAt = now();
  }

  // 6. monotonic
  if (nonce <= watermark.nonce) {
    return reject(
      'NON_MONOTONIC_NONCE',
      `nonce ${nonce} is not above the watermark ${watermark.nonce}`,
      chainReads
    );
  }
  if (cumulative <= watermark.cumulative) {
    return reject(
      'NON_MONOTONIC_CUMULATIVE',
      `cumulative ${cumulative} is not above the watermark ${watermark.cumulative}`,
      chainReads
    );
  }

  // 7. delta
  const delta = cumulative - watermark.cumulative;
  if (delta < input.expectedDelta) {
    return reject(
      'CUMULATIVE_SHORTFALL',
      `claim advances by ${delta}; at least ${input.expectedDelta} was expected`,
      chainReads
    );
  }
  if (input.maxDelta !== undefined && delta > input.maxDelta) {
    return reject(
      'DELTA_TOO_LARGE',
      `claim advances by ${delta}; at most ${input.maxDelta} is accepted per fill`,
      chainReads
    );
  }

  // 8. cover
  if (slot && slot.state !== 'opened') {
    return reject(
      'CHANNEL_NOT_OPEN',
      `channel ${expectedChannelId} is ${slot.state}`,
      chainReads
    );
  }
  const deposit = watermark.deposit ?? 0n;
  if (deposit < cumulative) {
    return reject(
      'DEPOSIT_SHORTFALL',
      `counterparty deposit ${deposit} does not cover cumulative ${cumulative}`,
      chainReads
    );
  }

  return {
    ok: true,
    nonce,
    cumulative,
    delta,
    deposit,
    watermark: { ...watermark, nonce, cumulative },
    chainReads,
  };
}

async function readCounterpartySlot(
  reader: ChannelSlotReader,
  facts: ChannelFacts,
  channelId: string
): Promise<CounterpartySlot> {
  if (facts.family === 'evm') {
    return reader.evmSlot(facts, channelId, facts.counterparty);
  }
  const account = await reader.solanaChannel(facts, channelId);
  if (!account)
    return { state: 'missing', deposit: 0n, nonce: 0n, transferredAmount: 0n };
  const isA = account.participantA === facts.counterparty;
  const isB = account.participantB === facts.counterparty;
  if (!isA && !isB) {
    throw new Error(
      `counterparty ${facts.counterparty} is not a participant of ${channelId}`
    );
  }
  return {
    state:
      account.state === 0
        ? 'opened'
        : account.state === 1
          ? 'closed'
          : 'settled',
    deposit: isA ? account.depositA : account.depositB,
    nonce: isA ? account.nonceA : account.nonceB,
    transferredAmount: isA
      ? account.transferredAmountA
      : account.transferredAmountB,
  };
}

// ---------------------------------------------------------------------------
// Read budget — a sliding window per counterparty
// ---------------------------------------------------------------------------

export interface ReadBudgetOptions {
  maxReadsPerMinute: number;
  now?: () => number;
}

/** One budget per key (a counterparty's pubkey), each a one-minute sliding window. */
export function createReadBudgets(
  opts: ReadBudgetOptions
): (key: string) => ReadBudget {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, number[]>();
  return (key) => ({
    tryAcquire() {
      const t = now();
      const stamps = (windows.get(key) ?? []).filter((s) => t - s < 60_000);
      if (stamps.length >= opts.maxReadsPerMinute) {
        windows.set(key, stamps);
        return false;
      }
      stamps.push(t);
      windows.set(key, stamps);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// The default reader — raw JSON-RPC, no chain SDK on the hot path
// ---------------------------------------------------------------------------

const TOKEN_NETWORK_READ_ABI = parseAbi([
  'function channelEpoch(address, address) view returns (uint256)',
  'function channels(bytes32) view returns (uint256 settlementTimeout, uint8 state, uint256 closedAt, uint256 openedAt, address participant1, address participant2)',
  'function participants(bytes32, address) view returns (uint256 deposit, uint256 nonce, uint256 transferredAmount)',
]);

export interface RpcChannelSlotReaderOptions {
  /** RPC URL per chain key (`evm:…`, `solana:…`). */
  rpcUrls: Record<string, string>;
  fetch?: typeof fetch;
}

async function jsonRpc(
  fetchImpl: typeof fetch,
  url: string,
  calls: { method: string; params: unknown[] }[]
): Promise<unknown[]> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, ...c }))
    ),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const json = (await response.json()) as {
    id: number;
    result?: unknown;
    error?: { message?: string };
  }[];
  if (!Array.isArray(json))
    throw new Error(`${url} did not answer the batch as an array`);
  return calls.map((_, i) => {
    const entry = json.find((e) => e.id === i + 1);
    if (!entry) throw new Error(`${url} omitted batch item ${i + 1}`);
    if (entry.error)
      throw new Error(entry.error.message ?? JSON.stringify(entry.error));
    return entry.result;
  });
}

export function createRpcChannelSlotReader(
  opts: RpcChannelSlotReaderOptions
): ChannelSlotReader {
  const fetchImpl = opts.fetch ?? fetch;
  const urlFor = (chain: string): string => {
    const url = opts.rpcUrls[chain];
    if (!url) throw new Error(`no RPC URL configured for chain '${chain}'`);
    return url;
  };
  return {
    async evmEpoch(facts) {
      const [p1, p2] = [getAddress(facts.self), getAddress(facts.counterparty)];
      const [lo, hi] =
        p1.toLowerCase() < p2.toLowerCase() ? [p1, p2] : [p2, p1];
      const data = encodeFunctionData({
        abi: TOKEN_NETWORK_READ_ABI,
        functionName: 'channelEpoch',
        args: [lo, hi],
      });
      const [result] = await jsonRpc(fetchImpl, urlFor(facts.chain), [
        {
          method: 'eth_call',
          params: [{ to: facts.tokenNetwork, data }, 'latest'],
        },
      ]);
      return decodeFunctionResult({
        abi: TOKEN_NETWORK_READ_ABI,
        functionName: 'channelEpoch',
        data: result as Hex,
      });
    },
    async evmSlot(facts, channelId, participant) {
      const to = facts.tokenNetwork;
      const [slotRaw, channelRaw] = await jsonRpc(
        fetchImpl,
        urlFor(facts.chain),
        [
          {
            method: 'eth_call',
            params: [
              {
                to,
                data: encodeFunctionData({
                  abi: TOKEN_NETWORK_READ_ABI,
                  functionName: 'participants',
                  args: [channelId as Hex, getAddress(participant)],
                }),
              },
              'latest',
            ],
          },
          {
            method: 'eth_call',
            params: [
              {
                to,
                data: encodeFunctionData({
                  abi: TOKEN_NETWORK_READ_ABI,
                  functionName: 'channels',
                  args: [channelId as Hex],
                }),
              },
              'latest',
            ],
          },
        ]
      );
      const [deposit, nonce, transferredAmount] = decodeFunctionResult({
        abi: TOKEN_NETWORK_READ_ABI,
        functionName: 'participants',
        data: slotRaw as Hex,
      });
      const [, state] = decodeFunctionResult({
        abi: TOKEN_NETWORK_READ_ABI,
        functionName: 'channels',
        data: channelRaw as Hex,
      });
      const states = ['missing', 'opened', 'closed', 'settled'] as const;
      return {
        state: states[state] ?? 'missing',
        deposit,
        nonce,
        transferredAmount,
      };
    },
    async solanaChannel(facts, channelId) {
      const [result] = await jsonRpc(fetchImpl, urlFor(facts.chain), [
        {
          method: 'getAccountInfo',
          params: [channelId, { encoding: 'base64', commitment: 'confirmed' }],
        },
      ]);
      const value = (
        result as
          | { value?: { data?: unknown; owner?: string } | null }
          | undefined
      )?.value;
      if (value === undefined)
        throw new Error(`getAccountInfo(${channelId}) returned no result`);
      if (value === null) return null;
      if (value.owner !== facts.programId) {
        throw new Error(
          `account ${channelId} is owned by ${value.owner ?? 'unknown'}, not ${facts.programId}`
        );
      }
      const data = value.data;
      const base64 =
        typeof data === 'string'
          ? data
          : Array.isArray(data) && typeof data[0] === 'string'
            ? data[0]
            : undefined;
      if (base64 === undefined)
        throw new Error(`getAccountInfo(${channelId}) data is not base64`);
      return decodeSolanaChannelAccount(
        Uint8Array.from(Buffer.from(base64, 'base64'))
      );
    },
  };
}
