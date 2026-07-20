/** TQ-503: reusable context is externally owned; Tasq retains only safe links. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachExternalContextLink,
  createCommitment,
  detachExternalContextLink,
  inspectCommitment,
  listExternalContextLinks,
  openDb,
  runKernelMigrations,
} from "@tasq/core";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function fixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `tasq-external-context-${name}-`));
  dirs.push(dir);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(opened.client, { now: 1_000 });
  return opened;
}

describe("TQ-503 external context-link acceptance", () => {
  for (const scenario of [
    { domain: "robotics", resourceType: "calibration-runbook", externalId: "arm-left/v7" },
    { domain: "software", resourceType: "deployment-runbook", externalId: "api/canary/v3" },
    { domain: "research", resourceType: "method-note", externalId: "dataset/provenance/v5" },
  ]) {
    it(`reuses one ${scenario.domain} context identity without kernel domain knowledge`, async () => {
      const { db, client, close } = await fixture(scenario.domain);
      const workspaceId = `${scenario.domain}/shared`;
      try {
        const first = await createCommitment(db, { title: "First desired outcome" }, {
          workspaceId, actor: "producer", now: 2_000,
        });
        const second = await createCommitment(db, { title: "Later desired outcome" }, {
          workspaceId, actor: "unrelated-reader", now: 2_001,
        });
        const target = {
          system: "https://memory.example.invalid",
          resourceType: scenario.resourceType,
          externalId: scenario.externalId,
          url: `https://memory.example.invalid/${scenario.externalId}`,
          version: "content-version-7",
          digest: null,
        };
        const links = await Promise.all([first, second].map((commitment, index) =>
          attachExternalContextLink(db, {
            workspaceId, commitmentId: commitment.id, target,
            expectedPreviousLinkId: null,
          }, {
            actor: index === 0 ? "producer" : "unrelated-reader",
            idempotencyKey: `reuse-${index}`,
            now: 3_000 + index,
            clock: { now: () => { throw new Error("explicit now must win"); } },
          })));

        expect(links[0]!.id).not.toBe(links[1]!.id);
        expect(links.every((link) => link.binding === "pinned" && link.state === "active"))
          .toBe(true);
        const inspection = await inspectCommitment(db, second.id, {
          workspaceId, now: 4_000,
          clock: { now: () => { throw new Error("device clock must not be read"); } },
        });
        expect(inspection?.externalContextLinks).toEqual([links[1]]);
        expect(inspection?.artifacts).toEqual([]);
        expect(inspection?.evidence).toEqual([]);
        expect(inspection?.completionRecords).toEqual([]);
        expect(JSON.stringify(inspection?.externalContextLinks)).not.toContain("memory body");

        const columns = await client.execute("PRAGMA table_info('external_context_link')");
        const names = columns.rows.map((row) => String(row.name));
        for (const forbidden of ["content", "body", "embedding", "credentials", "authority"]) {
          expect(names).not.toContain(forbidden);
        }
      } finally {
        await close();
      }
    });
  }

  it("makes an unpinned pointer honest and elects one append-only chain", async () => {
    const { db, close } = await fixture("race");
    const workspaceId = "knowledge/race";
    try {
      const commitment = await createCommitment(db, { title: "Use current procedure" }, {
        workspaceId, actor: "coordinator", now: 10_000,
      });
      const target = {
        system: "https://notes.example.invalid",
        resourceType: "procedure",
        externalId: "current",
        url: null,
        version: null,
        digest: null,
      };
      const race = await Promise.allSettled(["alpha", "beta"].map((actor, index) =>
        attachExternalContextLink(db, {
          workspaceId, commitmentId: commitment.id, target,
          expectedPreviousLinkId: null,
        }, { actor, idempotencyKey: `root-${actor}`, now: 11_000 + index })));
      expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(race.filter((item) => item.status === "rejected")).toHaveLength(1);
      const winner = (race.find((item) => item.status === "fulfilled") as
        PromiseFulfilledResult<Awaited<ReturnType<typeof attachExternalContextLink>>>).value;
      expect(winner.binding).toBe("floating");

      const detached = await detachExternalContextLink(db, {
        workspaceId, expectedPreviousLinkId: winner.id,
      }, { actor: "coordinator", idempotencyKey: "detach-winner", now: 12_000 });
      expect(detached.state).toBe("detached");
      expect(await listExternalContextLinks(db, {
        workspaceId, commitmentId: commitment.id, currentOnly: true,
      })).toEqual([]);
      expect((await listExternalContextLinks(db, {
        workspaceId, commitmentId: commitment.id,
      })).map((item) => item.state)).toEqual(["superseded", "detached"]);
    } finally {
      await close();
    }
  });
});
