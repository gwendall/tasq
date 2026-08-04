/**
 * Repository-wide test guard: never let a suite touch the developer's ledger.
 *
 * `configDir()` returns `process.env.TASQ_HOME || join(homedir(), ".tasq")`, so
 * running the suites in a shell that selects a real ledger made fixtures ("Buy
 * milk", "water plants") land in it. Exporting TASQ_HOME is the documented way
 * to pick a ledger and running the suites is the documented way to verify a
 * change; doing both must not be destructive.
 *
 * Preloaded by each package's `bunfig.toml`, this clears every ambient TASQ_*
 * variable and points HOME at a throwaway directory before any test module is
 * evaluated.
 *
 * It deliberately does NOT set TASQ_HOME. Suites isolate themselves by spawning
 * the CLI with a per-test `HOME`, relying on that homedir() fallback; an
 * inherited TASQ_HOME would override their choice through `...process.env` and
 * silently collapse every test in a file onto one shared ledger. Clearing the
 * variables and moving HOME gives the same protection without competing with
 * the isolation the suites already implement.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AMBIENT = [
  "TASQ_HOME",
  "TASQ_TENANT",
  "TASQ_ACTOR",
  "TASQ_DB_URL",
  "TASQ_EVENT_JOURNAL_PATH",
  "TASQ_PROJECTION_TARGET",
] as const;

const SANDBOX_MARKER = "tasq-test-home-";
const inherited = AMBIENT.filter((name) => process.env[name] !== undefined);

for (const name of AMBIENT) delete process.env[name];

if (!process.env.HOME?.includes(SANDBOX_MARKER)) {
  const sandbox = mkdtempSync(join(tmpdir(), SANDBOX_MARKER));
  process.env.HOME = sandbox;

  if (inherited.length > 0) {
    // Loud on purpose: a contributor who selected a ledger in this shell should
    // know the suites ignored it rather than silently wonder which store ran.
    // Children of a guarded process inherit a sandbox HOME and stay silent, so
    // this never pollutes the output a parent suite asserts on.
    process.stderr.write(
      `[tasq] ignoring inherited ${inherited.join(", ")}; tests run under ${sandbox}\n`,
    );
  }

  process.on("exit", () => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // A leaked temporary directory is not worth failing a green run over.
    }
  });
}
