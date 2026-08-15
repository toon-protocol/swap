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
  /** Nostr identity secret key (32 bytes) — determines the advertised pubkey. */
  secretKey: Uint8Array;
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
  };
  loggerName?: string;
}

const DOCKER_CHAIN_EVM_PREFIX = 'evm:base:';

export async function startPeerNode(
  opts: StartPeerNodeOptions
): Promise<PeerNodeHandle> {
  const evm = opts.evm;
  const chain = evm ? `${DOCKER_CHAIN_EVM_PREFIX}${evm.chainId}` : undefined;

  const config: SwapNodeConfig = {
    secretKey: opts.secretKey,
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
    channels: {},
    inventory: chain ? { [`USD:${chain}`]: 100_000_000_000n } : {},
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
