import { describe, expect, it, vi } from "vitest";
import { parseLsRemoteSha, pollForSha } from "./push-verify.ts";

describe("pollForSha", () => {
  it("matches on the first read without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const readSha = vi.fn().mockReturnValue("abc123");

    const result = await pollForSha(readSha, "abc123", { sleep });

    expect(result).toEqual({ matched: true, lastSha: "abc123", attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a stale read (the swap#107 race) and matches once origin catches up", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    // First two reads see the PRE-push tip (origin hasn't caught up yet); the
    // third read is the pushed sha — the exact shape reported in issue #108.
    const readSha = vi
      .fn()
      .mockReturnValueOnce("49bc6995")
      .mockReturnValueOnce("49bc6995")
      .mockReturnValueOnce("1f82028f");

    const result = await pollForSha(readSha, "1f82028f", {
      sleep,
      delayMs: 5_000,
      maxWaitMs: 30_000,
    });

    expect(result).toEqual({ matched: true, lastSha: "1f82028f", attempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("gives up after the time budget and reports the last-seen sha", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const readSha = vi.fn().mockReturnValue("stale-sha");

    const result = await pollForSha(readSha, "expected-sha", {
      sleep,
      delayMs: 10_000,
      maxWaitMs: 25_000,
    });

    // 25s budget / 10s delay -> reads at t=0,10,20,30(>=25 stop) => 4 attempts
    expect(result).toEqual({
      matched: false,
      lastSha: "stale-sha",
      attempts: 4,
    });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("treats a persistently-missing ref (null reads) as never matching", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const readSha = vi.fn().mockReturnValue(null);

    const result = await pollForSha(readSha, "some-sha", {
      sleep,
      delayMs: 1_000,
      maxWaitMs: 2_000,
    });

    expect(result.matched).toBe(false);
    expect(result.lastSha).toBe(null);
  });
});

describe("parseLsRemoteSha", () => {
  it("extracts the sha from a single-ref `git ls-remote` line", () => {
    expect(
      parseLsRemoteSha("1f82028f9c2b3a4d5e6f7a8b9c0d1e2f3a4b5c6d\trefs/heads/main\n"),
    ).toBe("1f82028f9c2b3a4d5e6f7a8b9c0d1e2f3a4b5c6d");
  });

  it("returns null for empty output (branch does not exist on origin)", () => {
    expect(parseLsRemoteSha("")).toBe(null);
    expect(parseLsRemoteSha("\n")).toBe(null);
  });
});
