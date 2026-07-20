#!/usr/bin/env bun

/**
 * Bun 1.3.11 can crash late in this SQLite-heavy suite on macOS when every
 * file shares one process. Keep the same deterministic file set and fail-fast
 * semantics while giving each file a fresh runtime and native-driver state.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const tests = (await readdir(resolve(packageRoot, "test")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

if (tests.length === 0) throw new Error("No Tasq service tests found");

for (const test of tests) {
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
