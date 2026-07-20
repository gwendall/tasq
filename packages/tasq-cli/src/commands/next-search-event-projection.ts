import {
  getAreaBySlug,
  listEvents,
  listTasks,
  pickNext,
  renderProjection,
  ENTITY_TYPES,
  type EntityType,
} from "@tasq-internal/local-service";
import { openRuntime, regenerateProjection } from "../runtime.js";
import {
  color,
  colorizeStatus,
  formatRelative,
  printError,
  printInfo,
  printJson,
  shortId,
} from "../output/format.js";
import { enumArg, parseDateArg, type ParsedArgs } from "../args.js";
import { SEARCH_USAGE } from "./usage.js";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ──────────────────────────────────────────────────────────────────────
// `tasq next [--limit N] [--area X] [--goal X] [--project X]`
// ──────────────────────────────────────────────────────────────────────

export async function nextCmd(args: ParsedArgs): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const areaSlug = args.string("area");
    const areaId = areaSlug ? (await getAreaBySlug(rt.db, areaSlug, rt.config.tenantId))?.id : undefined;
    if (areaSlug && !areaId) {
      printError(`area not found: ${areaSlug}`);
      return 1;
    }
    const limit = args.number("limit") ?? 5;
    const includeScheduled = args.bool("include-scheduled") || args.bool("include-deferred");
    const results = await pickNext(rt.db, {
      tenantId: rt.config.tenantId,
      limit,
      areaId,
      goalId: args.string("goal"),
      projectId: args.string("project"),
      includeScheduled,
      actor: rt.ctx.actor,
      includeClaimed: args.bool("include-claimed"),
    });
    if (args.bool("json", "j")) {
      printJson(results);
      return 0;
    }
    if (results.length === 0) {
      printInfo(color.dim("(nothing to surface — `tasq add <title>` to create one)"));
      return 0;
    }
    results.forEach((r, i) => {
      const tags: string[] = [];
      if (r.area) tags.push(`#${r.area.slug}`);
      if (r.goal) tags.push(`@${r.goal.title.slice(0, 30)}`);
      const due = r.task.dueAt != null ? color.yellow(` ⏰ ${formatRelative(r.task.dueAt)}`) : "";
      printInfo(`${color.bold((i + 1) + ".")}  ${colorizeStatus(r.task.status)}  ${r.task.title}${due}  ${color.dim(tags.join(" "))}`);
      if (r.task.nextAction) printInfo(`    ${color.dim("→ " + r.task.nextAction)}`);
      printInfo(
        `    ${color.dim(`score ${r.score.total.toFixed(2)} (lev ${r.score.leverage} · urg ${r.score.urgency} · av ${r.score.avoidance} · act ${r.score.active})  ${shortId(r.task.id)}`)}`,
      );
    });
    return 0;
  } finally {
    await rt.close();
  }
}

// ──────────────────────────────────────────────────────────────────────
// `tasq search "<query>"`
// ──────────────────────────────────────────────────────────────────────

export async function searchCmd(args: ParsedArgs): Promise<number> {
  const q = args.positional.join(" ").trim().toLowerCase();
  if (!q) {
    printError(SEARCH_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const tasks = await listTasks(rt.db, { tenantId: rt.config.tenantId, limit: 1000 });
    const matches = tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q) ||
        (t.nextAction ?? "").toLowerCase().includes(q),
    );
    if (args.bool("json", "j")) {
      printJson(matches);
    } else if (matches.length === 0) {
      printInfo(color.dim("(no matches)"));
    } else {
      for (const t of matches) {
        printInfo(`${color.dim(shortId(t.id))}  ${colorizeStatus(t.status).padEnd(20)}  ${t.title}`);
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

// ──────────────────────────────────────────────────────────────────────
// `tasq event list [--since <iso>] [--entity-id X] [--actor X]`
// ──────────────────────────────────────────────────────────────────────

export async function eventCmd(args: ParsedArgs): Promise<number> {
  const [sub] = args.positional;
  if (!sub || sub === "list") {
    const rt = await openRuntime(args.string("actor"), args.string("tenant"));
    try {
      const since = args.string("since") ? parseDateArg(args.string("since")!) : undefined;
      const before = args.string("before") ? parseDateArg(args.string("before")!) : undefined;
      const events = await listEvents(rt.db, {
        tenantId: rt.config.tenantId,
        sinceMs: since,
        beforeMs: before,
        afterSequence: args.number("after-sequence"),
        beforeSequence: args.number("before-sequence"),
        entityId: args.string("entity-id"),
        entityType: enumArg<EntityType>(args.string("entity-type"), ENTITY_TYPES, "entity-type"),
        actor: args.string("actor"),
        limit: args.number("limit") ?? 50,
        ascending: args.bool("ascending"),
      });
      if (args.bool("json", "j")) {
        printJson(events);
      } else if (events.length === 0) {
        printInfo(color.dim("(no events)"));
      } else {
        for (const e of events) {
          const when = new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 19);
          printInfo(
            `${color.dim(when)}  ${color.cyan(e.actor.padEnd(12))}  ${color.bold(e.eventType.padEnd(16))}  ${e.entityType}:${shortId(e.entityId)}`,
          );
          if (e.payload?.note) printInfo(`    ${color.dim("note: " + e.payload.note)}`);
          if (e.payload?.reason) printInfo(`    ${color.dim("reason: " + e.payload.reason)}`);
        }
      }
      return 0;
    } finally {
      await rt.close();
    }
  }
  printError(`unknown event subcommand: ${sub}`);
  return 1;
}

// ──────────────────────────────────────────────────────────────────────
// `tasq projection [--target <path>]`
// ──────────────────────────────────────────────────────────────────────

export async function projectionCmd(args: ParsedArgs): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const isolatedDb = Boolean(process.env.TASQ_DB_URL);
    const target =
      args.string("target") ??
      process.env.TASQ_PROJECTION_TARGET ??
      (isolatedDb ? undefined : rt.config.projectionTarget);
    if (!target) {
      // Print to stdout
      const md = await renderProjection(rt.db, { tenantId: rt.config.tenantId });
      process.stdout.write(md);
      return 0;
    }
    const md = await renderProjection(rt.db, { tenantId: rt.config.tenantId });
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, md, "utf-8");
    renameSync(temporary, target);
    if (args.bool("json", "j")) printJson({ ok: true, target });
    else printInfo(color.green("✓") + ` projection written to ${target}`);
    return 0;
  } finally {
    await rt.close();
  }
}
