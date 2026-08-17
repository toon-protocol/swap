#!/usr/bin/env node
/**
 * CLI wiring for the empty-changeset rule (swap#168). See ./changeset-lib.ts
 * for what the rule is and why it is a marker rather than a ban.
 *
 * usage: changeset-check.ts [changesetDir]
 *
 * Exits 1 with a job summary when a changeset releases nothing without saying
 * so. Runs against the WHOLE `.changeset/` directory, not just the files a PR
 * touched: swap#168 was 22 files accumulated over five weeks, and a diff-scoped
 * check would have gone green on every one of the PRs that added them and green
 * again on every PR after. Whole-tree also means a rebase that drops a marker
 * line cannot slip through on a later PR that never touches the file.
 */

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  findChangesetProblems,
  highestBumpFor,
  NO_RELEASE_MARKER,
  parseChangeset,
  type ParsedChangeset,
} from './changeset-lib.ts';

const PUBLISHABLE_PACKAGE = '@toon-protocol/swap';

// `config.json` is the changesets config and `README.md` is its shipped
// boilerplate; neither is a changeset.
const NOT_A_CHANGESET = new Set(['README.md']);

function readChangesets(dir: string): readonly ParsedChangeset[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !NOT_A_CHANGESET.has(name))
    .sort()
    .map((name) => parseChangeset(name, readFileSync(join(dir, name), 'utf8')));
}

function writeSummary(lines: readonly string[]): void {
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryPath === undefined || summaryPath === '') {
    return;
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

function main(): void {
  const dir = process.argv[2] ?? '.changeset';
  const parsed = readChangesets(dir);

  console.log(`[changeset-check] ${String(parsed.length)} changeset(s) in ${dir}`);
  for (const entry of parsed) {
    const plan =
      entry.releases.length > 0
        ? entry.releases.map((r) => `${r.packageName}:${r.bump}`).join(', ')
        : entry.declaredNoRelease
          ? `no release (declared: ${NO_RELEASE_MARKER})`
          : 'no release (UNDECLARED)';
    console.log(`[changeset-check]   ${entry.file} — ${plan}`);
  }

  const bump = highestBumpFor(parsed, PUBLISHABLE_PACKAGE);
  console.log(
    `[changeset-check] ${PUBLISHABLE_PACKAGE} would take a ${bump ?? 'NO'} bump from these changesets`,
  );

  const problems = findChangesetProblems(parsed);
  if (problems.length === 0) {
    console.log('[changeset-check] every changeset either names a package or declares no-release');
    return;
  }

  const summary: string[] = [
    '## ❌ A changeset releases nothing without saying so',
    '',
    'A changeset with no package in its frontmatter bumps nothing, and its description',
    'never reaches a CHANGELOG — the reader of the npm package is told nothing. That is',
    'CORRECT for a CI-only or docs-only change and wrong for everything else, and the two',
    'look identical, which is how swap#168 happened: 22 of 26 pending changesets were',
    'empty, ~13 of them describing shipped behaviour, and `@toon-protocol/swap` sat at',
    '2.1.0 for five weeks.',
    '',
    '| changeset | problem |',
    '| --- | --- |',
  ];

  for (const problem of problems) {
    console.error(`::error::${problem.file}: ${problem.detail}`);
    summary.push(`| \`${problem.file}\` | ${problem.detail} |`);
  }

  summary.push(
    '',
    '**If the change reaches a consumer of `@toon-protocol/swap`** — source, types, the',
    'wire, the `toon-swap` CLI, a dependency floor — name the package and pick a level:',
    '',
    '```',
    '---',
    `'${PUBLISHABLE_PACKAGE}': patch | minor | major`,
    '---',
    '```',
    '',
    '**If it genuinely ships nothing to npm** — CI, agent tooling, a test, a comment, root',
    `docs — keep the frontmatter empty and add a \`${NO_RELEASE_MARKER}\` marker to the body`,
    'saying which, e.g.:',
    '',
    '```',
    '---',
    '---',
    '',
    `<!-- ${NO_RELEASE_MARKER} — .github/workflows only; nothing in the published tarball -->`,
    '```',
    '',
    'The marker is the whole point: empty has to be a sentence someone wrote, not a',
    'template left untouched.',
  );

  writeSummary(summary);
  process.exit(1);
}

main();
