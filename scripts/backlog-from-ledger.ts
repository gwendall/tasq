#!/usr/bin/env bun

/**
 * Imports the public roadmap into Tasq once, then projects its item records
 * back into the reviewed repository contract.
 *
 * BACKLOG.json remains the release-scope publication. The `items` array is a
 * deterministic projection of tasks that explicitly carry `metadata.publicId`;
 * ordinary execution tasks never leak into it. Product support truth remains
 * owned by PRODUCT_SURFACE_MATRIX.json.
 *
 *   pnpm backlog:project -- --import  # idempotently seed/update the ledger
 *   pnpm backlog:project              # report differences, write nothing
 *   pnpm backlog:project -- --write   # regenerate items + executionOrder
 *   pnpm backlog:project -- --check   # fail if a committed item was hand-edited
 *
 * `--import` and `--check` require the operator's ledger, so they belong on a
 * maintainer machine rather than CI. CI tests the pure projection contract.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type PublicStatus =
  | "done"
  | "in_progress_implementation"
  | "in_progress_dogfood"
  | "in_progress_external_gate"
  | "candidate_done_publication_gate"
  | "candidate_done_external_gate"
  | "pending_independent_review"
  | "pending";

export type BacklogItem = {
  id: string;
  status: PublicStatus;
  milestone: string;
  dependsOn: string[];
  outcome: string;
  remaining?: string[];
  evidence?: string[];
  evidenceTarget?: string[];
};

type Backlog = {
  contractVersion: string;
  statusVocabulary: PublicStatus[];
  executionOrder: string[];
  items: BacklogItem[];
  [key: string]: unknown;
};

export type LedgerTask = {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled" | string;
  metadata: Record<string, unknown> | null;
};

type CommandResult = Record<string, unknown> & { id?: string };

const repositoryRoot = resolve(import.meta.dir, "..");
const backlogPath = process.env.TASQ_BACKLOG_PATH
  ? resolve(process.env.TASQ_BACKLOG_PATH)
  : resolve(repositoryRoot, "docs/roadmap/BACKLOG.json");
const cli = process.env.TASQ_CLI ?? resolve(repositoryRoot, "dist/cli/index.js");
const space = process.env.TASQ_TENANT ?? "tasq/dev";
const actor = process.env.TASQ_ACTOR ?? "tasq-roadmap-import";

function arrayOfStrings(value: unknown, field: string, publicId: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${publicId}: metadata.${field} must be an array of strings`);
  }
  return [...value];
}

function requireString(value: unknown, field: string, publicId: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${publicId}: metadata.${field} must be a non-empty string`);
  }
  return value;
}

export function publicMetadata(item: BacklogItem, order: number): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    roadmapProjectionVersion: 1,
    publicId: item.id,
    publicOrder: order,
    publicStatus: item.status,
    milestone: item.milestone,
    dependsOn: [...item.dependsOn],
    outcome: item.outcome,
  };
  if (item.remaining !== undefined) metadata.remaining = [...item.remaining];
  if (item.evidence !== undefined) metadata.evidence = [...item.evidence];
  if (item.evidenceTarget !== undefined) metadata.evidenceTarget = [...item.evidenceTarget];
  return metadata;
}

function projectedStatus(task: LedgerTask, metadata: Record<string, unknown>, vocabulary: PublicStatus[]): PublicStatus {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") {
    throw new Error(`${String(metadata.publicId)}: cancelled roadmap tasks cannot be published`);
  }
  const publicStatus = requireString(metadata.publicStatus, "publicStatus", String(metadata.publicId));
  if (publicStatus === "done") {
    throw new Error(`${String(metadata.publicId)}: ledger task is ${task.status}, but publicStatus is done`);
  }
  if (!vocabulary.includes(publicStatus as PublicStatus)) {
    throw new Error(`${String(metadata.publicId)}: unknown public status "${publicStatus}"`);
  }
  return publicStatus as PublicStatus;
}

export function projectItem(task: LedgerTask, vocabulary: PublicStatus[]): BacklogItem {
  const metadata = task.metadata ?? {};
  const publicId = requireString(metadata.publicId, "publicId", task.id);
  const outcome = requireString(metadata.outcome, "outcome", publicId);
  if (outcome.length <= 20) {
    throw new Error(`${publicId}: metadata.outcome must be longer than 20 characters`);
  }
  const order = metadata.publicOrder;
  if (!Number.isInteger(order) || (order as number) < 0) {
    throw new Error(`${publicId}: metadata.publicOrder must be a non-negative integer`);
  }

  const item: BacklogItem = {
    id: publicId,
    status: projectedStatus(task, metadata, vocabulary),
    milestone: requireString(metadata.milestone, "milestone", publicId),
    dependsOn: arrayOfStrings(metadata.dependsOn, "dependsOn", publicId) ?? [],
    outcome,
  };
  const remaining = arrayOfStrings(metadata.remaining, "remaining", publicId);
  const evidence = arrayOfStrings(metadata.evidence, "evidence", publicId);
  const evidenceTarget = arrayOfStrings(metadata.evidenceTarget, "evidenceTarget", publicId);
  if (remaining !== undefined) item.remaining = remaining;
  if (evidence !== undefined) item.evidence = evidence;
  if (evidenceTarget !== undefined) item.evidenceTarget = evidenceTarget;
  return item;
}

export function projectItems(backlog: Backlog, tasks: LedgerTask[]): BacklogItem[] {
  const published = tasks.filter((task) => typeof task.metadata?.publicId === "string");
  const seen = new Set<string>();
  const projected = published.map((task) => {
    const item = projectItem(task, backlog.statusVocabulary);
    if (seen.has(item.id)) throw new Error(`${item.id}: duplicate metadata.publicId in ${space}`);
    seen.add(item.id);
    return { item, order: task.metadata!.publicOrder as number };
  });
  projected.sort((left, right) => left.order - right.order || left.item.id.localeCompare(right.item.id));
  return projected.map(({ item }) => item);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

export function projectionDifferences(backlog: Backlog, projected: BacklogItem[]): string[] {
  const differences: string[] = [];
  const committedById = new Map(backlog.items.map((item) => [item.id, item]));
  const projectedById = new Map(projected.map((item) => [item.id, item]));

  for (const item of projected) {
    const current = committedById.get(item.id);
    if (!current) differences.push(`${item.id}: in the ledger, absent from BACKLOG.json`);
    else if (stable(current) !== stable(item)) differences.push(`${item.id}: committed item differs from ledger projection`);
  }
  for (const item of backlog.items) {
    if (!projectedById.has(item.id)) differences.push(`${item.id}: in BACKLOG.json, absent from the ledger`);
  }
  const order = projected.map((item) => item.id);
  if (stable(backlog.executionOrder) !== stable(order)) {
    differences.push("executionOrder differs from the ledger projection");
  }
  return differences;
}

function runCli(args: string[]): CommandResult {
  const result = Bun.spawnSync([cli, ...args, "--tenant", space, "--actor", actor, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TASQ_TENANT: space },
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(`tasq ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
  }
  return stdout ? JSON.parse(stdout) as CommandResult : {};
}

function readLedgerTasks(): LedgerTask[] {
  return runCli(["list", "--limit", "5000"]) as unknown as LedgerTask[];
}

function importedTitle(item: BacklogItem): string {
  const title = `${item.id} — ${item.outcome}`;
  return title.length <= 500 ? title : `${title.slice(0, 497)}...`;
}

function evidenceUris(item: BacklogItem): string[] {
  return item.evidence ?? item.evidenceTarget ?? [];
}

function containsMetadata(current: Record<string, unknown> | null, expected: Record<string, unknown>): boolean {
  if (!current) return false;
  return Object.entries(expected).every(([key, value]) => stable(current[key]) === stable(value));
}

function importBacklog(backlog: Backlog): void {
  const existing = readLedgerTasks();
  const byPublicId = new Map<string, LedgerTask>();
  for (const task of existing) {
    const publicId = task.metadata?.publicId;
    if (typeof publicId !== "string") continue;
    if (byPublicId.has(publicId)) throw new Error(`${publicId}: duplicate metadata.publicId in ${space}`);
    byPublicId.set(publicId, task);
  }

  const ids = new Map<string, string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [order, item] of backlog.items.entries()) {
    const metadata = publicMetadata(item, order);
    const current = byPublicId.get(item.id);
    if (current) {
      if (containsMetadata(current.metadata, metadata)) unchanged += 1;
      else {
        runCli(["update", current.id, "--metadata-patch", JSON.stringify(metadata)]);
        updated += 1;
      }
      ids.set(item.id, current.id);
      continue;
    }
    const added = runCli([
      "add",
      importedTitle(item),
      "--description",
      item.outcome,
      "--success",
      `The published ${item.id} outcome is satisfied by its recorded repository evidence`,
      "--completion",
      "evidence",
      "--metadata",
      JSON.stringify(metadata),
      "--idempotency-key",
      `roadmap-import:${item.id}:v1`,
    ]);
    if (typeof added.id !== "string") throw new Error(`${item.id}: add returned no task id`);
    ids.set(item.id, added.id);
    created += 1;
  }

  // Materialize only dependencies that can still affect actionability. The
  // historical roadmap contains release-era cycles among already-done items;
  // those remain honest publication metadata but must not be smuggled into
  // the acyclic kernel relation graph.
  const importedIds = new Set(ids.keys());
  for (const item of backlog.items) {
    const taskId = ids.get(item.id)!;
    const shown = runCli(["show", taskId]) as CommandResult & {
      dependencies?: Array<{ fromTaskId?: string; toTaskId?: string; type?: string }>;
    };
    const existingEdges = new Set(
      (shown.dependencies ?? [])
        .filter((edge) => edge.fromTaskId === taskId)
        .map((edge) => `${edge.type}:${edge.toTaskId}`),
    );
    if (item.status === "done" || shown.status === "done") continue;
    for (const dependency of item.dependsOn) {
      if (!importedIds.has(dependency)) continue;
      const dependencyId = ids.get(dependency)!;
      if (existingEdges.has(`blocks:${dependencyId}`)) continue;
      runCli(["depend", taskId, "--on", dependencyId, "--type", "blocks"]);
    }
  }

  let completed = 0;
  for (const item of backlog.items) {
    if (item.status !== "done") continue;
    const taskId = ids.get(item.id)!;
    const current = runCli(["show", taskId]);
    if (current.status === "done") continue;
    const evidenceIds: string[] = [];
    for (const [index, uri] of evidenceUris(item).entries()) {
      const evidence = runCli([
        "evidence",
        "add",
        taskId,
        "--kind",
        "roadmap-import",
        "--uri",
        uri.startsWith("https://") ? uri : `repo:${uri}`,
        "--summary",
        `${item.id} historical repository evidence ${index + 1}`,
        "--idempotency-key",
        `roadmap-import:${item.id}:${taskId}:evidence:${index + 1}`,
      ]);
      if (typeof evidence.id !== "string") throw new Error(`${item.id}: evidence add returned no id`);
      evidenceIds.push(evidence.id);
    }
    if (evidenceIds.length === 0) throw new Error(`${item.id}: done roadmap item has no evidence coordinate`);
    runCli([
      "done",
      taskId,
      "--evidence",
      evidenceIds.join(","),
      "--reason",
      "Historical roadmap state imported from the reviewed BACKLOG.json contract",
      "--idempotency-key",
      `roadmap-import:${item.id}:${taskId}:done:v1`,
    ]);
    completed += 1;
  }
  process.stdout.write(
    `Imported ${backlog.items.length} roadmap items: ${created} created, ${updated} updated, ${unchanged} unchanged, ${completed} completed\n`,
  );
}

function writeProjection(backlog: Backlog, projected: BacklogItem[]): void {
  backlog.items = projected;
  backlog.executionOrder = projected.map((item) => item.id);
  writeFileSync(backlogPath, `${JSON.stringify(backlog, null, 2)}\n`, "utf8");
}

function main(): void {
  const backlog = JSON.parse(readFileSync(backlogPath, "utf8")) as Backlog;
  if (process.argv.includes("--import")) importBacklog(backlog);
  const projected = projectItems(backlog, readLedgerTasks());
  const differences = projectionDifferences(backlog, projected);
  for (const difference of differences) process.stdout.write(`  ${difference}\n`);
  process.stdout.write(`${projected.length} projected from ${space}, ${differences.length} difference(s)\n`);

  if (process.argv.includes("--write") && differences.length > 0) {
    writeProjection(backlog, projected);
    process.stdout.write("BACKLOG.json regenerated; publish it through a reviewed pull request\n");
  } else if (process.argv.includes("--check") && differences.length > 0) {
    process.stderr.write("The ledger and published backlog disagree. Run with --write.\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
