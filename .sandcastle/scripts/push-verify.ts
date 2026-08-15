// Post-push tip verification (issue #108): a single immediate read of a
// remote branch ref races the push it's meant to verify — GitHub's API can
// still answer with the pre-push tip for a moment after a push that already
// landed. pollForSha() re-reads with retry/backoff instead of reading once,
// and the caller compares against the EXACT sha that was pushed (not "did
// the tip move at all").

export interface PollForShaOptions {
  /** Total time budget to keep polling, in ms. Default 30s (issue #108). */
  maxWaitMs?: number;
  /** Delay between reads, in ms. Default 5s. */
  delayMs?: number;
  /** Injectable for tests — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollForShaResult {
  matched: boolean;
  lastSha: string | null;
  attempts: number;
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
