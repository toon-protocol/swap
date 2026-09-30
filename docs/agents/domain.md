# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**, and it has no `CONTEXT.md` or `docs/adr/` of its own.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root: what swap is, the cross-repo dependencies and the config
  ordering rule.
- **`docs/relay-swap.md`** and **`docs/how-it-works.md`**: the relay-mediated design and how a
  swap flows. `docs/rust-connector-migration.md`, `docs/sdk-2x-migration.md` and
  `docs/swap-3x-migration.md` record how it got here.
- **The connector's decisions**: cross-repo wire and settlement decisions live in
  [`toon-protocol/connector`'s `docs/adr/`](https://github.com/toon-protocol/connector/tree/main/docs/adr)
  and its `CONTEXT.md`, not here. Read the ones that touch the area you are about to work in.

If a file doesn't exist, **proceed silently**. Don't flag its absence, and don't suggest creating
it up front. The `/domain-modeling` skill creates a `CONTEXT.md` or an ADR lazily, when a term or a
decision is actually resolved.

## File structure

```
/
├── CLAUDE.md
├── docs/            ← design notes and migration guides
└── packages/        ← pnpm workspace (packages/swap is the published package)
```

## Use the vocabulary the docs use

When your output names a domain concept (in an issue title, a refactor proposal, a test name), use
the term the docs above use. `CLAUDE.md` bans the retired "mill" vocabulary: don't reintroduce
mill-named identifiers.

## Flag decision conflicts

If your output contradicts a documented decision (here or in the connector's ADRs), surface it
explicitly rather than silently overriding it.
