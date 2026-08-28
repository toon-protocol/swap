/**
 * Solana leg-B channel provisioning — the maker opens and funds the channel
 * a taker will be paid on, on demand.
 *
 * On the connector's `payment_channel` program a channel is the ONE PDA
 * `["channel", min(a, b), max(a, b), mint]` (ADR 0059), so there is no pool
 * of pre-funded channels to bind a taker to the way `RollingSwapChannel`
 * allows on EVM: the channel between this maker and a given recipient does
 * not exist until somebody submits `InitializeChannel`, and the maker's side
 * of it holds nothing until the maker submits `Deposit` (the program credits
 * strictly by signer). Before this module an operator did both by hand, per
 * taker. Now the maker does it at the first paid fill — the taker has paid
 * by then, so an RFQ cannot make the maker lock capital for free — and tops
 * the channel up whenever the next claim would exceed what it holds.
 *
 * Instruction layouts mirror `packages/solana-program/src/{instruction,
 * processor,state}.rs` in toon-protocol/connector; the e2e toolkit
 * (`tests/e2e/helpers/solana-chain.ts`) carries the same ones and is checked
 * against a real validator.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { deriveSolanaChannelPda, findProgramAddress } from './solana-pda.js';
import { base58Decode, base58Encode } from '@toon-protocol/sdk';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
const CHANNEL_ACCOUNT_SIZE = 178;
const ACCOUNT_DISCRIMINATOR = Buffer.from('pchannel', 'ascii');
const IX_INITIALIZE_CHANNEL = 1;
const IX_DEPOSIT = 2;

/** One day, mirroring `RollingSwapChannel.MIN_CHALLENGE_PERIOD`. */
export const DEFAULT_SOLANA_CHALLENGE_DURATION_SECONDS = 86_400;

function u64le(value: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [pda] = findProgramAddress(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID.toBytes()
  );
  return new PublicKey(pda);
}

function vaultPda(programId: PublicKey, channelPda: PublicKey): PublicKey {
  const [pda] = findProgramAddress(
    [new TextEncoder().encode('vault'), channelPda.toBytes()],
    programId.toBytes()
  );
  return new PublicKey(pda);
}

export interface SolanaChannelAccount {
  participantA: string;
  participantB: string;
  tokenMint: string;
  depositA: bigint;
  depositB: bigint;
  transferredAmountA: bigint;
  transferredAmountB: bigint;
  nonceA: bigint;
  nonceB: bigint;
  challengeDuration: bigint;
  /** 0 Opened, 1 Closed, 2 Settled. */
  state: number;
}

export function decodeSolanaChannelAccount(data: Uint8Array): SolanaChannelAccount {
  const b = Buffer.from(data);
  if (b.length !== CHANNEL_ACCOUNT_SIZE) {
    throw new Error(`channel account is ${b.length} bytes, expected ${CHANNEL_ACCOUNT_SIZE}`);
  }
  if (!b.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR)) {
    throw new Error('channel account discriminator is not "pchannel"');
  }
  return {
    participantA: base58Encode(b.subarray(8, 40)),
    participantB: base58Encode(b.subarray(40, 72)),
    tokenMint: base58Encode(b.subarray(72, 104)),
    depositA: b.readBigUInt64LE(104),
    depositB: b.readBigUInt64LE(112),
    transferredAmountA: b.readBigUInt64LE(120),
    transferredAmountB: b.readBigUInt64LE(128),
    nonceA: b.readBigUInt64LE(136),
    nonceB: b.readBigUInt64LE(144),
    challengeDuration: b.readBigUInt64LE(152),
    state: b[160] ?? 0,
  };
}

export interface SolanaLegBChannelProvisionerConfig {
  rpcUrl: string;
  programId: string;
  tokenMint: string;
  /** The maker's 32-byte Ed25519 seed (BIP-44 index 2). Funds and signs. */
  makerSeed: Uint8Array;
  /**
   * How much to place in a fresh channel, and the minimum top-up, in the
   * mint's base units. A channel is topped up whenever the next claim would
   * exceed the maker's deposit in it.
   */
  channelDeposit: bigint;
  challengeDurationSeconds?: number;
  confirmTimeoutMs?: number;
  logger?: {
    info?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  };
}

export interface EnsuredSolanaChannel {
  /** The channel PDA, base58 — the `channelId` every leg-B claim names. */
  channelId: string;
  /** The maker's deposit in it after this call. */
  deposit: bigint;
  opened: boolean;
  toppedUp: bigint;
}

export interface SolanaLegBChannelProvisioner {
  readonly makerPubkey: string;
  /** The PDA for `recipient`, without touching the chain. */
  channelFor(recipient: string): string;
  /**
   * Make sure the channel with `recipient` exists and the maker's deposit in
   * it is at least `minDeposit`. Idempotent; one transaction at most.
   */
  ensure(recipient: string, minDeposit: bigint): Promise<EnsuredSolanaChannel>;
  /** Read the channel account, or null when it does not exist. */
  read(recipient: string): Promise<SolanaChannelAccount | null>;
}

