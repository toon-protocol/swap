/**
 * swap#160 — a real `solana-test-validator` for the E2E harness.
 *
 * The Solana suites in this directory have never once executed. They gated on
 * an operator having stood a validator up by hand and exported
 * `SOLANA_E2E_RPC_URL`, which no CI job has ever done, so they collected two
 * tests and skipped both on every run — the same shape of hole swap#106 found
 * (four suites collecting *zero* while reporting a pass) and swap#153 closed
 * for the EVM legs by booting a second anvil.
 *
 * This module closes it for Solana, following the pattern
 * `tests/integration/helpers/rolling-e2e-harness.ts` established: spawn a real
 * local binary, rehydrate vendored state, poll until it is genuinely ready,
 * never sleep on a guess.
 *
 * ## Why a local validator works where the public devnet does not
 *
 * The blocker on public Solana devnet is SUPPLY, not code: the public airdrop
 * is dry and the TOON faucet's Solana route is unconfigured, and the mock-USDC
 * mint authority lives off-repo (toon-meta#394's T6 rig hit exactly this and
 * worked around it with a local validator). A local validator mints SOL and
 * SPL tokens on demand and confirms in a slot, so the whole leg-B Solana path
 * is exercisable for free, deterministically, with no network access.
 *
 * ## Program provenance and how it gets deployed
 *
 * There is no deploy transaction. `--bpf-program <ADDRESS> <path.so>` bakes the
 * program into the validator's GENESIS, which is both faster and more
 * deterministic than `solana program deploy` (no fee payer, no program
 * keypair, no confirmation to wait on) — the same mechanism connector's Rust
 * test harness uses (`crates/connector-settlement-solana/src/test_support.rs`).
 * The binary is vendored; see `../fixtures/solana/README.md` for its source
 * commit, build command, and how to refresh it. {@link assertProgramFixture}
 * checks its size and sha256 before every boot, so a truncated or
 * silently-swapped blob fails here with a clear message instead of producing a
 * validator whose program rejects every instruction for reasons nobody can see.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ed25519 } from '@noble/curves/ed25519.js';
import { EvmSigner, OnChainChannelClient } from '@toon-protocol/client';
import { base58Encode } from '@toon-protocol/sdk';

import { deriveSwapNodeKeys } from '../../../src/wallet.js';
import {
  SOLANA_CHAIN,
  SOLANA_DYNAMIC_PORT_RANGE,
  SOLANA_FAUCET_PORT,
  SOLANA_PROGRAM_ID,
  SOLANA_RPC_PORT,
  SOLANA_RPC_URL,
  SOLANA_USDC_MINT,
} from './topology.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'solana'
);

export const SOLANA_PROGRAM_SO = join(FIXTURES_DIR, 'payment_channel.so');

/**
 * Size and hash of the vendored program, asserted at boot. Update BOTH of
 * these and the table in `../fixtures/solana/README.md` whenever the blob is
 * refreshed — the mismatch message points a reader at that file.
 */
const SOLANA_PROGRAM_SO_BYTES = 109_416;
const SOLANA_PROGRAM_SO_SHA256 =
  'b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600';

/** The BPF upgradeable loader — the owner every loaded program account has. */
const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Mock USDC decimals — real-USDC standard, matching the EVM mock's 6. */
const SOLANA_USDC_DECIMALS = 6;

/**
 * Collateral each seeded channel is opened with, in mint base units (6 dp).
 *
 * Sized well above anything the suites move (they swap 1 USDC), because a
 * channel whose vault cannot cover the claims written against it is not a
 * realistic thing for the maker's chain-truth reader to be reading.
 */
const CHANNEL_DEPOSIT = '5000000';

/** Challenge period for the seeded channels, in seconds. */
const CHANNEL_CHALLENGE_DURATION = 3600;

/** Whole mock-USDC minted to each opener — comfortably over its deposit. */
const OPENER_MINT_AMOUNT = 1000;

/**
 * Lamports airdropped to each provisioning key. Generous: rent for a channel
 * PDA + its vault ATA plus fees, times a few opens, with headroom — a local
 * faucet is free and an under-funded payer fails deep inside an instruction.
 */
