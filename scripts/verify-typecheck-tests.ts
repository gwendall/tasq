#!/usr/bin/env bun
/**
 * Keep the type checker looking at the tests.
 *
 * No package included its tests in the typecheck scope, so a test could call an
 * API that does not exist and pass - which is how several tests came to pass
 * `durationMs` to a function whose option is `leaseMs`, silently receiving the
 * default lease while asserting against something else.
 *
 * Adding the scope surfaced 66 pre-existing errors, and a gate that fails on 66
 * known errors only teaches people to skip it. So the ones already clean are
 * held clean, and the rest are named here with their count.
 *
 * The list is checked in BOTH directions. A package that is not on it may not
 * have errors, and a package that IS on it may not be clean: a list that only
 * ever grows stale in the direction of forgiveness is not a list, it is an
 * excuse. Clear a package, delete its line, and it can never come back.
 */

import { resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "..");

/** Packages with pre-existing errors, and how many. Delete a line when it hits zero. */
const KNOWN_UNCHECKED: Record<string, number> = {
  "tasq-core": 22,
  "tasq-service": 14,
  "tasq-schema": 8,
  "tasq-mcp": 7,
};

const child = Bun.spawn(
  ["pnpm", "-r", "--no-bail", "--if-present", "typecheck:tests"],
  { cwd: productRoot, stdout: "pipe", stderr: "pipe", env: process.env },
);
const [stdout, stderr] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
await child.exited;
const output = `${stdout}${stderr}`;

const counts = new Map<string, number>();
for (const line of output.split("\n")) {
  const match = /^packages\/([a-z0-9-]+) typecheck:tests: .*error TS\d+/.exec(line);
  if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
}

const problems: string[] = [];
for (const [name, count] of [...counts].sort()) {
  const allowed = KNOWN_UNCHECKED[name];
  if (allowed === undefined) {
    problems.push(
      `${name} has ${count} type error(s) in its tests, and was clean.\n`
      + "    A test that does not typecheck can call an API that does not exist and still pass.",
    );
  } else if (count > allowed) {
    problems.push(
      `${name} has ${count} type error(s), up from the recorded ${allowed}.\n`
      + "    Fix the new ones rather than raising the number.",
    );
  }
}
for (const [name, allowed] of Object.entries(KNOWN_UNCHECKED)) {
  const actual = counts.get(name) ?? 0;
  if (actual === 0) {
    problems.push(
      `${name} is clean but still listed as having ${allowed} error(s).\n`
      + "    Delete its line from KNOWN_UNCHECKED so it can never regress.",
    );
  } else if (actual < allowed) {
    problems.push(
      `${name} is down to ${actual} error(s) from ${allowed}.\n`
      + `    Lower its line to ${actual} so the ground you gained is held.`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Test typecheck rejected:\n${problems.map((entry) => `  - ${entry}`).join("\n")}\n`,
  );
  process.exit(1);
}

const remaining = [...Object.values(KNOWN_UNCHECKED)].reduce((sum, count) => sum + count, 0);
process.stdout.write(`${JSON.stringify({
  contractVersion: "tasq.test-typecheck.v1",
  cleanPackages: 14 - Object.keys(KNOWN_UNCHECKED).length,
  knownUnchecked: KNOWN_UNCHECKED,
  remaining,
  ok: true,
}, null, 2)}\n`);
