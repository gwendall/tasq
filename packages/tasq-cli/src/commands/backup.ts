/**
 * `tasq backup` — atomic snapshot of the LibSQL DB to a file path.
 *
 * Uses SQLite's `VACUUM INTO '<path>'` which (a) writes a defragmented copy
 * of the DB (b) flushes WAL frames into it (c) is atomic with respect to
 * concurrent writers (WAL handles serialization). The resulting file is a
 * self-contained SQLite database identical in content to the source.
 *
 * Pairs with the append-only event journal (`~/.tasq/events.jsonl`) for
 * defense-in-depth: the journal mirrors emitted task-scoped audit events;
 * backups are replay-complete point-in-time DB snapshots.
 *
 * No `tasq restore` command on purpose — restore is a destructive operation
 * that an agent could trigger by accident. Recovery stays a deliberate
 * manual step: `cp ~/.tasq/snapshots/<file> ~/.tasq/db.sqlite` (after
 * removing the WAL sidecars).
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { openRuntime } from "../runtime.js";
import { color, printError, printInfo, printJson } from "../output/format.js";
import type { ParsedArgs } from "../args.js";
import { configDir } from "../config.js";
import { STORE_FORMAT_COMPATIBILITY, verifyDatabaseFile } from "@tasq-internal/local-service";

export async function backupCmd(args: ParsedArgs): Promise<number> {
  const json = args.bool("json", "j");
  const explicitTarget = args.string("target") ?? args.positional[0];
  const rotate = args.number("rotate");
  if (rotate != null && (!Number.isInteger(rotate) || rotate < 1)) {
    throw new Error("Invalid value for --rotate: expected an integer greater than or equal to 1");
  }

  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const target = explicitTarget ?? defaultBackupPath(rt.ctx.clock.now());
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    chmodSync(dirname(target), 0o700);

    // VACUUM INTO is the canonical SQLite "online backup". WAL-safe; the
    // source DB stays available to concurrent readers/writers throughout.
    await rt.client.execute({
      sql: `VACUUM INTO ?`,
      args: [target],
    });

    const verification = await verifyDatabaseFile(target);
    if (!verification.ok) {
      unlinkSync(target);
      throw new Error(
        `Backup verification failed: integrity=${verification.integrity}, foreignKeys=${verification.foreignKeyViolations}`,
      );
    }
    chmodSync(target, 0o600);

    const sizeBytes = statSync(target).size;
    const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
    const rotated = rotate != null ? rotateBackups(rotate) : [];

    if (json) {
      printJson({
        contractVersion: "tasq.backup-receipt.v1",
        ok: true,
        target,
        sizeBytes,
        sha256,
        verified: true,
        eventCursor: verification.eventCursor,
        storeFormat: STORE_FORMAT_COMPATIBILITY.current,
        rollbackRule: STORE_FORMAT_COMPATIBILITY.rollback,
        rotated,
      });
    } else {
      printInfo(color.green("✓") + ` backup written to ${target}`);
      printInfo(`  size: ${formatBytes(sizeBytes)}`);
      printInfo(`  sha256: ${sha256}`);
      printInfo(`  event cursor: ${verification.eventCursor ?? "unavailable"}`);
      if (rotated.length > 0) {
        printInfo(`  rotated ${rotated.length} old snapshot(s)`);
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

function defaultBackupPath(now: number): string {
  // ms-resolution stamp so back-to-back backups (or scripted retries) don't
  // collide on the same filename.
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
  return join(configDir(), "snapshots", `db-${stamp}.sqlite`);
}

/**
 * Keep the N most recent snapshots in `~/.tasq/snapshots/`, delete the rest.
 * Returns the list of deleted paths.
 */
function rotateBackups(keep: number): string[] {
  const dir = join(configDir(), "snapshots");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const snapshots = entries
    .filter((f) => f.startsWith("db-") && f.endsWith(".sqlite"))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = snapshots.slice(keep);
  for (const s of toDelete) unlinkSync(s.path);
  return toDelete.map((s) => s.path);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
