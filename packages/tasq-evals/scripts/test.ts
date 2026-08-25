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
  // A Bun runtime crash is not a test failure: assertion failures exit 1,
  // crash exits land at 133 or in the 128+ signal range, at startup of
  // arbitrary files on loaded CI hosts. Retry the file a bounded number of
  // times, loudly; exit 1 is never retried so a red test cannot be masked.
  const CRASH_RETRIES = 2;
  let exitCode = 1;
  for (let attempt = 0; attempt <= CRASH_RETRIES; attempt += 1) {
    const child = Bun.spawn([process.execPath, "test", test], {
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
      `[tasq test runner] bun crashed (exit ${exitCode}) running ${test}; ` +
        `retrying (${attempt + 1}/${CRASH_RETRIES}) - a runtime crash, not a test failure`,
    );
  }
  if (exitCode !== 0) process.exit(exitCode);
}
