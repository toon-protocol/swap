// The no-op merge guard (swap#189) is a bash step inlined in
// .github/workflows/ci.yml. This runs that exact step — read out of ci.yml, not
// copied — against throwaway repos shaped like `refs/pull/N/merge`: base tip as
// first parent, PR head as second.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CI_YML = join(import.meta.dirname, "../../.github/workflows/ci.yml");
const STEP_NAME = "A merge that changes nothing must not merge green";

function guardScript(): string {
  const lines = readFileSync(CI_YML, "utf8").split("\n");
  const step = lines.findIndex((l) => l.includes(`- name: ${STEP_NAME}`));
  if (step < 0) throw new Error(`step "${STEP_NAME}" not found in ci.yml`);
  const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  const runIndent = lines[run].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = body.find((l) => l.trim() !== "")!.search(/\S/);
  return body.map((l) => l.slice(indent)).join("\n");
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(
  cwd: string,
  file: string,
  content: string,
  message = `${file}: ${content}`,
): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", message);
}

// Builds main + a `pr` branch, lets `shape` move them, then checks out the
// merge the way GitHub builds refs/pull/N/merge. Returns the repo and PR head.
function mergeRef(shape: (repo: string) => void): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "no-op-guard-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "guard@test");
  git(repo, "config", "user.name", "guard");
  commitFile(repo, "README.md", "base");
  git(repo, "branch", "pr");
  shape(repo);
  const head = git(repo, "rev-parse", "pr");
  git(repo, "checkout", "-q", "--detach", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge", "pr");
  return { repo, head };
}

function runGuard(
  repo: string,
  env: { event?: string; head?: string; changedFiles?: number },
) {
  const summary = join(repo, ".step-summary");
  writeFileSync(summary, "");
  const result = spawnSync("bash", ["-c", guardScript()], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: env.event ?? "pull_request",
      GITHUB_STEP_SUMMARY: summary,
      PR_HEAD_SHA: env.head ?? "",
      PR_BASE_REF: "main",
      PR_NUMBER: "1",
      PR_CHANGED_FILES: String(env.changedFiles ?? ""),
    },
  });
  return { ...result, summary: readFileSync(summary, "utf8") };
}

describe("no-op merge guard (ci.yml)", () => {
  it("passes a PR whose merge changes files", () => {
    const { repo, head } = mergeRef((r) => {
      git(r, "checkout", "-q", "pr");
      commitFile(r, "feature.txt", "new");
    });
    const out = runGuard(repo, { head, changedFiles: 1 });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("changes 1 file(s)");
  });

  it("fails a PR whose content already landed on the base (connector#1008)", () => {
    const { repo, head } = mergeRef((r) => {
      git(r, "checkout", "-q", "pr");
      commitFile(r, "feature.txt", "same");
      git(r, "checkout", "-q", "main");
      // A different commit (another PR) carrying the same content.
      commitFile(r, "feature.txt", "same", "the other PR");
    });
    const out = runGuard(repo, { head, changedFiles: 1 });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("its content is already on main");
    expect(out.summary).toContain("Merging this PR would change nothing");
  });

  it("fails a PR whose own commits cancel out", () => {
    const { repo, head } = mergeRef((r) => {
      git(r, "checkout", "-q", "pr");
      commitFile(r, "README.md", "changed");
      commitFile(r, "README.md", "base");
    });
    const out = runGuard(repo, { head, changedFiles: 0 });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("this branch's commits cancel out");
  });

  it("warns and passes when the merge ref is stale", () => {
    const { repo } = mergeRef((r) => {
      git(r, "checkout", "-q", "pr");
      commitFile(r, "README.md", "changed");
      commitFile(r, "README.md", "base");
    });
    const out = runGuard(repo, { head: "0".repeat(40), changedFiles: 0 });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("merge ref is probably stale");
  });

  it("passes plainly on push, where there is no merge to evaluate", () => {
    const { repo } = mergeRef(() => {});
    const out = runGuard(repo, { event: "push" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("no merge result to evaluate");
  });
});
