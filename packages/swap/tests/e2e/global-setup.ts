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
 *   5. Solana (swap#160) — a real `solana-test-validator` with the vendored
 *      payment-channel program baked into genesis, a mock USDC SPL mint, and
 *      REAL channel PDAs peer1 is seeded with. Requires only
 *      `solana-test-validator` + `solana`/`spl-token` on PATH; when they are
 *      absent Solana stays down and its suites skip (loudly — and hard-fail
 *      under `SWAP_E2E_REQUIRE_SOLANA`, which the `solana-e2e` CI job sets).
 *      See `helpers/solana-validator.ts`.
 *
 * Mina is still NOT started — this repo vendors no lightnet, and unlike Solana
 * there is no single binary + 109 KB blob that would stand one up (see
 * `tests/e2e/README.md`). Its suites gate on `waitForMinaHealth()` and skip
 * gracefully.
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
  areSolanaCliToolsAvailable,
  deriveMakerSolanaPubkey,
  isSolanaValidatorAvailable,
  openSolanaChannels,
  provisionSplMint,
  startSolanaValidator,
  type SolanaValidatorInstance,
} from './helpers/solana-validator.js';
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
  SOLANA_CHAIN,
} from './helpers/topology.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  let anvil: AnvilInstance | null = null;
  let anvilB: AnvilInstance | null = null;
  let relay: LocalRelay | null = null;
  let peer1: PeerNodeHandle | null = null;
  let solanaValidator: SolanaValidatorInstance | null = null;
  let solanaChain: {
    chainId: string;
    rpcUrl: string;
    programId: string;
    tokenMint: string;
    channelIds: readonly string[];
  } | null = null;

  // Solana comes up BEFORE peer1: the maker's `channels['solana:devnet']` seeds
  // have to be real, already-existing channel PDAs, so they must be opened on
  // chain before `startSwapNode()` reads the config. Failure here is never
  // fatal — the whole block degrades to "no Solana", the EVM legs run
  // untouched, and `infra-gate.ts` decides whether that is a skip (local) or a
  // hard failure (`SWAP_E2E_REQUIRE_SOLANA`, set by the `solana-e2e` CI job).
  if (isSolanaValidatorAvailable() && areSolanaCliToolsAvailable()) {
    try {
      const startedAt = Date.now();
      solanaValidator = await startSolanaValidator();
      const { mint } = await provisionSplMint(solanaValidator.rpcUrl);
      const makerSolanaPubkey = await deriveMakerSolanaPubkey(PEER1_MNEMONIC);
      const channelIds = await openSolanaChannels({
        rpcUrl: solanaValidator.rpcUrl,
        programId: solanaValidator.programId,
        tokenMint: mint,
        makerSolanaPubkey,
      });
      solanaChain = {
        chainId: SOLANA_CHAIN,
        rpcUrl: solanaValidator.rpcUrl,
        programId: solanaValidator.programId,
        tokenMint: mint,
        channelIds,
      };
      console.log(
        `[swap e2e] Solana ready in ${Date.now() - startedAt}ms — ` +
          `${channelIds.length} real channel PDAs at ${solanaValidator.rpcUrl} ` +
          `(maker ${makerSolanaPubkey})`
      );
    } catch (err) {
      // Loud, and naming what failed: a silent Solana absence is the exact
      // defect this ticket exists to remove.
      console.warn(
        '[swap e2e] Solana infra failed to come up — Solana suites will skip ' +
          '(or fail under SWAP_E2E_REQUIRE_SOLANA):',
        err instanceof Error ? err.message : err
      );
      await solanaValidator?.stop().catch(() => undefined);
      solanaValidator = null;
      solanaChain = null;
    }
  } else {
    console.warn(
      '[swap e2e] `solana-test-validator` / `solana` / `spl-token` not on ' +
        'PATH — the Solana suites will skip. Install the Solana CLI ' +
        '(https://release.anza.xyz/v2.1.21/install) to run them; CI does this ' +
        'in the `solana-e2e` job. See tests/e2e/README.md.'
    );
  }

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
        ...(solanaChain ? { solana: solanaChain } : {}),
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

  // Teardown in reverse boot order, so nothing is still talking to a chain
  // that has already gone away. The validator goes LAST because peer1's
  // chain-truth reader polls it, and it also removes its temp ledger — leaving
  // one behind fills a runner's disk over repeated runs.
  return async () => {
    await peer1?.stop().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
    await anvil?.stop().catch(() => undefined);
    await anvilB?.stop().catch(() => undefined);
    await solanaValidator?.stop().catch(() => undefined);
  };
}
