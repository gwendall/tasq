/**
 * `tasq tree <task-id>`         — print a task + descendants
 * `tasq task status <task-id>`  — progress + ETA for a task with sub-tasks
 * `tasq project status <id>`    — progress + ETA for a project
 *
 * All accept --json and short id prefixes.
 */

import {
  getProjectProgress,
  getTaskProgress,
  getTaskTree,
  type Progress,
  type Task,
} from "@tasq-internal/local-service";
import { openRuntime } from "../runtime.js";
import {
  color,
  colorizeStatus,
  formatRelative,
  printError,
  printInfo,
  printJson,
  shortId,
} from "../output/format.js";
import type { ParsedArgs } from "../args.js";
import { resolveProjectIdOrError, resolveTaskIdOrError } from "./_resolve.js";
import { TREE_USAGE, TASK_STATUS_USAGE } from "./usage.js";

// ──────────────────────────────────────────────────────────────────────
// tasq tree <id>
// ──────────────────────────────────────────────────────────────────────

export async function treeCmd(args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    printError(TREE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveTaskIdOrError(rt, id);
    if (!resolved) return 1;
    // resolveTaskIdOrError already confirmed the task exists, so getTaskTree
    // can't return null here.
    const tree = (await getTaskTree(rt.db, resolved, rt.config.tenantId)) as readonly Task[];
    if (args.bool("json", "j")) {
      printJson(tree);
      return 0;
    }
    renderTreeText(tree);
    return 0;
  } finally {
    await rt.close();
  }
}

function renderTreeText(tree: readonly Task[]): void {
  // Build parent → children map
  const byParent = new Map<string | null, Task[]>();
  for (const t of tree) {
    const key = t.parentTaskId ?? null;
    const bucket = byParent.get(key) ?? [];
    bucket.push(t);
    byParent.set(key, bucket);
  }
  const root = tree[0];
  if (!root) return;

  const renderNode = (t: Task, depth: number): void => {
    const indent = "  ".repeat(depth);
    const status = colorizeStatus(t.status);
    const due = t.dueAt != null ? color.dim(` · due ${formatRelative(t.dueAt)}`) : "";
    printInfo(`${indent}${color.dim(shortId(t.id))}  ${status.padEnd(15)}  ${t.title}${due}`);
    if (t.nextAction && (t.status === "open" || t.status === "in_progress" || t.status === "blocked")) {
      printInfo(`${indent}                   ${color.dim("→ " + t.nextAction)}`);
    }
    const children = byParent.get(t.id) ?? [];
    children.sort((a, b) => a.createdAt - b.createdAt);
    for (const child of children) renderNode(child, depth + 1);
  };

  renderNode(root, 0);
}

// ──────────────────────────────────────────────────────────────────────
// tasq task status <id> + tasq project status <id>
// ──────────────────────────────────────────────────────────────────────

export async function taskCmd(args: ParsedArgs): Promise<number> {
  const [sub, id] = args.positional;
  if (sub !== "status" || !id) {
    printError(TASK_STATUS_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveTaskIdOrError(rt, id);
    if (!resolved) return 1;
    const progress = (await getTaskProgress(rt.db, resolved, {
      tenantId: rt.config.tenantId,
    })) as Progress;
    if (args.bool("json", "j")) {
      printJson(progress);
      return 0;
    }
    renderProgressText(progress, "task");
    return 0;
  } finally {
    await rt.close();
  }
}

export async function projectStatusCmd(args: ParsedArgs): Promise<number> {
  // Called from inside projectCmd dispatch (positional[0] = "status", [1] = id)
  const [, id] = args.positional;
  if (!id) {
    printError("project status <id>  (shows progress + ETA for a project)");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveProjectIdOrError(rt, id);
    if (!resolved) return 1;
    const progress = await getProjectProgress(rt.db, resolved, { tenantId: rt.config.tenantId });
    if (args.bool("json", "j")) {
      printJson(progress);
      return 0;
    }
    renderProgressText(progress, "project");
    return 0;
  } finally {
    await rt.close();
  }
}

function renderProgressText(progress: Progress, scope: "task" | "project"): void {
  const { counts, percentDone, eta } = progress;
  printInfo(`${color.bold(scope === "task" ? "Task progress" : "Project progress")}`);
  printInfo("");
  printInfo(`  ${color.bold(percentDone + "%")} done  (${counts.done}/${counts.denominator})`);
  printInfo("");
  printInfo("  Status breakdown :");
  printInfo(`    ${colorizeStatus("open").padEnd(20)}  ${counts.open}`);
  printInfo(`    ${colorizeStatus("in_progress").padEnd(20)}  ${counts.in_progress}`);
  printInfo(`    ${colorizeStatus("blocked").padEnd(20)}  ${counts.blocked}`);
  printInfo(`    ${colorizeStatus("done").padEnd(20)}  ${counts.done}`);
  printInfo(`    ${colorizeStatus("cancelled").padEnd(20)}  ${counts.cancelled}`);
  printInfo("");
  if (eta) {
    printInfo(`  ${color.bold("ETA")}  ${formatDuration(eta.remainingMs)}  ${color.dim(`(based on ${eta.sampleSize} similar completions ; mean interval ${formatDuration(eta.meanCompletionIntervalMs)})`)}`);
    printInfo(`         ${color.dim("→ ~" + new Date(eta.estimatedCompletionAt).toISOString().slice(0, 10))}`);
  } else {
    printInfo(`  ${color.dim("ETA  (insufficient data — need ≥ 3 recent completions in the same area)")}`);
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0";
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  if (ms >= WEEK) return `${(ms / WEEK).toFixed(1)}w`;
  if (ms >= DAY) return `${(ms / DAY).toFixed(1)}d`;
  if (ms >= HOUR) return `${(ms / HOUR).toFixed(1)}h`;
  return `${Math.round(ms / 60000)}min`;
}
