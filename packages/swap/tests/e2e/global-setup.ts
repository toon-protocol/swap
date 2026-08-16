/**
 * swap#104 — Vitest `globalSetup` for the Docker cross-chain E2E harness.
 *
 * Runs once, in its own process, before any `tests/e2e` suite file
 * is collected (`vitest.e2e.config.ts`'s `pool: 'forks'` +
 * `singleFork: true` keeps every suite file in one shared test process, so
 * the infra booted here stays reachable for the whole run). Boots the
 * self-contained EVM legs only:
 *
 *   1. Anvil chain A (31337), loaded with the vendored
 *      `rolling-e2e-anvil-state.hex` fixture (the same one
 *      `tests/integration/helpers/rolling-e2e-harness.ts` uses — one deployed
 *      TokenNetwork/Registry/USDC surface, reused here rather than
 *      redeployed).
 *   2. Anvil chain B (31338) — swap#153. Same blob, different chain id, so
 *      peer1 can advertise a pair with `from.chain !== to.chain` and the
 *      rolling suites cross a real chain boundary with no operator infra.
 *   3. A minimal in-process Nostr relay (`local-nostr-relay.ts`).
 *   4. Peer1 — a real `startSwapNode()` instance (`peer-node.ts`).
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
  TOKEN_NETWORK_ADDRESS,
  ROLLING_SWAP_CHANNEL_ADDRESS,
  MAKER_EVM_PRIVATE_KEY,
} from '../integration/helpers/rolling-e2e-harness.js';
import {
  startLocalRelay,
  type LocalRelay,
} from './helpers/local-nostr-relay.js';
import { startPeerNode, type PeerNodeHandle } from './helpers/peer-node.js';
import {
  ANVIL_PORT,
  ANVIL_CHAIN_ID,
  ANVIL_B_PORT,
  ANVIL_B_CHAIN_ID,
  RELAY_PORT,
  RELAY_URL,
  PEER1_BTP_PORT,
  PEER1_BLS_PORT,
  PEER1_MNEMONIC,
  PEER1_ILP_ADDRESS,
} from './helpers/topology.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  let anvil: AnvilInstance | null = null;
  let anvilB: AnvilInstance | null = null;
  let relay: LocalRelay | null = null;
  let peer1: PeerNodeHandle | null = null;

  if (isAnvilAvailable()) {
    try {
      anvil = await startAnvil({ port: ANVIL_PORT, chainId: ANVIL_CHAIN_ID });
      // Chain B (swap#153) — the same vendored blob at a different chain id,
      // so peer1 can advertise a pair that genuinely crosses a chain
      // boundary. Same trick `tests/integration/rolling-settlement.
      // integration.test.ts` uses; no new external dependency.
      anvilB = await startAnvil({
        port: ANVIL_B_PORT,
        chainId: ANVIL_B_CHAIN_ID,
      });
      relay = await startLocalRelay(RELAY_PORT);
      peer1 = await startPeerNode({
        mnemonic: PEER1_MNEMONIC,
        evmPrivateKey: MAKER_EVM_PRIVATE_KEY,
        btpServerPort: PEER1_BTP_PORT,
        blsPort: PEER1_BLS_PORT,
        relayUrls: [RELAY_URL],
        ilpAddress: PEER1_ILP_ADDRESS,
        evm: {
          chainId: ANVIL_CHAIN_ID,
          rpcUrl: `http://127.0.0.1:${ANVIL_PORT}`,
          registryAddress: TOKEN_NETWORK_REGISTRY_ADDRESS,
          tokenAddress: USDC_TOKEN_ADDRESS,
          // Leg A (client opens its channel here) vs leg B (claims verify
          // here) — two different deployed contracts, issue #133.
          tokenNetworkAddress: TOKEN_NETWORK_ADDRESS,
          channelAddress: ROLLING_SWAP_CHANNEL_ADDRESS,
        },
        evmB: {
          chainId: ANVIL_B_CHAIN_ID,
          rpcUrl: `http://127.0.0.1:${ANVIL_B_PORT}`,
          registryAddress: TOKEN_NETWORK_REGISTRY_ADDRESS,
          tokenAddress: USDC_TOKEN_ADDRESS,
          tokenNetworkAddress: TOKEN_NETWORK_ADDRESS,
          channelAddress: ROLLING_SWAP_CHANNEL_ADDRESS,
        },
      });

      // Wait for peer1's BLS `/health` to report boot-complete before
      // resolving — the test process's first `checkAllServicesReady()` call
      // should never race an in-flight boot. On timeout, fall through anyway:
      // `infra-gate.ts`'s probes are the authority on readiness and will
      // skip (or fail under CI) if peer1 never came up.
      const deadline = Date.now() + 15_000;
      while (peer1.instance.health().status !== 'ok' && Date.now() < deadline) {
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
      await anvilB?.stop().catch(() => undefined);
      peer1 = null;
      relay = null;
      anvil = null;
      anvilB = null;
    }
  }

  return async () => {
    await peer1?.stop().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
    await anvil?.stop().catch(() => undefined);
    await anvilB?.stop().catch(() => undefined);
  };
}
