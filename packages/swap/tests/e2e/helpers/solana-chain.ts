/**
 * Solana side of the taker toolkit — a client for connector's
 * `packages/solana-program` (`payment_channel.so`, vendored under
 * `../fixtures/solana/`), written against `@solana/web3.js` because the
 * program is native Rust with no Anchor IDL and no client SDK.
 *
 * Every discriminator, account order, PDA seed and byte offset below is
 * copied from `packages/solana-program/src/{instruction,processor,state}.rs`
 * and mirrors `crates/connector-settlement-solana/src/wire.rs` — the
 * connector's own client half of the same wire.
 *
 * ## The balance proof (ADR 0053, 96 bytes)
 *
 * ```text
 * "TOON-BALPROOF-V2" (16) || program_id (32) || channel_pda (32)
 *   || nonce u64 LE (8) || transferred_amount u64 LE (8)
 * ```
 *
 * ed25519-signed by the PAYER. The same bytes are what the client edge
 * verifies off-chain (`claim_signature.rs`) and what `ClaimFromChannel`
 * verifies on-chain through the Ed25519 precompile at instruction index 0.
 *
 * ## Who signs what — read this before touching `claimFromSolanaChannel`
 *
 * `ClaimFromChannel`'s "claimer" account is the participant WHOSE SIGNATURE
 * authorises the (nonce, transferred_amount) — i.e. the PAYER — not the
 * party being paid. The precompile pubkey must equal `claimer`
 * (`processor.rs` `verify_ed25519_precompile`: `pubkey_bytes != claimer` →
 * `UnauthorizedSigner`), and the amount is written into the claimer's own
 * `transferred_amount_{a,b}` slot, bounded by the claimer's own deposit.
 * Anyone may be the fee payer. The instruction moves NO tokens: value
 * leaves the vault only at `SettleChannel`/`ForceCloseExpired`, which pay
 * `deposit_x - transferred_x + transferred_y` to each side — so a recipient
 * realises a payout with claim → close → (challenge elapses) → settle.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Signer,
} from '@solana/web3.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'solana'
);

// ---------------------------------------------------------------------------
// Program ids the SBF program hard-checks against
// ---------------------------------------------------------------------------

export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
export const ED25519_PROGRAM_ID = new PublicKey(
  'Ed25519SigVerify111111111111111111111111111'
);

/** `packages/solana-program/src/instruction.rs` — 8-byte little-endian tags. */
const DISCRIMINATOR = {
  InitializeChannel: 1,
  Deposit: 2,
  CloseChannel: 3,
  SettleChannel: 4,
  ClaimFromChannel: 6,
} as const;

/** `state.rs` — ASCII `pchannel`. */
const ACCOUNT_DISCRIMINATOR = Buffer.from('pchannel', 'ascii');
export const CHANNEL_ACCOUNT_SIZE = 178;

const BALANCE_PROOF_DOMAIN_TAG = Buffer.from('TOON-BALPROOF-V2', 'ascii');

// ---------------------------------------------------------------------------
// Small encoders
// ---------------------------------------------------------------------------

function u64le(value: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function tag(d: number): Buffer {
  return u64le(d);
}

export function toPubkey(k: string | PublicKey | Uint8Array): PublicKey {
  if (k instanceof PublicKey) return k;
  if (typeof k === 'string') return new PublicKey(k);
  return new PublicKey(k);
}

/** A Solana keypair from a 32-byte ed25519 seed (the connector's own key-file shape). */
export function keypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== 32) throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  return Keypair.fromSeed(seed);
}

export function seedToHex(seed: Uint8Array): string {
  return Buffer.from(seed).toString('hex');
}

/** The committed mock-USDC mint authority (`fixtures/solana/usdc-authority.json`). */
export function usdcAuthorityKeypair(): Keypair {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'usdc-authority.json'), 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

