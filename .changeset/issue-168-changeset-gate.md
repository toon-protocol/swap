---
---

<!-- changeset:no-release — `.github/workflows/ci.yml` and `.sandcastle/scripts/` only. This change adds the gate and corrects OTHER changesets' frontmatter; it ships no code, no types and no wire change of its own, and its own release effect is entirely carried by the changesets it fixed. -->

Add a changeset gate to CI, and correct the frontmatter of the 26 pending changesets (swap#168).

Nothing in `.github/` read a changeset before merge — `changeset` appeared only in `release.yml`, which runs after merge where its failure gates nothing. 22 of the 26 pending changesets therefore had empty frontmatter, ~13 of them describing shipped behaviour of `@toon-protocol/swap`, so `@toon-protocol/swap` sat on npm at 2.1.0 while the Docker image moved.

`CI OK` now requires a `Changeset check` job that (1) demands a changeset when `packages/swap/` changes, (2) runs the byte-identical `pnpm changeset version` that `release.yml` runs, and (3) requires a changeset that bumps nothing to say so with a `changeset:no-release` marker — this file being the first example.
