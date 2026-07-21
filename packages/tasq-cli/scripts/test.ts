#!/usr/bin/env bun

/**
 * CLI files build releases, install packages, spawn many processes and load the
 * native SQLite driver. Bun's default cross-file parallelism can make those
 * independent certification suites contend or retain native teardown state on
 * the macOS CI runner. Keep every file, but run them fail-fast in fresh
 * sequential processes.
 */

import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const available = (await readdir(resolve(packageRoot, "test")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const requested = process.argv.slice(2).filter((value) => value !== "--");
const tests = requested.length === 0
  ? available
  : requested.map((value) => basename(value));

if (tests.length === 0) throw new Error("No Tasq CLI tests found");
for (const test of tests) {
  if (!available.includes(test)) throw new Error(`Unknown Tasq CLI test file: ${test}`);
  const child = Bun.spawn([process.execPath, "test", `test/${test}`], {
    cwd: packageRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
