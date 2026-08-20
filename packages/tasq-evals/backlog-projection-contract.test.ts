import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const projectorPath = resolve(repositoryRoot, "scripts/backlog-from-ledger.ts");
const source = readFileSync(projectorPath, "utf8");

type PublicStatus =
  | "done"
  | "in_progress_implementation"
  | "in_progress_dogfood"
  | "in_progress_external_gate"
  | "candidate_done_publication_gate"
  | "candidate_done_external_gate"
  | "pending_independent_review"
  | "pending";
type BacklogItem = {
  id: string;
  status: PublicStatus;
  milestone: string;
  dependsOn: string[];
  outcome: string;
  remaining?: string[];
  evidence?: string[];
  evidenceTarget?: string[];
};
type LedgerTask = {
  id: string;
  title: string;
  status: string;
  metadata: Record<string, unknown> | null;
};
type BacklogContract = {
  contractVersion: string;
  statusVocabulary: PublicStatus[];
  executionOrder: string[];
  items: BacklogItem[];
  [key: string]: unknown;
};
type ProjectionModule = {
  publicMetadata(item: BacklogItem, order: number): Record<string, unknown>;
  projectItems(backlog: BacklogContract, tasks: LedgerTask[]): BacklogItem[];
  projectionDifferences(backlog: BacklogContract, projected: BacklogItem[]): string[];
};

// A computed dynamic import keeps this executable script outside the eval
// package's TypeScript project while testing its real exports under Bun.
const { projectionDifferences, projectItems, publicMetadata } = await import(projectorPath) as ProjectionModule;
const backlog = JSON.parse(
  readFileSync(resolve(repositoryRoot, "docs/roadmap/BACKLOG.json"), "utf8"),
) as BacklogContract;

function ledgerTasks(): LedgerTask[] {
  return backlog.items.map((item, order) => ({
    id: `ledger-${order}`,
    title: item.id,
    status: item.status === "done" ? "done" : "open",
    metadata: publicMetadata(item, order),
  }));
}

describe("ledger-backed public backlog", () => {
  test("round-trips every item and its execution order", () => {
    const projected = projectItems(backlog, ledgerTasks());
    expect(projected).toEqual(backlog.items);
    expect(projectionDifferences(backlog, projected)).toEqual([]);
    expect(projected).toHaveLength(backlog.executionOrder.length);
  });

  test("detects a hand-edited published item", () => {
    const projected = projectItems(backlog, ledgerTasks());
    const edited = structuredClone(backlog);
    edited.items[0]!.outcome += " hand edit";
    expect(projectionDifferences(edited, projected)).toContain(
      `${edited.items[0]!.id}: committed item differs from ledger projection`,
    );
  });

  test("uses lifecycle done while preserving non-terminal public gate detail", () => {
    const item = backlog.items.find((candidate) => candidate.status === "candidate_done_external_gate")!;
    const metadata = publicMetadata(item, 0);
    expect(projectItems(backlog, [{ id: "open", title: item.id, status: "open", metadata }])[0]!.status)
      .toBe("candidate_done_external_gate");
    expect(projectItems(backlog, [{ id: "done", title: item.id, status: "done", metadata }])[0]!.status)
      .toBe("done");
  });

  test("publishes only explicit public IDs and rejects duplicates", () => {
    const tasks = ledgerTasks();
    tasks.push({ id: "private", title: "ordinary execution", status: "open", metadata: {} });
    expect(projectItems(backlog, tasks)).toHaveLength(backlog.items.length);
    tasks.push({ ...tasks[0]!, id: "duplicate" });
    expect(() => projectItems(backlog, tasks)).toThrow(/duplicate metadata\.publicId/);
  });

  test("is deterministic and contains no workstation or wall-clock authority", () => {
    expect(source).not.toMatch(/Date\.now\(|new Date\(/);
    expect(source).not.toMatch(/\/Users\/|\/home\//);
    expect(source).toContain("publicOrder");
    expect(source).toContain("localeCompare");
    expect(source).toContain("--idempotency-key");
    expect(source).toContain('item.status === "done"');
    expect(source).toContain("containsMetadata");
  });

  test("documents that ledger checks do not run in ledger-free CI", () => {
    expect(source).toMatch(/maintainer machine rather than CI/i);
  });
});
