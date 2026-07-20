import { chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import {
  diagnoseStore,
  listEvents,
  listDeliveryOutbox,
  repairDelivery,
} from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { configDir, configPath } from "../config.js";
import {
  JOURNAL_CHECKPOINT_TYPE,
  parseJournalCheckpoint,
  verifyJournalArchiveChain,
  type JournalCheckpointV1,
} from "../journal.js";
import {
  drainEventJournal,
  openRuntime,
  verifyJournalCheckpointCoverage,
  type Runtime,
} from "../runtime.js";
import { color, printInfo, printJson } from "../output/format.js";

export async function doctorCmd(args: ParsedArgs): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const outboxRepairs = args.bool("repair-outbox")
      ? await repairOutboxAgainstJournal(rt)
      : [];
    const store = await diagnoseStore(rt.db, rt.client, rt.config.tenantId);
    const events = await listEvents(rt.db, {
      tenantId: rt.config.tenantId,
      ascending: true,
      limit: 1_000_000,
    });
    const dbEventIds = new Set(events.map((event) => event.id));
    const dbSequenceById = new Map(events.map((event) => [event.id, event.sequence]));
    const dbIdBySequence = new Map(events.map((event) => [event.sequence, event.id]));
    const databaseMaxSequence = events.at(-1)?.sequence ?? 0;

    const journalPath = process.env.TASQ_EVENT_JOURNAL_PATH ?? rt.config.eventJournalPath;
    const journalEventIds = new Set<string>();
    const journalSequenceById = new Map<string, number>();
    const journalSequenceIds = new Map<number, string>();
    let malformedJournalLines = 0;
    let duplicateJournalEvents = 0;
    let duplicateJournalSequences = 0;
    let legacyUnsequencedEvents = 0;
    let checkpoint: JournalCheckpointV1 | null = null;
    let checkpointArchiveVerified: boolean | null = null;
    let checkpointArchiveSegments = 0;
    const checkpointIssues: string[] = [];
    if (journalPath && existsSync(journalPath)) {
      let nonEmptyLine = 0;
      for (const line of readFileSync(journalPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        nonEmptyLine++;
        try {
          const parsed = JSON.parse(line) as { id?: unknown; sequence?: unknown; recordType?: unknown };
          if (parsed.recordType === JOURNAL_CHECKPOINT_TYPE) {
            const candidate = parseJournalCheckpoint(parsed);
            if (!candidate || nonEmptyLine !== 1 || checkpoint) {
              malformedJournalLines++;
              continue;
            }
            checkpoint = candidate;
            if (candidate.tenantId !== rt.config.tenantId) {
              checkpointIssues.push(`checkpoint tenant ${candidate.tenantId} differs from ${rt.config.tenantId}`);
            }
            if (candidate.databaseCursor > databaseMaxSequence) {
              checkpointIssues.push(`checkpoint cursor ${candidate.databaseCursor} is ahead of database cursor ${databaseMaxSequence}`);
            } else if (candidate.databaseCursor === 0) {
              if (candidate.databaseEventId !== null) checkpointIssues.push("checkpoint at cursor 0 must have a null databaseEventId");
            } else if (dbIdBySequence.get(candidate.databaseCursor) !== candidate.databaseEventId) {
              checkpointIssues.push(`checkpoint event identity does not match database cursor ${candidate.databaseCursor}`);
            }
            if (candidate.previousSegment) {
              const chain = verifyJournalArchiveChain(journalPath, candidate);
              checkpointArchiveVerified = chain.ok;
              checkpointArchiveSegments = chain.segments;
              checkpointIssues.push(...chain.issues);
            } else {
              checkpointArchiveVerified = true;
            }
            continue;
          }
          if (typeof parsed.id !== "string" || parsed.id.length === 0) {
            malformedJournalLines++;
            continue;
          }
          if (journalEventIds.has(parsed.id)) duplicateJournalEvents++;
          journalEventIds.add(parsed.id);

          if (parsed.sequence === undefined && checkpoint === null) {
            // Journals written before migration 0004 are valid JSONL but have
            // no cursor. For an event that is also in the DB, infer the
            // backfilled sequence by identity. A journal-only legacy event
            // remains visible in `journalOnly` and keeps doctor unhealthy.
            legacyUnsequencedEvents++;
            const inferred = dbSequenceById.get(parsed.id);
            if (inferred !== undefined) journalSequenceById.set(parsed.id, inferred);
          } else if (
            typeof parsed.sequence === "number" &&
            Number.isSafeInteger(parsed.sequence) &&
            parsed.sequence > 0
          ) {
            if (checkpoint && parsed.sequence <= checkpoint.databaseCursor) {
              checkpointIssues.push(`event ${parsed.id} sequence ${parsed.sequence} is not after checkpoint cursor ${checkpoint.databaseCursor}`);
            }
            const existingAtSequence = journalSequenceIds.get(parsed.sequence);
            if (existingAtSequence !== undefined && existingAtSequence !== parsed.id) {
              duplicateJournalSequences++;
            }
            journalSequenceById.set(parsed.id, parsed.sequence);
            journalSequenceIds.set(parsed.sequence, parsed.id);
          } else {
            malformedJournalLines++;
          }
        } catch {
          malformedJournalLines++;
        }
      }
    }

    const baselineCursor = checkpoint?.databaseCursor ?? 0;
    const comparedDbEventIds = new Set(
      events.filter((event) => event.sequence > baselineCursor).map((event) => event.id),
    );
    const journalOnly = [...journalEventIds].filter((id) => !dbEventIds.has(id));
    const dbOnly = [...comparedDbEventIds].filter((id) => !journalEventIds.has(id));
    const sequenceMismatches = [...journalSequenceById]
      .filter(([id, sequence]) => {
        const databaseSequence = dbSequenceById.get(id);
        return databaseSequence !== undefined && databaseSequence !== sequence;
      })
      .map(([id, journalSequence]) => ({
        id,
        databaseSequence: dbSequenceById.get(id)!,
        journalSequence,
      }));
    let journalMaxSequence = checkpointIssues.length === 0 ? baselineCursor : 0;
    let commonMaxSequence = checkpointIssues.length === 0 ? baselineCursor : 0;
    for (const [id, sequence] of journalSequenceById) {
      journalMaxSequence = Math.max(journalMaxSequence, sequence);
      if (dbSequenceById.get(id) === sequence) {
        commonMaxSequence = Math.max(commonMaxSequence, sequence);
      }
    }
    const dbUrl = process.env.TASQ_DB_URL;
    const permissionTargets = [
      { path: configDir(), expected: 0o700 },
      { path: configPath(), expected: 0o600 },
      { path: dbUrl?.startsWith("file:") ? dbUrl.slice(5) : rt.config.dbPath, expected: 0o600 },
      ...(journalPath ? [{ path: journalPath, expected: 0o600 }] : []),
    ];
    const permissionRepairs: Array<{ path: string; before: string; after: string }> = [];
    if (args.bool("fix-permissions")) {
      for (const target of permissionTargets) repairMode(target.path, target.expected, permissionRepairs);
    }
    const permissionIssues: string[] = [];
    for (const target of permissionTargets) checkMode(target.path, target.expected, permissionIssues);

    const isolatedWithoutJournal = Boolean(process.env.TASQ_DB_URL) && !process.env.TASQ_EVENT_JOURNAL_PATH;
    const outbox = rt.journal
      ? await listDeliveryOutbox(rt.db, {
        tenantId: rt.config.tenantId,
        sinkId: rt.journal.sinkId,
        limit: 1_000_000,
      })
      : [];
    const outboxCounts = {
      pending: outbox.filter((row) => row.status === "pending").length,
      delivering: outbox.filter((row) => row.status === "delivering").length,
      delivered: outbox.filter((row) => row.status === "delivered").length,
      quarantined: outbox.filter((row) => row.status === "quarantined").length,
    };
    const journalOk = isolatedWithoutJournal ||
      (malformedJournalLines === 0 &&
        duplicateJournalEvents === 0 &&
        duplicateJournalSequences === 0 &&
        checkpointIssues.length === 0 &&
        sequenceMismatches.length === 0 &&
        journalOnly.length === 0 &&
        dbOnly.length === 0);
    const ok = store.ok && journalOk && permissionIssues.length === 0;
    const report = {
      ok,
      store,
      journal: {
        checked: !isolatedWithoutJournal,
        path: isolatedWithoutJournal ? null : journalPath,
        databaseEvents: dbEventIds.size,
        journalEvents: journalEventIds.size,
        databaseMaxSequence,
        journalMaxSequence,
        commonMaxSequence,
        checkpoint: checkpoint ? {
          ...checkpoint,
          archiveVerified: checkpointArchiveVerified,
          archiveSegments: checkpointArchiveSegments,
        } : null,
        checkpointIssues,
        legacyUnsequencedEvents,
        malformedLines: malformedJournalLines,
        duplicateEvents: duplicateJournalEvents,
        duplicateSequences: duplicateJournalSequences,
        sequenceMismatches,
        journalOnly,
        databaseOnly: dbOnly,
      },
      outbox: {
        sinkId: rt.journal?.sinkId ?? null,
        ...outboxCounts,
        repairs: outboxRepairs,
      },
      permissionIssues,
      permissionRepairs,
    };

    if (args.bool("json", "j")) {
      printJson(report);
    } else {
      printInfo(ok ? `${color.green("✓")} tasq store healthy` : "tasq doctor found issues");
      printInfo(`  SQLite: ${store.sqliteIntegrity}; FK violations: ${store.foreignKeyViolations}`);
      for (const issue of store.issues) printInfo(`  - ${issue.code}: ${issue.message}`);
      for (const issue of permissionIssues) printInfo(`  - permissions: ${issue}`);
      for (const repair of permissionRepairs) printInfo(`  - permissions repaired: ${repair.path} ${repair.before} → ${repair.after}`);
      for (const repair of outboxRepairs) {
        printInfo(`  - outbox repaired: ${repair.id} ${repair.from} → ${repair.action}`);
      }
      if (outboxCounts.quarantined > 0) {
        printInfo(`  - outbox: ${outboxCounts.quarantined} quarantined delivery record(s)`);
      }
      if (!journalOk) {
        printInfo(`  - journal cursors: DB ${databaseMaxSequence}, journal ${journalMaxSequence}, common ${commonMaxSequence}`);
        for (const issue of checkpointIssues) printInfo(`  - checkpoint: ${issue}`);
        printInfo(`  - journal: ${malformedJournalLines} malformed, ${legacyUnsequencedEvents} legacy unsequenced, ${duplicateJournalEvents} duplicate IDs, ${duplicateJournalSequences} duplicate sequences, ${sequenceMismatches.length} sequence mismatches, ${journalOnly.length} journal-only, ${dbOnly.length} database-only`);
      }
    }
    return ok ? 0 : 1;
  } finally {
    await rt.close();
  }
}

