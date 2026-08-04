/**
 * Repository-wide test guard: never let a suite touch the developer's ledger.
 *
 * `configDir()` resolves to `process.env.TASQ_HOME`, so running the suites in a
 * shell that selects a real ledger made fixtures ("Buy milk", "water plants")
 * land in it. Exporting TASQ_HOME is the documented way to pick a ledger and
 * running the suites is the documented way to verify a change; doing both must
 * not be destructive.
 *
 * Preloaded by `bunfig.toml`, this replaces every ambient Tasq variable with a
 * throwaway home before any test module is evaluated. A suite that wants its
 * own temporary home still overrides these freely; what it can no longer do is
 * inherit a real one by accident.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AMBIENT = ["TASQ_HOME", "TASQ_TENANT", "TASQ_ACTOR", "TASQ_DB_URL", "TASQ_EVENT_JOURNAL_PATH", "TASQ_PROJECTION_TARGET"] as const;

const inherited = AMBIENT.filter((name) => process.env[name] !== undefined);
const sandbox = mkdtempSync(join(tmpdir(), "tasq-test-home-"));

for (const name of AMBIENT) delete process.env[name];
process.env.TASQ_HOME = sandbox;

if (inherited.length > 0) {
  // Loud on purpose: a contributor who selected a ledger in this shell should
  // know the suites ignored it rather than silently wonder which store ran.
  console.warn(
    `[tasq] ignoring inherited ${inherited.join(", ")}; tests run against ${sandbox}`,
  );
}

process.on("exit", () => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // A leaked temporary directory is not worth failing a green run over.
  }
});
