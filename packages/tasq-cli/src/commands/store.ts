/**
 * `tasq store` — the recovery half of the migration safety envelope.
 *
 * PUBLIC_RELEASE_POLICY names `restore-matching-verified-pre-migration-snapshot-and-binary`
 * as the rollback rule in three places, and the migration machinery already
 * writes exactly what that rule needs: a verified snapshot beside a receipt
 * carrying its digest, integrity result and event cursor. Nothing read any of
 * it back, so recovery meant listing a hidden directory, matching a digest by
 * hand and copying a file over a live database. A documented safety rule with
 * no command behind it is not a safety rule.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  inspectStoreFormat,
  listRecoveryPoints,
  openDb,
  restoreRecoveryPoint,
  verifyDatabaseFile,
} from "@tasq-internal/local-service";
import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { configUrl, loadConfig } from "../config.js";
import { color, printError, printInfo, printJson } from "../output/format.js";
import { inspectConfiguredStore, openRuntime } from "../runtime.js";

function configuredStorePath(): string {
  const url = process.env.TASQ_DB_URL || configUrl(loadConfig());
  if (!url.startsWith("file:") || url.startsWith("file::memory:")) {
    throw new Error(`Recovery points require a filesystem store, not ${url}`);
  }
  return url.slice(5);
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function size(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

export async function storeCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const sub = args.positional[0];
  const known = ["status", "upgrade", "recovery-points", "restore", "clone"];
  if (!sub || !known.includes(sub)) {
    printError(
      "usage: tasq store status\n"
      + "       tasq store upgrade\n"
      + "       tasq store recovery-points\n"
      + "       tasq store restore <recovery-point-id> [--force]\n"
      + "       tasq store clone --to <dir>",
    );
    return 1;
  }
  const json = args.flag("json", "j") !== undefined;
  const dbPath = configuredStorePath();

  if (sub === "status") {
    const inspection = await inspectConfiguredStore(args.string("tenant"));
    if (json) {
      printJson(inspection);
      return 0;
    }
    if (!inspection.existingStore) {
      printInfo(color.dim(`no store yet at ${inspection.dbUrl}`));
      return 0;
    }
    const upgrade = inspection.requiresIrreversibleUpgrade
      ? color.yellow(`upgrade pending → ${inspection.current} (irreversible)`)
      : color.green("up to date");
    printInfo(`${inspection.dbUrl}\n  format ${inspection.format}  ${upgrade}`);
    for (const entry of inspection.pending) printInfo(color.dim(`    ${entry.name}`));
    if (!inspection.readableByThisExecutable) {
      printInfo(color.red(`  this store is NEWER than this executable (writes ${inspection.current})`));
    }
    return 0;
  }



  if (sub === "upgrade") {
    const inspection = await inspectConfiguredStore(args.string("tenant"));
    if (!inspection.requiresIrreversibleUpgrade) {
      if (json) {
        printJson({ ...inspection, contractVersion: "tasq.store-upgrade.v1", ok: true, upgraded: false });
        return 0;
      }
      printInfo(color.green("✓") + ` already format ${inspection.format}; nothing to upgrade`);
      return 0;
    }

    const before = inspection.format;
    // Typing `store upgrade` IS the consent, so the gate steps aside for the
    // command that exists to express it - and only for that command.
    const previous = process.env.TASQ_ALLOW_STORE_UPGRADE;
    process.env.TASQ_ALLOW_STORE_UPGRADE = "1";
    try {
      const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
      await rt.close();
    } finally {
      if (previous === undefined) delete process.env.TASQ_ALLOW_STORE_UPGRADE;
      else process.env.TASQ_ALLOW_STORE_UPGRADE = previous;
    }

    const after = await inspectConfiguredStore(args.string("tenant"));
    const point = (await listRecoveryPoints(dbPath))[0];
    if (json) {
      printJson({
        contractVersion: "tasq.store-upgrade.v1",
        ok: true,
        upgraded: true,
        formatBefore: before,
        formatAfter: after.format,
        applied: inspection.pending.map((entry) => entry.name),
        recoveryPointId: point?.id ?? null,
      });
      return 0;
    }
    printInfo(`${color.green("✓")} upgraded format ${before} → ${after.format}`);
    for (const entry of inspection.pending) printInfo(color.dim(`    ${entry.name}`));
    if (point) {
      printInfo(color.dim(`  roll back with: tasq store restore ${point.id}`));
    }
    return 0;
  }

  if (sub === "clone") {
    const to = args.string("to");
    if (!to) {
      printError("usage: tasq store clone --to <dir>");
      return 1;
    }
    const outcome = await cloneStore(dbPath, resolve(to));
    if (json) {
      printJson(outcome);
      return 0;
    }
    printInfo(`${color.green("✓")} cloned to ${outcome.home}`);
    printInfo(`  format ${outcome.format}  ${size(outcome.sizeBytes)}`);
    printInfo(color.dim(`  work on it with: TASQ_HOME=${outcome.home} tasq <command>`));
    return 0;
  }

  const points = await listRecoveryPoints(dbPath);

  if (sub === "recovery-points") {
    if (json) {
      printJson({ contractVersion: "tasq.recovery-points.v1", store: dbPath, recoveryPoints: points });
      return 0;
    }
    if (points.length === 0) {
      printInfo(color.dim("no recovery points; one is written before every irreversible upgrade"));
      return 0;
    }
    for (const point of points) {
      const mark = point.usable ? color.green("●") : color.red("○");
      printInfo(`${mark} ${point.id}`);
      printInfo(`    ${stamp(point.startedAt)}  format ${point.sourceFormat} → ${point.targetFormat}`
        + `  ${size(point.snapshotSizeBytes)}  ${point.status}`);
      if (!point.usable) printInfo(color.red(`    unusable: ${point.unusableReason}`));
    }
    printInfo(color.dim("\nrestore one with `tasq store restore <id>`"));
    return 0;
  }

  const id = args.positional[1];
  if (!id) {
    printError("usage: tasq store restore <recovery-point-id> [--force]");
    return 1;
  }
  if (!existsSync(dbPath)) printInfo(color.dim(`no store at ${dbPath}; restoring into place`));

  const outcome = await restoreRecoveryPoint(dbPath, id, {
    now: clock.now(),
    force: args.flag("force") !== undefined,
  });
  if (json) {
    printJson(outcome);
    return 0;
  }
  printInfo(`${color.green("✓")} restored ${outcome.restored.id}`);
  printInfo(`  format ${outcome.formatBefore} → ${outcome.formatAfter}`);
  if (outcome.eventsDropped > 0) {
    printInfo(color.yellow(`  ${outcome.eventsDropped} event(s) written after this point were discarded`));
  }
  printInfo(color.dim(`  the replaced store was kept at ${outcome.replacedStorePath}`));
  return 0;
}

interface CloneOutcome {
  contractVersion: "tasq.store-clone.v1";
  source: string;
  home: string;
  dbPath: string;
  format: number | null;
  sizeBytes: number;
  journalCopied: boolean;
}

/**
 * Produce a Tasq home that is genuinely independent of the one it came from.
 *
 * Two things make a hand-rolled copy wrong, and the second is invisible:
 *
 *   - config.json holds dbPath and eventJournalPath as ABSOLUTE paths, so a
 *     copied home still drives the original. Rehearsing a migration on such a
 *     copy destroys the store it was rehearsing for, which is what happened to
 *     this project's own ledger on 2026-08-26.
 *   - the database runs in WAL mode, so `cp db.sqlite` without its -wal
 *     sidecar yields a silently EMPTY OR STALE store. Reproduced with a 4 KiB
 *     db.sqlite whose entire content sat in a 1.5 MiB WAL.
 *
 * So this uses VACUUM INTO, the canonical WAL-safe online copy, and rewrites
 * every path in the cloned config to point inside the clone. The source store
 * is never migrated: cloning a store you are unsure about is exactly when you
 * must not modify it.
 */
