# Superseded: the maker is not an app behind a Rust connector

**Status:** superseded on 2026-08-28 by [`relay-swap.md`](./relay-swap.md), before any release
carried it. Kept as a pointer because ADRs and issues link here.

The shape this document described — a Rust connector terminating `<ilpAddress>.rfq` and
`<ilpAddress>` at an HTTP maker, leg A verified by the connector and stated as `X-TOON-*`, leg B
in the paid response (`rolling/2`) — was built and proven on chain, then replaced. It did not
scale in two ways that were not about the code: every maker needed its own Rust connector plus
fleet-committed config, and discovery had no answer after connector ADR 0046 removed kind:10032.

What survived unchanged: the chain layer (the `TokenNetwork` balance proof, the 96-byte
`TOON-BALPROOF-V2` message, one ADR 0059 channel per pair opened by the maker on demand), the
maker engine, inventory, persistence, and the reasoning about why the legs are not coupled —
exposure is one fill in every transport. Read `git log -- docs/rust-connector-migration.md` for the
full text.
