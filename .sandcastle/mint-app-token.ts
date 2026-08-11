// Mint a FRESH GitHub App installation token, on demand, on the host.
//
// WHY THIS EXISTS — ported from connector#462 / connector#463
// -------------------------------------------------------------
// GitHub App installation tokens expire ONE HOUR after issue. This repo's
// workflow (.github/workflows/agent-implement.yml) minted a single token in
// an early step (`actions/create-github-app-token@v2`) and the runner pushed
// only after the implementer AND the reviewer had both finished. Any run
// longer than an hour would therefore die at the very last step:
//
//     remote: Invalid username or token. Password authentication is not
//     supported for Git operations.
//     Error: git push of 'sandcastle/issue-N' failed (exit 128).
//
// connector lost three completed implementations exactly this way (#430 at
// 77 min, #422 twice at 61/73 min — connector#462) before the fix below
// (connector#463, merged 2026-07-26, proven live on a >1h run in
// connector#459). swap has not been bitten yet (longest run to date: 22
// min), but raising `timeout-minutes` without this fix would only make the
// failure more expensive: the extra minutes get spent and the push still
// fails. See toon-meta#248 (fan-out) and swap#92 (this repo's row).
//
// THE FIX
// -------
// Keep the App's private key on the HOST (never in the sandbox container) and
// mint a brand-new installation token immediately before each push. The token is
// then at most seconds old, so run length stops mattering entirely.
//
// We mint here rather than adding a second `create-github-app-token@v2` step
// because the push happens from INSIDE the sandbox, part-way through this
// runner's execution — there is no workflow step boundary at that moment to hang
// an action off. See agent-implement-issue.ts for how the minted token is
// handed to git without ever appearing in argv or in the logs.
//
// LOCAL DEV / NO-APP FALLBACK
// --------------------------
// When APP_ID or APP_PRIVATE_KEY is absent (local runs, forks) this falls back
// to the ambient GH_TOKEN, so behaviour is exactly what it was before. The
// expiry problem is a CI-long-run problem; a local run has a token in the env
// already and no way to mint.
//
// PORT NOTE: swap is `"type": "module"` (package.json) and its runner already
// uses top-level `await` (agent-implement-issue.ts), unlike connector — the
// org's only `type: commonjs` + npm-workspaces repo, which has to wrap its
// async body in `main()`. This file ports the logic only; no such wrapper is
// needed here.

import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";

/** Minted token plus where it came from, for logging without leaking the value. */
export interface MintedToken {
  readonly token: string;
  /** 'app' = freshly minted (expiry reset). 'ambient' = pre-existing GH_TOKEN. */
  readonly source: "app" | "ambient";
}

/**
 * `owner/repo` for the current run. `GITHUB_REPOSITORY` is always set by
 * Actions; the `gh` fallback covers local invocation.
 */
function nameWithOwner(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) return fromEnv;
  return execFileSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { encoding: "utf8" },
  ).trim();
}

/**
 * RS256 JWT asserting the App's identity, valid for 9 minutes (GitHub rejects
 * anything over 10). `iat` is backdated 60s to absorb clock skew between the
 * runner and GitHub, which is the documented recommendation.
 */
function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  })}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  // APP_PRIVATE_KEY is a PEM. GitHub secrets preserve newlines, but a key that
  // has been round-tripped through a shell can arrive with literal `\n`; accept
  // both so a mis-pasted secret fails loudly at the API call rather than with an
  // opaque OpenSSL error here.
  const pem = privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
  return `${unsigned}.${signer.sign(pem, "base64url")}`;
}

async function githubJson(path: string, jwt: string, method: "GET" | "POST"): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "toon-protocol-sandcastle-runner",
    },
  });
  if (!res.ok) {
    // Body is App-level metadata, never the installation token itself (that is
    // only returned on success), so it is safe to surface.
    throw new Error(
      `GitHub API ${method} ${path} failed: ${res.status} ${res.statusText}\n${await res.text()}`,
    );
  }
  return res.json();
}

/**
 * Mint a fresh token for the App installation that covers this repository.
 *
 * The request carries no `repositories`/`permissions` body, so the token keeps
 * the installation's own scope — same as connector#463, and it is what makes the
 * `git push` and the host `gh` calls work without enumerating grants here.
 *
 * Requires `APP_ID` + `APP_PRIVATE_KEY` on the host. Falls back to the ambient
 * `GH_TOKEN` when they are absent. Throws if neither is available, since every
 * caller needs *some* credential.
 */
export async function mintAppToken(): Promise<MintedToken> {
  const appId = process.env.APP_ID?.trim();
  const privateKey = process.env.APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    const ambient = process.env.GH_TOKEN?.trim();
    if (!ambient) {
      throw new Error(
        "Cannot obtain a GitHub credential: APP_ID/APP_PRIVATE_KEY are unset " +
          "and there is no GH_TOKEN to fall back to.",
      );
    }
    return { token: ambient, source: "ambient" };
  }

  const jwt = appJwt(appId, privateKey);
  const repo = nameWithOwner();

  // The App is installed org-wide; ask GitHub which installation covers this
  // repo rather than hard-coding an installation id.
  const installation = (await githubJson(
    `/repos/${repo}/installation`,
    jwt,
    "GET",
  )) as { id?: number };
  if (typeof installation.id !== "number") {
    throw new Error(
      `GitHub returned no installation id for ${repo} — is the App installed on this repo?`,
    );
  }

  const minted = (await githubJson(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    "POST",
  )) as { token?: string };
  if (!minted.token) {
    throw new Error("GitHub returned an installation-token response with no `token` field.");
  }

  return { token: minted.token, source: "app" };
}
