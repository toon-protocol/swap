// Post-push tip verification (issue #108): a single immediate read of a
// remote branch ref races the push it's meant to verify — GitHub's API can
// still answer with the pre-push tip for a moment after a push that already
// landed. pollForSha() re-reads on a fixed interval until the ref catches up
// or a time budget runs out, and it matches the EXACT sha that was pushed
// (not "did the tip move at all").
//
// readRemoteHead() (issue #121, porting toon-meta#398) is the read primitive
// pollForSha is meant to be called with: it queries origin via
// `git ls-remote`, NOT `gh api repos/{owner}/{repo}/git/ref/heads/<branch>`.
// The REST ref endpoint is served from a read replica and can itself return
// the PRE-push SHA for seconds after a push lands — polling narrows that
// window but keeps hitting the same lagging replica every attempt.
// `ls-remote` talks to the same git backend the push just wrote to, so it
// does not lag it.

import { execFileSync } from "node:child_process";

export interface PollForShaOptions {
  /** Total time budget to keep polling, in ms. Default 30s (issue #108). */
  maxWaitMs?: number;
  /** Delay between reads, in ms. Default 5s. */
  delayMs?: number;
  /** Injectable for tests — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollForShaResult {
  /** True when some read returned `expectedSha`. */
  matched: boolean;
  /** The sha the final read returned — null when the ref was unreadable. */
  lastSha: string | null;
  /** How many times `readSha()` was called (always at least 1). */
  attempts: number;
}

// Parses `git ls-remote origin refs/heads/<branch>`'s stdout — a single
// `<sha>\t<ref>` line, or empty output when the ref does not exist on
// origin — into just the sha.
export function parseLsRemoteSha(output: string): string | null {
  const trimmed = output.trim();
  return trimmed ? (trimmed.split(/\s+/)[0] ?? null) : null;
}

// Reads a branch's current tip sha from origin via `git ls-remote`. Returns
// null when the branch does not exist on origin (or the read errors) — a
// null never equals the pushed sha, so pollForSha() keeps polling on it.
export function readRemoteHead(ref: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["ls-remote", "origin", `refs/heads/${ref}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseLsRemoteSha(out);
  } catch {
    return null;
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Calls `readSha()` until it returns `expectedSha` or the time budget runs
// out, waiting `delayMs` between reads. Always reads at least once.
export async function pollForSha(
  readSha: () => string | null,
  expectedSha: string,
  options: PollForShaOptions = {},
): Promise<PollForShaResult> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const delayMs = options.delayMs ?? 5_000;
  const sleep = options.sleep ?? realSleep;

  let waitedMs = 0;
  let attempts = 0;
  let lastSha: string | null = null;

  for (;;) {
    attempts += 1;
    lastSha = readSha();
    if (lastSha === expectedSha) {
      return { matched: true, lastSha, attempts };
    }
    if (waitedMs >= maxWaitMs) {
      return { matched: false, lastSha, attempts };
    }
    await sleep(delayMs);
    waitedMs += delayMs;
  }
}
