/**
 * Boot the maker's Rust connector (toon-protocol/connector) for the E2E
 * harness — the client edge the taker pays leg A into.
 *
 * The maker is an APP behind one of this connector's `[[routes]]`
 * terminations: the taker POSTs a sealed ILP PREPARE carrying a
 * payment-channel claim to `POST /ilp`, the connector verifies the claim
 * against the chain named in `[settlement.*]`, delivers HTTP to
 * `handler_url` with `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain`, and seals
 * the app's response back into the FULFILL (`docs/protocol/client-edge-spec.md`
 * §1.1, §1.3, §1.8 in that repo).
 *
 * This module writes the connector's ONE typed config file plus its key files
 * into a temp dir (every key is a path — connector ADR 0009/0012), spawns
 * either the locally built binary or the published image, and returns once
 * `GET /ilp/identity` answers. Everything the process prints is captured to a
 * log file and returned on a failed boot, because "the connector refused to
 * start" is a config problem the caller needs to read, not guess at
 * (a present-but-unsatisfiable `[settlement.*]` block is a hard startup
 * failure by design — connector configuration-spec CF-25).
 *
 * ## Config shape (connector `docs/protocol/configuration-spec.md` §2)
 *
 * - `[signer] key_file` — 32-byte secp256k1 secret, 64 hex chars on one line.
 * - `[settlement.evm]` — `contract_address` is the **TokenNetworkRegistry**
 *   (the connector resolves `getTokenNetwork(token_address)` at boot), never a
 *   TokenNetwork; `decimals` must equal the token's own `decimals()`.
 * - `[settlement.solana]` — the deployed `payment-channel` `program_id`, the
 *   SPL mint, and a 32-byte ed25519 SEED as the key file. The account needs
 *   SOL before boot: `connect` creates the node's own ATA.
 * - `[[routes]]` — `prefix` + `handler_url` + `price` (`0` = free). A trailing
 *   slash on `handler_url` is load-bearing: the envelope `target` is resolved
 *   beneath the handler's path (ADR 0025).
 * - `state_dir` — required as soon as any claim is chain-resolved rather than
 *   declared (watermarks must outlive the process, spec §1.3).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a plain `cargo build -p connector` in the sibling checkout lands. */
export const DEFAULT_CONNECTOR_BIN =
  '/home/jonathan/Documents/connector/target/debug/connector';

/** The uid the published image runs as (`deploy/connector-rust/Dockerfile`). */
const IMAGE_UID = 10001;

export interface RustConnectorRoute {
  prefix: string;
  handlerUrl: string;
  /** Flat price in the settlement asset's base units; `0` = free. */
  price: number | bigint;
}

export interface RustConnectorEvmSettlement {
  rpcUrl: string;
  /** The `TokenNetworkRegistry` — NOT a `TokenNetwork`. */
  registryAddress: string;
  tokenAddress: string;
  /** 32-byte secp256k1 private key, hex (with or without `0x`). Needs ETH. */
  settlementKeyHex: string;
  /** Must match the token's `decimals()`; default 6 (mock USDC). */
  decimals?: number;
}

export interface RustConnectorSolanaSettlement {
  rpcUrl: string;
  programId: string;
  tokenMint: string;
  /** 32-byte ed25519 seed, hex. Needs SOL before boot. */
  settlementSeedHex: string;
  decimals?: number;
}

export interface StartRustConnectorOptions {
  clientEdgePort: number;
  /** Writable directory for the claim journals. Created if missing. */
  stateDir: string;
  /** 32-byte secp256k1 identity key, hex — what `GET /ilp/identity` reports. */
  signerKeyHex: string;
  evm?: RustConnectorEvmSettlement;
  solana?: RustConnectorSolanaSettlement;
  routes: readonly RustConnectorRoute[];
  /**
   * Extra TOML appended verbatim to the generated file — for `[[client_channels]]`
   * or the local knobs (`channel_liveness_ttl_secs`, …) a test wants to pin.
   */
  extraToml?: string;
  /** Override `SWAP_E2E_CONNECTOR_BIN`. */
  binary?: string;
  /** Override `SWAP_E2E_CONNECTOR_IMAGE` (e.g. `ghcr.io/toon-protocol/connector:rust-sha-5c1b222`). */
  image?: string;
  /** `RUST_LOG` for the process; default `info`. */
  rustLog?: string;
  /** Boot deadline; default 60s (a cold docker pull is not included). */
  bootTimeoutMs?: number;
}

export interface ConnectorIdentity {
  keyId: string;
  /** `0x04…` uncompressed secp256k1 — what a sender seals to (§1.7). */
  publicKey: string;
}

