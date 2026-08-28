# Vendored EVM contract artifacts

Trimmed forge artifacts — `{ abi, bytecode }` only, the `metadata`/`ast`/
`deployedBytecode` sections dropped — for the connector's settlement contracts,
so `helpers/evm-chain.ts` can reproduce `DeployLocal.s.sol` on a fresh anvil
with `viem` and no Foundry toolchain in the loop.

|  |  |
| --- | --- |
| Source | [toon-protocol/connector](https://github.com/toon-protocol/connector) → `packages/contracts/` |
| Source commit | contracts last changed at `d578bde70dfd993c74fef607a7f3d07ea59102ac` (2026-08-26); artifacts taken from a `forge build` of repo HEAD `5c1b222f` |
| Compiler | `solc 0.8.26+commit.8a97fa7a` (from the artifacts' `metadata.compiler.version`) |

| file | contract | source |
| --- | --- | --- |
| `MockERC20.json` | `MockERC20` (ungated `mint`) | `test/mocks/MockERC20.sol` |
| `TokenNetworkRegistry.json` | `TokenNetworkRegistry` | `src/TokenNetworkRegistry.sol` |
| `TokenNetwork.json` | `TokenNetwork` — **ADR 0059** derived channel ids (`channelEpoch`, no `channelCounter`) | `src/TokenNetwork.sol` |
| `RollingSwapChannel.json` | `RollingSwapChannel` — v2 EIP-712 domain (`RollingSwapChannel`, `"2"`) | `src/RollingSwapChannel.sol` |

Regenerate:

```sh
cd /path/to/connector/packages/contracts && forge build
python3 - <<'PY'
import json
for n in ['MockERC20','TokenNetworkRegistry','TokenNetwork','RollingSwapChannel']:
    j = json.load(open(f'out/{n}.sol/{n}.json'))
    json.dump({'abi': j['abi'], 'bytecode': j['bytecode']['object']},
              open(f'/path/to/swap/packages/swap/tests/e2e/fixtures/evm/{n}.json', 'w'), indent=1)
PY
```

`deployEvmContracts()` replays the deploy script's exact sequence from anvil
account 0, so on a fresh chain the addresses match the deterministic ones
connector's `local/solo/connector.toml` commits (`0x5FbDB…` USDC,
`0xe7f17…` registry).
