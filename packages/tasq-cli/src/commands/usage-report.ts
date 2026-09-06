/**
 * `tasq usage [--since 30d] [--json]` - what actors actually do in this space.
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
import { listEvents } from "@tasq-internal/local-service";
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
    return 0;
  } finally {
    await rt.close();
  }
}