const AIRDROP_SOL = 100;

// ---------------------------------------------------------------------------
// Fixture keypairs (committed — see ../fixtures/solana/README.md)
// ---------------------------------------------------------------------------

const MINT_KEYPAIR = join(FIXTURES_DIR, 'usdc-mint.json');
const AUTHORITY_KEYPAIR = join(FIXTURES_DIR, 'usdc-authority.json');

/**
 * How many real channel PDAs to seed the maker with.
 *
 * This is a HEADROOM number, and the reason it is not 1 is the swap#113 rebind
 * precondition. `SwapChannelState.resolveChannel()` binds each distinct sender
 * pubkey to its own unbound channel and never frees one; a bound channel is
 * only rebindable once its on-chain `cumulativePaid` has caught up with the
 * off-chain watermark, i.e. once the sender has actually redeemed. These suites
 * never redeem (the claims are off-chain balance proofs), so every distinct
 * sender that targets Solana consumes one channel permanently, and peer1 is
 * shared across all ten suite files (`vitest.e2e.config.ts` — `singleFork`,
 * `isolate: false`).
 *
 * Four senders target Solana today — the rolling Solana suite, the rolling
 * pair-matrix, the legacy Solana suite, the legacy pair-matrix — and running
 * out is a confusing failure deep in the maker (`channel_unredeemed`, "not safe
 * to rebind"), so this is sized to twice that. Each extra channel costs ~1s of
 * provisioning, and they are opened concurrently.
 */
const OPENER_COUNT = 8;

/**
 * Deterministic per-opener Ed25519 seed.
 *
 * Derived rather than committed: the channel PDA is a function of
 * `(participantA, participantB, mint, programId)`, so one opener can only ever
 * produce ONE channel against peer1 — N channels need N distinct openers, and
 * committing N keypair files (then having to add another whenever a suite is
 * added) is worse than deriving them from a fixed label. Addresses stay stable
 * across runs either way, which is what the tests need.
 *
 * Test-only material with no value: it authorizes nothing but freshly minted
 * play tokens on a throwaway local validator.
 */
