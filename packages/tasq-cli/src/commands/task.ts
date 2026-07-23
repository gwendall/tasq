import {
  blockTask,
  cancelTask,
  completeTask,
  createTask,
  getAreaBySlug,
  getTask,
  listDependencies,
  getActiveTaskClaim,
  listTaskAttempts,
  listTaskEvidence,
  listTasks,
  justUnblocked,
  reopenTask,
  restoreTask,
  softDeleteTask,
  startTask,
  unblockTask,
  unresolvedBlockerCount,
  unresolvedBlockerMap,
  updateTask,
  TASK_STATUSES,
  RECURRENCE_UNITS,
  RECURRENCE_ANCHORS,
  COMPLETION_MODES,
  type CompletionMode,
  type RecurrenceUnit,
  type RecurrenceAnchor,
  type StatusChangeOptions,
  type Task,
  type TaskDependency,
  type TaskStatus,
  type TasqDb,
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
import { enumArg, parseDateArg, positiveIntegerArg, type ParsedArgs } from "../args.js";
import { resolveGoalIdOrError, resolveProjectIdOrError, resolveTaskIdOrError } from "./_resolve.js";
import { ADD_USAGE, SHOW_USAGE, UPDATE_USAGE, transitionUsage } from "./usage.js";

/** Parse a `--metadata '{...}'` flag into an object (throws on invalid JSON). */
function parseMetadataArg(raw: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`--metadata must be valid JSON, got: ${raw}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("--metadata must be a JSON object");
  }
  return v as Record<string, unknown>;
}

/**
 * Parse the recurrence flags (--recurrence / --interval / --anchor) into the
 * shape createTask/updateTask consume. Only keys the user explicitly set are
 * returned so `update` leaves unspecified fields untouched. Throws (via
 * enumArg) on an invalid enum value → exit 2.
 */
function parseRecurrenceArgs(args: ParsedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const recurrence = enumArg<RecurrenceUnit>(
    args.string("recurrence"),
    RECURRENCE_UNITS,
    "recurrence",
  );
  if (recurrence !== undefined) out.recurrence = recurrence;
  if (args.number("interval") !== undefined) out.recurrenceInterval = args.number("interval");
  const anchor = enumArg<RecurrenceAnchor>(args.string("anchor"), RECURRENCE_ANCHORS, "anchor");
  if (anchor !== undefined) out.recurrenceAnchor = anchor;
  return out;
}

/**
 * `tasq` (no args) → tasq next 5 default
 * `tasq <command>` → routed elsewhere
 *
 * The task subcommands (`add`, `list`, `start`, `done`, `block`, ...)
 * are *top-level* in the CLI (not under `task <sub>`) because they're
 * the most common verbs. We expose them directly.
 */

// ──────────────────────────────────────────────────────────────────────
// Common helpers
// ──────────────────────────────────────────────────────────────────────

async function resolveAreaId(rt: Awaited<ReturnType<typeof openRuntime>>, slug: string): Promise<string | null> {
  const a = await getAreaBySlug(rt.db, slug, rt.config.tenantId);
  return a ? a.id : null;
}

/**
 * Per-line dependency annotations (additive — appended after the existing
 * title/priority/due so prior format assertions still hold):
 *   - `blockers` > 0     → a `🔒N` marker (this task has N unresolved blockers)
 *   - `unblocked` (true) → a "just unblocked" tag (had blockers, now has none)
 */
interface DepAnnotations {
  blockers?: number;
  unblocked?: boolean;
}

function printTaskLine(
  t: Awaited<ReturnType<typeof listTasks>>[number],
  ann: DepAnnotations = {},
): void {
  const status = colorizeStatus(t.status).padEnd(20);
  const due = t.dueAt != null ? color.dim(` · due ${formatRelative(t.dueAt)}`) : "";
  const priority = t.priority != null ? color.dim(` · p${t.priority}`) : "";
  const blocked = ann.blockers && ann.blockers > 0 ? color.yellow(` · 🔒${ann.blockers}`) : "";
  const unblocked = ann.unblocked ? color.green(" · just unblocked") : "";
  printInfo(`${color.dim(shortId(t.id))}  ${status}  ${t.title}${priority}${due}${blocked}${unblocked}`);
  if (t.nextAction) printInfo(`           ${color.dim("→ " + t.nextAction)}`);
}

// ──────────────────────────────────────────────────────────────────────
// `tasq add <title> [--area X] [--goal X] [--project X] [--next ...]`
// ──────────────────────────────────────────────────────────────────────

export async function addCmd(args: ParsedArgs): Promise<number> {
  const title = args.positional.join(" ");
  if (!title) {
    printError(ADD_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const hierarchy = await resolveHierarchyFlags(rt, args);
    if (hierarchy === null) return 1;

    const t = await createTask(
      rt.db,
      {
        title,
        ...hierarchy,
        nextAction: args.string("next") ?? null,
        description: args.string("description") ?? null,
        successCriteria: args.string("success") ?? null,
        completionMode:
          enumArg<CompletionMode>(args.string("completion"), COMPLETION_MODES, "completion") ??
          "assertion",
        validationRequired: args.bool("validated"),
        priority: args.number("priority") ?? null,
        estimatedMinutes: args.number("est") ?? null,
        dueAt: args.string("due") ? parseDateArg(args.string("due")!) : null,
        scheduledAt: args.string("schedule") ? parseDateArg(args.string("schedule")!) : null,
        ...parseRecurrenceArgs(args),
        ...(args.string("metadata") ? { metadata: parseMetadataArg(args.string("metadata")!) } : {}),
      },
      { ...rt.ctx, idempotencyKey: args.string("idempotency-key") },
    );
    await regenerateProjection(rt);

    if (args.bool("json", "j")) printJson(t);
    else printInfo(color.green("✓") + ` task created ${color.dim(shortId(t.id))}  ${t.title}`);
    return 0;
  } finally {
    await rt.close();
  }
}

/**
 * Resolve --area / --goal / --project / --parent flags into ids the service
 * can consume. Returns `null` on resolution failure (error already printed).
 * Returns an object with only the keys the user explicitly provided so the
 * service can distinguish "inherit from parent" (key omitted) from "detach"
 * (key set to null) — see TaskInsert in @tasq-run/schema.
 */
async function resolveHierarchyFlags(
  rt: Awaited<ReturnType<typeof openRuntime>>,
  args: ParsedArgs,
): Promise<Record<string, string | null> | null> {
  const out: Record<string, string | null> = {};

  const areaSlug = args.string("area");
  if (areaSlug !== undefined) {
    const areaId = await resolveAreaId(rt, areaSlug);
    if (!areaId) {
      printError(`area not found: ${areaSlug}`);
      return null;
    }
    out.areaId = areaId;
  }

  const goalArg = args.string("goal");
  if (goalArg !== undefined) {
    const goalId = await resolveGoalIdOrError(rt, goalArg);
    if (!goalId) return null;
    out.goalId = goalId;
  }

  const projectArg = args.string("project");
  if (projectArg !== undefined) {
    const projectId = await resolveProjectIdOrError(rt, projectArg);
    if (!projectId) return null;
    out.projectId = projectId;
  }

  const parentArg = args.string("parent");
  if (parentArg !== undefined) {
    const parentTaskId = await resolveTaskIdOrError(rt, parentArg, "parent task");
    if (!parentTaskId) return null;
    out.parentTaskId = parentTaskId;
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────
// `tasq list [--status X] [--area X] [--goal X] [--project X] [--json]`
// `tasq inbox` — tasks without a project_id (the "untriaged" pile)
// ──────────────────────────────────────────────────────────────────────

export async function listCmd(args: ParsedArgs): Promise<number> {
  return listImpl(args, { orphanOnly: false });
}

export async function inboxCmd(args: ParsedArgs): Promise<number> {
  return listImpl(args, { orphanOnly: true });
}

async function listImpl(args: ParsedArgs, opts: { orphanOnly: boolean }): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    let areaId: string | undefined;
    const areaSlug = args.string("area");
    if (areaSlug !== undefined) {
      const a = await resolveAreaId(rt, areaSlug);
      if (!a) {
        printError(`area not found: ${areaSlug}`);
        return 1;
      }
      areaId = a;
    }
    let goalId: string | undefined;
    const goalArg = args.string("goal");
    if (goalArg !== undefined) {
      const g = await resolveGoalIdOrError(rt, goalArg);
      if (!g) return 1;
      goalId = g;
    }
    let projectId: string | undefined;
    const projectArg = args.string("project");
    if (projectArg !== undefined) {
      const p = await resolveProjectIdOrError(rt, projectArg);
      if (!p) return 1;
      projectId = p;
    }
    const status = enumArg<TaskStatus>(args.string("status"), TASK_STATUSES, "status");
    const includeScheduled = args.bool("include-scheduled") || args.bool("include-deferred");
    const tasks = await listTasks(rt.db, {
      tenantId: rt.config.tenantId,
      status,
      areaId,
      goalId,
      projectId,
      orphanOnly: opts.orphanOnly,
      includeScheduled,
      limit: args.number("limit") ?? 100,
    });
    if (args.bool("json", "j")) {
      printJson(tasks);
    } else if (tasks.length === 0) {
      printInfo(color.dim(opts.orphanOnly ? "(inbox is empty)" : "(no tasks match)"));
    } else {
      // Compute dependency annotations once per list call (no N+1). The blocker
      // map needs the live status of EVERY candidate task in the tenant (a
      // blocker may sit outside the filtered slice), so source statuses from a
      // tenant-wide open/in_progress/blocked listing — not just the printed set.
      const liveStatuses = await listTasks(rt.db, {
        tenantId: rt.config.tenantId,
        limit: 5000,
      });
      const statusById = new Map<string, string>(
        liveStatuses
          .filter((t) => t.status !== "done" && t.status !== "cancelled")
          .map((t) => [t.id, t.status]),
      );
      const blockerMap = await unresolvedBlockerMap(rt.db, rt.config.tenantId, statusById);
      const unblockedSet = await justUnblocked(rt.db, { tenantId: rt.config.tenantId });
      for (const t of tasks) {
        const blockers = blockerMap.get(t.id) ?? 0;
        printTaskLine(t, {
          blockers,
          unblocked: blockers === 0 && unblockedSet.has(t.id),
        });
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

// ──────────────────────────────────────────────────────────────────────
// `tasq show <id>`
// ──────────────────────────────────────────────────────────────────────

export async function showCmd(args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    printError(SHOW_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveTaskIdOrError(rt, id);
    if (!resolved) return 1;
    const t = await getTask(rt.db, resolved, rt.config.tenantId);

    // Dependency surfacing (SPEC §4.5 / §5.2). One read of both-direction edges
    // + the unresolved-blocker count for the W_blocked down-weight transparency.
    const deps = await listDependencies(rt.db, {
      tenantId: rt.config.tenantId,
      taskId: resolved,
      direction: "both",
    });
    const unresolvedBlockers = await unresolvedBlockerCount(
      rt.db,
      resolved,
      rt.config.tenantId,
    );
    const [claim, attempts, evidence] = await Promise.all([
      getActiveTaskClaim(rt.db, resolved, rt.config.tenantId),
      listTaskAttempts(rt.db, resolved, { tenantId: rt.config.tenantId, limit: 20 }),
      listTaskEvidence(rt.db, resolved, { tenantId: rt.config.tenantId, limit: 20 }),
    ]);

    if (args.bool("json", "j")) {
      printJson({ ...t, dependencies: deps, unresolvedBlockers, claim, attempts, evidence });
    } else {
      printInfo(JSON.stringify(t, null, 2));
      await printDependencySections(rt, deps, resolved, unresolvedBlockers);
    }
    return 0;
  } finally {
    await rt.close();
  }
}

/**
 * Append the dependency sections to `tasq show <id>` (text mode). Clearly
 * delimited after the task body so existing format assertions are unaffected:
 *   - "Blocked by:"  live `blocks` edges where this task is `from` (its blockers)
 *   - "Blocks:"      live `blocks` edges where this task is `to`
 *   - "Related:" / "Duplicates:"  informational edges (either endpoint)
 *   - a "(just unblocked)" hint when the task had blockers but now has none.
 */
async function printDependencySections(
  rt: Awaited<ReturnType<typeof openRuntime>>,
  deps: TaskDependency[],
  taskId: string,
  unresolvedBlockers: number,
): Promise<void> {
  if (deps.length === 0) return;

  // Resolve referenced task titles/statuses for a legible line.
  const otherIds = Array.from(
    new Set(
      deps.flatMap((d) => [d.fromTaskId, d.toTaskId]).filter((x) => x !== taskId),
    ),
  );
  const others = new Map<string, Task>();
  for (const oid of otherIds) {
    const ot = await getTask(rt.db, oid, rt.config.tenantId);
    if (ot) others.set(oid, ot);
  }
  const line = (otherId: string): string => {
    const ot = others.get(otherId);
    const label = ot ? `${ot.title} [${ot.status}]` : "(unknown task)";
    return `  ${color.dim(shortId(otherId))}  ${label}`;
  };

  const blockedBy = deps.filter((d) => d.type === "blocks" && d.fromTaskId === taskId);
  const blocks = deps.filter((d) => d.type === "blocks" && d.toTaskId === taskId);
  const related = deps.filter((d) => d.type === "relates_to");
  const duplicates = deps.filter((d) => d.type === "duplicates");

  if (blockedBy.length > 0) {
    printInfo(color.bold("\nBlocked by:"));
    for (const d of blockedBy) printInfo(line(d.toTaskId));
    if (unresolvedBlockers === 0) {
      printInfo(color.green("  (just unblocked — no unresolved blockers remain)"));
    }
  }
  if (blocks.length > 0) {
    printInfo(color.bold("\nBlocks:"));
    for (const d of blocks) printInfo(line(d.fromTaskId));
  }
  if (related.length > 0) {
    printInfo(color.bold("\nRelated:"));
    for (const d of related) printInfo(line(d.fromTaskId === taskId ? d.toTaskId : d.fromTaskId));
  }
  if (duplicates.length > 0) {
    printInfo(color.bold("\nDuplicates:"));
    for (const d of duplicates) {
      printInfo(line(d.fromTaskId === taskId ? d.toTaskId : d.fromTaskId));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Status transitions — start, done, block, unblock, cancel, reopen, restore, delete
// ──────────────────────────────────────────────────────────────────────

export type Transition =
  | "start"
  | "done"
  | "block"
  | "unblock"
  | "cancel"
  | "reopen"
  | "restore"
  | "delete";

/**
 * The status-changing service functions all share the same call shape:
 *   (db, id, StatusChangeOptions) → Promise<Task>.
 * `restoreTask` differs (it takes only ServiceContext — no reason/note/source),
 * so we wrap it in a thin adapter to make the dispatch table monomorphic.
 */
type StatusFn = (db: TasqDb, id: string, options?: StatusChangeOptions) => Promise<Task>;

const TRANSITION_FN: Record<Exclude<Transition, "delete">, StatusFn> = {
  start: startTask,
  done: completeTask,
  block: blockTask,
  unblock: unblockTask,
  cancel: cancelTask,
  reopen: reopenTask,
  restore: (db, id, options) =>
    restoreTask(db, id, { actor: options?.actor, tenantId: options?.tenantId }),
};

export async function transitionCmd(verb: Transition, args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    printError(transitionUsage(verb));
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveTaskIdOrError(rt, id);
    if (!resolved) return 1;

    if (verb === "delete") {
      await softDeleteTask(rt.db, resolved, { ...rt.ctx, cascade: args.bool("cascade") });
      await regenerateProjection(rt);
      if (args.bool("json", "j")) printJson({ ok: true, id: resolved, deleted: true });
      else printInfo(color.green("✓") + ` task deleted ${color.dim(shortId(resolved))}`);
      return 0;
    }

    const fn = TRANSITION_FN[verb];
    let evidenceIds: string[] | undefined;
    if (verb === "done" && args.string("evidence")) {
      const requested = args.string("evidence")!.split(",").map((id) => id.trim()).filter(Boolean);
      const available = await listTaskEvidence(rt.db, resolved, {
        tenantId: rt.config.tenantId,
        limit: 10_000,
      });
      evidenceIds = [];
      for (const prefix of requested) {
        const matches = available.filter((item) => item.id === prefix || item.id.startsWith(prefix));
        if (matches.length === 0) throw new Error(`evidence not found on task ${resolved}: ${prefix}`);
        if (matches.length > 1) throw new Error(`ambiguous evidence id prefix '${prefix}'`);
        evidenceIds.push(matches[0]!.id);
      }
    }
    const result: Task = await fn(rt.db, resolved, {
      ...rt.ctx,
      idempotencyKey: args.string("idempotency-key"),
      expectedRevision: positiveIntegerArg(args, "expected-revision"),
      reason: args.string("reason"),
      note: args.string("note"),
      source: args.string("source"),
      occurredAt: args.string("at") ? parseDateArg(args.string("at")!) : undefined,
      evidenceIds,
      validationDecisionId: verb === "done" ? args.string("decision") : undefined,
    });
    await regenerateProjection(rt);

    if (args.bool("json", "j")) {
      printJson(result);
    } else {
      printInfo(
        color.green("✓") +
          ` task ${verb} → ${result.status}  ${color.dim(shortId(resolved))}  ${result.title}`,
      );
    }
    return 0;
  } finally {
    await rt.close();
  }
}

// ──────────────────────────────────────────────────────────────────────
// `tasq update <id> --next "..." --priority 4 --due ...`
// ──────────────────────────────────────────────────────────────────────

export async function updateCmd(args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    printError(UPDATE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveTaskIdOrError(rt, id);
    if (!resolved) return 1;
    const hierarchy = await resolveHierarchyFlags(rt, args);
    if (hierarchy === null) return 1;

    const patch: Record<string, unknown> = { ...hierarchy };
    if (args.string("title") !== undefined) patch.title = args.string("title");
    if (args.string("description") !== undefined) patch.description = args.string("description");
    if (args.string("next") !== undefined) patch.nextAction = args.string("next");
    if (args.string("success") !== undefined) patch.successCriteria = args.string("success");
    const completionMode = enumArg<CompletionMode>(
      args.string("completion"),
      COMPLETION_MODES,
      "completion",
    );
    if (completionMode !== undefined) patch.completionMode = completionMode;
    if (args.flag("validated") !== undefined) patch.validationRequired = args.bool("validated");
    if (args.number("priority") !== undefined) patch.priority = args.number("priority");
    if (args.number("est") !== undefined) patch.estimatedMinutes = args.number("est");
    if (args.string("due") !== undefined) patch.dueAt = parseDateArg(args.string("due")!);
    if (args.string("schedule") !== undefined) patch.scheduledAt = parseDateArg(args.string("schedule")!);
    Object.assign(patch, parseRecurrenceArgs(args));
    if (args.string("metadata") !== undefined) patch.metadata = parseMetadataArg(args.string("metadata")!);
    if (args.string("metadata-patch") !== undefined) {
      if ("metadata" in patch) throw new Error("Cannot combine --metadata and --metadata-patch");
      const current = await getTask(rt.db, resolved, rt.config.tenantId);
      patch.metadata = {
        ...(current?.metadata ?? {}),
        ...parseMetadataArg(args.string("metadata-patch")!),
      };
    }

    const clearable: Array<[string, string, unknown]> = [
      ["clear-description", "description", null],
      ["clear-next", "nextAction", null],
      ["clear-success", "successCriteria", null],
      ["clear-priority", "priority", null],
      ["clear-est", "estimatedMinutes", null],
      ["clear-due", "dueAt", null],
      ["clear-schedule", "scheduledAt", null],
      ["clear-area", "areaId", null],
      ["clear-goal", "goalId", null],
      ["clear-project", "projectId", null],
      ["clear-parent", "parentTaskId", null],
      ["clear-recurrence", "recurrence", null],
      ["clear-metadata", "metadata", {}],
    ];
    for (const [flag, field, value] of clearable) {
      if (args.bool(flag)) {
        if (field in patch) throw new Error(`Cannot combine --${flag} with a value for ${field}`);
        patch[field] = value;
      }
    }

    const updated = await updateTask(rt.db, resolved, patch, rt.ctx);
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(updated);
    else printInfo(color.green("✓") + ` task updated ${color.dim(shortId(resolved))}`);
    return 0;
  } finally {
    await rt.close();
  }
}
