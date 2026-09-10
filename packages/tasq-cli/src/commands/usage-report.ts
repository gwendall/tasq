/**
 * `tasq usage [--since 30d] [--all] [--json]` - what actors actually do here.
 *
 * The managed AGENTS.md block prescribes a ritual: onboard, next, claim,
 * attempt, evidence, done, capture, because, wrong, why. On 2026-09-05 the
 * ledger of this project's own space showed which of those were used: add,
 * claim, attempt, evidence and done by the hundreds; capture twice in 352
 * tasks; beliefs never. A ritual nobody follows is prose, and the only way to
 * know is to count. This report is that count, from the event log, so the
 * block can be trimmed to what is practiced and grown from what is missing.
 *
 * Reads (`next`, `why`, `list`) leave no event and are reported as such rather
 * than as zero: absence of evidence is not evidence of absence.
 */
import type { Clock } from "@tasq-run/schema";
import { listCoordinationSpaces, listEvents } from "@tasq-internal/local-service";
import { readCommandJournal, type CommandRecordT } from "../command-journal.js";
import type { ParsedArgs } from "../args.js";
import { color, printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";

export const USAGE_REPORT_CONTRACT = "tasq.usage-report.v1" as const;

const WINDOWS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `--since 30d`, `--since 24h`, `--since 2w`. Absent means everything ever recorded. */
export function windowStart(raw: string | undefined, now: number): number {
  if (!raw) return 0;
  const match = /^(\d+)([hdw])$/.exec(raw.trim());
  if (!match) throw new Error("--since takes a window like 24h, 30d or 2w");
  return now - Number(match[1]) * WINDOWS[match[2]!]!;
}

interface RitualStep {
  command: string;
  /** Event types that prove the command ran; a predicate refines by payload. */
  eventTypes: readonly string[];
  matches?: (payload: Record<string, unknown>) => boolean;
  /** Reads leave no event; they are reported as unobservable, never as zero. */
  observable: boolean;
}

const relationOfType = (type: string) => (payload: Record<string, unknown>) => {
  const after = payload.after as Record<string, unknown> | undefined;
  return after?.type === type;
};

/** The ritual the managed AGENTS.md block prescribes, in its order. */
export const RITUAL: readonly RitualStep[] = [
  { command: "onboard", eventTypes: [], observable: false },
  { command: "next", eventTypes: [], observable: false },
  { command: "add", eventTypes: ["created"], observable: true },
  { command: "claim", eventTypes: ["claim_acquired", "claim_renewed"], observable: true },
  { command: "attempt", eventTypes: ["attempt_started", "attempt_succeeded", "attempt_failed", "attempt_running", "attempt_cancelled"], observable: true },
  { command: "evidence", eventTypes: ["evidence_added"], observable: true },
  { command: "done", eventTypes: ["completed"], observable: true },
  { command: "capture", eventTypes: ["dependency_added"], matches: relationOfType("discovered_from"), observable: true },
  { command: "because", eventTypes: ["assumption_recorded", "assumption_linked"], observable: true },
  { command: "wrong", eventTypes: ["assumption_withdrawn"], observable: true },
  { command: "why", eventTypes: [], observable: false },
];

/**
 * What the command journal saw, which the ledger structurally cannot.
 *
 * The ledger records mutations that SUCCEEDED. Reads leave nothing, and a
 * refusal leaves nothing at all, so the two signals that say whether the
 * product fits the hand using it were both invisible. Rolling Tasq out to
 * other projects to gather feedback without this half is gathering the half
 * that already works.
 */
export interface CommandActivity {
  invocations: number;
  failures: number;
  byHarness: Record<string, number>;
  byVersion: Record<string, number>;
  /** Commands that failed, worst first: this is the actionable list. */
  failing: Array<{ command: string; subcommand: string | null; failures: number; invocations: number; messages: string[] }>;
  /** Reads leave no event, so only the journal can prove they happened. */
  reads: Record<string, number>;
}

export interface SpaceUsage {
  workspaceId: string;
  adoptedAt: number | null;
  lastActivityAt: number | null;
  events: number;
  actors: number;
  ritual: UsageReport["ritual"];
  unusedRitual: string[];
}

export interface UsageReport {
  contractVersion: typeof USAGE_REPORT_CONTRACT;
  workspaceId: string;
  since: string | null;
  from: number;
  events: number;
  actors: Array<{ actor: string; events: number; byType: Record<string, number> }>;
  byType: Record<string, number>;
  ritual: Array<{ command: string; observable: boolean; count: number | null; actors: string[] }>;
  unusedRitual: string[];
  /** Present with `--all`: one row per space this machine holds. */
  spaces?: SpaceUsage[];
  /** Present when the private command journal has anything in the window. */
  commands?: CommandActivity;
}

/** Reads the ritual prescribes; only the journal can observe them. */
const READ_COMMANDS = new Set(["onboard", "next", "why", "list", "show", "search", "usage", "contention", "doctor"]);

export function buildCommandActivity(records: readonly CommandRecordT[]): CommandActivity {
  const byHarness: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  const reads: Record<string, number> = {};
  const perCommand = new Map<string, { command: string; subcommand: string | null; failures: number; invocations: number; messages: Map<string, number> }>();
  let failures = 0;
  for (const record of records) {
    byHarness[record.harness] = (byHarness[record.harness] ?? 0) + 1;
    byVersion[record.version] = (byVersion[record.version] ?? 0) + 1;
    if (READ_COMMANDS.has(record.command)) reads[record.command] = (reads[record.command] ?? 0) + 1;
    const key = record.subcommand ? `${record.command} ${record.subcommand}` : record.command;
    const row = perCommand.get(key) ?? { command: record.command, subcommand: record.subcommand, failures: 0, invocations: 0, messages: new Map<string, number>() };
    row.invocations++;
    if (record.exitCode !== 0) {
      row.failures++;
      failures++;
      if (record.message) row.messages.set(record.message, (row.messages.get(record.message) ?? 0) + 1);
    }
    perCommand.set(key, row);
  }
  const failing = [...perCommand.values()]
    .filter((row) => row.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .map((row) => ({
      command: row.command,
      subcommand: row.subcommand,
      failures: row.failures,
      invocations: row.invocations,
      messages: [...row.messages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([message]) => message),
    }));
  return { invocations: records.length, failures, byHarness, byVersion, failing, reads };
}

export function buildUsageReport(input: {
  workspaceId: string;
  since: string | null;
  from: number;
  events: Array<{ actor: string; eventType: string; payload: unknown }>;
}): UsageReport {
  const byActor = new Map<string, { events: number; byType: Record<string, number> }>();
  const byType: Record<string, number> = {};
  const ritualCounts = RITUAL.map(() => ({ count: 0, actors: new Set<string>() }));
  for (const event of input.events) {
    const actor = byActor.get(event.actor) ?? { events: 0, byType: {} };
    actor.events++;
    actor.byType[event.eventType] = (actor.byType[event.eventType] ?? 0) + 1;
    byActor.set(event.actor, actor);
    byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
    const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
    RITUAL.forEach((step, index) => {
      if (!step.eventTypes.includes(event.eventType)) return;
      if (step.matches && !step.matches(payload)) return;
      ritualCounts[index]!.count++;
      ritualCounts[index]!.actors.add(event.actor);
    });
  }
  const ritual = RITUAL.map((step, index) => ({
    command: step.command,
    observable: step.observable,
    count: step.observable ? ritualCounts[index]!.count : null,
    actors: [...ritualCounts[index]!.actors].sort(),
  }));
  return {
    contractVersion: USAGE_REPORT_CONTRACT,
    workspaceId: input.workspaceId,
    since: input.since,
    from: input.from,
    events: input.events.length,
    actors: [...byActor.entries()]
      .map(([actor, value]) => ({ actor, ...value }))
      .sort((a, b) => b.events - a.events || a.actor.localeCompare(b.actor)),
    byType,
    ritual,
    unusedRitual: ritual.filter((step) => step.observable && step.count === 0).map((step) => step.command),
  };
}

export async function usageCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  if (args.positional.length > 0) throw new Error("usage accepts flags only");
  const json = args.flag("json", "j") !== undefined;
  const all = args.bool("all");
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    const now = rt.ctx.clock.now();
    const since = args.string("since") ?? null;
    const from = windowStart(since ?? undefined, now);
    const events = await listEvents(rt.db, { tenantId: rt.config.tenantId, sinceMs: from > 0 ? from : undefined, ascending: true, limit: 1_000_000 });
    const report = buildUsageReport({
      workspaceId: rt.config.tenantId,
      since,
      from,
      events: events.map((event) => ({ actor: event.actor, eventType: event.eventType, payload: event.payload })),
    });
    // A rollout is several projects on one machine, and every read here named
    // exactly one of them: comparing five projects meant running this five
    // times and joining the answers by hand.
    if (all) {
      const spaces = await listCoordinationSpaces(rt.db);
      report.spaces = [];
      for (const space of spaces) {
        const spaceEvents = await listEvents(rt.db, { tenantId: space.workspaceId, sinceMs: from > 0 ? from : undefined, ascending: true, limit: 1_000_000 });
        const spaceReport = buildUsageReport({
          workspaceId: space.workspaceId,
          since,
          from,
          events: spaceEvents.map((event) => ({ actor: event.actor, eventType: event.eventType, payload: event.payload })),
        });
        const timestamps = spaceEvents.map((event) => event.createdAt);
        report.spaces.push({
          workspaceId: space.workspaceId,
          adoptedAt: space.createdAt,
          lastActivityAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
          events: spaceReport.events,
          actors: spaceReport.actors.length,
          ritual: spaceReport.ritual,
          unusedRitual: spaceReport.unusedRitual,
        });
      }
      report.spaces.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    }
    const journal = readCommandJournal(from);
    if (journal.length > 0) report.commands = buildCommandActivity(journal);
    if (json) {
      printJson(report);
      return 0;
    }
    const window = since ? `the last ${since}` : "all time";
    printInfo(`${color.bold(report.workspaceId)}: ${report.events} event(s) over ${window}`);
    for (const actor of report.actors) {
      const top = Object.entries(actor.byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([type, count]) => `${type} ${count}`).join(", ");
      printInfo(`  ${actor.actor.padEnd(24)} ${String(actor.events).padStart(6)}  ${color.dim(top)}`);
    }
    printInfo("");
    printInfo(color.bold("Ritual, as the managed AGENTS.md block prescribes it:"));
    for (const step of report.ritual) {
      const shown = step.observable ? String(step.count) : color.dim("read, leaves no event");
      const who = step.actors.length > 0 ? color.dim(`  ${step.actors.join(", ")}`) : "";
      printInfo(`  ${step.command.padEnd(10)} ${shown}${who}`);
    }
    if (report.unusedRitual.length > 0) {
      printInfo("");
      printInfo(`${color.yellow("!")} never used over ${window}: ${report.unusedRitual.join(", ")}`);
      printInfo(color.dim("  A prescribed command nobody runs is prose. Trim it, or find out what would make it worth running."));
    }
    if (report.spaces) {
      printInfo("");
      printInfo(color.bold(`Every space on this machine (${report.spaces.length}):`));
      for (const space of report.spaces) {
        const last = space.lastActivityAt === null ? "silent in window" : new Date(space.lastActivityAt).toISOString().slice(0, 10);
        const adopted = space.adoptedAt === null ? "unknown" : new Date(space.adoptedAt).toISOString().slice(0, 10);
        printInfo(`  ${space.workspaceId.padEnd(22)} ${String(space.events).padStart(5)} ev  ${String(space.actors).padStart(2)} actor(s)  ${color.dim(`adopted ${adopted}, last ${last}`)}`);
      }
    }
    if (report.commands) {
      const activity = report.commands;
      printInfo("");
      printInfo(color.bold(`Commands actually run here (${activity.invocations}, ${activity.failures} refused):`));
      const harness = Object.entries(activity.byHarness).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ");
      if (harness) printInfo(color.dim(`  through ${harness}`));
      const reads = Object.entries(activity.reads).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ");
      if (reads) printInfo(color.dim(`  reads the ledger cannot see: ${reads}`));
      for (const row of activity.failing.slice(0, 8)) {
        const name = row.subcommand ? `${row.command} ${row.subcommand}` : row.command;
        printInfo(`  ${color.yellow("!")} ${name.padEnd(20)} ${row.failures}/${row.invocations} refused`);
        for (const message of row.messages) printInfo(color.dim(`      ${message}`));
      }
      if (activity.failing.length === 0) printInfo(color.dim("  nothing was refused in this window"));
    } else {
      printInfo("");
      printInfo(color.dim("No command journal yet: ~/.tasq/commands.jsonl fills as commands run."));
    }
    return 0;
  } finally {
    await rt.close();
  }
}
