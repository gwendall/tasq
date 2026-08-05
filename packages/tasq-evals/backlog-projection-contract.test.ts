/**
 * Guards the ledger-to-backlog projection without needing a ledger.
 *
 * CI has no ledger to project from, so it cannot verify that the committed
 * backlog matches a space. What it can verify, and what actually protects the
 * public contract, is that the projector refuses to guess: publication text is
 * explicit, execution fields are never repurposed as public prose, and only
 * tasks that opted in are published at all.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const projector = readFileSync(resolve(repositoryRoot, "scripts/backlog-from-ledger.ts"), "utf8");
const backlog = JSON.parse(
  readFileSync(resolve(repositoryRoot, "docs/roadmap/BACKLOG.json"), "utf8"),
) as { items: Array<{ id: string; status: string; outcome: string }>; statusVocabulary: string[] };

describe("ledger to backlog projection", () => {
  test("publishes only tasks that opted in", () => {
    // Working tasks vastly outnumber published ones. Projecting a space
    // wholesale would leak internal execution into a public contract.
    expect(projector).toContain('typeof task.metadata?.publicId === "string"');
  });

  test("never infers publication prose from execution fields", () => {
    // The first version projected `outcome` from successCriteria and produced
    // five wrong outcomes: "how will we know this is done" is not "what does
    // this deliver". Publication fields are read, never derived.
    expect(projector).toContain("metadata.outcome");
    expect(projector).not.toMatch(/outcome\s*=\s*[^;]*successCriteria/);
  });

  test("every projected status is in the frozen public vocabulary", () => {
    const block = /STATUS_PROJECTION[^=]*=\s*\{([^}]*)\}/.exec(projector);
    expect(block, "status projection table not found").not.toBeNull();
    const targets = [...block![1].matchAll(/:\s*"([a-z_]+)"/g)].map((match) => match[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(backlog.statusVocabulary, `"${target}" is not a published status`).toContain(target);
    }
  });

  test("refuses an outcome too short to be a public contract", () => {
    // public-roadmap.test.ts requires outcome.length > 20 on every item. The
    // projector must reject it at the source rather than write a file that
    // fails that eval afterwards.
    expect(projector).toContain("outcome.length <= 20");
    for (const item of backlog.items) {
      expect(item.outcome.length, `${item.id}: outcome too short`).toBeGreaterThan(20);
    }
  });

  test("carries no timestamp, ledger id or workstation path into the file", () => {
    // Determinism is what makes a projection reviewable: re-running it on an
    // unchanged ledger must produce a byte-identical file.
    expect(projector).not.toMatch(/Date\.now\(|new Date\(/);
    expect(projector).not.toMatch(/\/Users\/|\/home\//);
    expect(projector).toContain("localeCompare");
  });

  test("states that --check belongs on a maintainer machine, not in CI", () => {
    expect(projector).toMatch(/no ledger to compare against/i);
  });
});
