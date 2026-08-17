import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findChangesetProblems,
  highestBumpFor,
  NO_RELEASE_MARKER,
  parseChangeset,
} from "./changeset-lib.ts";

const CHANGESET_DIR = join(import.meta.dirname, "..", "..", ".changeset");

describe("parseChangeset", () => {
  it("reads a single quoted release", () => {
    const parsed = parseChangeset(
      "a.md",
      "---\n'@toon-protocol/swap': minor\n---\n\nbody\n",
    );
    expect(parsed.releases).toEqual([
      { packageName: "@toon-protocol/swap", bump: "minor" },
    ]);
    expect(parsed.malformedLines).toEqual([]);
    expect(parsed.missingFrontmatter).toBe(false);
  });

  it("reads unquoted and double-quoted names, and every bump level", () => {
    const parsed = parseChangeset(
      "a.md",
      '---\n@toon-protocol/swap: major\n"other": patch\n---\n',
    );
    expect(parsed.releases).toEqual([
      { packageName: "@toon-protocol/swap", bump: "major" },
      { packageName: "other", bump: "patch" },
    ]);
  });

  it("treats an empty frontmatter block as a valid parse with no releases", () => {
    const parsed = parseChangeset("a.md", "---\n---\n\nbody\n");
    expect(parsed.releases).toEqual([]);
    expect(parsed.missingFrontmatter).toBe(false);
    expect(parsed.declaredNoRelease).toBe(false);
  });

  it("reports a missing frontmatter block distinctly from an empty one", () => {
    const parsed = parseChangeset("a.md", "just some prose\n");
    expect(parsed.missingFrontmatter).toBe(true);
  });

  it("reports an unterminated frontmatter block as missing", () => {
    const parsed = parseChangeset("a.md", "---\n'@toon-protocol/swap': minor\n");
    expect(parsed.missingFrontmatter).toBe(true);
  });

  it("reports an unknown bump level as malformed rather than accepting it", () => {
    const parsed = parseChangeset(
      "a.md",
      "---\n'@toon-protocol/swap': breaking\n---\n",
    );
    expect(parsed.releases).toEqual([]);
    expect(parsed.malformedLines).toEqual(["'@toon-protocol/swap': breaking"]);
  });

  it("finds the no-release marker in the body", () => {
    const parsed = parseChangeset(
      "a.md",
      `---\n---\n\n<!-- ${NO_RELEASE_MARKER} — CI only -->\n\nbody\n`,
    );
    expect(parsed.declaredNoRelease).toBe(true);
  });

  it("does not read a marker out of the frontmatter block", () => {
    const parsed = parseChangeset(
      "a.md",
      `---\n# ${NO_RELEASE_MARKER}\n---\n\nbody\n`,
    );
    expect(parsed.declaredNoRelease).toBe(false);
  });
});

describe("findChangesetProblems", () => {
  it("passes a changeset that names a package", () => {
    const parsed = [
      parseChangeset("a.md", "---\n'@toon-protocol/swap': minor\n---\n\nbody\n"),
    ];
    expect(findChangesetProblems(parsed)).toEqual([]);
  });

  it("passes an empty changeset that declares no-release", () => {
    const parsed = [
      parseChangeset("a.md", `---\n---\n\n<!-- ${NO_RELEASE_MARKER} — CI -->\n`),
    ];
    expect(findChangesetProblems(parsed)).toEqual([]);
  });

  // This is swap#168 itself: the shape of all 22 offenders on `main`. The
  // changeset is valid YAML, `changeset version` accepts it, and it bumps
  // nothing — so this assertion is the whole reason the gate exists.
  it("BLOCKS an empty changeset that does not declare no-release", () => {
    const parsed = [
      parseChangeset(
        "issue-101-v2-eip712-balance-proof-digest.md",
        "---\n---\n\nThe swap node now signs the v2 EIP-712 digest.\n",
      ),
    ];
    const problems = findChangesetProblems(parsed);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("undeclared-empty");
    expect(problems[0]?.file).toBe(
      "issue-101-v2-eip712-balance-proof-digest.md",
    );
  });

  it("blocks a malformed frontmatter line", () => {
    const parsed = [
      parseChangeset("a.md", "---\n'@toon-protocol/swap': breaking\n---\n"),
    ];
    expect(findChangesetProblems(parsed)[0]?.kind).toBe("malformed-frontmatter");
  });

  it("blocks a file with no frontmatter block", () => {
    const parsed = [parseChangeset("a.md", "prose only\n")];
    expect(findChangesetProblems(parsed)[0]?.kind).toBe("missing-frontmatter");
  });

  it("reports every offender, not just the first", () => {
    const parsed = [
      parseChangeset("a.md", "---\n---\n\nbody\n"),
      parseChangeset("b.md", "---\n'@toon-protocol/swap': minor\n---\n"),
      parseChangeset("c.md", "---\n---\n\nbody\n"),
    ];
    expect(findChangesetProblems(parsed).map((p) => p.file)).toEqual([
      "a.md",
      "c.md",
    ]);
  });
});

describe("highestBumpFor", () => {
  it("picks the highest level across changesets", () => {
    const parsed = [
      parseChangeset("a.md", "---\n'@toon-protocol/swap': patch\n---\n"),
      parseChangeset("b.md", "---\n'@toon-protocol/swap': major\n---\n"),
      parseChangeset("c.md", "---\n'@toon-protocol/swap': minor\n---\n"),
    ];
    expect(highestBumpFor(parsed, "@toon-protocol/swap")).toBe("major");
  });

  it("ignores other packages and returns undefined when none match", () => {
    const parsed = [parseChangeset("a.md", "---\n'other': major\n---\n")];
    expect(highestBumpFor(parsed, "@toon-protocol/swap")).toBeUndefined();
  });
});

// The rule is only worth anything if the repo's own pending changesets satisfy
// it. This is the regression half of swap#168: it fails the moment a changeset
// is added that bumps nothing without saying so, whether or not CI runs the CLI.
describe("this repo's pending changesets", () => {
  const parsed = readdirSync(CHANGESET_DIR)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) =>
      parseChangeset(name, readFileSync(join(CHANGESET_DIR, name), "utf8")),
    );

  it("all satisfy the rule", () => {
    expect(findChangesetProblems(parsed)).toEqual([]);
  });

  it("every declared release names @toon-protocol/swap (the only publishable package)", () => {
    const names = new Set(
      parsed.flatMap((entry) => entry.releases.map((r) => r.packageName)),
    );
    expect([...names].filter((name) => name !== "@toon-protocol/swap")).toEqual(
      [],
    );
  });
});
