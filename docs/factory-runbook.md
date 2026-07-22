# Sandcastle factory — first-run runbook (swap)

This is the maintainer runbook for **triggering** swap's sandcastle software
factory. Authoring the runners is done (workflows + labels + entry scripts);
pulling the trigger is a deliberate human action. Nothing in this repo starts an
agent run on its own.

Related:
- Trigger-label + engine spec: `FACTORY.md` (in `toon-meta`).
- Engine reference + verified-on-first-run corrections:
  `scratchpad-sandcastle-engine.md` (in `toon-meta`).
- The runners: `.github/workflows/agent-implement.yml`,
  `.github/workflows/agent-review.yml`.
- The entry scripts: `.sandcastle/agent-implement-issue.ts`,
  `.sandcastle/agent-review-pr.ts`.

---

## Prerequisites (one-time)

- `agent:implement` (`#1D76DB`) and `agent:review` (`#B392F0`) labels exist in
  the swap repo. (Created as part of this slice.)
- Org/repo Actions secrets present:
  - `CLAUDE_CODE_OAUTH_TOKEN` — Claude Max-plan credential (`claude setup-token`).
  - `APP_ID` + `APP_PRIVATE_KEY` — the GitHub App the existing loops already use.
    The engine opens the PR with this App token so the PR triggers `ci.yml`
    (the green gate). A PR opened with the default `GITHUB_TOKEN` would NOT
    trigger CI.
- `agent-implement.yml` / `agent-review.yml` are merged to `main`. Issue- and
  PR-`labeled` workflows only fire from the default branch, so nothing runs
  until these land on `main`.

---

## Trigger the implement checkpoint (the pilot proof)

1. **Pick a small, self-contained issue.** It MUST NOT be an epic/PRD parent:
   no `epic`, `tracking`, or `needs:human` label, and no sub-issues. The runner
   guards refuse those, but pick a clean target anyway. A tightly-scoped bugfix
   or a single small feature is ideal for the first run.

2. **Apply the `agent:implement` label** to that issue. That single act is the
   trigger.

3. **Watch the run** under the repo's Actions tab → **agent:implement**. Two
   jobs:
   - `guard` — evaluates the target (actor write-access, no epic/tracking/
     needs:human label, no sub-issues). If it decides not to proceed you'll see
     a `::warning::` explaining why and the `implement` job is skipped.
   - `implement` — the real work, in order:
     1. checkout + node 22 + `corepack`/`pnpm install`
     2. **build the agent image** (`sandcastle docker build-image`)
     3. **run** `pnpm sandcastle:implement`, which inside the sandbox:
        - **implements** the issue (opus, up to 100 iterations, RED→GREEN→
          REFACTOR, running swap's gate `eslint . / pnpm run typecheck /
          vitest run / pnpm -r run build`),
        - **reviews** the branch (opus, 1 iteration),
        - **opens a PR** against `main` (`Part of #<issue>`, NOT `Closes`).

4. **Expected result:** a new PR from branch `sandcastle/issue-<n>`, with
   `ci.yml` running on it. **The issue is NOT auto-closed and nothing is merged.**

5. **Review and merge the PR yourself.** Merging it (and thereby closing the
   issue) is what satisfies toon-meta#189's "a real agent PR merges" acceptance
   criterion. This is the human half of the checkpoint.

### Reading the logs

- The `implement` job's step **"Run sandcastle implement runner"** streams the
  engine output: the branch name, `implementer` / `reviewer` / `open-pr` phase
  banners, and the agents' tool calls.
- "Implementer produced no commits" in the log → the agent did nothing. No PR is
  opened. Inspect why, then **remove and re-apply** the label to retry.
- A non-zero exit (red job) = the engine or an agent errored. The PR, if any,
  is whatever was pushed before the failure.

### Rollback / abort

- **Before or during a run:** remove the `agent:implement` label and, in the
  Actions tab, **Cancel** the in-progress run.
- **After a bad PR:** just close the PR (and delete the `sandcastle/issue-<n>`
  branch). Nothing was merged, so there is nothing to revert on `main`.
- Re-running is safe: the branch name is deterministic (`sandcastle/issue-<n>`),
  so a retry reuses/updates the same branch rather than spawning duplicates.

---

## Trigger a review pass

1. **Apply `agent:review` to a PULL REQUEST** (not an issue). The
   `agent-review.yml` runner fires on PR label events.
2. The runner checks out the PR head, runs the reviewer (opus, 1 iteration) for
   clarity/standards refinements, and **pushes any commits back onto the PR**.
   It never merges or closes anything.
3. Rollback: remove the label / cancel the run. Any pushed review commits live
   on the PR branch and can be dropped like any other commit.

> **Verify on first review run:** the standalone-review path (reviewing an
> existing PR branch rather than a fresh loop branch) is our interpretation of
> the 0.12.0 engine. Confirm the sandbox checks out the existing head branch and
> that the reviewer's `git diff` against `main` is non-empty. See
> `.sandcastle/agent-review-pr.ts` for the exact caveats.

---

## The auto-merge toggle (leave OFF for the pilot)

The implement runner ships in **PR mode**: agent opens a PR, human merges. This
is the safe default and there is no merge code in the default path.

**To re-enable auto-merge later**, once the pilot is trusted:

- In `.github/workflows/agent-implement.yml`, in the **"Run sandcastle implement
  runner"** step's `env:`, set:

  ```yaml
  SANDCASTLE_AUTO_MERGE: "true"
  ```

  With that set, `agent-implement-issue.ts` runs the stock merge phase
  (`merge-prompt.md`) instead of opening a PR: it merges the branch into the
  checked-out base and closes the issue.

- **Before trusting it**, prove the merge path on a throwaway issue: the stock
  merge prompt's exact push-to-`main` semantics are inherited from the engine
  and are themselves verify-on-first-run. Branch protection on `main` is the
  recommended backstop even after enabling auto-merge.

The toggle lives in exactly one place — that env var — and is read once in
`agent-implement-issue.ts`.

---

## Guard limitations (known gaps)

- **Sub-issue detection** uses a GraphQL `subIssues` query. If that field is
  unavailable on the repo's GitHub plan the query errors; the guard then logs a
  warning and falls back to the `epic`/`tracking` label check only (it does not
  hard-block). Keep epics labeled `epic`/`tracking` so they're refused reliably.
- **PRD-shaped parents** are detected via the `epic`/`tracking` labels + the
  sub-issue count. A parent that is neither labeled nor has GitHub sub-issues
  (e.g. a body-only checklist) would not be caught — pick clean targets.
- **Actor permission** is checked via the collaborator-permission API; only
  `admin`/`maintain`/`write` proceed.
