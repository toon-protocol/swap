---
'@toon-protocol/swap': minor
---

Make legacy-vs-rolling swap intake countable — the removal gate was
unmeasurable.

ADR 0003 gates every stage of the legacy-swap removal on "no legacy traffic
observed for N consecutive days", and that sentence could not be evaluated.
swap#137 gave the maker a real logger, but everything it emits is a **refusal**
(`swap.claim.refused`, `swap.packet.dispatch_failed`); nothing on the success
path ever said which protocol served a swap, so a maker serving legacy all day
and a maker serving none produced identical logs.

The dispatch seam now classifies **every** arrival onto the row of the issue
#47 dispatch matrix it landed on — `legacy` (a zero-condition gift wrap that
reached the legacy handler, inner rumor kind reported verbatim),
`rolling-rfq` (inner kind 20033), `rolling-fill` (a coupled fill under a real
32-byte sender-chosen condition), or `refused` (a pre-dispatch reject, carrying
the reason discriminator that was already on the wire) — and records it two
ways:

- one `swap.intake` JSON line per arrival, at `info`, carrying the class, the
  arrival peer and source ILP address, the requested pair, the inner rumor
  kind and the outcome. This is the durable reading: it is in the container's
  log stream, so a windowed count survives the Watchtower recreate that a
  `:release` move performs.
- `GET /admin/intake` — the same counts without shell-parsing, on the swap#138
  operator surface, unauthenticated exactly as `GET /admin/inventory` is (a
  read, disclosing strictly less than the pre-existing `GET /health`). Also
  `SwapNodeInstance.intakeReport()`. These counters are in-process, so the
  report always carries `since`/`windowSec` — an in-process reset is visible
  rather than silent.

The class is the dispatch row, not the outcome: a rolling fill the engine later
rejects is still `rolling-fill`, with `accepted:false` and the reject `code`.
The inner rumor kind — the only thing separating a legacy request from a
rolling RFQ inside an otherwise byte-identical envelope — is read from the
unwrap the RFQ intake already performs, via a new read-only `sniff` by-product
on `createRollingRfqIntake().handle()`, so nothing decrypts twice.

**Removes nothing and changes no swap behaviour.** No routing decision moved,
no packet outcome changed, and the meter swallows its own errors so accounting
can never fail a packet. Only routing metadata is recorded — the gift wrap
stays sealed, and counterparty-supplied strings are length-capped. **No new
config key**, required or optional (swap#134): verbosity remains the existing
optional `SWAP_LOG_LEVEL`.
