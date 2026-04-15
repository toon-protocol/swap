/**
 * Story 12.10 — Docker infra gate for Mill E2E tests.
 *
 * Re-exports the SDK's `docker-e2e-setup.ts` helpers so Mill E2E tests
 * have a single import target (Task 1.3). We use a relative path into the
 * SDK's `tests/e2e/helpers/` directory because the helpers are TEST-ONLY
 * code (not part of the SDK's public surface) and there is no reason to
 * publish a new `@toon-protocol/*` package just for them (guardrail 9.4).
 *
 * ## Anvil account allocation (Task 1.4)
 *
 * The SDK E2E suite claims Anvil accounts **#3–#10** (see
 * `packages/sdk/tests/e2e/helpers/docker-e2e-setup.ts` TEST_PRIVATE_KEY
 * and friends). Mill E2E must pick disjoint accounts to avoid nonce
 * contention if both suites ever run in parallel on shared infra.
 *
 * Mill E2E uses:
 * - Anvil account **#1** — `MILL_E2E_EVM_SENDER_PRIVATE_KEY` (EVM-flow tests).
 * - Anvil account **#2** — `MILL_E2E_EVM_SENDER_PRIVATE_KEY_ALT` (pair-matrix
 *   alternate sender where a second EVM signer is needed).
 *
 * Account #0 is Anvil's deployer and holds the full Mock USDC supply; do NOT
 * reuse it from tests. Accounts #3–#10 are SDK-claimed. If the Mill E2E
 * suite ever needs >2 concurrent EVM signers, switch to a one-time
 * `cast send` top-up of a fresh mnemonic-derived key at the top of the
 * suite rather than grabbing #11+ (the Anvil default fund is 10 accounts).
 */

export {
  // Endpoints
  ANVIL_RPC,
  PEER1_RELAY_URL,
  PEER1_BTP_URL,
  PEER1_BLS_URL,
  PEER1_EVM_ADDRESS,
  PEER2_RELAY_URL,
  PEER2_BLS_URL,
  SOLANA_RPC,
  SOLANA_WS,
  SOLANA_PROGRAM_ID,
  MINA_GRAPHQL,
  MINA_ACCOUNTS_MANAGER,
  MINA_ZKAPP_ADDRESS,

  // Contracts
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  REGISTRY_ADDRESS,
  CHAIN_ID,

  // Chain def + ABIs
  anvilChain,
  TOKEN_NETWORK_ABI,
  ERC20_ABI,
  BALANCE_PROOF_TYPES,

  // Client helpers
  createViemClient,
  getChannelState,
  getParticipantInfo,
  getTokenBalance,
  getChannelCounter,

  // Wait / probe helpers
  waitForEventOnRelay,
  waitForServiceHealth,
  waitForRelayReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  waitForMinaHealth,
  acquireMinaAccount,
  releaseMinaAccount,

  // Infra gate
  checkAllServicesReady,
  skipIfNotReady,
} from '../../../../sdk/tests/e2e/helpers/docker-e2e-setup.js';

// ---------------------------------------------------------------------------
// Mill-E2E-specific Anvil keys (disjoint from SDK E2E accounts #3–#10)
// ---------------------------------------------------------------------------

/** Anvil account #1 — EVM swap-flow sender for Mill E2E tests. */
export const MILL_E2E_EVM_SENDER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

/** Anvil account #1 address (derived, hardcoded for cheap lookup). */
export const MILL_E2E_EVM_SENDER_ADDRESS =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

/** Anvil account #2 — alternate EVM sender for pair-matrix scenarios. */
export const MILL_E2E_EVM_SENDER_PRIVATE_KEY_ALT =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

/** Anvil account #2 address. */
export const MILL_E2E_EVM_SENDER_ADDRESS_ALT =
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;

// ---------------------------------------------------------------------------
// Chain-string constants (must match docker-compose-sdk-e2e.yml env vars)
// ---------------------------------------------------------------------------

/** Exact chain strings advertised in `SUPPORTED_CHAINS` on peer1/peer2. */
export const DOCKER_CHAIN_EVM = 'evm:base:31337' as const;
export const DOCKER_CHAIN_SOLANA = 'solana:devnet' as const;
export const DOCKER_CHAIN_MINA = 'mina:devnet' as const;

export const DOCKER_CHAINS = [
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_SOLANA,
  DOCKER_CHAIN_MINA,
] as const;

export type DockerChain = (typeof DOCKER_CHAINS)[number];

/** All 9 ordered (source, target) pairs. AC-9 coverage target. */
export const DOCKER_PAIR_MATRIX: readonly {
  from: DockerChain;
  to: DockerChain;
}[] = Object.freeze(
  DOCKER_CHAINS.flatMap((from) =>
    DOCKER_CHAINS.map((to) => ({ from, to }))
  )
);
