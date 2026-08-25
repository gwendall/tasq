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
  // This one historical file creates 52 independent SQLite stores. On the
  // 7.5 GiB GitHub macOS arm64 runner, Bun 1.3.11 can reproducibly segfault
  // in native-driver teardown after ~51 cases. Preserve every case and its
  // fail-fast semantics while giving each entity suite fresh native state.
  const patterns = test === "state-machines.test.ts"
    ? ["^Task state machine", "^Goal state machine", "^Project state machine"]
    : [null];
  for (const pattern of patterns) {
    // Real LibSQL files, WAL negotiation and native-driver teardown can exceed
    // Bun's implicit five-second per-test limit on loaded CI hosts. Keep one
    // explicit package-wide ceiling high enough for I/O variance while every
    // assertion and the fail-fast process boundary remain unchanged.
    const args = [process.execPath, "test", "--timeout", "15000", `test/${test}`];
    if (pattern) args.push("--test-name-pattern", pattern);
    // A Bun runtime crash is not a test failure. Assertion failures exit 1;
    // the observed macOS crashes panic with exit 133 (and POSIX signal deaths
    // land in the 128+ range), at startup of arbitrary files. Retry the FILE a
    // bounded number of times, loudly, only for crash exits - a red test can
    // never be masked because exit 1 is excluded, and a persistent crash still
    // fails the job with its original code.
    const CRASH_RETRIES = 2;
    let exitCode = 1;
    for (let attempt = 0; attempt <= CRASH_RETRIES; attempt += 1) {
      const child = Bun.spawn(args, {
        cwd: packageRoot,
        env: process.env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      exitCode = await child.exited;
      const crashed = exitCode >= 128 || exitCode === 133;
      if (!crashed || attempt === CRASH_RETRIES) break;
      console.error(
        `[tasq test runner] bun crashed (exit ${exitCode}) running test/${test}` +
          `${pattern ? ` (${pattern})` : ""}; retrying (${attempt + 1}/${CRASH_RETRIES}) - ` +
          "this is a runtime crash, not a test failure",
      );
    }
    if (exitCode !== 0) process.exit(exitCode);
  }
}