export interface RustConnectorInstance {
  /** `http://127.0.0.1:<port>` — the client edge origin. */
  url: string;
  identity: ConnectorIdentity;
  /** `GET /ilp` — the node self-description (connector ADR 0050). */
  describe: () => Promise<unknown>;
  /** Path of the captured stdout+stderr. */
  logPath: string;
  /** The generated config file, for a reader debugging a refusal. */
  configPath: string;
  /** Last N KiB of the log — what to print when a test fails. */
  logTail: (bytes?: number) => string;
  stop: () => Promise<void>;
}

function stripHex(hex: string, expectedBytes: number, what: string): string {
  const bare = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(bare) || bare.length !== expectedBytes * 2) {
    throw new Error(
      `${what} must be ${expectedBytes} bytes of hex (${expectedBytes * 2} chars), got ${bare.length} chars`
    );
  }
  return bare.toLowerCase();
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Resolve how the connector will be run: a local binary, or the published
 * image. `SWAP_E2E_CONNECTOR_IMAGE` wins over the binary when set, so CI can
 * pin an image without editing a test.
 */
function resolveLauncher(opts: StartRustConnectorOptions): {
  kind: 'binary' | 'docker';
  ref: string;
} {
  const image = opts.image ?? process.env['SWAP_E2E_CONNECTOR_IMAGE'];
  if (image) return { kind: 'docker', ref: image };
  const bin =
    opts.binary ?? process.env['SWAP_E2E_CONNECTOR_BIN'] ?? DEFAULT_CONNECTOR_BIN;
  if (!existsSync(bin)) {
    throw new Error(
      `no connector binary at ${bin} — set SWAP_E2E_CONNECTOR_BIN to a built ` +
        `toon-protocol/connector binary (\`cargo build -p connector\`), or ` +
        `SWAP_E2E_CONNECTOR_IMAGE to a published image`
    );
  }
  return { kind: 'binary', ref: bin };
}

/**
 * Write config + keys into `dir` and return the config path. `pathFor` maps a
 * file we wrote to the path the CONNECTOR will see it at — identical for a
 * local binary, `/app/data/<name>` inside the image.
 */
