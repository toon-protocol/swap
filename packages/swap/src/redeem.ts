/**
 * On-chain redemption of a verified leg-B claim — the one place the taker
 * spends gas.
 *
 *   EVM    `TokenNetwork.claimFromChannel(channelId, proof, sig)` pays the
 *          claimant the delta immediately and leaves the channel open.
 *   Solana `ClaimFromChannel` (Ed25519 precompile at ix 0) only RECORDS the
 *          maker's proof in the maker's slot; value leaves the vault at
 *          `SettleChannel`, after `CloseChannel` and the challenge window.
 *          So "redeem" here is the claim, and {@link SolanaSettler} does the
 *          close/settle pair the CLI drives afterwards.
 *
 * Both use the taker's own keys and gas. The gas-station path (kind:5096 /
 * 5098 through `@toon-protocol/client`'s `sendJob`) slots in behind the
 * same {@link Redeemer} interface once the station admits claims
 * (toon-protocol/gas-station#18).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { base58Decode } from '@toon-protocol/sdk';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { solanaBalanceProofMessage } from './payment-channel-signer.js';
import { associatedTokenAddress } from './solana-leg-b-channel.js';
import { findProgramAddress } from './solana-pda.js';
import type { SwapNodeChainProvider } from './swap-node.js';
import type { Redeemer } from './swap-taker.js';
import type { TakerSessionState } from './taker-state.js';
import type { SwapNodeKeys } from './wallet.js';

const TOKEN_NETWORK_CLAIM_ABI = parseAbi([
  'function claimFromChannel(bytes32 channelId, (bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) balanceProof, bytes signature)',
  'function closeChannel(bytes32 channelId)',
  'function settleChannel(bytes32 channelId)',
]);
const ZERO_LOCKS_ROOT = `0x${'00'.repeat(32)}` as Hex;

const ED25519_PROGRAM_ID = new PublicKey(
  'Ed25519SigVerify111111111111111111111111111'
);
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
/** `packages/solana-program/src/instruction.rs` — 8-byte little-endian tags. */
const DISCRIMINATOR = {
  CloseChannel: 3,
  SettleChannel: 4,
  ClaimFromChannel: 6,
} as const;

function tag(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  return b;
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

/** The Ed25519 precompile instruction `ClaimFromChannel` reads at index 0. */
export function ed25519VerifyIx(
  pubkey: PublicKey,
  signature: Uint8Array,
  message: Uint8Array
): TransactionInstruction {
  const DATA_START = 16;
  const pubkeyOffset = DATA_START;
  const sigOffset = pubkeyOffset + 32;
  const msgOffset = sigOffset + 64;
  const header = Buffer.alloc(DATA_START);
  header[0] = 1;
  header[1] = 0;
  header.writeUInt16LE(sigOffset, 2);
  header.writeUInt16LE(0xffff, 4);
  header.writeUInt16LE(pubkeyOffset, 6);
  header.writeUInt16LE(0xffff, 8);
  header.writeUInt16LE(msgOffset, 10);
  header.writeUInt16LE(message.length, 12);
  header.writeUInt16LE(0xffff, 14);
  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data: Buffer.concat([
      header,
      pubkey.toBuffer(),
      Buffer.from(signature),
      Buffer.from(message),
    ]),
  });
}

export function claimFromChannelIx(p: {
  programId: PublicKey;
  feePayer: PublicKey;
  /** The PAYER whose signature the precompile verified (the maker, for leg B). */
  claimer: PublicKey;
  channelPda: PublicKey;
  nonce: bigint;
  transferredAmount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.feePayer, isSigner: true, isWritable: true },
      { pubkey: p.claimer, isSigner: false, isWritable: false },
      { pubkey: p.channelPda, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.concat([
      tag(DISCRIMINATOR.ClaimFromChannel),
      u64le(p.nonce),
      u64le(p.transferredAmount),
    ]),
  });
}

export function closeChannelIx(p: {
  programId: PublicKey;
  closer: PublicKey;
  channelPda: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.closer, isSigner: true, isWritable: false },
      { pubkey: p.channelPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: tag(DISCRIMINATOR.CloseChannel),
  });
}

export function settleChannelIx(p: {
  programId: PublicKey;
  caller: PublicKey;
  channelPda: PublicKey;
  participantATokenAccount: PublicKey;
  participantBTokenAccount: PublicKey;
  rentRecipient: PublicKey;
}): TransactionInstruction {
  const [vault] = findProgramAddress(
    [new TextEncoder().encode('vault'), p.channelPda.toBytes()],
    p.programId.toBytes()
  );
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.caller, isSigner: true, isWritable: false },
      { pubkey: p.channelPda, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(vault), isSigner: false, isWritable: true },
      { pubkey: p.participantATokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.participantBTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.rentRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: tag(DISCRIMINATOR.SettleChannel),
  });
}

async function sendSolana(
  rpcUrl: string,
  ixs: TransactionInstruction[],
  payer: Keypair
): Promise<string> {
  const conn = new Connection(rpcUrl, 'confirmed');
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  const res = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  if (res.value.err)
    throw new Error(
      `transaction ${sig} failed: ${JSON.stringify(res.value.err)}`
    );
  return sig;
}

export interface RedeemerConfig {
  keys: SwapNodeKeys;
  chainProviders: readonly SwapNodeChainProvider[];
  logger?: {
    info?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  };
}

