import { diagnoseStore, listEvents } from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { checkpointJournal } from "../journal.js";
import { openRuntime } from "../runtime.js";
import { color, printError, printInfo, printJson } from "../output/format.js";

export async function journalCmd(args: ParsedArgs): Promise<number> {
  const [sub] = args.positional;
  if (sub !== "checkpoint") {
    printError("journal checkpoint --accept-database --reason <text> [--dry-run]");
    return 1;
  }
  const reason = args.string("reason");
  const dryRun = args.bool("dry-run");
  if (!reason?.trim()) throw new Error("journal checkpoint requires a non-empty --reason");
  if (!dryRun && !args.bool("accept-database")) {
    printError("journal checkpoint requires --accept-database (or use --dry-run)");
    return 1;
  }

  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const store = await diagnoseStore(rt.db, rt.client, rt.config.tenantId);
    if (!store.ok) {
      throw new Error(`Refusing journal checkpoint: store has ${store.issues.length} invariant issue(s)`);
    }
    const events = await listEvents(rt.db, {
      tenantId: rt.config.tenantId,
      ascending: true,
      limit: 1_000_000,
    });
    const last = events.at(-1) ?? null;
    const journalPath = process.env.TASQ_EVENT_JOURNAL_PATH ?? rt.config.eventJournalPath;
    if (!journalPath) throw new Error("Event journal is disabled");

    if (dryRun) {
      const plan = {
        ok: true,
        dryRun: true,
        journalPath,
        databaseCursor: last?.sequence ?? 0,
        databaseEventId: last?.id ?? null,
        reason: reason.trim(),
      };
      if (args.bool("json", "j")) printJson(plan);
      else printInfo(`would checkpoint ${journalPath} at DB cursor ${plan.databaseCursor}`);
      return 0;
    }

    const result = checkpointJournal({
      path: journalPath,
      tenantId: rt.config.tenantId,
      databaseCursor: last?.sequence ?? 0,
      databaseEventId: last?.id ?? null,
      actor: rt.ctx.actor ?? rt.config.defaultActor,
      reason,
      clock: rt.ctx.clock,
    });
    const output = {
      ok: true,
      journalPath,
      checkpoint: result.checkpoint,
      archivePath: result.archivePath,
      reused: result.reused,
    };
    if (args.bool("json", "j")) printJson(output);
    else {
      printInfo(color.green("✓") + ` journal checkpointed at DB cursor ${result.checkpoint.databaseCursor}`);
      if (result.archivePath) printInfo(`  archived: ${result.archivePath}`);
      if (result.reused) printInfo("  existing checkpoint reused");
    }
    return 0;
  } finally {
    await rt.close();
  }
}
