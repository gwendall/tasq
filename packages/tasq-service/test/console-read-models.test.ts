import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock, task, uuidv7 } from "@tasq/schema";
import {
  acquireResourceLease,
  acquireTaskClaim,
  buildConsoleHealth,
  buildConsoleOverview,
  buildConsolePage,
  bootstrapCoordinationSpace,
  createCommitment,
  createPrincipal,
  createWaitCondition,
  installExtension,
  openDb,
  proposeEffect,
  runMigrations,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function fresh(start = 1_000) {
  const dir = mkdtempSync(join(tmpdir(), "tasq-console-models-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(start);
  await runMigrations(handle.client, { clock, installReferenceExtension: false });
  return { ...handle, clock, workspaceId: "console/team-a" };
}

describe("bounded Console read models", () => {
  it("is useful when empty and refuses to manufacture an integrity claim or authority time", async () => {
    const h = await fresh();
    try {
      await expect(buildConsoleOverview(h.db, { workspaceId: h.workspaceId }))
        .rejects.toThrow(/require an injected clock/);

      const overview = await buildConsoleOverview(h.db, { workspaceId: h.workspaceId, now: 42_000 });
      expect(overview).toMatchObject({
        contractVersion: "tasq.console-overview.v1",
        inspectedAt: 42_000,
        attention: ["workspace_missing"],
        workspaceExists: false,
        counts: {
          commitments: {},
          claims: { active: 0, expiredHeld: 0 },
          resources: { active: 0, expiredHeld: 0 },
          waits: { waiting: 0, overdue: 0 },
        },
      });
      expect(Object.keys(overview.pages).sort()).toEqual([
        "actors", "audit", "claims", "effects", "resources", "waits", "work",
      ]);

      const health = await buildConsoleHealth(h.db, { workspaceId: h.workspaceId, now: 42_000 });
      expect(health).toMatchObject({
        contractVersion: "tasq.console-health.v1",
        assessment: "attention",
        scope: "bounded_operational_signals",
        workspaceExists: false,
        fullIntegrity: {
          checked: false,
          reason: "full_doctor_is_explicit_and_not_request_bounded",
          argv: ["tasq", "doctor", "--tenant", h.workspaceId],
        },
        cursors: { eventSequence: 0, resourceEventSequence: 0 },
      });
    } finally {
      await h.close();
    }
  });

  it("pages a mature hostile workspace without leaking bodies and derives expiry only from injected time", async () => {
    const h = await fresh();
    try {
      const hostile = `<script>globalThis.pwned=true</script>`;
      const runtime = (await bootstrapCoordinationSpace(h.db, {
        workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
      })).principal;
      const hostileActor = await createPrincipal(h.db, {
        tenantId: h.workspaceId,
        kind: "agent",
        displayName: hostile,
        localAlias: "hostile",
      }, { tenantId: h.workspaceId, actor: "runtime", clock: h.clock });
      const commitments = [];
      for (const title of [hostile, "Wait for fact", "Propose deploy"]) {
        h.clock.advance(10);
        commitments.push(await createCommitment(h.db, { title }, {
          workspaceId: h.workspaceId, actor: "runtime", principalId: runtime.id, clock: h.clock,
        }));
      }
      await acquireTaskClaim(h.db, commitments[0]!.id, {
        tenantId: h.workspaceId, actor: "runtime", principalId: runtime.id,
        leaseMs: 1_000, clock: h.clock,
      });
      await acquireResourceLease(h.db, "robot:arm:left", {
        workspaceId: h.workspaceId, actor: "runtime", principalId: runtime.id,
        leaseMs: 1_000, idempotencyKey: "console-resource", clock: h.clock,
      });
      await createWaitCondition(h.db, {
        tenantId: h.workspaceId,
        taskId: commitments[1]!.id,
        kind: "http.response",
        parameters: { url: "https://example.test/health", method: "GET", allowedStatuses: [200] },
        notBefore: h.clock.now(),
        deadlineAt: h.clock.now() + 1_000,
      }, { tenantId: h.workspaceId, actor: "runtime", clock: h.clock });
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
      }, { tenantId: h.workspaceId, actor: "runtime", principalId: runtime.id, clock: h.clock });
      await proposeEffect(h.db, {
        tenantId: h.workspaceId,
        taskId: commitments[2]!.id,
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
            instanceRef: "connector:deploy:test",
            bindingDigest: `sha256:${"b".repeat(64)}`,
          },
          parameters: { ref: hostile },
          secretBindings: [],
        },
      }, { principalId: runtime.id, clock: h.clock });

      h.clock.advance(1_001);
      const overview = await buildConsoleOverview(h.db, { workspaceId: h.workspaceId, clock: h.clock });
      expect(overview.attention).toEqual(["expired_claims", "expired_resources", "overdue_waits"]);
      expect(overview.counts).toMatchObject({
        actors: { enabled: 2, disabled: 0 },
        claims: { active: 0, expiredHeld: 1 },
        resources: { active: 0, expiredHeld: 1 },
        waits: { waiting: 1, overdue: 1 },
        effects: { proposed: 1 },
      });

      const sections = ["actors", "claims", "resources", "waits", "effects", "audit"] as const;
      for (const section of sections) {
        const page = await buildConsolePage(h.db, { workspaceId: h.workspaceId, section, limit: 100, clock: h.clock });
        expect(page.section).toBe(section);
        expect(page.inspectedAt).toBe(h.clock.now());
        expect(page.items.length).toBeGreaterThan(0);
        expect(JSON.stringify(page)).not.toContain("secretBindings");
        expect(JSON.stringify(page)).not.toContain(`\"ref\":\"${hostile}`);
      }
      const audit = await buildConsolePage(h.db, {
        workspaceId: h.workspaceId, section: "audit", limit: 100, clock: h.clock,
      });
      expect(audit.items.every((item) => item.payload.reason === "operator_index_redaction")).toBe(true);

      const first = await buildConsolePage(h.db, {
        workspaceId: h.workspaceId, section: "work", limit: 1, clock: h.clock,
      });
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const second = await buildConsolePage(h.db, {
        workspaceId: h.workspaceId, section: "work", limit: 1,
        cursor: first.nextCursor, clock: h.clock,
      });
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      await expect(buildConsolePage(h.db, {
        workspaceId: h.workspaceId, section: "actors", cursor: first.nextCursor, clock: h.clock,
      })).rejects.toThrow(/does not match this workspace and section/);
      await expect(buildConsolePage(h.db, {
        workspaceId: "console/team-b", section: "work", cursor: first.nextCursor, clock: h.clock,
      })).rejects.toThrow(/does not match this workspace and section/);
      expect(hostileActor.id).not.toBe(runtime.id);
    } finally {
      await h.close();
    }
  });

  it("keeps the frozen 2,500-record fixture bounded and within its coarse request budget", async () => {
    const h = await fresh();
    try {
      await createCommitment(h.db, { title: "Bootstrap fixture" }, {
        workspaceId: h.workspaceId, actor: "fixture", clock: h.clock,
      });
      const total = 2_500;
      for (let offset = 0; offset < total; offset += 100) {
        const rows = Array.from({ length: Math.min(100, total - offset) }, (_, index) => {
          const sequence = offset + index + 1;
          const at = 10_000 + sequence;
          return {
            id: uuidv7(at), tenantId: h.workspaceId, title: `Large fixture ${sequence}`,
            createdAt: at, updatedAt: at,
          };
        });
        await h.db.insert(task).values(rows);
      }

      const plan = await h.client.execute({
        sql: `EXPLAIN QUERY PLAN
          SELECT id, title, status, revision, priority, due_at, created_at, updated_at
          FROM task
          WHERE tenant_id = ? AND deleted_at IS NULL AND status NOT IN ('done','cancelled')
          ORDER BY created_at DESC, id DESC LIMIT 101`,
        args: [h.workspaceId],
      });
      const planText = plan.rows.map((row) => String(row.detail ?? "")).join("\n");
      expect(planText).toContain("idx_console_work");
      expect(planText).not.toContain("USE TEMP B-TREE");
      const installedIndexes = await h.client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_console_%' ORDER BY name",
      );
      expect(installedIndexes.rows.map((row) => row.name)).toEqual([
        "idx_console_actors",
        "idx_console_claims",
        "idx_console_delivery_status",
        "idx_console_effects",
        "idx_console_replication_outgoing_status",
        "idx_console_resources",
        "idx_console_waits",
        "idx_console_work",
      ]);

      const started = performance.now();
      const page = await buildConsolePage(h.db, {
        workspaceId: h.workspaceId, section: "work", limit: 100, now: 99_000,
      });
      const overview = await buildConsoleOverview(h.db, { workspaceId: h.workspaceId, now: 99_000 });
      const elapsedMs = performance.now() - started;
      expect(page).toMatchObject({ returned: 100, hasMore: true, inspectedAt: 99_000 });
      expect(overview.counts.commitments.open).toBe(2_501);
      // This is deliberately a generous regression ceiling, not a latency SLO.
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      await h.close();
    }
  });
});
