/**
 * Issue #101 — the swap node signs the v2 EIP-712 balance-proof digest.
 *
 * Covers what `payment-channel-signer.test.ts`'s existing round-trip test
 * does not:
 *   - the canonical golden vector, pinned as fixed literals (byte-for-byte)
 *   - domain separation: a claim signed under one (chainId, verifyingContract)
 *     pair fails to recover as valid under another's
 *   - `parseEvmChainId` — both the two-segment (`evm:84532`) and
 *     three-segment (`evm:base:8453`) chain-key shapes
 *   - boot-time refusal when an EVM target chain has no configured
 *     RollingSwapChannel address
 */
import { describe, it, expect } from 'vitest';

import {
  balanceProofHashEvm,
  hexToBytes,
  recoverEvmClaimSigner,
} from '@toon-protocol/settlement-digest';

import { EvmPaymentChannelSigner } from './payment-channel-signer.js';
import { validateConfig, parseEvmChainId } from './swap-node.js';
import type { SwapNodeConfig, SwapNodeEvmChainProvider } from './swap-node.js';
import { SwapNodeStartError } from './errors.js';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Anvil deterministic dev key #0 — 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266.
const ANVIL_KEY_0 = hexToBytes(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);
const ANVIL_ADDR_0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

// The canonical vector every v2 signer/verifier in the ecosystem (client,
// sdk, connector, on-chain RollingSwapChannel) must reproduce byte for byte.
const GOLDEN = {
  chainId: 8453n,
  verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  channelId:
    '0x000000000000000000000000000000000000000000000000000000000000005b',
  cumulativeAmount: 24000000n,
  nonce: 24n,
  recipient: '0x00000000000000000000000000000000DEADBEEF',
  digest: '0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede',
  recovered: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

describe('issue #101 — v2 EIP-712 balance-proof digest: canonical golden vector', () => {
  // WARNING (matches the client's equivalent conformance test): if this test
  // ever fails, the fix belongs in the SIGNER, never in this test. Do NOT
  // "fix" a failure here by editing the expected digest/recovered values to
  // match whatever the code currently produces — that silently re-breaks
  // interoperability with every other v2 signer/verifier (client, sdk,
  // connector, on-chain RollingSwapChannel) that reproduces this SAME vector.
  it('[P0] the pinned inputs hash to the pinned digest, byte for byte', () => {
    const digest = balanceProofHashEvm(
      hexToBytes(GOLDEN.channelId),
      GOLDEN.cumulativeAmount,
      GOLDEN.nonce,
      hexToBytes(GOLDEN.recipient),
      GOLDEN.chainId,
      hexToBytes(GOLDEN.verifyingContract)
    );
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN.digest);
  });

  it('[P0] EvmPaymentChannelSigner.signBalanceProof, given the pinned inputs and anvil key #0, recovers the pinned signer', async () => {
    const signer = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey: ANVIL_KEY_0,
      chainId: GOLDEN.chainId,
      verifyingContract: GOLDEN.verifyingContract,
    });

    const sig = await signer.signBalanceProof({
      channelId: GOLDEN.channelId,
      cumulativeAmount: GOLDEN.cumulativeAmount,
      nonce: GOLDEN.nonce,
      recipient: GOLDEN.recipient,
    });

    const recovered = recoverEvmClaimSigner(
      {
        channelId: GOLDEN.channelId,
        cumulativeAmount: GOLDEN.cumulativeAmount,
        nonce: GOLDEN.nonce,
        recipient: GOLDEN.recipient,
        chainId: GOLDEN.chainId,
        verifyingContract: GOLDEN.verifyingContract,
      },
      sig
    );
    expect(recovered.toLowerCase()).toBe(GOLDEN.recovered.toLowerCase());
    expect(recovered.toLowerCase()).toBe(ANVIL_ADDR_0);
  });
});

describe('issue #101 — v2 EIP-712 domain separation (replay protection)', () => {
  it('[P0] a claim signed under one EVM chain domain fails to recover the signer under another chain domain', async () => {
    const privateKey = ANVIL_KEY_0;
    const params = {
      channelId: '0x' + 'ab'.repeat(32),
      cumulativeAmount: 500_000n,
      nonce: 3n,
      recipient: '0x' + '11'.repeat(20),
    };

    const signerChainA = new EvmPaymentChannelSigner({
      chain: 'evm:base:8453',
      privateKey,
      chainId: 8453n,
      verifyingContract: '0x' + 'aa'.repeat(20),
    });
    const signerChainB = new EvmPaymentChannelSigner({
      chain: 'evm:84532',
      privateKey,
      chainId: 84532n,
      verifyingContract: '0x' + 'bb'.repeat(20),
    });

    const sigA = await signerChainA.signBalanceProof(params);

    // Recovers correctly under chain A's own domain.
    const recoveredUnderA = recoverEvmClaimSigner(
      { ...params, chainId: 8453n, verifyingContract: '0x' + 'aa'.repeat(20) },
      sigA
    );
    expect(recoveredUnderA.toLowerCase()).toBe(ANVIL_ADDR_0);

    // The SAME signature does NOT recover the signer under chain B's domain
    // (different chainId AND different verifyingContract) — this is exactly
    // the replay protection v2 exists to provide.
    const recoveredUnderB = recoverEvmClaimSigner(
      { ...params, chainId: 84532n, verifyingContract: '0x' + 'bb'.repeat(20) },
      sigA
    );
    expect(recoveredUnderB.toLowerCase()).not.toBe(ANVIL_ADDR_0);

    // Sanity: chain B's OWN signer produces a DIFFERENT signature for the
    // identical params (same key, different domain) — proving the two
    // signer instances are genuinely domain-bound, not sharing one digest.
    const sigB = await signerChainB.signBalanceProof(params);
    expect(Buffer.from(sigB).toString('hex')).not.toBe(
      Buffer.from(sigA).toString('hex')
    );
  });
});