function writeConfig(
  dir: string,
  opts: StartRustConnectorOptions,
  pathFor: (name: string) => string,
  stateDirForConnector: string
): string {
  const files: Record<string, string> = {
    'signer.key': stripHex(opts.signerKeyHex, 32, '[signer] key'),
  };
  const lines: string[] = [
    `# Generated by tests/e2e/helpers/rust-connector.ts — never committed.`,
    `client_edge_addr = "127.0.0.1:${opts.clientEdgePort}"`,
    `state_dir = ${tomlString(stateDirForConnector)}`,
    ``,
    `[signer]`,
    `key_file = ${tomlString(pathFor('signer.key'))}`,
    ``,
  ];

  for (const route of opts.routes) {
    lines.push(
      `[[routes]]`,
      `prefix = ${tomlString(route.prefix)}`,
      `handler_url = ${tomlString(route.handlerUrl)}`,
      `price = ${route.price.toString()}`,
      ``
    );
  }

  if (opts.evm) {
    files['settlement-evm.key'] = stripHex(
      opts.evm.settlementKeyHex,
      32,
      '[settlement.evm.key]'
    );
    lines.push(
      `[settlement.evm]`,
      `rpc_url = ${tomlString(opts.evm.rpcUrl)}`,
      `contract_address = ${tomlString(opts.evm.registryAddress)}`,
      `token_address = ${tomlString(opts.evm.tokenAddress)}`,
      `decimals = ${opts.evm.decimals ?? 6}`,
      ``,
      `[settlement.evm.key]`,
      `key_file = ${tomlString(pathFor('settlement-evm.key'))}`,
      ``
    );
  }

  if (opts.solana) {
    files['settlement-solana.key'] = stripHex(
      opts.solana.settlementSeedHex,
      32,
      '[settlement.solana.key]'
    );
    lines.push(
      `[settlement.solana]`,
      `rpc_url = ${tomlString(opts.solana.rpcUrl)}`,
      `program_id = ${tomlString(opts.solana.programId)}`,
      `token_address = ${tomlString(opts.solana.tokenMint)}`,
      `decimals = ${opts.solana.decimals ?? 6}`,
      ``,
      `[settlement.solana.key]`,
      `key_file = ${tomlString(pathFor('settlement-solana.key'))}`,
      ``
    );
  }

  if (opts.extraToml) lines.push(opts.extraToml, '');

  for (const [name, hex] of Object.entries(files)) {
    // One line of hex, the shape `local/keys.sh` writes (`openssl rand -hex 32`).
    // World-readable on purpose: the image runs as uid 10001 and mounts this
    // directory read-only; these are throwaway local-chain keys.
    writeFileSync(join(dir, name), `${hex}\n`, { mode: 0o644 });
  }
  const configPath = join(dir, 'connector.toml');
  writeFileSync(configPath, lines.join('\n'), { mode: 0o644 });
  return configPath;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function startRustConnector(
  opts: StartRustConnectorOptions
): Promise<RustConnectorInstance> {
  const launcher = resolveLauncher(opts);
  const workDir = mkdtempSync(join(tmpdir(), 'swap-e2e-connector-'));
  mkdirSync(opts.stateDir, { recursive: true });

  const docker = launcher.kind === 'docker';
  const pathFor = (name: string) =>
    docker ? `/app/data/${name}` : join(workDir, name);
  const configPath = writeConfig(
    workDir,
    opts,
    pathFor,
    docker ? '/app/state' : opts.stateDir
  );
  if (docker) {
    // uid 10001 inside the container must be able to read the keys and write
    // the journals. The keys dir is mounted read-only; the state dir is not.
    chmodSync(workDir, 0o755);
    chmodSync(opts.stateDir, 0o777);
    if (process.getuid && process.getuid() !== IMAGE_UID) {
      spawnSync('chown', ['-R', `${IMAGE_UID}:${IMAGE_UID}`, opts.stateDir], {
        stdio: 'ignore',
      });
    }
  }

  const logPath = join(workDir, 'connector.log');
  const log: WriteStream = createWriteStream(logPath, { flags: 'a' });
  const url = `http://127.0.0.1:${opts.clientEdgePort}`;

  // Fail fast on a port something else already answers on. Otherwise the
  // readiness probe below "succeeds" against a stale connector (a leftover
  // `docker run` from an aborted run, say) and every packet goes to a node
  // with somebody else's routes — which is exactly how this was found.
  try {
    const stale = await fetch(`${url}/ilp/identity`, { signal: AbortSignal.timeout(1500) });
    throw new Error(
      `port ${opts.clientEdgePort} already serves a connector (GET /ilp/identity → ${stale.status}); ` +
        `stop it first (try: docker ps / ss -ltnp | grep ${opts.clientEdgePort})`
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('port ')) throw err;
    // connection refused / timeout = free, as it should be
  }

  const args = docker
    ? [
        'run',
        '--rm',
        '--network',
        'host',
        '-e',
        `RUST_LOG=${opts.rustLog ?? 'info'}`,
        '-v',
        `${workDir}:/app/data:ro`,
        '-v',
        `${opts.stateDir}:/app/state`,
        launcher.ref,
        '/app/data/connector.toml',
      ]
    : [configPath];
  const child: ChildProcess = spawn(docker ? 'docker' : launcher.ref, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: opts.rustLog ?? 'info' },
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  const exit: { info: { code: number | null; signal: string | null } | null } = {
    info: null,
  };
  child.once('exit', (code, signal) => {
    exit.info = { code, signal };
  });

  const logTail = (bytes = 8192): string => {
    try {
      const all = readFileSync(logPath, 'utf8');
      return all.length > bytes ? all.slice(all.length - bytes) : all;
    } catch {
      return '';
    }
  };

  const stop = async (): Promise<void> => {
    if (exit.info === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && exit.info === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (exit.info === null) child.kill('SIGKILL');
    }
    log.end();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  const deadline = Date.now() + (opts.bootTimeoutMs ?? 60_000);
  let identity: ConnectorIdentity | null = null;
  for (;;) {
    if (exit.info !== null) {
      const tail = logTail();
      await stop();
      throw new Error(
        `connector exited during startup (code=${String(exit.info.code)} ` +
          `signal=${String(exit.info.signal)}). Config: ${configPath}\n--- log tail ---\n${tail}`
      );
    }
    identity = await fetchJson<ConnectorIdentity>(`${url}/ilp/identity`, 1000);
    if (identity && typeof identity.publicKey === 'string') break;
    if (Date.now() > deadline) {
      const tail = logTail();
      await stop();
      throw new Error(
        `connector on :${opts.clientEdgePort} did not answer GET /ilp/identity ` +
          `within ${opts.bootTimeoutMs ?? 60_000}ms\n--- log tail ---\n${tail}`
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    url,
    identity,
    describe: async () => {
      const res = await fetch(`${url}/ilp`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`GET /ilp → HTTP ${res.status}`);
      return res.json();
    },
    logPath,
    configPath,
    logTail,
    stop,
  };
}
