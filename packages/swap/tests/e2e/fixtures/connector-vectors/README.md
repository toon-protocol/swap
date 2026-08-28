# Vendored connector wire vectors

`wire-vectors.json` is a verbatim copy of `vectors/wire-vectors.json` from
[toon-protocol/connector](https://github.com/toon-protocol/connector) — the
cross-repo contract for the client-edge wire (connector ADR 0021: *vectors are
normative, prose is not*).

|  |  |
| --- | --- |
| Source commit | `67164041755b315af88d9cf9095aea42135ac391` (file last changed); repo HEAD at vendoring `5c1b222f` |
| `schema_version` | 4 |

`tests/e2e/taker-toolkit.selfcheck.test.ts` replays the sections the taker
toolkit depends on before it talks to a live connector:

- `peer_carriage.prepare.http_body_hex` — `helpers/taker-edge.ts`'s PREPARE
  encoder must reproduce these 108 bytes (TOON's ILP dialect, ADR 0063).
- `peer_carriage.claim_digest_hex` / `claim_evm` — `helpers/evm-chain.ts`'s
  EIP-712 `BalanceProof` digest, and recovering the vector's signature to its
  `signerAddress`.
- `peer_carriage.claim_solana.signed_message_hex` — the 96-byte ADR 0053
  balance-proof message from `helpers/solana-chain.ts`.

Refresh by copying the file again; if the connector bumps `schema_version`
the self-check's assertions are the place a divergence shows up.
