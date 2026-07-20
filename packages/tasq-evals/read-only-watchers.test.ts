/** TQ-108: the same read-only watcher contract across all five bundled domains. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommitment,
  createWaitCondition,
  diagnoseStore,
  ingestObservation,
  inspectCommitment,
  listObservations,
  openDb,
  reconcileWaitObservation,
  runMigrations,
} from "@tasq-internal/local-service";

interface WatcherFixture {
  id: string;
  condition: { kind: string; parameters: Record<string, unknown> };
  observation: {
    source: string;
    externalEventId: string;
    kind: string;
    payload: Record<string, unknown>;
    occurredAt: number;
    verificationLevel: string;
    verificationMethod: string;
    rawRef: string;
    digest: string;
    metadata: Record<string, unknown>;
  };
  expected: {
    conditionTypeUri: string;
    observationTypeUri: string;
    evaluatorUri: string;
  };
}

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/read-only-watchers.json", import.meta.url),
  "utf8",
)) as WatcherFixture[];
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("TQ-108 read-only watcher fixtures", () => {
  it("normalizes, deduplicates, reconciles and inspects all five domains without secrets", async () => {
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "gmail-reply",
      "github-merge",
      "mercury-settlement",
      "filesystem-artifact",
      "http-health",
    ]);
    const serialized = JSON.stringify(fixtures).toLowerCase();
    for (const forbidden of [
      "accesstoken", "access_token", "authorization", "cookie", "password",
      "routingnumber", "accountnumber", "rawbody", "messagebody", "responsebody",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const dir = mkdtempSync(join(tmpdir(), "tasq-watchers-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const workspaceId = "watcher-fixtures";
    try {
      await runMigrations(client, { now: 10_000 });
      for (const [index, fixture] of fixtures.entries()) {
        const commitment = await createCommitment(db, {
          title: `Wait for ${fixture.id}`,
          successCriteria: `The ${fixture.id} fixture matches deterministically`,
          completionPolicy: "evidence",
        }, { workspaceId, actor: "fixture-runner", now: 11_000 + index * 100 });
        const condition = await createWaitCondition(db, {
          tenantId: workspaceId,
          taskId: commitment.id,
          kind: fixture.condition.kind,
          parameters: fixture.condition.parameters,
        }, { tenantId: workspaceId, actor: "fixture-runner", now: 11_010 + index * 100 });
        const observationInput = { tenantId: workspaceId, ...fixture.observation };
        const fact = await ingestObservation(db, observationInput, {
          tenantId: workspaceId,
          actor: `watcher:${fixture.id}`,
          now: 30_020 + index * 100,
        });
        const duplicate = await ingestObservation(db, observationInput, {
          tenantId: workspaceId,
          actor: `watcher:${fixture.id}`,
          now: 30_030 + index * 100,
        });
        expect(duplicate.id, fixture.id).toBe(fact.id);
        const result = await reconcileWaitObservation(db, condition.id, fact.id, {
          tenantId: workspaceId,
          actor: "fixture-reconciler",
          now: 30_040 + index * 100,
        });
        expect(result, fixture.id).toMatchObject({ decision: "matched", effect: "satisfied" });

        const snapshot = await inspectCommitment(db, commitment.id, {
          workspaceId,
          now: 30_050 + index * 100,
        });
        expect(snapshot?.conditions[0], fixture.id).toMatchObject({
          type: { uri: fixture.expected.conditionTypeUri, schemaVersion: 1 },
          evaluator: { uri: fixture.expected.evaluatorUri, version: 1 },
        });
        expect(snapshot?.observations[0], fixture.id).toMatchObject({
          type: { uri: fixture.expected.observationTypeUri, schemaVersion: 1 },
        });
        expect(snapshot?.evidence).toHaveLength(1);
      }

      const conflict = { ...fixtures[0]!.observation, payload: {
        ...fixtures[0]!.observation.payload,
        sender: "attacker@example.invalid",
      } };
      await expect(ingestObservation(db, { tenantId: workspaceId, ...conflict }, {
        tenantId: workspaceId,
        actor: "watcher:gmail-reply",
        now: 40_000,
      })).rejects.toThrow(/reused with different content/);

      const seen: string[] = [];
      let after: { recordedAt: number; id: string } | undefined;
      do {
        const page = await listObservations(db, { tenantId: workspaceId, after, ascending: true, limit: 2 });
        seen.push(...page.map((fact) => fact.id));
        const last = page.at(-1);
        after = last ? { recordedAt: last.recordedAt, id: last.id } : undefined;
        if (page.length < 2) break;
      } while (true);
      expect(seen).toHaveLength(fixtures.length);
      expect(new Set(seen).size).toBe(fixtures.length);

      const report = await diagnoseStore(db, client, workspaceId);
      expect(report.ok, JSON.stringify(report.issues, null, 2)).toBe(true);
    } finally {
      await close();
    }
  });
});
