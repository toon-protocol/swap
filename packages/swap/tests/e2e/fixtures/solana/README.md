# Vendored Solana test fixtures

Everything here exists so `tests/e2e/global-setup.ts` can stand up a **real**
`solana-test-validator` with the **real** payment-channel program at a **fixed**
address, with no network access and no Rust toolchain, on every CI run.

Precedent: this package already vendors a machine-generated chain-state blob for
the EVM legs (`tests/integration/fixtures/rolling-e2e-anvil-state.hex`), and the
connector repo vendors both `packages/contracts/anvil-state.json` and throwaway
Solana keypairs (`infra/solana/usdc-{mint,authority}.json`). This is the Solana
half of the same idea.

## `payment_channel.so` — the deployed program

|  |  |
| --- | --- |
| Source | [`toon-protocol/connector`](https://github.com/toon-protocol/connector) → `packages/solana-program/` (native Rust, **not** Anchor) |
| Source commit | `d4b1511e75c8050e94167b151c5aa9a90dd4c95b` (tree of `packages/solana-program`; previously `e9bfadad717e66ad9f6b99a929afed1514adce57`) |
| Built with | `cargo build-sbf --tools-version v1.52` — the pin connector's own CI and `Makefile` use, and the one its `solana-program-reproducibility` job asserts is byte-stable |
| Size | 109,400 bytes |
| sha256 | `ae2e91488c5b7920ca58279359d99cf8a3726d6b3f3b80a398a014af759e7e87` |

`tests/e2e/helpers/solana-validator.ts` asserts the size and hash at boot, so a
truncated or silently-swapped blob fails loudly instead of producing a validator
whose program rejects everything.

### Why vendor rather than build or clone

- **Build in CI**: would add a Rust toolchain plus Solana platform-tools (a
  ~200 MB download, and connector's CI carries a documented retry for its flaky
  version resolution) to a TypeScript repo, to produce 109 KB.
- **Clone from a deployment** (`solana program dump <id>` off public devnet, the
  toon-meta#394 T6 rig's route): puts a live third-party RPC in the critical path
  of the gate. A devnet outage would turn into a red PR.
- **Vendor**: no toolchain, no network, byte-identical every run. The cost is
  remembering to refresh it when the program changes — see below.

### Regenerating

```sh
cd /path/to/connector/packages/solana-program
cargo build-sbf --tools-version v1.52
cp ../../target/deploy/payment_channel.so \
   /path/to/swap/packages/swap/tests/e2e/fixtures/solana/payment_channel.so
sha256sum .../payment_channel.so   # update the table above AND solana-validator.ts
```

The program has **no `declare_id!`** — it reads `program_id` from the entrypoint and
derives its PDAs from it — so the address is simply wherever the validator loads
it. `solana-validator.ts` loads it at
`HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR`, the same
`LOCAL_TEST_PROGRAM_ID` connector's own Rust test harness uses
(`crates/connector-settlement-solana/src/test_support.rs`), so one local id means
one set of PDAs across both repos' tests.

The canonical account layout this program writes — the 178-byte `ChannelState`
with the ASCII `pchannel` discriminator — is `packages/solana-program/src/state.rs`
in that same commit, and is what `src/solana-channel-reader.ts` (swap#141) decodes.
`S-3` in `docker-rolling-swap-solana-e2e.test.ts` reads a real PDA written by
**this** binary through **that** decoder, which is the only thing that can catch a
layout drift between the two repos.

## `usdc-mint.json`, `usdc-authority.json` — throwaway keypairs

Locally-generated Ed25519 keypairs, committed so that the SPL mint and the mint
authority land at **deterministic** addresses across `--reset` wipes. They exist
only to make the local validator's account addresses stable so tests can assert
on them.

These are **not secrets**. They control nothing but freshly minted play tokens on
a throwaway local validator that is destroyed at the end of the test run, they are
never funded on any real cluster, and the mint they authorize is a mock 6-decimal
SPL token with no relationship to real USDC. Same posture, and same rationale, as
connector's committed `infra/solana/usdc-{mint,authority}.json`.

| file | address | role |
| --- | --- | --- |
| `usdc-mint.json` | `CfXoHk5zRtFDtxD4HtTJXDzhfRMtSad4r3BiKeG9A2AC` | the mock 6-dp SPL mint the channels settle in |
| `usdc-authority.json` | `AFb8fB4Ky9pZmsH9CZwE8s21zCrCHqXhT2QwshQrTLRP` | mint + freeze authority, fee payer for provisioning |

The **channel openers** are NOT committed. A channel PDA is a function of
`(participantA, participantB, mint, programId)`, so one opener yields exactly one
channel against peer1, and the maker needs one per distinct sender that targets
Solana in a run (the swap#113 rebind precondition will not hand a bound channel
to a second sender until the first has redeemed on chain). Rather than commit a
growing pile of keypair files, `solana-validator.ts` derives them from a fixed
label — `sha256("swap-e2e-solana-opener/<i>")` — so their addresses are just as
stable while the count is a constant in one place.

Never point the provisioning helper at a non-local RPC. `solana-validator.ts`
refuses any RPC URL that is not loopback, for the same reason connector's
`create-usdc-mint.sh` refuses a mainnet-shaped one.
