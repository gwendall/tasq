import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq/schema";
import {
  buildInspectorIndex,
  createCommitment,
  createPrincipal,
  createWaitCondition,
  installExtension,
  openDb,
  proposeEffect,
  recordEffectApproval,
  runMigrations,
  startCommitment,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-inspector-index-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(10_000);
  await runMigrations(handle.client, { clock, installReferenceExtension: true });
  return { ...handle, clock, workspaceId: "inspection/team-a" };
}

describe("read-first inspector index", () => {
  it("is hard-bounded, filter-honest and deterministic from an injected clock", async () => {
    const h = await fresh();
    try {
      for (let index = 0; index < 103; index++) {
        await createCommitment(h.db, {
          title: index === 0 ? "literal 100%_done" : index === 1 ? "literal 100XXdone" : `Commitment ${index}`,
        }, { workspaceId: h.workspaceId, actor: "fixture", clock: h.clock });
        h.clock.advance(1);
      }
      const snapshot = await buildInspectorIndex(h.db, {
        workspaceId: h.workspaceId,
        limit: 100,
        clock: h.clock,
      });
      expect(snapshot).toMatchObject({
        contractVersion: "tasq.inspector-index.v1",
        inspectedAt: 10_103,
        matched: 103,
        truncated: true,
      });
      expect(snapshot.items).toHaveLength(100);

      const literal = await buildInspectorIndex(h.db, {
        workspaceId: h.workspaceId,
        query: "%_",
        limit: 10,
        now: 42_000,
      });
      expect(literal).toMatchObject({ inspectedAt: 42_000, matched: 1, truncated: false });
      expect(literal.items[0]?.title).toBe("literal 100%_done");
    } finally {
      await h.close();
    }
  });

  it("aggregates coordination signals without importing graph bodies into the index", async () => {
    const h = await fresh();
    try {
      const principal = await createPrincipal(h.db, {
        tenantId: h.workspaceId,
        displayName: "Inspector fixture",
        kind: "agent",
        localAlias: "fixture",
      }, { tenantId: h.workspaceId, actor: "fixture", clock: h.clock });
      const commitment = await createCommitment(h.db, {
        title: "Audit deployment authority",
      }, { workspaceId: h.workspaceId, actor: "fixture", principalId: principal.id, clock: h.clock });
      await createWaitCondition(h.db, {
        tenantId: h.workspaceId,
        taskId: commitment.id,
        kind: "http.response",
        parameters: { url: "https://example.test/health", method: "GET", allowedStatuses: [200] },
      }, { tenantId: h.workspaceId, actor: "fixture", clock: h.clock });
      await installExtension(h.db, {
        extensionUri: "https://example.test/extensions/deployment",
        version: "1.0.0",
        types: [{
          recordKind: "effect",
          typeUri: "https://example.test/effects/deploy",
          schemaVersion: 1,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { ref: { type: "string" } },
            required: ["ref"],
          },
        }],
        evaluators: [],
      }, { tenantId: h.workspaceId, actor: "fixture", principalId: principal.id, clock: h.clock });
      const effect = await proposeEffect(h.db, {
        tenantId: h.workspaceId,
        taskId: commitment.id,
        request: {
          protocol: "tasq.effect-request.v1",
          canonicalization: "tasq.jcs-safe-integer.v1",
          digestAlgorithm: "sha-256",
          workspaceId: h.workspaceId,
          effectTypeUri: "https://example.test/effects/deploy",
          effectSchemaVersion: 1,
          connector: {
            operationUri: "https://example.test/connectors/deploy",
            operationVersion: 1,
            contractDigest: `sha256:${"a".repeat(64)}`,
            instanceRef: "connector:deployment:test",
            bindingDigest: `sha256:${"b".repeat(64)}`,
          },
          parameters: { ref: "artifact:1" },
          secretBindings: [],
        },
      }, { principalId: principal.id, clock: h.clock });
      await recordEffectApproval(h.db, {
        tenantId: h.workspaceId,
        effectId: effect.id,
        decision: "denied",
      }, { principalId: principal.id, clock: h.clock });

      const snapshot = await buildInspectorIndex(h.db, {
        workspaceId: h.workspaceId,
        query: "deployment",
        limit: 10,
        clock: h.clock,
      });
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]?.signals).toEqual({
        waits: 1,
        waiting: 1,
        effects: 1,
        unresolvedEffects: 1,
        authorityDecisions: 1,
        receipts: 0,
      });
      expect(snapshot.items[0]).not.toHaveProperty("request");
      expect(snapshot.items[0]).not.toHaveProperty("parameters");

      await startCommitment(h.db, commitment.id, {
        workspaceId: h.workspaceId,
        actor: "fixture",
        principalId: principal.id,
        expectedRevision: commitment.revision,
        clock: h.clock,
      });
      const filtered = await buildInspectorIndex(h.db, {
        workspaceId: h.workspaceId,
        status: "in_progress",
        clock: h.clock,
      });
      expect(filtered.items.map((item) => item.commitmentId)).toEqual([commitment.id]);
    } finally {
      await h.close();
    }
  });

  it("fails closed when neither an explicit timestamp nor an injected clock exists", async () => {
    const h = await fresh();
    try {
      await expect(buildInspectorIndex(h.db, {
        workspaceId: h.workspaceId,
      })).rejects.toThrow(/requires an injected clock/);
    } finally {
      await h.close();
    }
  });
});
