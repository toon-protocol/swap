// Shared, pure logic for the two gate guard scripts (gate-correctness.ts /
// gate-no-regression.ts). Kept side-effect-free and independently testable
// (gate-lib.test.ts) — the scripts themselves only wire this logic to real
// child-process output and process.exit, which unit tests don't need to
// exercise.

export interface EslintResult {
  errorCount: number;
  warningCount: number;
}

export interface GateCorrectnessSnapshot {
  lint: { errors: number; warnings: number };
  typecheck: { errors: number };
}

export interface GateBaseline {
  gateSpeed: {
    lintMs: number;
    typecheckMs: number;
    testMs: number;
    buildMs: number;
    gateTotalMs: number;
  };
  gatePerformance: {
    runnerMinutesBillable: number;
    dockerImageSize: number | null;
  };
  gateCorrectness: GateCorrectnessSnapshot;
  regressionTolerancePct: number;
}

export function summarizeEslintResults(results: EslintResult[]): {
  errors: number;
  warnings: number;
} {
  return results.reduce(
    (totals, result) => ({
      errors: totals.errors + result.errorCount,
      warnings: totals.warnings + result.warningCount,
    }),
    { errors: 0, warnings: 0 },
  );
}

export function countTypecheckErrors(output: string): number {
  const matches = output.match(/error TS\d+:/g);
  return matches ? matches.length : 0;
}

export function evaluateCorrectness(
  baseline: GateCorrectnessSnapshot,
  current: GateCorrectnessSnapshot,
): { pass: boolean; violations: string[] } {
  const violations: string[] = [];

  if (current.lint.errors > baseline.lint.errors) {
    violations.push(
      `lint errors regressed: ${current.lint.errors} > frozen baseline ${baseline.lint.errors}`,
    );
  }
  if (current.lint.warnings > baseline.lint.warnings) {
    violations.push(
      `lint warnings regressed: ${current.lint.warnings} > frozen baseline ${baseline.lint.warnings}`,
    );
  }
  if (current.typecheck.errors > baseline.typecheck.errors) {
    violations.push(
      `typecheck errors regressed: ${current.typecheck.errors} > frozen baseline ${baseline.typecheck.errors}`,
    );
  }

  return { pass: violations.length === 0, violations };
}

function exceedsTolerance(
  currentMs: number,
  baselineMs: number,
  tolerancePct: number,
): boolean {
  return currentMs > baselineMs * (1 + tolerancePct / 100);
}

export function evaluateSpeedRegression(
  baseline: GateBaseline["gateSpeed"],
  current: GateBaseline["gateSpeed"],
  tolerancePct: number,
): { pass: boolean; violations: string[] } {
  const violations: string[] = [];
  const phases: Array<[string, keyof GateBaseline["gateSpeed"]]> = [
    ["lint", "lintMs"],
    ["typecheck", "typecheckMs"],
    ["test", "testMs"],
    ["build", "buildMs"],
  ];

  for (const [label, key] of phases) {
    if (exceedsTolerance(current[key], baseline[key], tolerancePct)) {
      violations.push(
        `gate speed regressed (${label}): ${current[key]}ms > ${tolerancePct}% tolerance over frozen baseline ${baseline[key]}ms`,
      );
    }
  }

  if (
    exceedsTolerance(
      current.gateTotalMs,
      baseline.gateTotalMs,
      tolerancePct,
    )
  ) {
    violations.push(
      `gate speed regressed (total): ${current.gateTotalMs}ms > ${tolerancePct}% tolerance over frozen baseline ${baseline.gateTotalMs}ms`,
    );
  }

  return { pass: violations.length === 0, violations };
}

export function evaluatePerformanceRegression(
  baseline: GateBaseline["gatePerformance"],
  current: GateBaseline["gatePerformance"],
  tolerancePct: number,
): { pass: boolean; violations: string[]; skipped: string[] } {
  const violations: string[] = [];
  const skipped: string[] = [];

  if (baseline.runnerMinutesBillable <= 0) {
    skipped.push(
      "runner-minutes: frozen baseline is 0 (free/unlimited GitHub-hosted minutes) — nothing to regress against",
    );
  } else if (
    exceedsTolerance(
      current.runnerMinutesBillable,
      baseline.runnerMinutesBillable,
      tolerancePct,
    )
  ) {
    violations.push(
      `runner-minutes regressed: ${current.runnerMinutesBillable} > ${tolerancePct}% tolerance over frozen baseline ${baseline.runnerMinutesBillable}`,
    );
  }

  if (baseline.dockerImageSize === null) {
    skipped.push(
      "image size: no frozen baseline captured yet (no Docker daemon at capture time)",
    );
  } else if (current.dockerImageSize === null) {
    skipped.push(
      "image size: no current measurement available (no Docker daemon in this environment)",
    );
  } else if (
    exceedsTolerance(
      current.dockerImageSize,
      baseline.dockerImageSize,
      tolerancePct,
    )
  ) {
    violations.push(
      `image size regressed: ${current.dockerImageSize} bytes > ${tolerancePct}% tolerance over frozen baseline ${baseline.dockerImageSize} bytes`,
    );
  }

  return { pass: violations.length === 0, violations, skipped };
}
