#!/usr/bin/env bun

/**
 * Projects a Tasq space onto the repository's public backlog items.
 *
 * The point is to stop maintaining the same intention in two places. A task
 * lives in the ledger, where it is claimed, attempted and closed with evidence;
 * `docs/roadmap/BACKLOG.json` is its *publication*, and a pull request is the
 * governance step the ledger deliberately does not have.
 *
 * Only tasks carrying `metadata.publicId` are projected, so ordinary working
 * tasks never leak into a public contract. Everything else in the backlog
 * (external gates, invariants, ADR decisions, support truth) stays hand-written:
 * it does not model tasks and must not be generated from one.
 *
 * Determinism is the whole game. Output is ordered by publicId and carries no
 * timestamp, ledger identifier or workstation path, so re-running it on an
 * unchanged ledger produces a byte-identical file and a reviewer sees only real
 * changes.
 *
 *   bun scripts/backlog-from-ledger.ts            # report the diff, write nothing
 *   bun scripts/backlog-from-ledger.ts --write    # apply it to BACKLOG.json
 *   bun scripts/backlog-from-ledger.ts --check    # exit 1 if the two disagree
 *
 * `--check` needs the ledger, so it belongs on a maintainer's machine, not in
 * CI: a clean CI checkout has no ledger to compare against. What CI enforces is
 * the committed file's own contract, which `public-roadmap.test.ts` already does.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type LedgerTask = {
  id: string;
  title: string;
  status: string;
  successCriteria: string | null;
  nextAction: string | null;
  metadata: Record<string, unknown> | null;
};

type BacklogItem = {
  id: string;
  status: string;
  milestone: string;
  dependsOn: string[];
  outcome: string;
  remaining?: string[];
  evidence?: string[];
};

const repositoryRoot = resolve(import.meta.dir, "..");
const backlogPath = resolve(repositoryRoot, "docs/roadmap/BACKLOG.json");

const cli = process.env.TASQ_CLI ?? resolve(repositoryRoot, "dist/cli/index.js");
const space = process.env.TASQ_TENANT ?? "tasq/dev";

/** Ledger status → the backlog's frozen status vocabulary. */
const STATUS_PROJECTION: Record<string, string> = {
  open: "pending",
  in_progress: "in_progress_implementation",
  blocked: "pending",
  done: "done",
};

function readLedgerTasks(): LedgerTask[] {
  const result = Bun.spawnSync([cli, "list", "--tenant", space, "--limit", "5000", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TASQ_TENANT: space },
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Cannot read the ledger (${cli}, space ${space}): ${stderr || "unknown error"}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as LedgerTask[];
}

/**
 * Publication fields are explicit, never inferred from execution fields. The
 * first version of this script projected `outcome` from the task's success
 * criteria and produced five wrong outcomes: a success criterion answers "how
 * will we know this is done", a roadmap outcome answers "what does this
 * deliver". Both matter, they are not the same sentence, and guessing one from
 * the other silently rewrites a public contract.
 */
function projectItem(task: LedgerTask): BacklogItem {
  const metadata = task.metadata ?? {};
  const publicId = String(metadata.publicId);
  const status = STATUS_PROJECTION[task.status];
  if (!status) throw new Error(`${publicId}: no projection for ledger status "${task.status}"`);

  const outcome = String(metadata.outcome ?? "").trim();
  if (outcome.length <= 20) {
    throw new Error(
      `${publicId}: metadata.outcome is missing or too short. Publication text is explicit: `
      + `set it with \`tasq update <id> --metadata-patch '{"outcome":"..."}'\``,
    );
  }

  const dependsOn = Array.isArray(metadata.dependsOn) ? metadata.dependsOn.map(String).sort() : [];
  const remaining = Array.isArray(metadata.remaining) ? metadata.remaining.map(String) : [];

  const item: BacklogItem = {
    id: publicId,
    status,
    milestone: String(metadata.milestone ?? "unassigned"),
    dependsOn,
    outcome,
  };
  if (remaining.length > 0) item.remaining = remaining;
  return item;
}

const published = readLedgerTasks()
  .filter((task) => typeof task.metadata?.publicId === "string")
  .map(projectItem)
  .sort((left, right) => left.id.localeCompare(right.id));

if (published.length === 0) {
  throw new Error(`No task in ${space} carries metadata.publicId; nothing to project`);
}

const backlog = JSON.parse(readFileSync(backlogPath, "utf8")) as {
  items: BacklogItem[];
  executionOrder: string[];
};
const committed = new Map(backlog.items.map((item) => [item.id, item]));

const differences: string[] = [];
for (const projected of published) {
  const current = committed.get(projected.id);
  if (!current) {
    differences.push(`${projected.id}: in the ledger, absent from the backlog`);
    continue;
  }
  for (const field of ["status", "milestone", "outcome"] as const) {
    if (current[field] !== projected[field]) {
      differences.push(`${projected.id}.${field}: backlog "${current[field]}" vs ledger "${projected[field]}"`);
    }
  }
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check");

for (const line of differences) process.stdout.write(`  ${line}\n`);
process.stdout.write(
  `${published.length} projected from ${space}, ${differences.length} difference(s)\n`,
);

if (write && differences.length > 0) {
  let source = readFileSync(backlogPath, "utf8");
  for (const projected of published) {
    const current = committed.get(projected.id);
    if (!current) continue;
    // Rewrite in place, field by field, so the file's hand-authored formatting
    // and every unprojected field survive untouched.
    for (const field of ["status", "milestone", "outcome"] as const) {
      if (current[field] === projected[field]) continue;
      const pattern = new RegExp(
        `("id": ${JSON.stringify(projected.id)},[\\s\\S]{0,600}?"${field}": )${JSON.stringify(current[field])}`,
      );
      if (!pattern.test(source)) throw new Error(`${projected.id}.${field}: cannot locate it in the file`);
      source = source.replace(pattern, `$1${JSON.stringify(projected[field])}`);
    }
  }
  writeFileSync(backlogPath, source, "utf8");
  process.stdout.write("BACKLOG.json updated; publish it through a pull request\n");
} else if (check && differences.length > 0) {
  process.stderr.write("\nThe ledger and the published backlog disagree. Run with --write.\n");
  process.exit(1);
}