/** `sort_participants` — by the 32 BYTES, not the base58 text (`processor.rs`). */
export function sortSolanaParticipants(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

/** `["channel", min(a,b), max(a,b), mint]` — `processor.rs:206-212`. */
export function deriveSolanaChannelPda(
  programId: PublicKey,
  a: PublicKey,
  b: PublicKey,
  mint: PublicKey
): PublicKey {
  const [min, max] = sortSolanaParticipants(a, b);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('channel'), min.toBuffer(), max.toBuffer(), mint.toBuffer()],
    programId
  )[0];
}

/** `["vault", channel_pda]`. */
export function deriveSolanaVaultPda(programId: PublicKey, channelPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), channelPda.toBuffer()], programId)[0];
}

/** The SPL associated token account for `(owner, mint)`. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

// ---------------------------------------------------------------------------
// The balance proof
// ---------------------------------------------------------------------------

/** ADR 0053's 96-byte message — byte-identical to `connector_signer::solana_balance_proof_message`. */
export function solanaBalanceProofMessage96(params: {
  programId: PublicKey | string;
  channelAccount: PublicKey | string;
  nonce: bigint | number;
  transferredAmount: bigint | number;
}): Uint8Array {
  const out = Buffer.concat([
    BALANCE_PROOF_DOMAIN_TAG,
    toPubkey(params.programId).toBuffer(),
    toPubkey(params.channelAccount).toBuffer(),
    u64le(params.nonce),
    u64le(params.transferredAmount),
  ]);
  if (out.length !== 96) throw new Error(`balance proof is ${out.length} bytes, not 96`);
  return new Uint8Array(out);
}

/** ed25519-sign the 96-byte proof with a 32-byte seed → 64-byte signature. */
export function signSolanaBalanceProof(
  seed: Uint8Array,
  params: Parameters<typeof solanaBalanceProofMessage96>[0]
): { message: Uint8Array; signature: Uint8Array; publicKey: PublicKey } {
  const message = solanaBalanceProofMessage96(params);
  const signature = ed25519.sign(message, seed);
  return { message, signature, publicKey: new PublicKey(ed25519.getPublicKey(seed)) };
}

export interface SolanaClientClaim {
  version: '1.0';
  blockchain: 'solana';
  messageId: string;
  timestamp: string;
  senderId: string;
  programId: string;
  channelAccount: string;
  nonce: number;
  transferredAmount: string;
  /** base64 of the 64-byte ed25519 signature. */
  signature: string;
  signerPublicKey: string;
  cluster?: string;
}

/**
 * Build a spec §1.3 `solana` claim. `programId` MUST be the settlement
 * program the channel lives under — it is inside the signed bytes at offset
 * 16, and a connector logs a disagreement with its own `[settlement.solana]
 * program_id` at `warn` (spec §1.3 step 4). `cluster` is optional and is
 * cross-checked against the connector's own when both are known; omit it on a
 * local validator.
 */
export function signSolanaClientClaim(params: {
  seed: Uint8Array;
  programId: PublicKey | string;
  channelAccount: PublicKey | string;
  nonce: bigint | number;
  transferredAmount: bigint | number;
  cluster?: string;
  messageId?: string;
  timestamp?: string;
  senderId?: string;
}): SolanaClientClaim {
  const { signature, publicKey } = signSolanaBalanceProof(params.seed, params);
  const channelAccount = toPubkey(params.channelAccount).toBase58();
  const claim: SolanaClientClaim = {
    version: '1.0',
    blockchain: 'solana',
    messageId: params.messageId ?? `swap-e2e:solana:${channelAccount}:${String(params.nonce)}`,
    timestamp: params.timestamp ?? new Date().toISOString(),
    senderId: params.senderId ?? publicKey.toBase58(),
    programId: toPubkey(params.programId).toBase58(),
    channelAccount,
    nonce: Number(params.nonce),
    transferredAmount: BigInt(params.transferredAmount).toString(),
    signature: Buffer.from(signature).toString('base64'),
    signerPublicKey: publicKey.toBase58(),
  };
  if (params.cluster) claim.cluster = params.cluster;
  return claim;
}

