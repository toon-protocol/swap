/**
 * swap#104 — self-contained "peer1" boot for the E2E harness.
 *
 * Boots a REAL `startSwapNode()` instance (this package's own product) as a
 * standalone embedded-connector peer, listening for inbound BTP sessions on
 * `btpServerPort` — exactly the role `docker-compose-sdk-e2e.yml`'s `peer1`
 * service played before the monorepo extraction dropped it (swap#51). No
 * Docker required: identity, chain wiring and relay publishing are all
 * in-process, callable from `global-setup.ts`.
 *
 * Only EVM legs are wired to live chain infra (the vendored Anvil fixture
 * from `tests/integration/helpers/rolling-e2e-harness.ts`). Solana and Mina
 * swap pairs are NOT advertised by this boot helper — those chains need
 * real external infra (`solana-test-validator`, Mina lightnet) this repo
 * does not vendor; see `tests/e2e/README.md`. The suites correctly gate on
 * `waitForSolanaHealth()` / `waitForMinaHealth()` before touching those
 * chains, so their absence here is a graceful skip, not a failure.
 *
 * swap#153: `evmB` adds a SECOND EVM chain, so peer1 advertises a pair whose
 * `from.chain !== to.chain` and the rolling suites can cross a real chain
 * boundary in CI without any infra this repo does not already vendor. See
 * `topology.ts`'s `ANVIL_B_CHAIN_ID` for why that mattered.
 */

import { startSwapNode } from '../../../src/swap-node.js';
import type {
  SwapNodeConfig,
  SwapNodeInstance,
} from '../../../src/swap-node.js';
import { EVM_CHAIN_PREFIX } from './topology.js';

export interface PeerNodeHandle {
  instance: SwapNodeInstance;
  pubkey: string;
  stop: () => Promise<void>;
}

/** One deployed EVM surface peer1 can price and settle against. */
export interface PeerNodeEvmChain {
  chainId: number;
  rpcUrl: string;
  registryAddress: string;
  tokenAddress: string;
  /**
   * Leg A — deployed `TokenNetwork` address, the contract a client opens its
   * payment channel against and the value the kind:10032 `tokenNetworks`
   * entry carries (issue #133).
   */
  tokenNetworkAddress: string;
  /**
   * Leg B — deployed `RollingSwapChannel` address, the EIP-712
   * `verifyingContract` `startSwapNode()` binds into its v2 balance-proof
   * signer (issue #101). `validateConfig()` refuses to boot a pair targeting
   * this chain without it (PR #106 review finding #2).
   */
  channelAddress: string;
}

/**
 * One deployed Solana surface peer1 can price and settle against (swap#160).
 *
 * Only leg B. The maker DELIVERS on Solana here — it signs a real ed25519
 * balance proof (`src/payment-channel-signer.ts`'s
 * `SolanaPaymentChannelSigner`) against a real channel PDA, and reads that
 * PDA's on-chain `transferred_amount` back through
 * `src/solana-channel-reader.ts` (swap#141) for its rebind precondition and
 * inventory recycling.
 *
 * The reverse — leg A genuinely PAID on Solana, i.e. a `solana:* → evm:*`
 * pair — is not wireable from here; see `S-4` in
 * `docker-rolling-swap-solana-e2e.test.ts` for the three reasons and the
 * follow-up tickets. That is why there is no `solana` equivalent of
 * `evmB`'s "and leg A can start here" story.
 */
export interface PeerNodeSolanaChain {
  /** Chain key — must equal the `pair.to.chain` string (`solana:devnet`). */
  chainId: string;
  rpcUrl: string;
  /** Deployed payment-channel program id (base58). */
  programId: string;
  /** Mock USDC SPL mint (base58) — surfaces as the announce's preferred token. */
  tokenMint: string;
  /**
   * REAL channel PDAs, opened on the validator by
   * `solana-validator.ts`'s `openSolanaChannels()`.
   *
   * A Solana `channelId` IS its channel PDA (no derivation), so unlike the
   * EVM legs — which seed synthetic ids because the leg-B contract does not
   * need a channel to exist before a claim is signed against it — these have
   * to be accounts that really exist and really name this maker as a
   * participant. Anything else and the chain-truth reader throws (it fails
   * closed on a missing or wrongly-owned account, by design).
   */
  channelIds: readonly string[];
}