describe('issue #101 — parseEvmChainId: chain-key shape parsing', () => {
  it('[P1] parses the two-segment shape (evm:84532)', () => {
    expect(parseEvmChainId('evm:84532')).toBe(84532n);
  });

  it('[P1] parses the three-segment shape (evm:base:8453)', () => {
    expect(parseEvmChainId('evm:base:8453')).toBe(8453n);
  });

  it('[P2] rejects a chain key with a non-numeric trailing segment', () => {
    expect(() => parseEvmChainId('evm:base')).toThrow(/numeric chainId/);
    expect(() => parseEvmChainId('evm:base:mainnet')).toThrow(
      /numeric chainId/
    );
  });
});

describe('boot refuses without a deployed TokenNetwork address (leg B lives there)', () => {
  function baseConfig(chain: string): SwapNodeConfig {
    return {
      mnemonic: VALID_MNEMONIC,
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain },
          to: { assetCode: 'USDC', assetScale: 6, chain },
          rate: '1.0',
        },
      ],
      chains: ['evm'],
      channels: {
        [chain]: [
          { channelId: 'c-1', cumulativeAmount: 0n, nonce: 0n, updatedAt: 0 },
        ],
      },
      inventory: { [chain]: 1_000_000n },
    };
  }

  function evmProvider(chain: string): SwapNodeEvmChainProvider {
    return {
      chainType: 'evm',
      chainId: chain,
      rpcUrl: 'http://127.0.0.1:1',
      registryAddress: '0x' + '11'.repeat(20),
      tokenAddress: '0x' + '22'.repeat(20),
      tokenNetworkAddress: '0x' + '44'.repeat(20),
      channelAddress: '0x' + '33'.repeat(20),
    };
  }

  it('[P0] a swap pair targeting an EVM chain with NO chainProviders entry at all fails INVALID_CONFIG, naming the chain', () => {
    const chain = 'evm:8453';
    let caught: unknown;
    try {
      validateConfig(baseConfig(chain));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SwapNodeStartError);
    expect((caught as SwapNodeStartError).code).toBe('INVALID_CONFIG');
    expect((caught as Error).message).toContain(chain);
    expect((caught as Error).message).toContain('tokenNetworkAddress');
  });

  it('[P0] a chainProviders entry present but missing tokenNetworkAddress fails INVALID_CONFIG, naming the setting', () => {
    const chain = 'evm:8453';
    const { tokenNetworkAddress: _drop, ...withoutTokenNetwork } = evmProvider(chain);
    const config: SwapNodeConfig = {
      ...baseConfig(chain),
      chainProviders: [withoutTokenNetwork as unknown as SwapNodeEvmChainProvider],
    };
    expect(() => validateConfig(config)).toThrow(/tokenNetworkAddress/);
  });
  it('[P1] the 2.x channelAddress (RollingSwapChannel) is optional: a config without it boots', () => {
    const chain = 'evm:8453';
    const { channelAddress: _drop, ...withoutChannelAddress } = evmProvider(chain);
    const config: SwapNodeConfig = {
      ...baseConfig(chain),
      chainProviders: [withoutChannelAddress],
    };
    expect(() => validateConfig(config)).not.toThrow();
  });
  it('[P1] a fully-configured chainProviders entry (with channelAddress) boots cleanly, both key shapes', () => {
    for (const chain of ['evm:8453', 'evm:base:8453']) {
      const config: SwapNodeConfig = {
        ...baseConfig(chain),
        chainProviders: [evmProvider(chain)],
      };
      expect(() => validateConfig(config)).not.toThrow();
    }
  });

  it('[P2] a malformed EVM chain key (no numeric trailing segment) fails INVALID_CONFIG even with a chainProviders entry present', () => {
    const chain = 'evm:mainnet';
    const config: SwapNodeConfig = {
      ...baseConfig(chain),
      chainProviders: [evmProvider(chain)],
    };
    expect(() => validateConfig(config)).toThrow(/numeric chainId/);
  });
});
