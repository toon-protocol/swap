// Shared, pure logic for the gate guard script (gate-correctness.ts). Kept side-effect-free and independently testable
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
  gateCorrectness: GateCorrectnessSnapshot;
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