async function repairOutboxAgainstJournal(rt: Runtime): Promise<Array<{
  id: string;
  from: string;
  action: "retry" | "mark_delivered" | "redeliver";
}>> {
  if (!rt.journal) return [];
  const exact = new Map<string, number>();
  if (existsSync(rt.journal.path)) {
    for (const line of readFileSync(rt.journal.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { id?: unknown; sequence?: unknown };
        if (
          typeof row.id === "string" &&
          typeof row.sequence === "number" &&
          Number.isSafeInteger(row.sequence)
        ) exact.set(row.id, row.sequence);
      } catch {
        // Full diagnostics report malformed records. Repair never guesses
        // through malformed external state.
      }
    }
  }
  const rows = await listDeliveryOutbox(rt.db, {
    tenantId: rt.config.tenantId,
    sinkId: rt.journal.sinkId,
    ascending: true,
    limit: 1_000_000,
  });
  const checkpointCoverage = await verifyJournalCheckpointCoverage(rt.db, rt.journal);
  const now = rt.ctx.clock.now();
  const repairs: Array<{
    id: string;
    from: string;
    action: "retry" | "mark_delivered" | "redeliver";
  }> = [];
  for (const row of rows) {
    const present = exact.get(row.eventId) === row.eventSequence ||
      (checkpointCoverage.valid && row.eventSequence <= checkpointCoverage.cursor);
    let action: "retry" | "mark_delivered" | "redeliver" | null = null;
    if (
      present &&
      row.status !== "delivered" &&
      !(row.status === "delivering" && (row.leaseExpiresAt ?? 0) > now)
    ) action = "mark_delivered";
    else if (!present && row.status === "delivered") action = "redeliver";
    else if (!present && row.status === "quarantined") action = "retry";
    else if (!present && row.status === "pending" && row.lastError) action = "retry";
    else if (
      !present &&
      row.status === "delivering" &&
      (row.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER) <= now
    ) action = "retry";
    if (!action) continue;
    await repairDelivery(rt.db, row.id, action, {
      tenantId: rt.config.tenantId,
      now,
    });
    repairs.push({ id: row.id, from: row.status, action });
  }
  await drainEventJournal(rt.db, rt.journal, rt.ctx.clock);
  return repairs;
}

function checkMode(path: string, expected: number, issues: string[]): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    issues.push(`${path} is a symbolic link; refusing mode checks through links`);
    return;
  }
  const actual = stat.mode & 0o777;
  if (actual !== expected) {
    issues.push(`${path} is ${actual.toString(8)}, expected ${expected.toString(8)}`);
  }
}

function repairMode(
  path: string,
  expected: number,
  repairs: Array<{ path: string; before: string; after: string }>,
): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  const actual = stat.mode & 0o777;
  if (actual === expected) return;
  chmodSync(path, expected);
  repairs.push({ path, before: actual.toString(8), after: expected.toString(8) });
}
