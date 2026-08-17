---
'@toon-protocol/swap': minor
---

`GET /admin/intake` — a durable per-class intake ledger backing ADR 0003's removal gate.

swap#152 made every arrival classifiable (`swap.intake.arrival`), but the gate that reads it — "no legacy intake observed for N consecutive days" — could not survive to N days: `swap:release` is auto-on-green, Watchtower recreates the container on every merge, and `docker logs` only ever holds the CURRENT container's stdout. Every recreate reset the observation window to zero. The documented read pattern was also false-green (`"event":"swap.intake"` never matches the real `swap.intake.arrival`), so the gate returned `0 legacy` unconditionally.

A small ledger (per-class count, `firstSeenAt`, `lastSeenAt`, plus the ledger's own `since`) now persists beside the existing `statePath` snapshot — the same durable volume the maker's inventory and channel watermarks already survive a recreate on — and is read back at `GET /admin/intake`, next to the existing `GET /admin/inventory`. `since` distinguishes "this ledger just started" from "legacy has truly been silent"; without it a fresh ledger's `count: 0` is indistinguishable from 90 days of silence.

No new required config key: `intakeLedgerPath` is optional and defaults to `intake-ledger.json` beside `statePath`; with neither set, the ledger still counts in-memory for the life of the process. Unlike `statePath`'s load-fails-loudly policy, a missing or corrupt ledger file starts empty rather than blocking boot, and a ledger write failure is logged and dropped rather than rejecting a swap — this is observability evidence, not a crash-consistency watermark.
