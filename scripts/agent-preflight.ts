#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const canonicalRepository = "https://github.com/gwendall/tasq.git";

function run(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(argv, { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

const unknown = process.argv.slice(2).filter((arg) => arg !== "--json");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(", ")}`);
  process.exit(2);
}

const gitRoot = run(["git", "rev-parse", "--show-toplevel"]);
const remote = run(["git", "remote", "get-url", "origin"]);
const branch = run(["git", "branch", "--show-current"]);
const status = run(["git", "status", "--porcelain=v1"]);
const pnpm = run(["pnpm", "--version"]);
const backlog = readJson("docs/roadmap/BACKLOG.json");
const dogfood = readJson("docs/contracts/TQ-607_DOGFOOD_STATUS.json");
const active = backlog.items.find((item: any) => ![
  "done",
  "candidate_done_publication_gate",
  "candidate_done_external_gate",
].includes(item.status));
const dirtyFiles = status.stdout === "" ? [] : status.stdout.split("\n");
const canonicalCheckout = gitRoot.exitCode === 0 &&
  resolve(gitRoot.stdout) === repositoryRoot &&
  remote.exitCode === 0 &&
  [canonicalRepository, "https://github.com/gwendall/tasq", "git@github.com:gwendall/tasq.git"]
    .includes(remote.stdout);

const result = {
  contractVersion: "tasq.agent-preflight.v1",
  ok: canonicalCheckout && pnpm.exitCode === 0,
  repository: {
    root: gitRoot.stdout,
    origin: remote.stdout,
    canonical: canonicalCheckout,
    branch: branch.stdout,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  },
  tools: {
    bun: { current: Bun.version, minimum: "1.3.0" },
    node: { current: process.version.replace(/^v/, ""), minimum: "22.0.0" },
    pnpm: { current: pnpm.stdout, minimum: "10.29.0", available: pnpm.exitCode === 0 },
  },
  work: {
    activeBacklogItem: active ? { id: active.id, status: active.status, outcome: active.outcome } : null,
    dogfood: {
      phase: dogfood.currentPhase,
      earliestDecisionAt: dogfood.earliestDecisionAt,
      nextAction: dogfood.nextAction,
    },
  },
  readFirst: ["AGENTS.md", "docs/guides/DEVELOPMENT.md", "docs/concepts/CURRENT_STATE.md", "docs/roadmap/BACKLOG.json"],
  verification: {
    quick: [["pnpm", "docs:check"], ["pnpm", "typecheck"]],
    handoff: [["pnpm", "verify:handoff"]],
  },
  warnings: [
    ...(dirtyFiles.length > 0 ? ["Preserve and identify existing worktree changes before editing."] : []),
    ...(!canonicalCheckout ? ["Stop: this is not the canonical standalone Tasq checkout."] : []),
  ],
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result));
} else {
  console.log(`Tasq agent preflight: ${result.ok ? "OK" : "FAILED"}`);
  console.log(`Repository: ${result.repository.origin} (${result.repository.branch || "detached"})`);
  console.log(`Worktree: ${result.repository.dirty ? `${dirtyFiles.length} changed path(s)` : "clean"}`);
  console.log(`Current: ${result.work.activeBacklogItem?.id ?? "none"} — ${result.work.dogfood.nextAction}`);
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
}

process.exit(result.ok ? 0 : 1);
