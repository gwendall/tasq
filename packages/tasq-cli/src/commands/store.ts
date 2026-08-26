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

import { existsSync } from "node:fs";
import { listRecoveryPoints, restoreRecoveryPoint } from "@tasq-internal/local-service";
import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { configUrl, loadConfig } from "../config.js";
import { color, printError, printInfo, printJson } from "../output/format.js";
import { inspectConfiguredStore } from "../runtime.js";

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
  if (sub !== "status" && sub !== "recovery-points" && sub !== "restore") {
    printError(
      "usage: tasq store status\n"
      + "       tasq store recovery-points\n"
      + "       tasq store restore <recovery-point-id> [--force]",
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
