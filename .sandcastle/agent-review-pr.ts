// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is the single-pass replacement for the old 4-round `review-round:*`
// reviewer loop. It runs the reviewer role (review-prompt.md — two axes:
// Standards refinement + Spec review against the PR's target issue) against
// the PR's head branch, pushes any refinement commits back to the PR, and
// REQUIRES a structured verdict (toon-meta#275):
//   - the reviewer must emit <review>{"verdict":"clean"|"blocking",
//     "blockingFindings":[{file,line,summary,why}]}</review>; a malformed
//     verdict fails the run (one engine-style resume retry, then non-zero exit)
//   - on "blocking", the findings are posted as a PR review and the
//     `needs:human` label is applied
// It NEVER merges the PR and NEVER closes anything — a human still merges.
//
// STANDALONE-REVIEW MECHANICS (proven live on connector#634's first run):
//   Sandcastle checks the PR head branch out in its OWN worktree under
//   .sandcastle/worktrees/, and git refuses one branch in two worktrees — so
//   the workflow checks out MAIN, never the PR head. Because the local clone
//   is then on main, this runner materialises the PR head as a LOCAL branch
//   (git fetch origin +head:head) before createSandbox(): without it the
//   engine's `worktree add` falls back to `-b <branch> HEAD`, silently
//   reviewing an EMPTY diff off main. review-prompt.md's {{TARGET_BRANCH}}
//   resolves to the checked-out branch (main), so the diff base is right.
//
// The target issue for the Spec axis is resolved from the PR body's
// `Closes #n` (the implement runner writes one into every factory PR body).
// PRs without a closing reference get a Standards-only review.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write +
//                             issues:write (labels)
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: pnpm sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxSecrets } from "./sandbox-secrets.ts";
import {
  postBlockingVerdict,
  resolveIssueFromPrBody,
  runReviewerWithVerdict,
  type ReviewVerdict,
} from "./review-verdict.ts";

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

// Materialise the PR head as a local branch at origin's tip (the host clone is
// on main — see the standalone-review mechanics note above). Forced so a
// re-labeled PR re-reviews the CURRENT head even after a force-push.
execFileSync("git", ["fetch", "origin", `+${headRef}:${headRef}`], {
  stdio: "inherit",
});

// Resolve the Spec-axis target issue from the PR body's `Closes #n`.
const targetIssue = resolveIssueFromPrBody(prNumber);
console.log(
  targetIssue
    ? `Spec axis target: issue #${targetIssue.number} — ${targetIssue.title}`
    : "No `Closes #n` in the PR body — Standards-only review.",
);

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
      {
        command:
          'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; ' +
          "git config --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true; fi",
      },
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
  // review-push step's in-sandbox `git push` to the PR branch authenticates
  // with, and what the reviewer's in-sandbox `gh issue view` (Spec axis) reads.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

let verdict: ReviewVerdict;
try {
  const review = await runReviewerWithVerdict(sandbox, {
    branch: headRef,
    issue: targetIssue,
  });
  verdict = review.verdict;

  if (review.commits.length > 0) {
    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(
      `\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`,
    );
    // Record origin's PR-branch tip BEFORE the push so we can prove afterwards
    // that it actually advanced.
    const remoteShaBefore = remoteBranchSha(headRef);

    // DETERMINISTIC (no agent) — see toon-meta#235. This was an agent run
    // (review-push-prompt.md) whose only job was `git push origin <branch>`.
    // Run it directly; sandbox.exec() surfaces a non-zero exitCode (it does NOT
    // throw) — check it and fail loud.
    const push = await sandbox.exec(`git push origin ${headRef}`, {
      onLine: (line) => console.log(`  [push] ${line}`),
    });
    if (push.exitCode !== 0) {
      throw new Error(
        `git push of '${headRef}' failed (exit ${push.exitCode}).\n${push.stderr}`,
      );
    }

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
    console.log("\nReviewer made no changes — nothing to push.");
  }
} finally {
  await sandbox.close();
}

// The verdict's side effects run AFTER the sandbox is closed, from the
// authenticated host: findings must land on the PR even if the push
// verification below is about to fail the job.
if (verdict.verdict === "blocking") {
  postBlockingVerdict(prNumber, verdict, targetIssue);
} else {
  console.log("\nVerdict clean — no blocking findings.");
}

// Fail loud AFTER the sandbox is closed: a silently-failed push must turn the
// Actions job red, never green.
if (reviewPushVerificationError) {
  console.error(reviewPushVerificationError);
  process.exit(1);
}

console.log("\nReview complete. The PR was NOT merged — a human still merges.");
