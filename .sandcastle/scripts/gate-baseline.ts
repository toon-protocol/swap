import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GateBaseline } from "./gate-lib.ts";

const BASELINE_PATH = fileURLToPath(
  new URL("../gate-baseline.json", import.meta.url),
);

export function loadGateBaseline(): GateBaseline {
  const raw = readFileSync(BASELINE_PATH, "utf8");
  const parsed = JSON.parse(raw) as {
    gateSpeed: GateBaseline["gateSpeed"];
    gatePerformance: {
      runnerMinutesBillable: { value: number };
      dockerImageSize: { value: number | null };
    };
    gateCorrectness: {
      lint: { errors: number; warnings: number };
      typecheck: { errors: number };
    };
    regressionTolerancePct: number;
  };

  return {
    gateSpeed: parsed.gateSpeed,
    gatePerformance: {
      runnerMinutesBillable: parsed.gatePerformance.runnerMinutesBillable.value,
      dockerImageSize: parsed.gatePerformance.dockerImageSize.value,
    },
    gateCorrectness: parsed.gateCorrectness,
    regressionTolerancePct: parsed.regressionTolerancePct,
  };
}
