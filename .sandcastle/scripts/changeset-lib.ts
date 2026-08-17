/**
 * Changeset frontmatter inspection (swap#168).
 *
 * `changeset version` answers "is this a VALID release plan". It cannot answer
 * "is this the release plan the author MEANT", because a changeset that names
 * no package is perfectly valid — it is what `changeset add --empty` produces,
 * and it is the right shape for a CI-only or docs-only change. It is also what
 * you get by accident, and the two are byte-indistinguishable.
 *
 * swap#168 is what that costs: 22 of 26 pending changesets on `main` had empty
 * frontmatter, ~13 of them describing shipped behaviour of the published
 * `@toon-protocol/swap` — the v2 EIP-712 digest, the leg-B return path, the
 * `cli.ts` fix that made every log line in the released image a no-op. Each one
 * documented a real change, satisfied the "a changeset file exists" check, and
 * bumped nothing, so the npm package sat at 2.1.0 for five weeks while the
 * Docker image moved. Nothing was wrong with any individual file; the failure
 * was that "empty" carried no signal.
 *
 * So this module does not forbid empty. It requires empty to be SAID: an
 * explicit `changeset:no-release` marker in the body, which an author has to
 * type and a reviewer can see. An author can still mark a behavioural change
 * no-release and be wrong — no static check can tell prose from truth — but
 * they can no longer do it by leaving a template untouched, which is how all 22
 * happened.
 */

/** The marker that makes an empty changeset a decision instead of a default. */
export const NO_RELEASE_MARKER = 'changeset:no-release';

export type ChangesetBump = 'major' | 'minor' | 'patch';

export interface ChangesetRelease {
  readonly packageName: string;
  readonly bump: ChangesetBump;
}

export interface ParsedChangeset {
  readonly file: string;
  /** Package releases declared in the frontmatter, in file order. */
  readonly releases: readonly ChangesetRelease[];
  /** Frontmatter lines this parser could not read as a release. */
  readonly malformedLines: readonly string[];
  /** True when the body carries {@link NO_RELEASE_MARKER}. */
  readonly declaredNoRelease: boolean;
  /** True when the file has no `---` delimited frontmatter block at all. */
  readonly missingFrontmatter: boolean;
}

export type ChangesetProblemKind =
  | 'missing-frontmatter'
  | 'malformed-frontmatter'
  | 'undeclared-empty';

export interface ChangesetProblem {
  readonly file: string;
  readonly kind: ChangesetProblemKind;
  readonly detail: string;
}

const FRONTMATTER_DELIMITER = '---';

// `'@toon-protocol/swap': minor`, with the quotes optional because changesets
// accepts either. The bump alternatives are spelled out rather than captured
// loosely so an unknown level is reported here, next to the file name, instead
// of surfacing later as a changesets stack trace.
const RELEASE_LINE = /^\s*(['"]?)(?<name>[^'":]+)\1\s*:\s*(?<bump>major|minor|patch)\s*$/u;

/**
 * Split a changeset into its frontmatter lines and its body.
 *
 * Returns `undefined` when there is no frontmatter block, which is a distinct
 * condition from an EMPTY one: an empty block is a legitimate no-release
 * changeset, whereas a missing block means the file is not a changeset at all.
 */
function splitFrontmatter(
  source: string,
): { readonly frontmatter: readonly string[]; readonly body: string } | undefined {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return undefined;
  }

  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
      return {
        frontmatter: lines.slice(1, i),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }

  return undefined;
}

export function parseChangeset(file: string, source: string): ParsedChangeset {
  const split = splitFrontmatter(source);
  if (split === undefined) {
    return {
      file,
      releases: [],
      malformedLines: [],
      // The marker is read from the whole file here: a changeset with no
      // frontmatter is already failing, and looking for the marker in a body we
      // could not delimit would only add a second, confusing complaint.
      declaredNoRelease: source.includes(NO_RELEASE_MARKER),
      missingFrontmatter: true,
    };
  }

  const releases: ChangesetRelease[] = [];
  const malformedLines: string[] = [];

  for (const line of split.frontmatter) {
    if (line.trim() === '') {
      continue;
    }
    const match = RELEASE_LINE.exec(line);
    const groups = match?.groups;
    if (groups === undefined) {
      malformedLines.push(line.trim());
      continue;
    }
    const name = groups['name'];
    const bump = groups['bump'];
    // Both groups are non-optional in the pattern, so this is unreachable —
    // written as a guard rather than a `!` because the frozen lint baseline
    // forbids the assertion, and a narrowing guard costs nothing.
    if (name === undefined || bump === undefined) {
      malformedLines.push(line.trim());
      continue;
    }
    releases.push({
      packageName: name.trim(),
      bump: bump as ChangesetBump,
    });
  }

  return {
    file,
    releases,
    malformedLines,
    declaredNoRelease: split.body.includes(NO_RELEASE_MARKER),
    missingFrontmatter: false,
  };
}

/**
 * The rule: a changeset that releases nothing must say so on purpose.
 *
 * Deliberately NOT a rule about which packages a changeset ought to name. That
 * question needs the diff, the prose and a reviewer; this only removes the
 * silent default.
 */
export function findChangesetProblems(
  parsed: readonly ParsedChangeset[],
): readonly ChangesetProblem[] {
  const problems: ChangesetProblem[] = [];

  for (const entry of parsed) {
    if (entry.missingFrontmatter) {
      problems.push({
        file: entry.file,
        kind: 'missing-frontmatter',
        detail:
          'no `---` delimited frontmatter block. A changeset must open with one, even when it is empty.',
      });
      continue;
    }

    if (entry.malformedLines.length > 0) {
      problems.push({
        file: entry.file,
        kind: 'malformed-frontmatter',
        detail: `frontmatter line(s) that are not \`'<package>': major|minor|patch\`: ${entry.malformedLines
          .map((line) => JSON.stringify(line))
          .join(', ')}`,
      });
      continue;
    }

    if (entry.releases.length === 0 && !entry.declaredNoRelease) {
      problems.push({
        file: entry.file,
        kind: 'undeclared-empty',
        detail:
          'names no package, so it bumps nothing and its description will never reach a CHANGELOG.',
      });
    }
  }

  return problems;
}

/** The version bump a set of parsed changesets implies for one package. */
export function highestBumpFor(
  parsed: readonly ParsedChangeset[],
  packageName: string,
): ChangesetBump | undefined {
  const order: readonly ChangesetBump[] = ['patch', 'minor', 'major'];
  let highest: ChangesetBump | undefined;

  for (const entry of parsed) {
    for (const release of entry.releases) {
      if (release.packageName !== packageName) {
        continue;
      }
      if (highest === undefined || order.indexOf(release.bump) > order.indexOf(highest)) {
        highest = release.bump;
      }
    }
  }

  return highest;
}
