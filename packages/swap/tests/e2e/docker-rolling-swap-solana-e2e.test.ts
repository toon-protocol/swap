/**
 * swap#160 — ROLLING swap-flow + settlement E2E, Solana target.
 *
 * This suite EXECUTES. It used to collect two tests and skip both on every run,
 * because it gated on an operator having stood a `solana-test-validator` up by
 * hand and exported `SOLANA_E2E_RPC_URL` — which no CI job ever did. Now
 * `global-setup.ts` boots a real validator with the real payment-channel
 * program baked into its genesis from a 109 KB vendored blob, mints a mock USDC
 * SPL token, and opens REAL channel PDAs peer1 is seeded with. Nothing is
 * operator-supplied and nothing is mocked.
 *
 * ## What crossing THIS boundary proves that `evm → evmB` does not
 *
 * `docker-rolling-swap-cross-chain-e2e.test.ts` crosses a chain-ID boundary:
 * two anvils, two EIP-712 domains, one signer implementation. This suite
 * crosses a chain-FAMILY boundary, so a different half of the maker runs:
 * `SolanaPaymentChannelSigner` (ed25519 over `balanceProofHashSolana`, not
 * secp256k1 over an EIP-712 digest), a base58 `swapSignerAddress`, base58
 * recipient validation, a Solana claim envelope, and — `S-3` — the swap#141
 * on-chain reader that hand-decodes the program's 178-byte `ChannelState`.
 *
 * ## Direction, and why it is this one
 *
 * `evm:base:31337 → solana:devnet`: leg A paid on the harness anvil, leg-B
 * claim delivered on Solana. The reverse (`solana → evm`, leg A genuinely PAID
 * on Solana — the direction toon-meta#394's T6 rig proved by hand) is NOT
 * drivable here; `S-4` asserts the maker refuses it and records the three
 * reasons.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildSettlementTx, generateSolanaKeypair } from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import { createSolanaChannelOnChainReader } from '../../src/solana-channel-reader.js';
import {
  buildLiveSender,
  type LiveSender,
} from './helpers/build-live-sender.js';
import {
  createLegBDaemon,
  openRollingSession,
  runRollingSwap,
  type LegBDaemon,
  type RollingSwapResult,
} from './helpers/rolling-driver.js';
import { present } from './helpers/present.js';
import { deriveMakerSolanaPubkey } from './helpers/solana-validator.js';

import {
  checkAllServicesReady,
  waitForPeer2Bootstrap,
  waitForSolanaHealth,
  skipIfNotReady,
  PEER1_NOSTR_PUBKEY,
  PEER1_ILP_ADDRESS,
  SOLANA_RPC,
  SOLANA_PROGRAM_ID,
  DOCKER_CHAIN_EVM,
  DOCKER_CHAIN_SOLANA,
} from './helpers/infra-gate.js';
import {
  PEER1_MNEMONIC,
  ROLLING_SENDER_ILP,
  SOLANA_RPC_URL,
} from './helpers/topology.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
  to: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_SOLANA },
  rate: '1',
};

describe('Docker Rolling Swap Solana E2E (swap#153)', () => {
  let servicesReady = false;
  let sender: LiveSender | null = null;
  let daemon: LegBDaemon = createLegBDaemon();
  let solanaRecipient = '';
  let result: RollingSwapResult | null = null;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;
    const bootstrapped = await waitForPeer2Bootstrap(45_000);
    if (!bootstrapped) return;
    const solanaReady = await waitForSolanaHealth(30_000);
    if (!solanaReady) return;
    servicesReady = true;

    try {
      daemon = createLegBDaemon();
      sender = await buildLiveSender({
        nodeIdPrefix: 'roll-sol',
        btpServerPort: 19936,
        healthCheckPort: 19937,
        loggerName: 'swap-e2e-rolling-solana-connector',
        senderIlpAddress: ROLLING_SENDER_ILP.solana,
        localDeliveryHandler: daemon.handler,
      });
      // generateSolanaKeypair() returns publicKey already base58-encoded;
      // do NOT re-encode (that would treat the string as a byte array and
      // throw "Cannot convert R to a BigInt" inside base58Encode).
      solanaRecipient = generateSolanaKeypair().publicKey;
      result = await runRollingSwap({
        sender,
        daemon,
        makerPubkey: PEER1_NOSTR_PUBKEY,
        makerIlpAddress: PEER1_ILP_ADDRESS,
        pair: PAIR,
        chainRecipient: solanaRecipient,
        totalAmount: 1_000_000n,
        packetCount: 1,
      });
    } catch (err) {
      console.error('Solana rolling swap failed in beforeAll:', err);
    }
  }, 120_000);

  afterAll(async () => {
    if (sender) await sender.close();
    await new Promise((r) => setTimeout(r, 250));
  });

  it('S-1 [P1] a rolling session to solana:devnet delivers leg-B claims bound to a 32-byte base58 pubkey', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    const swap = present(result, 'the Solana rolling swap result');
    expect(
      swap.state,
      `rfq: ${JSON.stringify(swap.rfqReject)} rejections: ${JSON.stringify(swap.rejections)}`
    ).toBe('completed');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);
    const first = present(swap.claims[0], 'the first leg-B claim');
    expect(first.recipient).toBe(solanaRecipient);
    expect(first.pair.to.chain).toBe(DOCKER_CHAIN_SOLANA);
  });

  it('S-2 [P1] buildSettlementTx() over the leg-B claims produces a valid Solana bundle', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // Config-drift guards. `SOLANA_PROGRAM_ID` is no longer allowed to be
    // empty: the harness loads the vendored program at a fixed address, so an
    // empty value now means the wiring broke rather than "no deployment
    // exists".
    expect(
      SOLANA_PROGRAM_ID,
      'SOLANA_PROGRAM_ID unset — solana-validator.ts should default it'
    ).not.toBe('');
    expect(SOLANA_RPC).toBe(SOLANA_RPC_URL);
    const swap = present(result, 'the Solana rolling swap result');
    expect(swap.claims.length).toBeGreaterThanOrEqual(1);

    const lastClaim = present(swap.claims.at(-1), 'the last leg-B claim');
    const settlement = buildSettlementTx({
      claims: swap.claims,
      signers: {
        [DOCKER_CHAIN_SOLANA]: {
          address: present(
            lastClaim.swapSignerAddress,
            'claim.swapSignerAddress'
          ),
          programId: SOLANA_PROGRAM_ID,
        },
      },
      recipients: { [DOCKER_CHAIN_SOLANA]: solanaRecipient },
      verifySignatures: false,
    });

    expect(settlement.bundles.length).toBeGreaterThanOrEqual(1);
    const bundle = present(settlement.bundles[0], 'the settlement bundle');
    expect(bundle.chainKind).toBe('solana');
    expect(bundle.chain).toBe(DOCKER_CHAIN_SOLANA);
    expect(bundle.channelId).toBe(lastClaim.channelId);
    expect(bundle.nonce).toBe(lastClaim.nonce);
    expect(bundle.cumulativeAmount).toBe(lastClaim.cumulativeAmount);
    expect(bundle.recipient).toBe(solanaRecipient);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
    expect(bundle.claimsMerged).toBeGreaterThanOrEqual(1);

    // NOTE the deliberate absence of a broadcast. `buildSettlementTx`'s Solana
    // branch emits an Anchor-style discriminator (`sha256('global:update_
    // balance')`) and a `cumulative || nonce` payload, while the deployed
    // program is native, expects `CLAIM_FROM_CHANNEL = [6,0,0,0,0,0,0,0]` and
    // `nonce || transferred_amount`, and takes the signature out of band. The
    // bundle is therefore structurally right and not executable; submitting it
    // here would fail for reasons that have nothing to do with this harness.
    // Tracked separately — see the README's "known gaps".
  });

  // ---------------------------------------------------------------------
  // S-3 — the maker's chain-truth reader against a REAL account
  // ---------------------------------------------------------------------
  it('S-3 [P1] the swap#141 Solana reader decodes a REAL channel PDA written by the deployed program', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // This is the assertion that makes booting a validator worth its wall
    // clock. `src/solana-channel-reader.ts` hand-decodes the 178-byte
    // `ChannelState` — the ASCII `pchannel` discriminator, the participant
    // pubkeys at 8/40, `transferred_amount_{a,b}` at 120/128 — from a layout
    // that is CANONICALLY DEFINED IN ANOTHER REPO
    // (connector `packages/solana-program/src/state.rs`). Every unit test for
    // it feeds a hand-built buffer, so all of them would keep passing if that
    // layout moved. Only a read of an account the real program actually wrote
    // can catch that, and this is it.
    //
    // The seeded channels name peer1 as `participant_b` (the fixture opener is
    // `participant_a`), so a reader that picked the wrong slot, or that failed
    // to match either participant, throws instead of returning a number —
    // which is also the behaviour that keeps a stale watermark from
    // over-recycling inventory.
    const makerSolanaPubkey = await deriveMakerSolanaPubkey(PEER1_MNEMONIC);
    const reader = createSolanaChannelOnChainReader([
      {
        chainId: DOCKER_CHAIN_SOLANA,
        rpcUrl: SOLANA_RPC,
        programId: SOLANA_PROGRAM_ID,
        payerPubkey: makerSolanaPubkey,
      },
    ]);

    const swap = present(result, 'the Solana rolling swap result');
    const channelId = present(swap.claims[0], 'the first leg-B claim').channelId;

    // A Solana channelId IS the channel PDA's base58 address — never 0x-hex.
    // If this ever fails, the maker bound the sender to an EVM-shaped seed for
    // a Solana pair and the read below would be meaningless.
    expect(channelId).not.toMatch(/^0x/);

    const cumulativePaid = await reader.getCumulativePaid({
      assetCode: 'USD',
      chain: DOCKER_CHAIN_SOLANA,
      channelId,
    });

    // Nothing has been redeemed on chain (the claims are off-chain balance
    // proofs), so the maker's on-chain paid-out slot is still zero. The point
    // is that the decode SUCCEEDED against real account data — a wrong owner,
    // a short account, a moved discriminator or a moved offset all throw.
    expect(cumulativePaid).toBe(0n);

    // And the reader really is fail-closed on an account the program did not
    // write: same shape of address, no such channel.
    await expect(
      reader.getCumulativePaid({
        assetCode: 'USD',
        chain: DOCKER_CHAIN_SOLANA,
        channelId: makerSolanaPubkey,
      })
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // S-4 — the reverse direction is REFUSED, not quoted
  // ---------------------------------------------------------------------
  it('S-4 [P1] peer1 REFUSES solana:devnet → evm:base:31337 — it will not quote a leg A it cannot be paid on', async (ctx) => {
    if (skipIfNotReady(servicesReady)) return ctx.skip();

    // `solana → evm` is the direction the owner actually wants covered, and
    // the one toon-meta#394's T6 rig proved by hand against live Base Sepolia.
    // It is not drivable automatically today, for three reasons — all in
    // product code, none of them in this harness:
    //
    // 1. **The sender cannot pay on Solana.** Leg A is paid by the sender
    //    connector's `PerPacketClaimService`, and a `ConnectorNode` can only
    //    open EVM channels: `ChannelManager.openChannelForPeer` calls the EVM
    //    `PaymentChannelSDK` unconditionally with no chain dispatch, the
    //    manager itself is only constructed `if (hasEvm)`, and the admin
    //    surface refuses non-EVM outright (`POST /admin/channels` → 400
    //    `Unsupported blockchain: solana`). The only TS code that CAN open a
    //    Solana channel is `@toon-protocol/client`'s `OnChainChannelClient` —
    //    which is what `helpers/solana-validator.ts` uses to seed the channels
    //    this suite reads, and what the T6 rig's sender was. Moving
    //    `build-live-sender.ts` onto it is a rewrite of the sender, not a
    //    config change. (And there is no upstream to wait on: the TypeScript
    //    connector was retired in toon-protocol/connector#543, so `^3.30.0` is
    //    the last line that ships `ConnectorNode` at all.)
    // 2. **The maker could not verify such a claim if it arrived.**
    //    `startSwapNode` defaults EVERY `chainProviders[].keyId` to the 0x-hex
    //    EVM settlement key regardless of `chainType` (`src/swap-node.ts`), and
    //    the connector base58-decodes it — which throws on `0`. The embedded
    //    connector's Solana provider registration therefore always fails
    //    (swallowed as a `chain_provider_registration_failed` warn) and its
    //    `InboundClaimValidator` rejects every Solana claim with
    //    `No settlement provider registered for blockchain: solana`.
    // 3. **Nothing would have told us.** `pair.from.chain` is never validated
    //    anywhere in `validateConfig` — only `to.chain` is — so a
    //    `solana:* → evm:*` maker boots silently with no Solana key, provider
    //    or reader and quotes RFQs it can never be paid for.
    //
    // So the refusal below is the correct behaviour to pin, and it is a
    // regression detector in both directions: if the maker ever starts quoting
    // this pair while (1) and (2) are still true, it is quoting something it
    // cannot deliver, and this fails. When the direction is genuinely
    // implemented, this fails too — which is the signal to replace it with a
    // real swap.
    const live = present(sender, 'the Solana rolling sender');
    const probe = createLegBDaemon();
    const opened = await openRollingSession({
      sender: live,
      daemon: probe,
      makerPubkey: PEER1_NOSTR_PUBKEY,
      makerIlpAddress: PEER1_ILP_ADDRESS,
      pair: {
        from: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_SOLANA },
        to: { assetCode: 'USD', assetScale: 6, chain: DOCKER_CHAIN_EVM },
        rate: '1',
      },
      chainRecipient: '0x' + '5e5e'.repeat(10),
    });

    expect(
      opened.ok,
      'peer1 quoted solana → evm, a pair whose leg A no sender can pay'
    ).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe('unsupported_pair');
    }
  });
});
