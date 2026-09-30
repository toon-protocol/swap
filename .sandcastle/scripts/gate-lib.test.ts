import { describe, expect, it } from "vitest";
import {
  countTypecheckErrors,
  evaluateCorrectness,
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