async function cloneStore(sourceDbPath: string, home: string): Promise<CloneOutcome> {
  if (existsSync(home) && readdirSync(home).length > 0) {
    throw new Error(`Refusing to clone into a non-empty directory: ${home}`);
  }
  if (!existsSync(sourceDbPath)) throw new Error(`No store to clone at ${sourceDbPath}`);

  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const clonedDb = join(home, "db.sqlite");

  const source = await openDb({ url: `file:${sourceDbPath}` });
  let format: number | null;
  try {
    // Read the format before copying so the clone can be described without
    // opening it through a path that would migrate it.
    format = (await inspectStoreFormat(source.client)).format;
    await source.client.execute({ sql: "VACUUM INTO ?", args: [clonedDb] });
  } finally {
    await source.close();
  }

  const verification = await verifyDatabaseFile(clonedDb);
  if (!verification.ok) {
    unlinkSync(clonedDb);
    throw new Error(
      `Clone verification failed: integrity=${verification.integrity}, `
      + `foreignKeys=${verification.foreignKeyViolations}`,
    );
  }
  chmodSync(clonedDb, 0o600);

  const loaded = loadConfig();
  const clonedJournal = join(home, "events.jsonl");
  let journalCopied = false;
  if (loaded.eventJournalPath && existsSync(loaded.eventJournalPath)) {
    copyFileSync(loaded.eventJournalPath, clonedJournal);
    chmodSync(clonedJournal, 0o600);
    journalCopied = true;
  }

  // projectionTarget is deliberately dropped rather than rewritten: a clone
  // must never write a projection over the file the original maintains.
  writeFileSync(join(home, "config.json"), `${JSON.stringify({
    dbPath: clonedDb,
    eventJournalPath: clonedJournal,
    tenantId: loaded.tenantId,
    defaultActor: loaded.defaultActor,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    contractVersion: "tasq.store-clone.v1",
    source: sourceDbPath,
    home,
    dbPath: clonedDb,
    format,
    sizeBytes: statSync(clonedDb).size,
    journalCopied,
  };
}
