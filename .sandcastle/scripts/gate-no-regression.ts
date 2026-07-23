// gate:no-regression — fails the gate when gate speed (wall-clock) or gate
// performance (runner-minutes / Docker image size) regress beyond the
// frozen `.sandcastle/gate-baseline.json` numbers (+ regressionTolerancePct).
// Reads the FROZEN baseline, never a live/recomputed threshold, so the same
// commit always earns the same verdict (no false FAIL from a moving target).
//
// Usage: npx tsx .sandcastle/scripts/gate-no-regression.ts
//        (wired as `pnpm run gate:no-regression`)
//
// Optional env var GATE_DOCKER_IMAGE_SIZE_BYTES lets a caller with a Docker
// daemon (e.g. .github/workflows/agent-image.yml) feed in a freshly measured
// image size; without it the image-size check is skipped (matches the
// baseline's own `null` semantics — see gate-baseline.json).

import { spawnSync } from "node:child_process";
import { loadGateBaseline } from "./gate-baseline.ts";
import {
  evaluatePerformanceRegression,
  evaluateSpeedRegression,
} from "./gate-lib.ts";

function timed(label: string, command: string, args: string[]): number {
  console.log(`[gate:no-regression] ${label}: ${command} ${args.join(" ")}`);
  const start = Date.now();
  spawnSync(command, args, { encoding: "utf8" });
  return Date.now() - start;
}

// Same order as the baseline capture (gateShape.order in gate-baseline.json)
// so the comparison is apples-to-apples. Exit codes are ignored here —
// correctness (pass/fail) is gate-correctness.ts's job; this script only
// measures wall-clock.
const lintMs = timed("lint", "pnpm", ["exec", "eslint", "."]);
const buildMs = timed("build", "pnpm", ["-r", "run", "build"]);
const typecheckMs = timed("typecheck", "pnpm", ["run", "typecheck"]);
const testMs = timed("test", "pnpm", ["run", "test"]);
const gateTotalMs = lintMs + buildMs + typecheckMs + testMs;

const baseline = loadGateBaseline();
const currentSpeed = { lintMs, buildMs, typecheckMs, testMs, gateTotalMs };

const speedResult = evaluateSpeedRegression(
  baseline.gateSpeed,
  currentSpeed,
  baseline.regressionTolerancePct,
);

const currentImageSizeRaw = process.env["GATE_DOCKER_IMAGE_SIZE_BYTES"];
const currentPerformance = {
  runnerMinutesBillable: baseline.gatePerformance.runnerMinutesBillable,
  dockerImageSize: currentImageSizeRaw ? Number(currentImageSizeRaw) : null,
};

const performanceResult = evaluatePerformanceRegression(
  baseline.gatePerformance,
  currentPerformance,
  baseline.regressionTolerancePct,
);

console.log(
  `[gate:no-regression] gate total: ${gateTotalMs}ms (frozen baseline: ${baseline.gateSpeed.gateTotalMs}ms, tolerance ${baseline.regressionTolerancePct}%)`,
);
for (const skip of performanceResult.skipped) {
  console.log(`[gate:no-regression] skipped: ${skip}`);
}

const violations = [...speedResult.violations, ...performanceResult.violations];

if (violations.length > 0) {
  console.error("[gate:no-regression] FAIL — regression(s) beyond the frozen baseline:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("[gate:no-regression] PASS — no speed/performance regression beyond the frozen baseline");
