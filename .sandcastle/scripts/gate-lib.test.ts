import { describe, expect, it } from "vitest";
import {
  countTypecheckErrors,
  evaluateCorrectness,
  evaluatePerformanceRegression,
  evaluateSpeedRegression,
  summarizeEslintResults,
} from "./gate-lib.ts";
import type {
  EslintResult,
  GateBaseline,
  GateCorrectnessSnapshot,
} from "./gate-lib.ts";

describe("summarizeEslintResults", () => {
  it("sums error and warning counts across all files", () => {
    const results: EslintResult[] = [
      { errorCount: 1, warningCount: 2 },
      { errorCount: 0, warningCount: 5 },
    ];
    expect(summarizeEslintResults(results)).toEqual({
      errors: 1,
      warnings: 7,
    });
  });

  it("returns zero counts for an empty result set", () => {
    expect(summarizeEslintResults([])).toEqual({ errors: 0, warnings: 0 });
  });
});

describe("countTypecheckErrors", () => {
  it("counts one match per 'error TS' occurrence", () => {
    const output = [
      "src/a.ts(1,1): error TS2532: Object is possibly 'undefined'.",
      "src/b.ts(2,2): error TS2307: Cannot find module 'x'.",
      "Found 2 errors.",
    ].join("\n");
    expect(countTypecheckErrors(output)).toBe(2);
  });

  it("returns 0 when there is no error line", () => {
    expect(countTypecheckErrors("")).toBe(0);
  });
});

describe("evaluateCorrectness", () => {
  const baseline: GateCorrectnessSnapshot = {
    lint: { errors: 0, warnings: 342 },
    typecheck: { errors: 32 },
  };

  it("passes when current counts are at or below the frozen baseline", () => {
    const current: GateCorrectnessSnapshot = {
      lint: { errors: 0, warnings: 342 },
      typecheck: { errors: 32 },
    };
    expect(evaluateCorrectness(baseline, current)).toEqual({
      pass: true,
      violations: [],
    });
  });

  it("passes and reports no violations when counts improve", () => {
    const current: GateCorrectnessSnapshot = {
      lint: { errors: 0, warnings: 300 },
      typecheck: { errors: 20 },
    };
    expect(evaluateCorrectness(baseline, current).pass).toBe(true);
  });

  it("fails when lint errors exceed the frozen baseline", () => {
    const current: GateCorrectnessSnapshot = {
      lint: { errors: 1, warnings: 342 },
      typecheck: { errors: 32 },
    };
    const result = evaluateCorrectness(baseline, current);
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("lint errors"),
    );
  });

  it("fails when lint warnings exceed the frozen baseline", () => {
    const current: GateCorrectnessSnapshot = {
      lint: { errors: 0, warnings: 343 },
      typecheck: { errors: 32 },
    };
    const result = evaluateCorrectness(baseline, current);
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("lint warnings"),
    );
  });

  it("fails when typecheck errors exceed the frozen baseline", () => {
    const current: GateCorrectnessSnapshot = {
      lint: { errors: 0, warnings: 342 },
      typecheck: { errors: 33 },
    };
    const result = evaluateCorrectness(baseline, current);
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("typecheck errors"),
    );
  });

  it("reports every violated metric, not just the first", () => {
    const current: GateCorrectnessSnapshot = {
      lint: { errors: 1, warnings: 343 },
      typecheck: { errors: 33 },
    };
    expect(evaluateCorrectness(baseline, current).violations).toHaveLength(3);
  });
});

describe("evaluateSpeedRegression", () => {
  const baseline: GateBaseline["gateSpeed"] = {
    lintMs: 10_000,
    typecheckMs: 5_000,
    testMs: 8_000,
    buildMs: 7_000,
    gateTotalMs: 30_000,
  };

  it("passes when current timings are within tolerance", () => {
    const current = { ...baseline };
    const result = evaluateSpeedRegression(baseline, current, 25);
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes when a phase is faster than baseline", () => {
    const current = { ...baseline, lintMs: 1_000 };
    expect(evaluateSpeedRegression(baseline, current, 25).pass).toBe(true);
  });

  it("passes when a phase is slower but within the tolerance band", () => {
    // 10_000 * 1.25 = 12_500 threshold
    const current = { ...baseline, lintMs: 12_000 };
    expect(evaluateSpeedRegression(baseline, current, 25).pass).toBe(true);
  });

  it("fails when a phase regresses beyond the tolerance band", () => {
    // 10_000 * 1.25 = 12_500 threshold
    const current = { ...baseline, lintMs: 13_000 };
    const result = evaluateSpeedRegression(baseline, current, 25);
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("lint"));
  });

  it("fails when the total gate wall-clock regresses beyond tolerance", () => {
    const current = { ...baseline, gateTotalMs: 40_000 };
    const result = evaluateSpeedRegression(baseline, current, 25);
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("total"),
    );
  });
});

describe("evaluatePerformanceRegression", () => {
  it("skips the runner-minutes check when the frozen baseline is zero", () => {
    const result = evaluatePerformanceRegression(
      { runnerMinutesBillable: 0, dockerImageSize: null },
      { runnerMinutesBillable: 0, dockerImageSize: null },
      25,
    );
    expect(result.pass).toBe(true);
    expect(result.skipped).toContainEqual(
      expect.stringContaining("runner-minutes"),
    );
  });

  it("skips the image-size check when no baseline size was captured", () => {
    const result = evaluatePerformanceRegression(
      { runnerMinutesBillable: 0, dockerImageSize: null },
      { runnerMinutesBillable: 0, dockerImageSize: 500_000_000 },
      25,
    );
    expect(result.pass).toBe(true);
    expect(result.skipped).toContainEqual(
      expect.stringContaining("image size"),
    );
  });

  it("skips the image-size check when no current measurement is available", () => {
    const result = evaluatePerformanceRegression(
      { runnerMinutesBillable: 0, dockerImageSize: 100_000_000 },
      { runnerMinutesBillable: 0, dockerImageSize: null },
      25,
    );
    expect(result.pass).toBe(true);
    expect(result.skipped).toContainEqual(
      expect.stringContaining("image size"),
    );
  });

  it("fails when the image size regresses beyond tolerance", () => {
    const result = evaluatePerformanceRegression(
      { runnerMinutesBillable: 0, dockerImageSize: 100_000_000 },
      { runnerMinutesBillable: 0, dockerImageSize: 126_000_000 },
      25,
    );
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("image size"),
    );
  });

  it("passes when the image size is within tolerance", () => {
    const result = evaluatePerformanceRegression(
      { runnerMinutesBillable: 0, dockerImageSize: 100_000_000 },
      { runnerMinutesBillable: 0, dockerImageSize: 124_000_000 },
      25,
    );
    expect(result.pass).toBe(true);
  });

  it("fails when billable runner-minutes regress beyond tolerance", () => {
    const result = evaluatePerformanceRegression(
      { runnerMinutesBillable: 10, dockerImageSize: null },
      { runnerMinutesBillable: 13, dockerImageSize: null },
      25,
    );
    expect(result.pass).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("runner-minutes"),
    );
  });
});