function openerSeed(index: number): Uint8Array {
  return new Uint8Array(
    createHash('sha256')
      .update(`swap-e2e-solana-opener/${index}`)
      .digest()
      .subarray(0, 32)
  );
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * True when a `solana-test-validator` binary is on PATH.
 *
 * Mirrors `isAnvilAvailable()`. Absent it, `global-setup.ts` leaves Solana down
 * and the Solana suites skip with an actionable warning — except under
 * `SWAP_E2E_REQUIRE_SOLANA`, where `infra-gate.ts` turns that into a hard
 * failure (see `skipIfNotReady()`).
 */
export function isSolanaValidatorAvailable(): boolean {
  try {
    const res = spawnSync('solana-test-validator', ['--version'], {
      timeout: 15_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** True when the `solana` + `spl-token` CLIs needed for provisioning exist. */
export function areSolanaCliToolsAvailable(): boolean {
  for (const bin of ['solana', 'spl-token']) {
    try {
      if (spawnSync(bin, ['--version'], { timeout: 15_000 }).status !== 0) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Raw JSON-RPC (no chain SDK — same stance as the EVM harness and the
// production Solana channel reader, which both speak raw RPC on purpose)
// ---------------------------------------------------------------------------

let rpcId = 1;

async function solanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(`${method} → ${json.error.message ?? 'RPC error'}`);
  }
  return json.result as T;
}

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

/**
 * Fail loudly if the vendored program is not the exact binary this harness was
 * written against. A silently-different `.so` is the worst failure mode here:
 * the validator boots, the program is executable, and every instruction fails
 * for a reason no test message would explain.
 */
export function assertProgramFixture(): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(SOLANA_PROGRAM_SO);
  } catch (err) {
    throw new Error(
      `Vendored Solana program missing at ${SOLANA_PROGRAM_SO} — see ` +
        `tests/e2e/fixtures/solana/README.md for how to rebuild it ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== SOLANA_PROGRAM_SO_BYTES || sha256 !== SOLANA_PROGRAM_SO_SHA256) {
    throw new Error(
      `Vendored Solana program does not match the expected build: got ` +
        `${bytes.length} bytes / sha256 ${sha256}, expected ` +
        `${SOLANA_PROGRAM_SO_BYTES} bytes / sha256 ${SOLANA_PROGRAM_SO_SHA256}. ` +
        `If the program was intentionally refreshed, update ` +
        `SOLANA_PROGRAM_SO_BYTES/SHA256 here AND the provenance table in ` +
        `tests/e2e/fixtures/solana/README.md.`
    );
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface SolanaValidatorInstance {
  rpcUrl: string;
  programId: string;
  /** Disposable ledger directory — removed by {@link stop}. */
  ledgerDir: string;
  stop: () => Promise<void>;
}

function assertLoopback(rpcUrl: string): void {
  const host = new URL(rpcUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `Refusing to provision against a non-loopback RPC (${rpcUrl}). This ` +
        `helper airdrops SOL and mints an unlimited supply of a mock token ` +
        `from keypairs committed to this repo; it must only ever talk to a ` +
        `throwaway local validator.`
    );
  }
}

/**
 * Spawn a validator with the vendored program baked in at
 * {@link SOLANA_PROGRAM_ID}, and return once it is genuinely serving.
 *
 * Readiness is TWO checks, both polled, neither slept on:
 *
 * 1. `getHealth` returns `ok` — the validator is producing blocks. (Note that
 *    `/health` alone is not proof of a *working* validator in general: a
 *    disk-full validator keeps answering `ok` while block production is frozen,
 *    which is how the devnet Solana box wedged. Here the ledger is a fresh
 *    tmpdir, so the failure mode is boot-time, not disk.)
 * 2. the program account exists, is `executable`, and is owned by the BPF
 *    upgradeable loader — i.e. `--bpf-program` actually took. Without this
 *    check a bad path or unreadable blob yields a healthy validator with no
 *    program on it, and every channel open fails later with an opaque
 *    instruction error.
 */
export async function startSolanaValidator(): Promise<SolanaValidatorInstance> {
  assertProgramFixture();
  assertLoopback(SOLANA_RPC_URL);

  const ledgerDir = mkdtempSync(join(tmpdir(), 'swap-e2e-solana-'));
  const child: ChildProcess = spawn(
    'solana-test-validator',
    [
      '--ledger',
      join(ledgerDir, 'ledger'),
      '--rpc-port',
      String(SOLANA_RPC_PORT),
      '--faucet-port',
      String(SOLANA_FAUCET_PORT),
      '--dynamic-port-range',
      SOLANA_DYNAMIC_PORT_RANGE,
      '--bpf-program',
      SOLANA_PROGRAM_ID,
      SOLANA_PROGRAM_SO,
      '--reset',
      '--quiet',
    ],
    { stdio: 'ignore' }
  );

  // Held behind a property rather than a bare `let`: TypeScript's control-flow
  // analysis narrows a `let` assigned only inside a callback to `null` at every
  // read, which makes the fields below unreachable types.
  const childExit: {
    info: { code: number | null; signal: string | null } | null;
  } = { info: null };
  child.once('exit', (code, signal) => {
    childExit.info = { code, signal };
  });

  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM');
    for (let i = 0; i < 50 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    try {
      rmSync(ledgerDir, { recursive: true, force: true });
    } catch {
      /* best-effort: a leftover tmpdir is not worth failing a run over */
    }
  };

  // 1. Block production. 90s budget at 250ms — a cold GitHub runner takes a
  // few seconds; the generous ceiling is there so a slow runner is slow, not
  // flaky, and the failure below says which check timed out.
  const healthDeadline = Date.now() + 90_000;
  for (;;) {
    const exit = childExit.info;
    if (exit !== null) {
      await stop();
      throw new Error(
        `solana-test-validator exited during startup (code=${String(
          exit.code
        )} signal=${String(exit.signal)}). A common cause is a stale ` +
          `validator still holding :${SOLANA_RPC_PORT}.`
      );
    }
    try {
      const health = await solanaRpc<string>(SOLANA_RPC_URL, 'getHealth');
      if (health === 'ok') break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > healthDeadline) {
      await stop();
      throw new Error(
        `solana-test-validator on :${SOLANA_RPC_PORT} did not report ` +
          `getHealth=ok within 90s`
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 2. The program is really there. Polled too: the account is written at
  // genesis, but the first `getAccountInfo` can still land on a slot the RPC
  // has not caught up to.
  const programDeadline = Date.now() + 30_000;
  for (;;) {
    const info = await solanaRpc<{
      value: { executable: boolean; owner: string } | null;
    }>(SOLANA_RPC_URL, 'getAccountInfo', [
      SOLANA_PROGRAM_ID,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    const value = info.value;
    if (value && value.executable && value.owner === BPF_UPGRADEABLE_LOADER) {
      break;
    }
    if (Date.now() > programDeadline) {
      await stop();
      throw new Error(
        `the vendored payment-channel program is not loaded at ` +
          `${SOLANA_PROGRAM_ID} (account=${
            value ? `executable=${String(value.executable)} owner=${value.owner}` : 'missing'
          }) — --bpf-program did not take. Fixture: ${SOLANA_PROGRAM_SO}`
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    rpcUrl: SOLANA_RPC_URL,
    programId: SOLANA_PROGRAM_ID,
    ledgerDir,
    stop,
  };
}

// ---------------------------------------------------------------------------
// SPL mint provisioning
// ---------------------------------------------------------------------------

function run(
  bin: string,
  args: readonly string[],
  label: string
): { ok: boolean; output: string } {
  const res = spawnSync(bin, [...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0) {
    return { ok: false, output: `${label} failed: ${output.trim()}` };
  }
  return { ok: true, output };
}

function mustRun(bin: string, args: readonly string[], label: string): string {
  const { ok, output } = run(bin, args, label);
  if (!ok) throw new Error(output);
  return output;
}

function pubkeyOf(keypairPath: string): string {
  return mustRun(
    'solana-keygen',
    ['pubkey', keypairPath],
    `solana-keygen pubkey ${keypairPath}`
  ).trim();
}

export interface Opener {
  /** 32-byte Ed25519 seed — what `OnChainChannelClient` signs with. */
  seed: Uint8Array;
  /** Base58 address. */
  pubkey: string;
  /**
   * Path to a Solana-CLI-format keypair file (the 64-byte `seed || pubkey`
   * JSON array), materialized in a temp dir so `spl-token` can use it as a
   * signer. Never committed.
   */
  keypairPath: string;
}

/** An opener whose SOL and mock-USDC are in place. */
export interface ProvisionedOpener extends Opener {
  /** Funded associated token account holding the mock USDC. */
  ata: string;
}

export interface SolanaProvisioning {
  /** The mock USDC SPL mint. */
  mint: string;
  openers: readonly ProvisionedOpener[];
  /**
   * Remove the temp dir holding the CLI config and the derived opener keypair
   * files. Call once the channels are open — nothing needs them afterwards.
   */
  dispose: () => void;
}

/**
 * Materialize {@link OPENER_COUNT} derived openers as CLI keypair files under
 * `dir`, and return them.
 */
function materializeOpeners(dir: string): Opener[] {
  return Array.from({ length: OPENER_COUNT }, (_, i) => {
    const seed = openerSeed(i);
    const publicKey = new Uint8Array(ed25519.getPublicKey(seed));
    const keypairPath = join(dir, `opener-${i}.json`);
    // Solana CLI keypair format: a 64-element JSON array of `seed || pubkey`.
    writeFileSync(
      keypairPath,
      JSON.stringify([...seed, ...publicKey]),
      // Owner-only: it is throwaway material, but a world-readable private key
      // on a shared runner is still a bad habit to model.
      { mode: 0o600 }
    );
    return { seed, pubkey: base58Encode(publicKey), keypairPath };
  });
}

/**
 * Create the mock USDC mint and fund each opener's associated token account.
 *
 * Driven through the `solana` / `spl-token` CLIs against a throwaway config
 * file, exactly as connector's `infra/solana/create-usdc-mint.sh` does — the
 * CLIs handle ATA derivation and the SPL instruction encoding, so this harness
 * does not carry a second copy of either.
 *
 * Idempotent: a second call against a live validator skips creation and tops
 * up. Every step is a confirmed CLI call (the CLI blocks on confirmation), so
 * nothing here sleeps waiting for a transaction to land.
 *
 * `--fee-payer` is passed EXPLICITLY on every `spl-token` subcommand even
 * though the throwaway config already names a keypair: `spl-token` 4.x accepts
 * the config's keypair as a signer but still errors `fee payer is required` on
 * `create-account --owner`, which is exactly the call this needs.
 */
export async function provisionSplMint(
  rpcUrl: string
): Promise<SolanaProvisioning> {
  assertLoopback(rpcUrl);

  const workDir = mkdtempSync(join(tmpdir(), 'swap-e2e-solcfg-'));
  const cfg = join(workDir, 'config.yml');
  const authority = pubkeyOf(AUTHORITY_KEYPAIR);
  const mint = pubkeyOf(MINT_KEYPAIR);
  if (mint !== SOLANA_USDC_MINT) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `fixtures/solana/usdc-mint.json derives ${mint} but topology.ts pins ` +
        `SOLANA_USDC_MINT=${SOLANA_USDC_MINT} — one of them changed`
    );
  }

  mustRun(
    'solana',
    [
      '-C',
      cfg,
      'config',
      'set',
      '--keypair',
      AUTHORITY_KEYPAIR,
      '--url',
      rpcUrl,
    ],
    'solana config set'
  );

  const openers = materializeOpeners(workDir);

  // Fees for the authority first, serially: everything below is paid for by
  // it, so nothing else can proceed until it is funded.
  mustRun(
    'solana',
    ['-C', cfg, 'airdrop', String(AIRDROP_SOL), authority],
    `solana airdrop ${authority}`
  );

  // The mint lands at the committed keypair's address, so it is identical
  // across runs. Skipped when the account already exists (idempotent against a
  // validator this process did not start).
  const mintExists = run(
    'solana',
    ['-C', cfg, 'account', mint],
    'solana account'
  ).ok;
  if (!mintExists) {
    mustRun(
      'spl-token',
      [
        '-C',
        cfg,
        'create-token',
        '--decimals',
        String(SOLANA_USDC_DECIMALS),
        '--fee-payer',
        AUTHORITY_KEYPAIR,
        MINT_KEYPAIR,
      ],
      'spl-token create-token'
    );
  }

  // Per-opener work is independent (distinct addresses, distinct ATAs) and each
  // step is a separate CLI process, so most of the cost is process startup.
  // Running the openers concurrently turns ~8×3 sequential spawns into three
  // concurrent waves — the difference between ~25s and ~6s of setup, on a local
  // validator that has no trouble with the concurrency.
  const provisioned = await Promise.all(
    openers.map(async (opener) => {
      await Promise.resolve();
      mustRun(
        'solana',
        ['-C', cfg, 'airdrop', String(AIRDROP_SOL), opener.pubkey],
        `solana airdrop ${opener.pubkey}`
      );

      // `create-account` on an existing ATA errors "already in use", which for
      // our purposes is success — so its failure is tolerated and the balance
      // check below is what actually decides whether provisioning worked.
      run(
        'spl-token',
        [
          '-C',
          cfg,
          'create-account',
          mint,
          '--owner',
          opener.pubkey,
          '--fee-payer',
          AUTHORITY_KEYPAIR,
        ],
        'spl-token create-account'
      );

      const ataOut = mustRun(
        'spl-token',
        [
          '-C',
          cfg,
          'address',
          '--token',
          mint,
          '--owner',
          opener.pubkey,
          '--verbose',
        ],
        'spl-token address'
      );
      const ata = ataOut
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^Associated token address:/i.test(line))
        ?.split(/\s+/)
        .pop();
      if (!ata) {
        throw new Error(
          `could not read the associated token address for ${opener.pubkey} ` +
            `from: ${ataOut.trim()}`
        );
      }

      mustRun(
        'spl-token',
        [
          '-C',
          cfg,
          'mint',
          mint,
          String(OPENER_MINT_AMOUNT),
          '--fee-payer',
          AUTHORITY_KEYPAIR,
          '--',
          ata,
        ],
        'spl-token mint'
      );

      // Read the balance back rather than trusting exit codes: an ATA that
      // exists but holds nothing produces a channel open that fails inside
      // `Deposit`, a long way from the cause.
      const balance = mustRun(
        'spl-token',
        ['-C', cfg, 'balance', '--address', ata],
        'spl-token balance'
      ).trim();
      if (!(Number(balance) > 0)) {
        throw new Error(
          `opener ${opener.pubkey}'s token account ${ata} holds ${balance} ` +
            `after minting`
        );
      }

      return { ...opener, ata };
    })
  );

  return {
    mint,
    openers: provisioned,
    dispose: () => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort: a leftover tmpdir is not worth failing a run over */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Real channel PDAs
// ---------------------------------------------------------------------------

/** Peer1's own Solana address — the counterparty every seeded channel names. */
export async function deriveMakerSolanaPubkey(
  mnemonic: string
): Promise<string> {
  const keys = await deriveSwapNodeKeys({
    mnemonic,
    chains: ['evm', 'solana'],
  });
  const solana = keys.solana;
  if (!solana) {
    throw new Error(
      'deriveSwapNodeKeys returned no Solana key — cannot seed Solana channels'
    );
  }
  // `deriveSwapNodeKeys` uses m/44'/501'/2'/0'/0' (wallet.ts) — the SAME path
  // `startSwapNode` derives its own Solana key from, which is what makes the
  // maker a participant of these channels and its chain-truth reader able to
  // pick its own `transferred_amount` slot out of them.
  return base58Encode(solana.publicKey);
}

/**
 * Open REAL payment-channel PDAs on the validator between each fixture opener
 * and peer1, and return their base58 addresses.
 *
 * These are what `peer-node.ts` seeds `channels['solana:devnet']` with, and
 * they are the whole reason this harness boots a validator rather than mocking
 * one: a Solana `channelId` IS its channel PDA, so seeding real PDAs is what
 * lets `src/solana-channel-reader.ts` (swap#141) decode account data written
 * by the REAL program. That decoder hand-rolls the 178-byte `ChannelState`
 * layout from connector's `packages/solana-program/src/state.rs`; a drift
 * between the two repos is invisible to every mock and caught here.
 *
 * Driven through `@toon-protocol/client`'s `OnChainChannelClient` — the same
 * class the toon-meta#394 T6 rig used to open its live Solana channel — so the
 * PDA derivation, instruction encoding and deposit flow come from product code
 * rather than a test-only reimplementation. Note the program records the
 * OPENER as `participant_a` and peer1 as `participant_b`; the reader handles
 * either slot.
 */
export async function openSolanaChannels(params: {
  rpcUrl: string;
  programId: string;
  tokenMint: string;
  makerSolanaPubkey: string;
  openers: readonly ProvisionedOpener[];
}): Promise<string[]> {
  assertLoopback(params.rpcUrl);

  // Concurrent: each open is a distinct payer writing a distinct PDA, so they
  // do not contend, and a local validator confirms them in the same few slots.
  return Promise.all(
    params.openers.map(async (opener) => {
      const client = new OnChainChannelClient({
        // Unused on this path — `openChannel` dispatches on the chain prefix
        // and the Solana branch never touches the EVM signer. A throwaway key
        // keeps the constructor (which takes it non-optionally) satisfied
        // without implying an EVM identity that does not exist here.
        evmSigner: new EvmSigner(`0x${'11'.repeat(32)}`),
        chainRpcUrls: {},
      });
      client.setSolanaConfig({
        rpcUrl: params.rpcUrl,
        keypair: opener.seed,
        programId: params.programId,
        tokenMint: params.tokenMint,
        challengeDuration: CHANNEL_CHALLENGE_DURATION,
      });

      const result = await client.openChannel({
        peerId: 'peer1',
        chain: SOLANA_CHAIN,
        token: params.tokenMint,
        peerAddress: params.makerSolanaPubkey,
        initialDeposit: CHANNEL_DEPOSIT,
        settlementTimeout: CHANNEL_CHALLENGE_DURATION,
      });
      return result.channelId;
    })
  );
}