export interface SolanaSettler {
  /** `CloseChannel` — starts the challenge window. */
  close(session: Readonly<TakerSessionState>): Promise<{ txId: string }>;
  /** `SettleChannel` — pays out after the window; the caller waits for it. */
  settle(session: Readonly<TakerSessionState>): Promise<{ txId: string }>;
}

/** A redeemer over the taker's own keys and gas, for EVM and Solana targets. */
export function createRedeemer(cfg: RedeemerConfig): Redeemer & SolanaSettler {
  const evmFor = (chain: string) => {
    const p = cfg.chainProviders.find(
      (x) => x.chainType === 'evm' && x.chainId === chain
    );
    if (!p || p.chainType !== 'evm')
      throw new Error(`no EVM chain provider for ${chain}`);
    if (!cfg.keys.evm) throw new Error(`no EVM key to redeem on ${chain}`);
    return { provider: p, key: cfg.keys.evm };
  };
  const solFor = (chain: string) => {
    const p = cfg.chainProviders.find(
      (x) => x.chainType === 'solana' && x.chainId === chain
    );
    if (!p || p.chainType !== 'solana')
      throw new Error(`no Solana chain provider for ${chain}`);
    if (!cfg.keys.solana)
      throw new Error(`no Solana key to redeem on ${chain}`);
    return {
      provider: p,
      keypair: Keypair.fromSeed(cfg.keys.solana.privateKey),
    };
  };
  const received = (session: Readonly<TakerSessionState>) => {
    if (!session.received)
      throw new Error('session holds no verified leg-B claim');
    return session.received;
  };
  const lastClaim = (session: Readonly<TakerSessionState>) => {
    const c = session.lastAdvance?.advance.claim;
    if (!c) throw new Error('session holds no advance to redeem');
    return c;
  };

  return {
    async redeem(session) {
      const r = received(session);
      const claim = lastClaim(session);
      if (claim.cumulativeAmount !== r.cumulative) {
        throw new Error(
          'the last advance does not match the verified watermark; refusing to redeem'
        );
      }
      if (r.chain.startsWith('evm:')) {
        const { provider, key } = evmFor(r.chain);
        const account = privateKeyToAccount(
          `0x${Buffer.from(key.privateKey).toString('hex')}` as Hex
        );
        const transport = http(provider.rpcUrl);
        const publicClient = createPublicClient({ transport });
        const walletClient = createWalletClient({ account, transport });
        const hash = await walletClient.writeContract({
          chain: null,
          address: provider.tokenNetworkAddress as Address,
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
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success')
          throw new Error(`claimFromChannel ${hash} reverted`);
        cfg.logger?.info?.('taker.redeem.evm', {
          txId: hash,
          channelId: claim.channelId,
          cumulative: claim.cumulativeAmount,
        });
        return { txId: hash };
      }
      const { provider, keypair } = solFor(r.chain);
      const programId = new PublicKey(provider.programId);
      const channelPda = new PublicKey(claim.channelId);
      const claimer = new PublicKey(base58Decode(claim.signer));
      const message = solanaBalanceProofMessage(
        provider.programId,
        claim.channelId,
        BigInt(claim.nonce),
        BigInt(claim.cumulativeAmount)
      );
      const sig = await sendSolana(
        provider.rpcUrl,
        [
          ed25519VerifyIx(
            claimer,
            Uint8Array.from(Buffer.from(claim.signature, 'base64')),
            message
          ),
          claimFromChannelIx({
            programId,
            feePayer: keypair.publicKey,
            claimer,
            channelPda,
            nonce: BigInt(claim.nonce),
            transferredAmount: BigInt(claim.cumulativeAmount),
          }),
        ],
        keypair
      );
      cfg.logger?.info?.('taker.redeem.solana.claimed', {
        txId: sig,
        channelId: claim.channelId,
        cumulative: claim.cumulativeAmount,
        next: 'close, wait the challenge window, then settle',
      });
      return { txId: sig };
    },

    async close(session) {
      const r = received(session);
      const { provider, keypair } = solFor(r.chain);
      const sig = await sendSolana(
        provider.rpcUrl,
        [
          closeChannelIx({
            programId: new PublicKey(provider.programId),
            closer: keypair.publicKey,
            channelPda: new PublicKey(r.channelId),
          }),
        ],
        keypair
      );
      cfg.logger?.info?.('taker.redeem.solana.closed', {
        txId: sig,
        channelId: r.channelId,
      });
      return { txId: sig };
    },

    async settle(session) {
      const r = received(session);
      const { provider, keypair } = solFor(r.chain);
      const programId = new PublicKey(provider.programId);
      const mint = new PublicKey(provider.tokenMint);
      const channelPda = new PublicKey(r.channelId);
      const me = keypair.publicKey;
      const counterparty = new PublicKey(base58Decode(r.signer));
      // Participants are sorted by bytes on chain; token accounts follow that order.
      const [a, b] =
        Buffer.compare(me.toBuffer(), counterparty.toBuffer()) <= 0
          ? [me, counterparty]
          : [counterparty, me];
      const sig = await sendSolana(
        provider.rpcUrl,
        [
          settleChannelIx({
            programId,
            caller: me,
            channelPda,
            participantATokenAccount: associatedTokenAddress(a, mint),
            participantBTokenAccount: associatedTokenAddress(b, mint),
            rentRecipient: me,
          }),
        ],
        keypair
      );
      cfg.logger?.info?.('taker.redeem.solana.settled', {
        txId: sig,
        channelId: r.channelId,
      });
      return { txId: sig };
    },
  };
}
