#!/usr/bin/env bun

/**
 * Bun 1.3.11 can crash in native teardown on the macOS CI runner after the
 * subprocess- and SQLite-heavy eval matrix accumulates in one runtime. Keep
 * every eval and fail-fast behavior, but isolate files in fresh processes.
 */

import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const available = (await readdir(packageRoot))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const requested = process.argv.slice(2).filter((value) => value !== "--");
const tests = requested.length === 0
  ? available
  : requested.map((value) => basename(value));

if (tests.length === 0) throw new Error("No Tasq evals found");
for (const test of tests) {
  if (!available.includes(test)) throw new Error(`Unknown Tasq eval file: ${test}`);
  const child = Bun.spawn([process.execPath, "test", test], {
    cwd: packageRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
