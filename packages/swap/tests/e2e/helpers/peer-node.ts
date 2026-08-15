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
 * Only the EVM leg is wired to live chain infra (the vendored Anvil fixture
 * from `tests/integration/helpers/rolling-e2e-harness.ts`). Solana and Mina
 * swap pairs are NOT advertised by this boot helper — those chains need
 * real external infra (`solana-test-validator`, Mina lightnet) this repo
 * does not vendor; see `tests/e2e/README.md`. The suites correctly gate on
 * `waitForSolanaHealth()` / `waitForMinaHealth()` before touching those
 * chains, so their absence here is a graceful skip, not a failure.
 */

import { startSwapNode } from '../../../src/swap-node.js';
import type { SwapNodeConfig, SwapNodeInstance } from '../../../src/swap-node.js';

export interface PeerNodeHandle {
  instance: SwapNodeInstance;
  pubkey: string;
  stop: () => Promise<void>;
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
  evm?: {
    chainId: number;
    rpcUrl: string;
    registryAddress: string;
    tokenAddress: string;
    /**
     * Deployed `RollingSwapChannel` address — the EIP-712 `verifyingContract`
     * `startSwapNode()` binds into its v2 balance-proof signer (issue #101).
     * `validateConfig()` refuses to boot a pair targeting this chain without
     * it (PR #106 review finding #2).
     */
    channelAddress: string;
  };
  loggerName?: string;
}

const DOCKER_CHAIN_EVM_PREFIX = 'evm:base:';

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
const SEED_CHANNEL_COUNT = 8;
function seedChannelId(i: number): string {
  return '0x' + 'e2'.repeat(31) + i.toString(16).padStart(2, '0');
}

export async function startPeerNode(
  opts: StartPeerNodeOptions
): Promise<PeerNodeHandle> {
  const evm = opts.evm;
  const chain = evm ? `${DOCKER_CHAIN_EVM_PREFIX}${evm.chainId}` : undefined;

  const config: SwapNodeConfig = {
    mnemonic: opts.mnemonic,
    swapPairs: chain
      ? [
          {
            from: { assetCode: 'USD', assetScale: 6, chain },
            to: { assetCode: 'USD', assetScale: 6, chain },
            rate: '1',
          },
        ]
      : [],
    chains: evm ? ['evm'] : [],
    channels: chain
      ? {
          [chain]: Array.from({ length: SEED_CHANNEL_COUNT }, (_, i) => ({
            channelId: seedChannelId(i),
            cumulativeAmount: 0n,
            nonce: 0n,
            updatedAt: 0,
          })),
        }
      : {},
    inventory: chain ? { [chain]: 100_000_000_000n } : {},
    logger: { debug: () => undefined, info: () => undefined, warn: console.warn, error: console.error },
    relayUrls: opts.relayUrls,
    blsPort: opts.blsPort,
    btpServerPort: opts.btpServerPort,
    ilpAddress: opts.ilpAddress,
    btpEndpoint: `ws://127.0.0.1:${opts.btpServerPort}`,
    advertisedAsset: { assetCode: 'USD', assetScale: 6 },
    settlementPrivateKey: opts.evmPrivateKey,
    chainProviders: evm && chain
      ? [
          {
            chainType: 'evm' as const,
            chainId: chain,
            rpcUrl: evm.rpcUrl,
            registryAddress: evm.registryAddress,
            tokenAddress: evm.tokenAddress,
            channelAddress: evm.channelAddress,
            keyId: opts.evmPrivateKey,
          },
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
