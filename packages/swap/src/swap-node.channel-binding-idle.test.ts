/**
 * Boot-time config validation for `SwapNodeConfig.channelBindingIdleMs`
 * (issue #113 — opt-in idle-timeout for reclaiming a sender's sticky
 * channel binding). The reclaim policy itself is covered at the
 * `SwapChannelState` level (channel-state.test.ts) and through
 * `MultiChainClaimIssuer` (claim-issuer.test.ts); this file only pins the
 * boot-refusal contract for a malformed value, matching the sibling
 * `config.rolling.*` knobs' validation shape.
 */
import { describe, it, expect } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';

import { validateConfig } from './swap-node.js';
import type { SwapNodeConfig } from './swap-node.js';

const PAIR_EVM: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:31337' },
  to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:31337' },
  rate: '0.0004',
};

function baseConfig(): SwapNodeConfig {
  return {
    mnemonic: 'test test test test test test test test test test test junk',
    swapPairs: [PAIR_EVM],
    chains: ['evm'],
    channels: {
      'evm:31337': [
        {
          channelId: '0x' + '01'.repeat(32),
          cumulativeAmount: 0n,
          nonce: 0n,
          updatedAt: 0,
        },
      ],
    },
    inventory: { 'evm:31337': 10n ** 18n },
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:31337',
        rpcUrl: 'http://127.0.0.1:1',
        registryAddress: '0x' + '11'.repeat(20),
        tokenAddress: '0x' + '22'.repeat(20),
        channelAddress: '0x' + '33'.repeat(20),
      },
    ],
    relayUrls: ['ws://localhost:0'],
  } as unknown as SwapNodeConfig;
}

describe('SwapNodeConfig.channelBindingIdleMs validation (issue #113)', () => {
  it('[P1] accepts a well-formed positive value', () => {
    expect(() =>
      validateConfig({ ...baseConfig(), channelBindingIdleMs: 60_000 })
    ).not.toThrow();
  });

  it('[P1] accepts being unset (opt-in, default disabled)', () => {
    expect(() => validateConfig(baseConfig())).not.toThrow();
  });

  it.each([[0], [-1], [Number.NaN], [Infinity]])(
    '[P1] rejects a non-positive-finite value (%j) with INVALID_CONFIG',
    (bad) => {
      expect(() =>
        validateConfig({ ...baseConfig(), channelBindingIdleMs: bad })
      ).toThrow(/channelBindingIdleMs/);
    }
  );
});
