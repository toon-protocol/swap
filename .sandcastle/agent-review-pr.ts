// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is the single-pass replacement for the old 4-round `review-round:*`
// reviewer loop. It runs the reviewer role (review-prompt.md — refactor for
// clarity while preserving behavior, enforce CODING_STANDARDS.md) against the
// PR's head branch, and pushes any refinement commits back to the PR. It NEVER
// merges the PR and NEVER closes anything — a human still merges.
//
// STANDALONE-REVIEW CAVEAT (verify on first run)
// ----------------------------------------------
// Sandcastle 0.12.0 exercises the reviewer only INSIDE the parallel loop's
// Phase 2, on a fresh `sandcastle/issue-*` branch it just created. Driving the
// same reviewer standalone against an already-existing PR head branch is our
// interpretation, not a documented engine feature. Two things to confirm on the
// first live run:
//   1. createSandbox({ branch: <existing PR head> }) checks out the EXISTING
//      branch (rather than failing because the ref already exists / creating a
//      divergent one). The workflow checks out the PR head first to help this.
//   2. The built-in {{TARGET_BRANCH}} inside review-prompt.md resolves to `main`
//      for a standalone sandbox. If the diff comes back empty, the base may be
//      resolving wrong — check the reviewer's logged `git diff` command.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: pnpm sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxSecrets } from "./sandbox-secrets.ts";

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    "SANDCASTLE_PR_NUMBER must be set to a numeric PR number " +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`,
  );
}

// Resolve the PR's head branch on the host. `gh` authenticates via GH_TOKEN.
const headRef = execFileSync(
  "gh",
  ["pr", "view", prNumber, "--json", "headRefName", "--jq", ".headRefName"],
  { encoding: "utf8" },
).trim();

if (!headRef) {
  throw new Error(`Could not resolve head branch for PR #${prNumber}.`);
}

const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container. The engine
      // (@ai-hero/sandcastle@0.12.0) configures git identity + safe.directory
      // but NO credential helper, so the review-push step's in-sandbox
      // `git push` to the PR branch is unauthenticated and only succeeds by
      // luck. `gh auth setup-git` installs `gh` as git's credential helper
      // (reads GH_TOKEN at push time, stores no token in any file). Guarded on
      // GH_TOKEN so token-less local dev no-ops rather than aborting setup. See
      // ./agent-implement-issue.ts for the full root-cause note.
      { command: 'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; fi' },
      { command: "pnpm install --frozen-lockfile" },
    ],
  },
};

// Reads origin's current tip SHA for a branch via the authenticated host `gh`.
// Returns null when the ref does not exist (or gh errors) — the caller treats a
// null as "cannot conclude" and does not fail on it.
function remoteBranchSha(ref: string): string | null {
  try {
    return execFileSync(
      "gh",
      ["api", `repos/{owner}/{repo}/git/ref/heads/${ref}`, "--jq", ".object.sha"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

console.log(
  `\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`,
);

// Set to a non-null message below when the review-push phase reported success
// but origin's PR branch tip did not advance. Recorded here so the `finally`
// still closes the sandbox before we fail the job non-zero.
let reviewPushVerificationError: string | null = null;

const sandbox = await sandcastle.createSandbox({
  branch: headRef,
  // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container (the engine's
  // env resolver does not — see ./sandbox-secrets.ts). GH_TOKEN is what the
  // review-push step's in-sandbox `git push` to the PR branch authenticates with.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

try {
  const review = await sandbox.run({
    name: "reviewer",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-sonnet-5"),
    promptFile: "./.sandcastle/review-prompt.md",
    promptArgs: { BRANCH: headRef },
  });

  if (review.commits.length > 0) {
    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(
      `\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`,
    );
    // Record origin's PR-branch tip BEFORE the push so we can prove afterwards
    // that it actually advanced.
    const remoteShaBefore = remoteBranchSha(headRef);

    await sandbox.run({
      name: "push-review",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-sonnet-5"),
      promptFile: "./.sandcastle/review-push-prompt.md",
      promptArgs: { BRANCH: headRef },
    });

    // FAIL LOUD. The push-review phase logs COMPLETE from its prompt regardless
    // of whether the in-sandbox `git push` actually landed, so we must NOT trust
    // it. Verify from the HOST that origin's PR-branch tip advanced. If the
    // reviewer produced commits but the remote tip did not move, the push failed
    // silently — exit non-zero so the Actions job goes red instead of green.
    // Same class of silent-push failure as store#50.
    const remoteShaAfter = remoteBranchSha(headRef);
    if (remoteShaAfter !== null && remoteShaAfter === remoteShaBefore) {
      reviewPushVerificationError =
        `\nERROR: the push-review phase reported COMPLETE, but origin's tip for ` +
        `branch '${headRef}' did not advance (still ${remoteShaAfter}).\n` +
        `  The reviewer made ${review.commits.length} commit(s), so the ` +
        `in-sandbox \`git push\` failed silently. Inspect the push-review phase ` +
        `logs above. The Actions job is failing deliberately so this is not ` +
        `mistaken for success.`;
    } else {
      console.log(
        `\nVerified: origin/${headRef} advanced to ${remoteShaAfter ?? "(unknown)"}.`,
      );
    }
  } else {
    console.log(
      "\nReviewer made no changes — the code was already clean. Nothing to push.",
    );
  }
} finally {
  await sandbox.close();
}

// Fail loud AFTER the sandbox is closed: a silently-failed push must turn the
// Actions job red, never green.
if (reviewPushVerificationError) {
  console.error(reviewPushVerificationError);
  process.exit(1);
}

console.log("\nReview complete. The PR was NOT merged — a human still merges.");
