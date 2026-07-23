// gate:correctness — fails the gate only on NEW lint/typecheck violations
// beyond the frozen `.sandcastle/gate-baseline.json` allowlist. Counts
// coming in at or below the frozen numbers pass; this is a ratchet, not a
// zero-tolerance gate — burning down the existing debt is a separate
// follow-up slice (swap#69).
//
// Usage: npx tsx .sandcastle/scripts/gate-correctness.ts
//        (wired as `pnpm run gate:correctness`)

import { spawnSync } from "node:child_process";
import { loadGateBaseline } from "./gate-baseline.ts";
import {
  countTypecheckErrors,
  evaluateCorrectness,
  summarizeEslintResults,
} from "./gate-lib.ts";
import type { EslintResult } from "./gate-lib.ts";

function run(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: "utf8" });
}

// Build BEFORE typecheck: tsc's resolution of the @toon-protocol/swap
// self-reference depends on packages/swap/dist existing (see
// gate-baseline.json's gateShape.note) — building first avoids inflating
// the error count with spurious module-resolution errors.
console.log("[gate:correctness] pnpm -r run build");
const build = run("pnpm", ["-r", "run", "build"]);
if (build.status !== 0) {
  console.error(build.stdout);
  console.error(build.stderr);
  console.error("[gate:correctness] build failed — cannot evaluate typecheck reliably");
  process.exit(build.status ?? 1);
}

console.log("[gate:correctness] eslint . -f json");
const lint = run("pnpm", ["exec", "eslint", ".", "-f", "json"]);
let eslintResults: EslintResult[];
try {
  eslintResults = JSON.parse(lint.stdout) as EslintResult[];
} catch {
  console.error(lint.stdout);
  console.error(lint.stderr);
  console.error("[gate:correctness] could not parse eslint JSON output");
  process.exit(1);
}
const lintCounts = summarizeEslintResults(eslintResults);

console.log("[gate:correctness] pnpm run typecheck");
const typecheck = run("pnpm", ["run", "typecheck"]);
const typecheckErrors = countTypecheckErrors(typecheck.stdout + typecheck.stderr);

const baseline = loadGateBaseline();
const current = {
  lint: lintCounts,
  typecheck: { errors: typecheckErrors },
};

const result = evaluateCorrectness(baseline.gateCorrectness, current);

console.log(
  `[gate:correctness] lint: ${current.lint.errors} errors / ${current.lint.warnings} warnings ` +
    `(frozen: ${baseline.gateCorrectness.lint.errors} / ${baseline.gateCorrectness.lint.warnings})`,
);
console.log(
  `[gate:correctness] typecheck: ${current.typecheck.errors} errors ` +
    `(frozen: ${baseline.gateCorrectness.typecheck.errors})`,
);

if (!result.pass) {
  console.error("[gate:correctness] FAIL — new violations beyond the frozen allowlist:");
  for (const violation of result.violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("[gate:correctness] PASS — no new violations beyond the frozen allowlist");