export interface StartPeerNodeOptions {
  /**
   * BIP-39 mnemonic — the Nostr/EVM identity `startSwapNode()` derives via
   * `fromMnemonic()`. `startSwapNode()` REQUIRES a mnemonic (it throws
   * `SWAP_REQUIRES_MNEMONIC` for a bare `secretKey`), so this is the only
   * identity input this harness accepts.
   */
  mnemonic: string;
  /** EVM settlement private key (0x-hex, 32 bytes). */
  evmPrivateKey: string;
  btpServerPort: number;
  blsPort: number;
  relayUrls: readonly string[];
  ilpAddress: string;
  /** EVM chain-provider wiring. Omit to boot without any live chain (identity/relay only). */
  evm?: PeerNodeEvmChain;
  /**
   * A second EVM chain (swap#153). When present, peer1 additionally advertises
   * the CROSS-chain pair `evm → evmB` and can issue leg-B claims on it.
   * Ignored without `evm` — leg A has to land somewhere.
   */
  evmB?: PeerNodeEvmChain;
  /**
   * A real Solana chain (swap#160). When present, peer1 additionally advertises
   * the CROSS-chain pair `evm → solana` and issues real ed25519 leg-B balance
   * proofs on it. Ignored without `evm` — leg A is paid on the EVM chain (see
   * {@link PeerNodeSolanaChain} for why leg A cannot be the Solana side).
   */
  solana?: PeerNodeSolanaChain;
  loggerName?: string;
}

/**
 * Synthetic channelIds seeding `channels[chain]`. `SwapChannelState.
 * resolveChannel()` binds each DISTINCT sender pubkey to its own unbound
 * seed entry, sticky for the life of the process — it never rebinds or
 * frees one, so it needs at least as many entries as there are distinct
 * senders that will target this chain in one `vitest.e2e.config.ts` run
 * (`isolate: false` + `singleFork` share one peer1 across every suite
 * file). Today that's 2 (the EVM suite's own sender + the pair-matrix
 * suite's shared sender); sized to 8 for headroom against future suites.
 */
const SEED_CHANNEL_COUNT = 24;
function seedChannelId(chainOrdinal: number, i: number): string {
  return (
    '0x' +
    'e2'.repeat(30) +
    chainOrdinal.toString(16).padStart(2, '0') +
    i.toString(16).padStart(2, '0')
  );
}

function seedChannels(chainOrdinal: number): {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  updatedAt: number;
}[] {
  return Array.from({ length: SEED_CHANNEL_COUNT }, (_, i) => ({
    channelId: seedChannelId(chainOrdinal, i),
    cumulativeAmount: 0n,
    nonce: 0n,
    updatedAt: 0,
  }));
}

