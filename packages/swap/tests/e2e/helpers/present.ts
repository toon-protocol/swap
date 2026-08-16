/**
 * A narrowing guard for E2E fixtures built in `beforeAll`.
 *
 * These suites build their sender, session and swap result once in
 * `beforeAll` and read them from several `it()` bodies, which in TypeScript
 * means `T | null` at every use site. The obvious spelling is `fixture!`, and
 * the repo's lint gate counts every one of those (`@typescript-eslint/
 * no-non-null-assertion`) — a frozen ceiling exists precisely so a growing
 * pile of `!` cannot creep in unnoticed.
 *
 * `present()` narrows for real: it throws a named error naming the fixture,
 * which is also a better failure than `Cannot read properties of null` when a
 * `beforeAll` silently failed.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `${what} is missing — its beforeAll almost certainly failed; check the ` +
        'console output above for the boot error.'
    );
  }
  return value;
}
