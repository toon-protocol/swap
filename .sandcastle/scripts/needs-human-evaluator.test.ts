import { describe, expect, it } from "vitest";
import {
  NEEDS_HUMAN_LABEL,
  lastNeedsHumanApplier,
  shouldClearNeedsHuman,
  // @ts-expect-error -- .mjs sibling has no type declarations, see module header
} from "../needs-human-evaluator.mjs";

const BOT = "ALLiDoizCode";
const HUMAN = "some-maintainer";

const labeled = (actor: string, name: string = NEEDS_HUMAN_LABEL) => ({
  event: "labeled",
  label: { name },
  actor: { login: actor },
});
const unlabeled = (actor: string, name: string = NEEDS_HUMAN_LABEL) => ({
  event: "unlabeled",
  label: { name },
  actor: { login: actor },
});

describe("lastNeedsHumanApplier", () => {
  it("returns null for an empty or non-array timeline", () => {
    expect(lastNeedsHumanApplier([])).toBe(null);
    expect(lastNeedsHumanApplier(undefined)).toBe(null);
    expect(lastNeedsHumanApplier(null)).toBe(null);
  });

  it("returns the actor that applied the label", () => {
    expect(lastNeedsHumanApplier([labeled(BOT)])).toBe(BOT);
  });

  it("returns null once the label has been removed", () => {
    expect(lastNeedsHumanApplier([labeled(BOT), unlabeled(BOT)])).toBe(null);
  });

  it("takes the LAST application when the label was cycled", () => {
    // The exact shape that broke: bot applies, human clears, human re-applies.
    const timeline = [labeled(BOT), unlabeled(HUMAN), labeled(HUMAN)];
    expect(lastNeedsHumanApplier(timeline)).toBe(HUMAN);
  });

  it("ignores events for other labels", () => {
    const timeline = [
      labeled(HUMAN, "agent:review"),
      labeled(BOT),
      labeled(HUMAN, "risk:high"),
      unlabeled(BOT, "agent:review"),
    ];
    expect(lastNeedsHumanApplier(timeline)).toBe(BOT);
  });

  it("ignores unrelated timeline events", () => {
    const timeline = [
      { event: "commented", actor: { login: HUMAN } },
      labeled(BOT),
      { event: "reviewed", actor: { login: HUMAN } },
    ];
    expect(lastNeedsHumanApplier(timeline)).toBe(BOT);
  });

  it("survives malformed entries without throwing", () => {
    const timeline = [null, {}, { event: "labeled" }, labeled(BOT)];
    expect(lastNeedsHumanApplier(timeline)).toBe(BOT);
  });

  it("reports null when the applying actor is missing", () => {
    expect(
      lastNeedsHumanApplier([{ event: "labeled", label: { name: NEEDS_HUMAN_LABEL } }]),
    ).toBe(null);
  });
});

describe("shouldClearNeedsHuman", () => {
  it("clears what the approver applied — the wedge this fixes", () => {
    expect(shouldClearNeedsHuman([labeled(BOT)], BOT)).toBe(true);
  });

  it("NEVER clears a label a human applied", () => {
    expect(shouldClearNeedsHuman([labeled(HUMAN)], BOT)).toBe(false);
  });

  it("does not clear when a human re-applied after the approver", () => {
    // A human deliberately re-gating a PR must survive a later clean verdict.
    const timeline = [labeled(BOT), unlabeled(BOT), labeled(HUMAN)];
    expect(shouldClearNeedsHuman(timeline, BOT)).toBe(false);
  });

  it("clears when the approver re-applied after a human removed it", () => {
    const timeline = [labeled(HUMAN), unlabeled(HUMAN), labeled(BOT)];
    expect(shouldClearNeedsHuman(timeline, BOT)).toBe(true);
  });

  it("is a no-op when the label is not applied", () => {
    expect(shouldClearNeedsHuman([], BOT)).toBe(false);
    expect(shouldClearNeedsHuman([labeled(BOT), unlabeled(BOT)], BOT)).toBe(false);
  });

  it("fails closed with no approver identity", () => {
    expect(shouldClearNeedsHuman([labeled(BOT)], "")).toBe(false);
    expect(shouldClearNeedsHuman([labeled(BOT)], undefined)).toBe(false);
  });

  it("is case-sensitive on the login, matching GitHub's actor field", () => {
    expect(shouldClearNeedsHuman([labeled("allidoizcode")], BOT)).toBe(false);
  });
});