async function awaitConfirmed(
  conn: Connection,
  signature: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (status?.err) {
      throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status &&
      (status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized')
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`transaction ${signature} not confirmed in ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function createSolanaLegBChannelProvisioner(
  cfg: SolanaLegBChannelProvisionerConfig
): SolanaLegBChannelProvisioner {
  if (!(cfg.makerSeed instanceof Uint8Array) || cfg.makerSeed.length !== 32) {
    throw new Error('Solana leg-B provisioner requires a 32-byte maker seed');
  }
  if (typeof cfg.channelDeposit !== 'bigint' || cfg.channelDeposit <= 0n) {
    throw new Error('Solana leg-B provisioner requires a positive channelDeposit');
  }
  const programId = new PublicKey(cfg.programId);
  const mint = new PublicKey(cfg.tokenMint);
  const maker = Keypair.fromSeed(cfg.makerSeed);
  const makerAta = associatedTokenAddress(maker.publicKey, mint);
  const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
  const challenge = cfg.challengeDurationSeconds ?? DEFAULT_SOLANA_CHALLENGE_DURATION_SECONDS;
  const confirmTimeoutMs = cfg.confirmTimeoutMs ?? 30_000;
  const makerPubkey = maker.publicKey.toBase58();
  /** Per-recipient serialization so two fills cannot both open/top up. */
  const inflight = new Map<string, Promise<unknown>>();

  const channelFor = (recipient: string): string => {
    base58Decode(recipient); // shape check; throws on garbage
    return deriveSolanaChannelPda({
      participantA: makerPubkey,
      participantB: recipient,
      mint: cfg.tokenMint,
      programId: cfg.programId,
    });
  };

  const read = async (recipient: string): Promise<SolanaChannelAccount | null> => {
    const info = await conn.getAccountInfo(new PublicKey(channelFor(recipient)), 'confirmed');
    if (!info || info.data.length === 0 || info.data.every((x) => x === 0)) return null;
    return decodeSolanaChannelAccount(info.data);
  };

  const makerDeposit = (acct: SolanaChannelAccount): bigint =>
    acct.participantA === makerPubkey ? acct.depositA : acct.depositB;

  async function ensureLocked(
    recipient: string,
    minDeposit: bigint
  ): Promise<EnsuredSolanaChannel> {
    const channelId = channelFor(recipient);
    const channelPda = new PublicKey(channelId);
    const existing = await read(recipient);
    if (existing && existing.state !== 0) {
      throw new Error(
        `Solana channel ${channelId} with ${recipient} is closed/settled (state ${existing.state}); it cannot be reused`
      );
    }
    const held = existing ? makerDeposit(existing) : 0n;
    const shortfall = minDeposit > held ? minDeposit - held : 0n;
    const topUp =
      existing === null
        ? cfg.channelDeposit > minDeposit
          ? cfg.channelDeposit
          : minDeposit
        : shortfall > 0n
          ? shortfall > cfg.channelDeposit
            ? shortfall
            : cfg.channelDeposit
          : 0n;
    if (existing !== null && topUp === 0n) {
      return { channelId, deposit: held, opened: false, toppedUp: 0n };
    }

    const ixs: TransactionInstruction[] = [];
    if (existing === null) {
      const [a, b] =
        Buffer.compare(maker.publicKey.toBuffer(), Buffer.from(base58Decode(recipient))) < 0
          ? [maker.publicKey, new PublicKey(recipient)]
          : [new PublicKey(recipient), maker.publicKey];
      ixs.push(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: maker.publicKey, isSigner: true, isWritable: true },
            { pubkey: a, isSigner: false, isWritable: false },
            { pubkey: b, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: channelPda, isSigner: false, isWritable: true },
            { pubkey: vaultPda(programId, channelPda), isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([u64le(IX_INITIALIZE_CHANNEL), u64le(challenge)]),
        })
      );
    }
    if (topUp > 0n) {
      ixs.push(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: maker.publicKey, isSigner: true, isWritable: false },
            { pubkey: makerAta, isSigner: false, isWritable: true },
            { pubkey: vaultPda(programId, channelPda), isSigner: false, isWritable: true },
            { pubkey: channelPda, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([u64le(IX_DEPOSIT), u64le(topUp)]),
        })
      );
    }
    const tx = new Transaction().add(...ixs);
    tx.feePayer = maker.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(maker);
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(tx.serialize(), {
        preflightCommitment: 'confirmed',
      });
    } catch (err) {
      const logs = (err as { logs?: string[] } | undefined)?.logs;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Solana leg-B channel ${existing ? 'top-up' : 'open'} for ${recipient} failed: ${msg}${logs ? `\n${logs.join('\n')}` : ''}`
      );
    }
    await awaitConfirmed(conn, signature, confirmTimeoutMs);
    const after = await read(recipient);
    if (!after) throw new Error(`channel ${channelId} missing after ${signature}`);
    const deposit = makerDeposit(after);
    cfg.logger?.info?.('swap.legB.solana_channel_provisioned', {
      recipient,
      channelId,
      opened: existing === null,
      toppedUp: topUp.toString(),
      deposit: deposit.toString(),
      signature,
    });
    return { channelId, deposit, opened: existing === null, toppedUp: topUp };
  }

  return {
    makerPubkey,
    channelFor,
    read,
    ensure(recipient, minDeposit) {
      const prev = inflight.get(recipient) ?? Promise.resolve();
      const run = prev.then(
        () => ensureLocked(recipient, minDeposit),
        () => ensureLocked(recipient, minDeposit)
      );
      inflight.set(recipient, run);
      return run.finally(() => {
        if (inflight.get(recipient) === run) inflight.delete(recipient);
      });
    },
  };
}