export async function startPeerNode(
  opts: StartPeerNodeOptions
): Promise<PeerNodeHandle> {
  const evm = opts.evm;
  const evmB = evm ? opts.evmB : undefined;
  const solana = evm ? opts.solana : undefined;
  const chain = evm ? `${EVM_CHAIN_PREFIX}${evm.chainId}` : undefined;
  const chainB = evmB ? `${EVM_CHAIN_PREFIX}${evmB.chainId}` : undefined;
  const chainSol = solana?.chainId;

  const asset = { assetCode: 'USD', assetScale: 6 } as const;

  const config: SwapNodeConfig = {
    mnemonic: opts.mnemonic,
    swapPairs: chain
      ? [
          // Same-chain pair — what peer1 has always advertised, and what the
          // legacy suites still drive. Also the shape the live devnet maker
          // advertises today (a USDC-at-parity placeholder).
          {
            from: { ...asset, chain },
            to: { ...asset, chain },
            rate: '1',
          },
          // Cross-chain pair (swap#153) — a real chain boundary: leg A on
          // `chain`, leg-B claim signed for `chainB`'s own EIP-712 domain.
          ...(chainB
            ? [
                {
                  from: { ...asset, chain },
                  to: { ...asset, chain: chainB },
                  rate: '1',
                },
              ]
            : []),
          // Cross-chain pair across a chain FAMILY boundary (swap#160) — leg A
          // on the EVM anvil, leg-B claim an ed25519 balance proof over the
          // Solana channel PDA. `evm → evmB` proves two chain ids can differ;
          // this proves two chain KINDS can, which is a different signer, a
          // different claim envelope, a different recipient encoding and a
          // different on-chain reader.
          ...(chainSol
            ? [
                {
                  from: { ...asset, chain },
                  to: { ...asset, chain: chainSol },
                  rate: '1',
                },
              ]
            : []),
        ]
      : [],
    // Selects which HD keys get derived (`wallet.ts`). 'solana' is what makes
    // `swapNodeKeys.solana` exist, and without it `startSwapNode` refuses to
    // boot a pair targeting a solana chain (MISSING_KEY) and builds no Solana
    // chain-truth reader at all.
    chains: evm ? (chainSol ? ['evm', 'solana'] : ['evm']) : [],
    channels: chain
      ? {
          [chain]: seedChannels(0),
          ...(chainB ? { [chainB]: seedChannels(1) } : {}),
          // REAL PDAs, not `seedChannels()` output — see
          // `PeerNodeSolanaChain.channelIds`.
          ...(chainSol && solana
            ? {
                [chainSol]: solana.channelIds.map((channelId) => ({
                  channelId,
                  cumulativeAmount: 0n,
                  nonce: 0n,
                  updatedAt: 0,
                })),
              }
            : {}),
        }
      : {},
    inventory: chain
      ? {
          [chain]: 100_000_000_000n,
          ...(chainB ? { [chainB]: 100_000_000_000n } : {}),
          ...(chainSol ? { [chainSol]: 100_000_000_000n } : {}),
        }
      : {},
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: console.warn,
      error: console.error,
    },
    relayUrls: opts.relayUrls,
    blsPort: opts.blsPort,
    btpServerPort: opts.btpServerPort,
    ilpAddress: opts.ilpAddress,
    btpEndpoint: `ws://127.0.0.1:${opts.btpServerPort}`,
    advertisedAsset: { assetCode: 'USD', assetScale: 6 },
    settlementPrivateKey: opts.evmPrivateKey,
    chainProviders:
      evm && chain
        ? [
            {
              chainType: 'evm' as const,
              chainId: chain,
              rpcUrl: evm.rpcUrl,
              registryAddress: evm.registryAddress,
              tokenAddress: evm.tokenAddress,
              tokenNetworkAddress: evm.tokenNetworkAddress,
              channelAddress: evm.channelAddress,
              keyId: opts.evmPrivateKey,
            },
            ...(evmB && chainB
              ? [
                  {
                    chainType: 'evm' as const,
                    chainId: chainB,
                    rpcUrl: evmB.rpcUrl,
                    registryAddress: evmB.registryAddress,
                    tokenAddress: evmB.tokenAddress,
                    tokenNetworkAddress: evmB.tokenNetworkAddress,
                    channelAddress: evmB.channelAddress,
                    keyId: opts.evmPrivateKey,
                  },
                ]
              : []),
            // Solana (swap#160). Only `chainId`/`rpcUrl`/`programId` are
            // required for this family (`swap-node.ts`'s
            // SWAP_REQUIRED_PROVIDER_FIELDS) — there is no `channelAddress`
            // analogue, because the Solana balance-proof hash carries no
            // domain separator. `tokenMint` is optional and feeds the
            // announce's `preferredTokens` for this chain.
            //
            // `keyId` is deliberately LEFT UNSET. `startSwapNode` defaults
            // every chainProviders entry's keyId to the 0x-hex EVM settlement
            // key regardless of chainType (swap-node.ts:1710-1722), and the
            // connector's `resolveSolanaSigner` base58-decodes it — which
            // throws on '0'. So the embedded connector's Solana provider
            // registration fails and is swallowed as a
            // `chain_provider_registration_failed` warn, whatever we pass.
            // That is harmless for leg B, which is all this pair needs: the
            // maker signs its Solana claims with its OWN mnemonic-derived key
            // (`SolanaPaymentChannelSigner`) and reads chain truth over raw
            // JSON-RPC, neither of which goes through the connector's
            // provider registry. It is also precisely what stops leg A from
            // being payable on Solana — see `S-4` in
            // `docker-rolling-swap-solana-e2e.test.ts`.
            ...(solana && chainSol
              ? [
                  {
                    chainType: 'solana' as const,
                    chainId: chainSol,
                    rpcUrl: solana.rpcUrl,
                    programId: solana.programId,
                    tokenMint: solana.tokenMint,
                  },
                ]
              : []),
          ]
        : [],
  };

  const instance = await startSwapNode(config);

  return {
    instance,
    pubkey: instance.identity.pubkey,
    stop: () => instance.stop(),
  };
}
