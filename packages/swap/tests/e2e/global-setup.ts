/**
 * swap#104 — Vitest `globalSetup` for the Docker cross-chain E2E harness.
 *
 * Runs once, in its own process, before any `tests/e2e` suite file
 * is collected (`vitest.e2e.config.ts`'s `pool: 'forks'` +
 * `singleFork: true` keeps every suite file in one shared test process, so
 * the infra booted here stays reachable for the whole run). Boots the
 * self-contained EVM leg only:
 *
 *   1. Anvil, loaded with the vendored `rolling-e2e-anvil-state.hex` fixture
 *      (the same one `tests/integration/helpers/rolling-e2e-harness.ts`
 *      uses — one deployed TokenNetwork/Registry/USDC surface, reused here
 *      rather than redeployed).
 *   2. A minimal in-process Nostr relay (`local-nostr-relay.ts`).
 *   3. Peer1 — a real `startSwapNode()` instance (`peer-node.ts`).
 *
 * Solana and Mina are NOT started here — this repo vendors no
 * `solana-test-validator` / Mina lightnet binary or image (see
 * `tests/e2e/README.md`). Their suites gate on `waitForSolanaHealth()` /
 * `waitForMinaHealth()` and skip gracefully when those chains are absent.
 *
 * Must never throw: a missing `anvil` binary (e.g. outside `devbox run`) is
 * an expected, common condition, not a hard failure — `infra-gate.ts`'s
 * readiness probes detect the resulting silence and the suites skip with an
 * actionable message (AC-2). Swallow every startup error and simply leave
 * the corresponding service unavailable.
 */

import {
  isAnvilAvailable,
  startAnvil,
  type AnvilInstance,
  USDC_TOKEN_ADDRESS,
  TOKEN_NETWORK_REGISTRY_ADDRESS,
  ROLLING_SWAP_CHANNEL_ADDRESS,
  MAKER_EVM_PRIVATE_KEY,
} from '../integration/helpers/rolling-e2e-harness.js';
import { startLocalRelay, type LocalRelay } from './helpers/local-nostr-relay.js';
import { startPeerNode, type PeerNodeHandle } from './helpers/peer-node.js';
import {
  ANVIL_PORT,
  ANVIL_CHAIN_ID,
  RELAY_PORT,
  RELAY_URL,
  PEER1_BTP_PORT,
  PEER1_BLS_PORT,
  PEER1_MNEMONIC,
} from './helpers/topology.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  let anvil: AnvilInstance | null = null;
  let relay: LocalRelay | null = null;
  let peer1: PeerNodeHandle | null = null;

  if (isAnvilAvailable()) {
    try {
      anvil = await startAnvil({ port: ANVIL_PORT, chainId: ANVIL_CHAIN_ID });
      relay = await startLocalRelay(RELAY_PORT);
      peer1 = await startPeerNode({
        mnemonic: PEER1_MNEMONIC,
        evmPrivateKey: MAKER_EVM_PRIVATE_KEY,
        btpServerPort: PEER1_BTP_PORT,
        blsPort: PEER1_BLS_PORT,
        relayUrls: [RELAY_URL],
        ilpAddress: 'g.toon.peer1',
        evm: {
          chainId: ANVIL_CHAIN_ID,
          rpcUrl: `http://127.0.0.1:${ANVIL_PORT}`,
          registryAddress: TOKEN_NETWORK_REGISTRY_ADDRESS,
          tokenAddress: USDC_TOKEN_ADDRESS,
          channelAddress: ROLLING_SWAP_CHANNEL_ADDRESS,
        },
      });

      // Wait for peer1's BLS `/health` to report boot-complete before
      // resolving — the test process's first `checkAllServicesReady()` call
      // should never race an in-flight boot.
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (peer1.instance.health().status === 'ok') break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      console.warn(
        '[swap e2e] self-contained EVM infra failed to start — suites will skip:',
        err instanceof Error ? err.message : err
      );
      await peer1?.stop().catch(() => undefined);
      await relay?.stop().catch(() => undefined);
      await anvil?.stop().catch(() => undefined);
      peer1 = null;
      relay = null;
      anvil = null;
    }
  }

  return async () => {
    await peer1?.stop().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
    await anvil?.stop().catch(() => undefined);
  };
}
