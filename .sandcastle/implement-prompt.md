/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers the repo. `docs/relay-swap.md` and `docs/how-it-works.md` describe the
  design. Dependencies on other TOON repos are pinned; a ticket that needs a change in
  `toon-protocol/connector` or another repo is not finished by editing this one.
- swap is a pnpm workspace. Install with `pnpm install --no-frozen-lockfile`, as CI does.
- Line numbers cited in older issues drift. Check that a `file.ts:123` reference still points
  at what the text claims before relying on it.
- After you finish, the runner runs CI's `build` job itself and won't open a PR while it is
  red: `pnpm run gate:correctness` (build, then eslint and typecheck against the frozen
  `.sandcastle/gate-baseline.json` allowlist) and `pnpm test`. Run both before you commit.
  Never weaken, skip or `.skip` a test, and never loosen a lint, to get green.
- The gate does not run CI's `solana-e2e` job, which needs the Rust connector image
  (`docker run`, not available here). The sandbox has `anvil` and `solana-test-validator`, but
  a ticket that changes what that suite covers needs its result from CI, so say so in a comment
  on the issue.
- A change under `packages/swap` needs a changeset (`pnpm changeset`, or a hand-written
  `.changeset/*.md`). CI's changeset job refuses the PR without one. A changeset that releases
  nothing must say `changeset:no-release` and name what does not ship
  (`.sandcastle/scripts/changeset-lib.ts` has the rule).
- A ticket that needs a live box, a funded key or an on-chain write doesn't need a human if a
  workflow in `.github/workflows/` does that work. Dispatch it with `gh workflow run`, run the
  dry run first and quote it in a commit message. If none does, stop as described below.

## When you cannot finish

Stop only when a genuinely new decision is needed and no ADR covers it, the action is
irreversible, it touches mainnet or real funds, or it needs a credential that no workflow
exposes. In that case, commit nothing and explain what blocks you in a comment on the issue
(`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.

If you stopped because you're blocked, output <promise>BLOCKED</promise> instead, after your
comment on the issue. The runner then ends the run. Otherwise it starts another session, which
hits the same blocker and posts the same comment again.