// ---------------------------------------------------------------------------
// RPC + funding
// ---------------------------------------------------------------------------

const connections = new Map<string, Connection>();

export function solanaConnection(rpcUrl: string): Connection {
  let c = connections.get(rpcUrl);
  if (!c) {
    c = new Connection(rpcUrl, { commitment: 'confirmed' });
    connections.set(rpcUrl, c);
  }
  return c;
}

/**
 * Poll a signature to `confirmed` — deliberately NOT `confirmTransaction`,
 * which opens a websocket subscription (`<rpc port>+1`) that keeps
 * reconnecting after the validator is torn down and spams `ws error:
 * connect ECONNREFUSED` into the test output.
 */
async function awaitConfirmed(conn: Connection, signature: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = value[0];
    if (status?.err) {
      throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return;
    }
    if (Date.now() > deadline) throw new Error(`transaction ${signature} not confirmed in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function send(
  rpcUrl: string,
  instructions: TransactionInstruction[],
  feePayer: Signer,
  extraSigners: Signer[] = []
): Promise<string> {
  const conn = solanaConnection(rpcUrl);
  const tx = new Transaction().add(...instructions);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const signers = [feePayer, ...extraSigners.filter((s) => !s.publicKey.equals(feePayer.publicKey))];
  tx.sign(...signers);
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  } catch (err) {
    // `SendTransactionError` hides the program's own `msg!` lines behind
    // `logs`; surface them, since "custom program error: 0x…" alone names
    // nothing.
    const logs =
      err && typeof err === 'object' && 'logs' in err
        ? (err as { logs?: string[] }).logs
        : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(logs ? `${msg}\n${logs.join('\n')}` : msg);
  }
  await awaitConfirmed(conn, signature);
  return signature;
}

export async function airdropSol(rpcUrl: string, to: PublicKey, sol: number): Promise<void> {
  const conn = solanaConnection(rpcUrl);
  const sig = await conn.requestAirdrop(to, Math.round(sol * 1_000_000_000));
  await awaitConfirmed(conn, sig);
}

export async function solBalance(rpcUrl: string, of: PublicKey): Promise<number> {
  return solanaConnection(rpcUrl).getBalance(of, 'confirmed');
}

/** Base units held by a token account (0 when the account does not exist). */
export async function splBalance(rpcUrl: string, tokenAccount: PublicKey): Promise<bigint> {
  const conn = solanaConnection(rpcUrl);
  const info = await conn.getAccountInfo(tokenAccount, 'confirmed');
  if (!info) return 0n;
  const res = await conn.getTokenAccountBalance(tokenAccount, 'confirmed');
  return BigInt(res.value.amount);
}

/** `CreateIdempotent` (tag 1) on the associated-token program. */
function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token `MintTo` (tag 7). */
function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  });
}

/**
 * Create `owner`'s ATA for `mint` if missing and mint `amount` base units
 * into it, signed by the committed fixture authority (mint authority AND fee
 * payer — it is airdropped by `provisionSplMint`). Returns the ATA.
 */
export async function mintUsdcTo(params: {
  rpcUrl: string;
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  authority?: Keypair;
}): Promise<PublicKey> {
  const authority = params.authority ?? usdcAuthorityKeypair();
  const ata = associatedTokenAddress(params.owner, params.mint);
  await send(
    params.rpcUrl,
    [
      createAtaIdempotentIx(authority.publicKey, params.owner, params.mint),
      mintToIx(params.mint, ata, authority.publicKey, params.amount),
    ],
    authority
  );
  return ata;
}

// ---------------------------------------------------------------------------
// Channel account decoding (`state.rs`)
// ---------------------------------------------------------------------------

export interface SolanaChannelState {
  participantA: PublicKey;
  participantB: PublicKey;
  tokenMint: PublicKey;
  depositA: bigint;
  depositB: bigint;
  transferredAmountA: bigint;
  transferredAmountB: bigint;
  nonceA: bigint;
  nonceB: bigint;
  challengeDuration: bigint;
  /** 0 Opened, 1 Closed, 2 Settled. */
  state: number;
  closeTimestamp: bigint;
  bump: number;
}

export function decodeSolanaChannel(data: Uint8Array): SolanaChannelState {
  const b = Buffer.from(data);
  if (b.length !== CHANNEL_ACCOUNT_SIZE) {
    throw new Error(`channel account is ${b.length} bytes, expected ${CHANNEL_ACCOUNT_SIZE}`);
  }
  if (!b.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR)) {
    throw new Error(`channel account discriminator is not "pchannel"`);
  }
  return {
    participantA: new PublicKey(b.subarray(8, 40)),
    participantB: new PublicKey(b.subarray(40, 72)),
    tokenMint: new PublicKey(b.subarray(72, 104)),
    depositA: b.readBigUInt64LE(104),
    depositB: b.readBigUInt64LE(112),
    transferredAmountA: b.readBigUInt64LE(120),
    transferredAmountB: b.readBigUInt64LE(128),
    nonceA: b.readBigUInt64LE(136),
    nonceB: b.readBigUInt64LE(144),
    challengeDuration: b.readBigUInt64LE(152),
    state: b[160] ?? 0,
    closeTimestamp: b.readBigInt64LE(161),
    bump: b[169] ?? 0,
  };
}

/** `null` when the PDA does not exist (or was zeroed by settlement). */
export async function readSolanaChannel(
  rpcUrl: string,
  channelAccount: PublicKey
): Promise<SolanaChannelState | null> {
  const info = await solanaConnection(rpcUrl).getAccountInfo(channelAccount, 'confirmed');
  if (!info || info.data.length === 0) return null;
  if (info.data.every((x) => x === 0)) return null;
  return decodeSolanaChannel(info.data);
}

/** Which slot (`a`/`b`) `who` occupies in the channel. */
export function participantSlot(state: SolanaChannelState, who: PublicKey): 'a' | 'b' {
  if (state.participantA.equals(who)) return 'a';
  if (state.participantB.equals(who)) return 'b';
  throw new Error(`${who.toBase58()} is not a participant of this channel`);
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export function initializeChannelIx(params: {
  programId: PublicKey;
  payer: PublicKey;
  participantA: PublicKey;
  participantB: PublicKey;
  mint: PublicKey;
  challengeDurationSeconds: bigint | number;
}): TransactionInstruction {
  const channelPda = deriveSolanaChannelPda(params.programId, params.participantA, params.participantB, params.mint);
  const vaultPda = deriveSolanaVaultPda(params.programId, channelPda);
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.participantA, isSigner: false, isWritable: false },
      { pubkey: params.participantB, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: channelPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([tag(DISCRIMINATOR.InitializeChannel), u64le(params.challengeDurationSeconds)]),
  });
}

export function depositIx(params: {
  programId: PublicKey;
  depositor: PublicKey;
  depositorTokenAccount: PublicKey;
  channelPda: PublicKey;
  amount: bigint | number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.depositor, isSigner: true, isWritable: false },
      { pubkey: params.depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: deriveSolanaVaultPda(params.programId, params.channelPda), isSigner: false, isWritable: true },
      { pubkey: params.channelPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([tag(DISCRIMINATOR.Deposit), u64le(params.amount)]),
  });
}

/**
 * The Ed25519 precompile instruction `ClaimFromChannel` requires at index 0,
 * laid out exactly as `wire.rs::ed25519_verify_instruction` — one signature,
 * every `*_instruction_index` = `u16::MAX` so all offsets read from this
 * instruction (the program refuses cross-instruction references).
 */
export function ed25519VerifyIx(pubkey: PublicKey, signature: Uint8Array, message: Uint8Array): TransactionInstruction {
  const DATA_START = 16;
  const pubkeyOffset = DATA_START;
  const sigOffset = pubkeyOffset + 32;
  const msgOffset = sigOffset + 64;
  const header = Buffer.alloc(DATA_START);
  header[0] = 1; // num_signatures
  header[1] = 0; // padding
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
    data: Buffer.concat([header, pubkey.toBuffer(), Buffer.from(signature), Buffer.from(message)]),
  });
}

export function claimFromChannelIx(params: {
  programId: PublicKey;
  feePayer: PublicKey;
  /** The PAYER whose signature the precompile verified. */
  claimer: PublicKey;
  channelPda: PublicKey;
  nonce: bigint | number;
  transferredAmount: bigint | number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.feePayer, isSigner: true, isWritable: true },
      { pubkey: params.claimer, isSigner: false, isWritable: false },
      { pubkey: params.channelPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([tag(DISCRIMINATOR.ClaimFromChannel), u64le(params.nonce), u64le(params.transferredAmount)]),
  });
}

export function closeChannelIx(params: { programId: PublicKey; closer: PublicKey; channelPda: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.closer, isSigner: true, isWritable: false },
      { pubkey: params.channelPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: tag(DISCRIMINATOR.CloseChannel),
  });
}

export function settleChannelIx(params: {
  programId: PublicKey;
  caller: PublicKey;
  channelPda: PublicKey;
  participantATokenAccount: PublicKey;
  participantBTokenAccount: PublicKey;
  rentRecipient: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.caller, isSigner: true, isWritable: false },
      { pubkey: params.channelPda, isSigner: false, isWritable: true },
      { pubkey: deriveSolanaVaultPda(params.programId, params.channelPda), isSigner: false, isWritable: true },
      { pubkey: params.participantATokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.participantBTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.rentRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: tag(DISCRIMINATOR.SettleChannel),
  });
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export interface DepositorSolanaChannel {
  channelAccount: PublicKey;
  vault: PublicKey;
  depositor: PublicKey;
  counterparty: PublicKey;
  programId: PublicKey;
  mint: PublicKey;
  /** The depositor's cumulative on-chain deposit after this call. */
  deposit: bigint;
}

/**
 * Open (if absent) the `(depositor, counterparty, mint)` channel with the
 * depositor as `InitializeChannel`'s payer, then `Deposit` `amount` from the
 * depositor's ATA. The depositor is a participant and signs — that is the
 * only party the program credits. Idempotent on the open; a repeat call
 * deposits again (the program only `checked_add`s).
 */
export async function openSolanaChannelAsDepositor(params: {
  rpcUrl: string;
  programId: PublicKey | string;
  mint: PublicKey | string;
  depositorSeed: Uint8Array;
  counterparty: PublicKey | string;
  amount: bigint;
  challengeDurationSeconds?: bigint | number;
}): Promise<DepositorSolanaChannel> {
  const programId = toPubkey(params.programId);
  const mint = toPubkey(params.mint);
  const depositor = keypairFromSeed(params.depositorSeed);
  const counterparty = toPubkey(params.counterparty);
  const channelAccount = deriveSolanaChannelPda(programId, depositor.publicKey, counterparty, mint);
  const vault = deriveSolanaVaultPda(programId, channelAccount);
  const depositorAta = associatedTokenAddress(depositor.publicKey, mint);

  const ixs: TransactionInstruction[] = [];
  if ((await readSolanaChannel(params.rpcUrl, channelAccount)) === null) {
    ixs.push(
      initializeChannelIx({
        programId,
        payer: depositor.publicKey,
        participantA: depositor.publicKey,
        participantB: counterparty,
        mint,
        challengeDurationSeconds: params.challengeDurationSeconds ?? 3600,
      })
    );
  }
  if (params.amount > 0n) {
    ixs.push(
      depositIx({
        programId,
        depositor: depositor.publicKey,
        depositorTokenAccount: depositorAta,
        channelPda: channelAccount,
        amount: params.amount,
      })
    );
  }
  if (ixs.length > 0) await send(params.rpcUrl, ixs, depositor);

  const state = await readSolanaChannel(params.rpcUrl, channelAccount);
  if (!state) throw new Error(`channel ${channelAccount.toBase58()} missing after open`);
  const slot = participantSlot(state, depositor.publicKey);
  return {
    channelAccount,
    vault,
    depositor: depositor.publicKey,
    counterparty,
    programId,
    mint,
    deposit: slot === 'a' ? state.depositA : state.depositB,
  };
}

/**
 * Submit a payer-signed balance proof: Ed25519 precompile at index 0, then
 * `ClaimFromChannel` with `claimer` = the payer whose seed signed. The
 * submitter pays fees and need not be a participant. Records
 * (nonce, transferredAmount) against the payer's slot; moves no tokens.
 */
export async function claimFromSolanaChannel(params: {
  rpcUrl: string;
  programId: PublicKey | string;
  channelAccount: PublicKey | string;
  feePayerSeed: Uint8Array;
  /** The payer's pubkey (the key that produced `signature`). */
  claimer: PublicKey | string;
  nonce: bigint | number;
  transferredAmount: bigint | number;
  /** 64-byte ed25519 signature over {@link solanaBalanceProofMessage96}. */
  signature: Uint8Array;
}): Promise<string> {
  const programId = toPubkey(params.programId);
  const channelAccount = toPubkey(params.channelAccount);
  const claimer = toPubkey(params.claimer);
  const feePayer = keypairFromSeed(params.feePayerSeed);
  const message = solanaBalanceProofMessage96({
    programId,
    channelAccount,
    nonce: params.nonce,
    transferredAmount: params.transferredAmount,
  });
  return send(
    params.rpcUrl,
    [
      ed25519VerifyIx(claimer, params.signature, message),
      claimFromChannelIx({
        programId,
        feePayer: feePayer.publicKey,
        claimer,
        channelPda: channelAccount,
        nonce: params.nonce,
        transferredAmount: params.transferredAmount,
      }),
    ],
    feePayer
  );
}

/** `CloseChannel` by a participant — starts the challenge window. */
export async function closeSolanaChannel(params: {
  rpcUrl: string;
  programId: PublicKey | string;
  channelAccount: PublicKey | string;
  closerSeed: Uint8Array;
}): Promise<string> {
  const closer = keypairFromSeed(params.closerSeed);
  return send(
    params.rpcUrl,
    [closeChannelIx({ programId: toPubkey(params.programId), closer: closer.publicKey, channelPda: toPubkey(params.channelAccount) })],
    closer
  );
}

/**
 * `SettleChannel` after the challenge window — pays each side
 * `deposit_x - transferred_x + transferred_y` into its ATA for the channel's
 * mint (the program checks owner + mint on each destination it pays) and
 * closes the PDA + vault to `rentRecipient`. Any signer may call.
 */
export async function settleSolanaChannel(params: {
  rpcUrl: string;
  programId: PublicKey | string;
  channelAccount: PublicKey | string;
  callerSeed: Uint8Array;
  rentRecipient?: PublicKey;
}): Promise<string> {
  const programId = toPubkey(params.programId);
  const channelAccount = toPubkey(params.channelAccount);
  const caller = keypairFromSeed(params.callerSeed);
  const state = await readSolanaChannel(params.rpcUrl, channelAccount);
  if (!state) throw new Error(`channel ${channelAccount.toBase58()} does not exist`);
  return send(
    params.rpcUrl,
    [
      settleChannelIx({
        programId,
        caller: caller.publicKey,
        channelPda: channelAccount,
        participantATokenAccount: associatedTokenAddress(state.participantA, state.tokenMint),
        participantBTokenAccount: associatedTokenAddress(state.participantB, state.tokenMint),
        rentRecipient: params.rentRecipient ?? caller.publicKey,
      }),
    ],
    caller
  );
}
