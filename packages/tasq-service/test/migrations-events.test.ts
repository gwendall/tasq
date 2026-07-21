/**
 * Tests for the migration runner + event audit log.
 *
 * Migrations must be idempotent across runs (no double-apply, no schema
 * drift). The event log is the trust foundation: it must capture every
 * mutation with the correct actor, payload, ordering, and timestamp.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  runMigrations,
  createArea,
  createTask,
  getTask,
  startTask,
  completeTask,
  updateTask,
  listEvents,
  getEvent,
  recordEvent,
  diagnoseStore,
  type Event,
} from "../src/index.js";

const TASQ_ZERO_FIXTURE = fileURLToPath(
  new URL("./fixtures/0000-populated.sql", import.meta.url),
);
const PRE_AGENTIC_FIXTURE = fileURLToPath(
  new URL("./fixtures/pre-0006-populated.sql", import.meta.url),
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-mig-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  return h;
}

describe("Migration runner", () => {
  it("runs migrations on a fresh DB exactly once", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied.length).toBeGreaterThan(0);
      expect(first.skipped.length).toBe(0);

      const second = await runMigrations(client);
      expect(second.applied.length).toBe(0);
      expect(second.skipped.length).toBe(first.applied.length);
    } finally {
      await close();
    }
  });

  it("rejects drift in an already-applied migration", async () => {
    const { client, close } = await freshDb();
    try {
      await runMigrations(client);
      await client.execute("UPDATE _migration SET checksum = 'tampered' WHERE name = '0000_init.sql'");
      await expect(runMigrations(client)).rejects.toThrow(/checksum mismatch/);
    } finally {
      await close();
    }
  });

  it("creates the core and agentic entity tables + _migration", async () => {
    const { client, close } = await freshDb();
    try {
      await runMigrations(client);
      const tables = await client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      );
      const names = tables.rows.map((r) => r["name"] as string);
      expect(names).toContain("area");
      expect(names).toContain("goal");
      expect(names).toContain("project");
      expect(names).toContain("task");
      expect(names).toContain("event");
      expect(names).toContain("task_claim");
      expect(names).toContain("task_attempt");
      expect(names).toContain("task_evidence");
      expect(names).toEqual(expect.arrayContaining([
        "principal", "assignment", "commitment_relation", "artifact",
        "external_ref", "completion_record",
      ]));
      expect(names).toContain("_migration");
    } finally {
      await close();
    }
  });

  it("adds commitment criteria plus claim/attempt/evidence primitives (0006)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0006_agent_primitives.sql");
      const taskCols = await client.execute("PRAGMA table_info('task')");
      const taskColNames = taskCols.rows.map((row) => row["name"] as string);
      expect(taskColNames).toEqual(expect.arrayContaining(["success_criteria", "completion_mode"]));
      for (const table of ["task_claim", "task_attempt", "task_evidence"]) {
        const found = await client.execute({
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          args: [table],
        });
        expect(found.rows).toHaveLength(1);
      }
    } finally {
      await close();
    }
  });

  it("installs database guards for agentic invariants (0007)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0007_agent_invariants.sql");
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      );
      const names = triggers.rows.map((row) => row["name"] as string);
      expect(names).toEqual(expect.arrayContaining([
        "task_claim_validate_insert",
        "task_claim_identity_immutable",
        "task_attempt_validate_insert",
        "task_attempt_terminal_immutable",
        "task_no_terminal_with_active_attempt",
        "task_evidence_validate_insert",
        "task_evidence_no_update",
        "task_evidence_mode_requires_criteria_update",
      ]));
      const claimIndexes = await client.execute("PRAGMA index_list('task_claim')");
      expect(claimIndexes.rows.map((row) => row["name"])).toContain("uniq_task_claim_fence");
    } finally {
      await close();
    }
  });

  it("adds typed wait conditions and monotone lifecycle guards (0008)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0008_wait_condition.sql");
      const table = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='wait_condition'",
      );
      expect(table.rows).toHaveLength(1);
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      );
      expect(triggers.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "task_no_terminal_with_waiting_condition",
        "wait_condition_identity_immutable",
        "wait_condition_no_delete",
        "wait_condition_transition_guard",
        "wait_condition_validate_insert",
      ]));
      const indexes = await client.execute("PRAGMA index_list('wait_condition')");
      expect(indexes.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "idx_wait_condition_due",
        "idx_wait_condition_kind",
        "idx_wait_condition_task_status",
        "uniq_wait_condition_supersedes",
      ]));
    } finally {
      await close();
    }
  });

  it("adds immutable deduplicated observations and indexes candidate routing (0009)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0009_observation.sql");
      const table = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observation'",
      );
      expect(table.rows).toHaveLength(1);
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      );
      expect(triggers.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "observation_no_delete",
        "observation_no_update",
        "observation_validate_insert",
        "wait_condition_insert_waiting_only",
        "wait_condition_satisfied_observation_validate",
      ]));
      const indexes = await client.execute("PRAGMA index_list('observation')");
      expect(indexes.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "idx_observation_candidate",
        "idx_observation_recorded",
        "uniq_observation_delivery",
      ]));
    } finally {
      await close();
    }
  });

  it("adds immutable reconciliation and multi-key observation routes (0010)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0010_reconciliation.sql");
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observation_route','reconciliation') ORDER BY name",
      );
      expect(tables.rows.map((row) => row["name"])).toEqual([
        "observation_route",
        "reconciliation",
      ]);
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      );
      expect(triggers.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "observation_route_no_delete",
        "observation_route_no_update",
        "observation_route_validate_insert",
        "reconciliation_no_delete",
        "reconciliation_no_update",
        "reconciliation_validate_insert",
      ]));
    } finally {
      await close();
    }
  });

  it("hardens deadline fallback result semantics (0011)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0011_deadline_fallback.sql");
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='wait_condition_expiry_fallback_validate'",
      );
      expect(triggers.rows).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("adds the immutable universal extension registry and identities (0012)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0012_extension_registry.sql");
      for (const table of ["extension_release", "extension_type", "extension_evaluator"]) {
        const found = await client.execute({
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          args: [table],
        });
        expect(found.rows).toHaveLength(1);
      }
      for (const [table, columns] of [
        ["wait_condition", ["type_uri", "evaluator_uri", "evaluator_version", "evaluator_implementation_digest"]],
        ["observation", ["type_uri"]],
        ["reconciliation", ["evaluator_uri", "evaluator_version", "evaluator_implementation_digest"]],
      ] as const) {
        const info = await client.execute(`PRAGMA table_info('${table}')`);
        const names = info.rows.map((row) => String(row["name"]));
        expect(names).toEqual(expect.arrayContaining([...columns]));
      }
      const counts = await Promise.all([
        "extension_release", "extension_type", "extension_evaluator",
      ].map(async (table) => {
        const rows = await client.execute(`SELECT count(*) AS n FROM ${table}`);
        return Number(rows.rows[0]?.["n"]);
      }));
      expect(counts).toEqual([1, 10, 5]);
      await expect(client.execute(`INSERT INTO extension_release (
        id, tenant_id, extension_uri, version, manifest_json, manifest_digest, installed_at, installed_by
      ) VALUES (
        'bad-digest', 'gwendall', 'https://example.com/extensions/bad', '1.0.0', '{}',
        'sha256:${"g".repeat(64)}', 0, 'test'
      )`)).rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await close();
    }
  });

  it("adds the guarded effect ledger, dispatch gate and immutable receipts (0014-0016)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0014_effect_ledger.sql");
      expect(first.applied).toContain("0015_effect_dispatch_gate.sql");
      expect(first.applied).toContain("0016_effect_receipt.sql");
      for (const table of ["effect", "effect_approval", "effect_receipt"]) {
        const found = await client.execute({
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          args: [table],
        });
        expect(found.rows).toHaveLength(1);
      }
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      );
      expect(triggers.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "effect_revision_and_identity_guard",
        "effect_workspace_guard",
        "effect_authorization_guard",
        "effect_execution_authority_guard",
        "effect_execution_attempt_guard",
        "effect_receipt_insert_guard",
        "effect_outcome_transition_guard",
        "effect_approval_workspace_guard",
        "effect_approval_no_update",
      ]));
    } finally {
      await close();
    }
  });

  it("adds the local sink registry and transactional event outbox (0017)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0017_transactional_outbox.sql");
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('delivery_sink','delivery_outbox') ORDER BY name",
      );
      expect(tables.rows.map((row) => row["name"])).toEqual([
        "delivery_outbox",
        "delivery_sink",
      ]);
      const trigger = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='delivery_outbox_after_event_insert'",
      );
      expect(trigger.rows).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("backfills primary and Mercury secondary routes for pre-0010 observations", async () => {
    const { client, close } = await freshDb();
    try {
      await runMigrations(client);
      for (const trigger of [
        "observation_route_validate_insert",
        "observation_route_no_update",
        "observation_route_no_delete",
        "reconciliation_validate_insert",
        "reconciliation_no_update",
        "reconciliation_no_delete",
      ]) {
        await client.execute(`DROP TRIGGER ${trigger}`);
      }
      await client.execute("DROP TABLE reconciliation");
      await client.execute("DROP TABLE observation_route");
      await client.execute("DELETE FROM _migration WHERE name='0010_reconciliation.sql'");
      await client.execute(`INSERT INTO observation (
        id, tenant_id, source, external_event_id, kind, schema_version,
        type_uri, subject_ref, payload, occurred_at, recorded_at, recorded_by,
        verification_level, metadata
      ) VALUES (
        '01930000-0000-7000-8000-000000000001', 'gwendall', 'mercury:kami',
        'pre-0010', 'mercury.transaction', 1,
        'https://schemas.tasq.dev/observations/mercury/transaction',
        '["mercury.transaction","mercury:kami","tx-1"]',
        '{"connectorAccount":"mercury:kami","transactionId":"tx-1","direction":"outgoing","currency":"USD","minorUnits":10000,"counterparty":null,"settlementState":"sent"}',
        1000, 1100, 'watcher:mercury', 'unverified', '{}'
      )`);

      const result = await runMigrations(client);
      expect(result.applied).toEqual(["0010_reconciliation.sql"]);
      const routes = await client.execute(
        "SELECT route_key FROM observation_route ORDER BY route_key",
      );
      expect(routes.rows.map((row) => row["route_key"])).toEqual([
        '["mercury.transaction","mercury:kami","tx-1"]',
        '["mercury.transaction.match","mercury:kami","outgoing","USD",10000]',
      ]);
    } finally {
      await close();
    }
  });

  it("adds generic resource lease history and immutable event streams (0021)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0021_resource_leases.sql");
      expect(first.applied).toContain("0022_replication_recovery.sql");
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('resource_lease','resource_event') ORDER BY name",
      );
      expect(tables.rows.map((row) => row["name"])).toEqual(["resource_event", "resource_lease"]);
      const triggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'resource_%' ORDER BY name",
      );
      expect(triggers.rows.map((row) => row["name"])).toEqual(expect.arrayContaining([
        "resource_event_immutable_delete",
        "resource_event_immutable_update",
        "resource_event_validate_insert",
        "resource_lease_identity_immutable",
        "resource_lease_no_delete",
        "resource_lease_transition_guard",
      ]));
    } finally {
      await close();
    }
  });

  it("runs every post-zero migration against populated tasq-zero state", async () => {
    const { db, client, close } = await freshDb();
    try {
      await client.executeMultiple(readFileSync(TASQ_ZERO_FIXTURE, "utf8"));

      const result = await runMigrations(client);
      expect(result.skipped).toEqual(["0000_init.sql"]);
      expect(result.applied).toEqual([
        "0001_subtasks.sql",
        "0002_task_dependency.sql",
        "0003_recurrence.sql",
        "0004_event_sequence.sql",
        "0005_idempotency.sql",
        "0006_agent_primitives.sql",
        "0007_agent_invariants.sql",
        "0008_wait_condition.sql",
        "0009_observation.sql",
        "0010_reconciliation.sql",
        "0011_deadline_fallback.sql",
        "0012_extension_registry.sql",
        "0013_universal_collaboration.sql",
        "0014_effect_ledger.sql",
        "0015_effect_dispatch_gate.sql",
        "0016_effect_receipt.sql",
        "0017_transactional_outbox.sql",
        "0018_scoped_idempotency.sql",
        "0019_replication.sql",
        "0020_coordination_space.sql",
        "0021_resource_leases.sql",
        "0022_replication_recovery.sql",
        "0023_commitment_summaries.sql",
        "0024_external_context_links.sql",
        "0025_console_read_indexes.sql",
      ]);

      const open = await getTask(db, "01910000-0000-7000-8000-000000000010");
      const done = await getTask(db, "01910000-0000-7000-8000-000000000011");
      expect(open).toMatchObject({
        title: "Tasq-zero open task",
        metadata: { legacyId: "1" },
        parentTaskId: null,
        recurrence: null,
        recurrenceInterval: 1,
        recurrenceAnchor: "due",
        streak: 0,
        successCriteria: null,
        completionMode: "assertion",
      });
      expect(done).toMatchObject({
        status: "done",
        revision: 1,
        startedAt: 1600000008000,
        completedAt: 1600000009000,
        successCriteria: null,
        completionMode: "assertion",
      });

      const universalBackfill = await client.execute(`
        SELECT
          (SELECT count(*) FROM event WHERE principal_id IS NULL) AS unattributed_events,
          (SELECT count(*) FROM completion_record WHERE task_id = '01910000-0000-7000-8000-000000000011') AS completions,
          (SELECT completion_policy_uri FROM completion_record WHERE task_id = '01910000-0000-7000-8000-000000000011') AS policy
      `);
      expect(universalBackfill.rows[0]).toMatchObject({
        unattributed_events: 0,
        completions: 1,
        policy: "urn:tasq:completion-policy:legacy-unverified",
      });

      const events = await client.execute(
        "SELECT sequence, id, payload, occurred_at FROM event ORDER BY sequence",
      );
      expect(events.rows.map((row) => ({
        sequence: Number(row["sequence"]),
        id: row["id"],
        payload: JSON.parse(String(row["payload"])),
        occurredAt: row["occurred_at"],
      }))).toEqual([
        {
          sequence: 1,
          id: "01910000-0000-7000-8000-000000000020",
          payload: { position: 1 },
          occurredAt: null,
        },
        {
          sequence: 2,
          id: "01910000-0000-7000-8000-000000000021",
          payload: { position: 2 },
          occurredAt: null,
        },
        {
          sequence: 3,
          id: "01910000-0000-7000-8000-000000000022",
          payload: { position: 3 },
          occurredAt: null,
        },
      ]);

      const report = await diagnoseStore(db, client);
      expect(report).toMatchObject({ ok: true, issues: [] });
    } finally {
      await close();
    }
  });

  it("migrates a populated pre-0006 store without losing historical state", async () => {
    const { db, client, close } = await freshDb();
    try {
      await client.executeMultiple(readFileSync(PRE_AGENTIC_FIXTURE, "utf8"));

      const result = await runMigrations(client);
      expect(result.applied).toEqual([
        "0006_agent_primitives.sql",
        "0007_agent_invariants.sql",
        "0008_wait_condition.sql",
        "0009_observation.sql",
        "0010_reconciliation.sql",
        "0011_deadline_fallback.sql",
        "0012_extension_registry.sql",
        "0013_universal_collaboration.sql",
        "0014_effect_ledger.sql",
        "0015_effect_dispatch_gate.sql",
        "0016_effect_receipt.sql",
        "0017_transactional_outbox.sql",
        "0018_scoped_idempotency.sql",
        "0019_replication.sql",
        "0020_coordination_space.sql",
        "0021_resource_leases.sql",
        "0022_replication_recovery.sql",
        "0023_commitment_summaries.sql",
        "0024_external_context_links.sql",
        "0025_console_read_indexes.sql",
      ]);
      expect(result.skipped).toEqual([
        "0000_init.sql",
        "0001_subtasks.sql",
        "0002_task_dependency.sql",
        "0003_recurrence.sql",
        "0004_event_sequence.sql",
        "0005_idempotency.sql",
      ]);

      const root = await getTask(db, "01900000-0000-7000-8000-000000000010");
      const child = await getTask(db, "01900000-0000-7000-8000-000000000011");
      const recurring = await getTask(db, "01900000-0000-7000-8000-000000000013");
      expect(root).toMatchObject({
        title: "Legacy root task",
        projectId: "01900000-0000-7000-8000-000000000003",
        goalId: "01900000-0000-7000-8000-000000000002",
        areaId: "01900000-0000-7000-8000-000000000001",
        metadata: { legacyId: "42", tags: ["migration", "critical"] },
        successCriteria: null,
        completionMode: "assertion",
      });
      expect(child).toMatchObject({
        status: "blocked",
        parentTaskId: root!.id,
        successCriteria: null,
        completionMode: "assertion",
      });
      expect(recurring).toMatchObject({
        status: "done",
        recurrence: "weekly",
        recurrenceInterval: 2,
        recurrenceAnchor: "due",
        streak: 4,
        lastDoneAt: 1700000040000,
        successCriteria: null,
        completionMode: "assertion",
      });

      const counts = await Promise.all(
        ["area", "goal", "project", "task", "task_dependency", "event", "idempotency_key"].map(
          async (table) => {
            const rows = await client.execute(`SELECT count(*) AS count FROM ${table}`);
            return Number(rows.rows[0]?.["count"]);
          },
        ),
      );
      expect(counts).toEqual([1, 1, 1, 5, 1, 3, 1]);

      const sequences = await client.execute("SELECT sequence FROM event ORDER BY sequence");
      expect(sequences.rows.map((row) => Number(row["sequence"]))).toEqual([3, 7, 11]);
      const migrationRows = await client.execute(
        "SELECT name, checksum FROM _migration ORDER BY name",
      );
      expect(migrationRows.rows).toHaveLength(26);
      expect(migrationRows.rows.every((row) => typeof row["checksum"] === "string")).toBe(true);

      const legacyIdentity = await client.execute(
        "SELECT * FROM idempotency_key WHERE key = 'legacy-import-task-42'",
      );
      expect(legacyIdentity.rows[0]).toMatchObject({
        caller_scope: "workspace:legacy",
        operation: "task.create",
        digest_version: "tasq.legacy.sha256.v0",
        request_digest: "sha256:4f830d49750f5a32f74e2e7d0a5f7474d3d1661454ad095d22fd098c8c365f21",
        result_type: "legacy",
        retention_class: "durable",
        expires_at: null,
      });

      for (const table of ["task_claim", "task_attempt", "task_evidence", "wait_condition", "observation", "observation_route", "reconciliation"]) {
        const rows = await client.execute(`SELECT count(*) AS count FROM ${table}`);
        expect(Number(rows.rows[0]?.["count"])).toBe(0);
      }

      const report = await diagnoseStore(db, client);
      expect(report).toMatchObject({
        ok: true,
        sqliteIntegrity: "ok",
        foreignKeyViolations: 0,
        issues: [],
      });

      const second = await runMigrations(client);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toHaveLength(26);
    } finally {
      await close();
    }
  });

  it("normalizes deterministic historical lifecycle and scope fields before installing guards", async () => {
    const { db, client, close } = await freshDb();
    try {
      await client.executeMultiple(readFileSync(PRE_AGENTIC_FIXTURE, "utf8"));
      await client.execute(`
        INSERT INTO area (
          id, tenant_id, name, slug, importance, metadata, created_at, updated_at
        ) VALUES (
          '01900000-0000-7000-8000-000000000099', 'gwendall',
          'Wrong legacy scope', 'wrong-legacy-scope', 1, '{}', 1, 1
        )
      `);
      await client.execute(`
        UPDATE project
        SET area_id = '01900000-0000-7000-8000-000000000099'
        WHERE id = '01900000-0000-7000-8000-000000000003'
      `);
      await client.execute(`
        UPDATE task
        SET status = 'in_progress', started_at = NULL,
            goal_id = NULL, area_id = '01900000-0000-7000-8000-000000000099'
        WHERE id = '01900000-0000-7000-8000-000000000010'
      `);
      await client.execute(`
        UPDATE task
        SET project_id = NULL, goal_id = NULL,
            area_id = '01900000-0000-7000-8000-000000000099'
        WHERE id = '01900000-0000-7000-8000-000000000011'
      `);
      await client.execute(`
        UPDATE task SET completed_at = NULL
        WHERE id = '01900000-0000-7000-8000-000000000013'
      `);

      await runMigrations(client);

      const root = await getTask(db, "01900000-0000-7000-8000-000000000010");
      const child = await getTask(db, "01900000-0000-7000-8000-000000000011");
      const recurring = await getTask(db, "01900000-0000-7000-8000-000000000013");
      expect(root).toMatchObject({
        status: "in_progress",
        startedAt: 1700000006000,
        projectId: "01900000-0000-7000-8000-000000000003",
        goalId: "01900000-0000-7000-8000-000000000002",
        areaId: "01900000-0000-7000-8000-000000000001",
      });
      expect(child).toMatchObject({
        projectId: root!.projectId,
        goalId: root!.goalId,
        areaId: root!.areaId,
      });
      expect(recurring?.completedAt).toBe(1700000040000);
      expect(await diagnoseStore(db, client)).toMatchObject({ ok: true, issues: [] });
    } finally {
      await close();
    }
  });

  it("creates task_dependency + its indexes (0002), idempotent on re-run", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0002_task_dependency.sql");

      const tables = await client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependency'`,
      );
      expect(tables.rows).toHaveLength(1);

      const idx = await client.execute(`PRAGMA index_list('task_dependency')`);
      const idxNames = idx.rows.map((r) => r["name"] as string);
      expect(idxNames).toContain("uniq_task_dep");
      expect(idxNames).toContain("idx_task_dep_to");
      expect(idxNames).toContain("idx_task_dep_from");

      const cols = await client.execute(`PRAGMA table_info('task_dependency')`);
      const colNames = cols.rows.map((r) => r["name"] as string);
      expect(colNames).toEqual(
        expect.arrayContaining([
          "id",
          "tenant_id",
          "from_task_id",
          "to_task_id",
          "type",
          "created_at",
          "updated_at",
          "deleted_at",
        ]),
      );

      // Second pass: 0002 is skipped (idempotent, no schema drift).
      const second = await runMigrations(client);
      expect(second.applied).not.toContain("0002_task_dependency.sql");
      expect(second.skipped).toContain("0002_task_dependency.sql");
    } finally {
      await close();
    }
  });

  it("adds the recurrence columns + idx_task_recurrence_parent (0003), idempotent on re-run", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0003_recurrence.sql");

      const cols = await client.execute(`PRAGMA table_info('task')`);
      const colNames = cols.rows.map((r) => r["name"] as string);
      expect(colNames).toEqual(
        expect.arrayContaining([
          "recurrence",
          "recurrence_interval",
          "recurrence_anchor",
          "last_done_at",
          "streak",
          "recurrence_parent_id",
        ]),
      );

      const idx = await client.execute(`PRAGMA index_list('task')`);
      const idxNames = idx.rows.map((r) => r["name"] as string);
      expect(idxNames).toContain("idx_task_recurrence_parent");

      // Second pass: 0003 is skipped (idempotent, no schema drift).
      const second = await runMigrations(client);
      expect(second.applied).not.toContain("0003_recurrence.sql");
      expect(second.skipped).toContain("0003_recurrence.sql");
    } finally {
      await close();
    }
  });

  it("rebuilds events with a monotonic sequence cursor (0004)", async () => {
    const { client, close } = await freshDb();
    try {
      const first = await runMigrations(client);
      expect(first.applied).toContain("0004_event_sequence.sql");
      const cols = await client.execute(`PRAGMA table_info('event')`);
      const colNames = cols.rows.map((r) => r["name"] as string);
      expect(colNames).toEqual(expect.arrayContaining(["sequence", "occurred_at"]));
    } finally {
      await close();
    }
  });

  it("forward-compat: a row written WITHOUT recurrence columns reads back recurrence=null defaults", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      await createArea(db, {
        id: "01900000-0000-7000-8000-0000000000a0",
        name: "FC",
        slug: "fc",
      });
      // Simulate a pre-recurrence write: INSERT only the legacy columns, relying
      // on the migration's column DEFAULTs for the new ones (this is exactly the
      // shape a pre-v0.3 row had). No data loss; getTask must parse it.
      await client.execute({
        sql: "INSERT INTO task (id, tenant_id, area_id, title, status, priority, created_at, updated_at) VALUES (?, 'gwendall', ?, 'legacy', 'open', 3, 1, 1)",
        args: [
          "01900000-0000-7000-8000-0000000000a1",
          "01900000-0000-7000-8000-0000000000a0",
        ],
      });

      const t = await getTask(db, "01900000-0000-7000-8000-0000000000a1");
      expect(t).not.toBeNull();
      expect(t!.recurrence).toBeNull();
      expect(t!.recurrenceInterval).toBe(1);
      expect(t!.recurrenceAnchor).toBe("due");
      expect(t!.streak).toBe(0);
      expect(t!.lastDoneAt).toBeNull();
      expect(t!.recurrenceParentId).toBeNull();
      expect(t!.successCriteria).toBeNull();
      expect(t!.completionMode).toBe("assertion");
    } finally {
      await close();
    }
  });

  it("enables foreign_keys", async () => {
    const { client, close } = await freshDb();
    try {
      await runMigrations(client);
      const r = await client.execute("PRAGMA foreign_keys");
      expect(r.rows[0]!["foreign_keys"]).toBe(1);
    } finally {
      await close();
    }
  });

  it("enforces FK on task.area_id", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      // Creating a task referencing a non-existent area_id is rejected. The
      // service-layer ancestor-liveness guard catches the dangling reference
      // first (clearer "Area not found" message); the DB FK constraint is the
      // defense-in-depth backstop verified separately below.
      await expect(
        createTask(db, {
          title: "orphan",
          areaId: "01900000-0000-7000-8000-000000000000",
        }),
      ).rejects.toThrow(/Area not found/);

      // Defense-in-depth: the raw FK constraint still rejects a direct insert
      // that bypasses the service layer.
      await expect(
        client.execute({
          sql: "INSERT INTO task (id, tenant_id, area_id, title, status, priority, created_at, updated_at) VALUES (?, 'gwendall', ?, 'orphan', 'open', 3, 0, 0)",
          args: ["01900000-0000-7000-8000-000000000001", "01900000-0000-7000-8000-000000000000"],
        }),
      ).rejects.toThrow(/FOREIGN KEY/);
    } finally {
      await close();
    }
  });
});

describe("Event audit log", () => {
  it("paginates without loss when several events share one millisecond", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const entityId = "01900000-0000-7000-8000-000000000099";
      for (const eventType of ["one", "two", "three"]) {
        await recordEvent(db, { entityType: "task", entityId, eventType });
      }
      await client.execute("UPDATE event SET created_at = 42");

      const first = await listEvents(db, { entityId, ascending: true, limit: 2 });
      const second = await listEvents(db, {
        entityId,
        ascending: true,
        afterSequence: first.at(-1)!.sequence,
        limit: 2,
      });
      expect([...first, ...second].map((e) => e.eventType)).toEqual(["one", "two", "three"]);
    } finally {
      await close();
    }
  });

  it("orders events by createdAt ascending when requested", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const area = await createArea(db, { name: "X", slug: "x" });
      const t = await createTask(db, { title: "t", areaId: area.id });
      await new Promise((r) => setTimeout(r, 5));
      await startTask(db, t.id);
      await new Promise((r) => setTimeout(r, 5));
      await completeTask(db, t.id);

      const events = await listEvents(db, { entityId: t.id, ascending: true });
      const types = events.map((e) => e.eventType);
      expect(types).toEqual(["created", "started", "completed"]);
      // Strictly ascending createdAt
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.createdAt).toBeGreaterThanOrEqual(events[i - 1]!.createdAt);
      }
    } finally {
      await close();
    }
  });

  it("filters by actor", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const area = await createArea(db, { name: "X", slug: "x" }, { actor: "setup" });
      const t = await createTask(db, { title: "t", areaId: area.id }, { actor: "hermes" });
      await startTask(db, t.id, { actor: "claude-code" });
      await completeTask(db, t.id, { actor: "gwendall" });

      const setup = await listEvents(db, { actor: "setup" });
      expect(setup.length).toBe(1);
      expect(setup[0]!.entityType).toBe("area");

      const hermes = await listEvents(db, { actor: "hermes" });
      expect(hermes.length).toBe(1);
      expect(hermes[0]!.eventType).toBe("created");
      expect(hermes[0]!.entityId).toBe(t.id);

      const cc = await listEvents(db, { actor: "claude-code" });
      expect(cc.length).toBe(1);
      expect(cc[0]!.eventType).toBe("started");

      const gwendall = await listEvents(db, { actor: "gwendall" });
      expect(gwendall.length).toBe(1);
      expect(gwendall[0]!.eventType).toBe("completed");
    } finally {
      await close();
    }
  });

  it("filters by since cursor (>=) and entityType", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const area = await createArea(db, { name: "X", slug: "x" });
      const beforeCursor = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      const t = await createTask(db, { title: "t", areaId: area.id });
      await new Promise((r) => setTimeout(r, 5));
      await startTask(db, t.id);

      const recent = await listEvents(db, { sinceMs: beforeCursor, entityType: "task" });
      expect(recent.length).toBe(2);
      for (const e of recent) {
        expect(e.entityType).toBe("task");
        expect(e.createdAt).toBeGreaterThan(beforeCursor);
      }
    } finally {
      await close();
    }
  });

  it("getEvent returns null for non-existent id", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const result = await getEvent(db, "01900000-0000-7000-8000-000000000000");
      expect(result).toBeNull();
    } finally {
      await close();
    }
  });

  it("recordEvent can be called directly with arbitrary eventType", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const area = await createArea(db, { name: "X", slug: "x" });
      const t = await createTask(db, { title: "t", areaId: area.id });

      const e = await recordEvent(db, {
        actor: "external-watcher",
        entityType: "task",
        entityId: t.id,
        eventType: "watcher_signal_received",
        payload: { source: "mercury", note: "wire confirmed" },
      });

      expect(e.eventType).toBe("watcher_signal_received");
      expect(e.actor).toBe("external-watcher");

      const fetched = await getEvent(db, e.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.eventType).toBe("watcher_signal_received");
    } finally {
      await close();
    }
  });
});

describe("Multi-actor scenarios", () => {
  it("attributes each mutation to the correct actor in events", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const area = await createArea(db, { name: "X", slug: "x" }, { actor: "gwendall" });
      const t = await createTask(db, { title: "t", areaId: area.id }, { actor: "claude-code" });
      await startTask(db, t.id, { actor: "hermes" });
      await updateTask(db, t.id, { nextAction: "step Y" }, { actor: "gwendall" });
      await completeTask(db, t.id, { actor: "hermes" });

      const events = await listEvents(db, { entityId: t.id, ascending: true });
      const actorSeq = events.map((e) => e.actor);
      expect(actorSeq).toEqual(["claude-code", "hermes", "gwendall", "hermes"]);
    } finally {
      await close();
    }
  });

  it("two different tasks can be touched concurrently by different actors", async () => {
    const { db, client, close } = await freshDb();
    try {
      await runMigrations(client);
      const area = await createArea(db, { name: "X", slug: "x" });
      const t1 = await createTask(db, { title: "a", areaId: area.id }, { actor: "hermes" });
      const t2 = await createTask(db, { title: "b", areaId: area.id }, { actor: "claude-code" });

      // Interleaved touches on each task
      await Promise.all([
        startTask(db, t1.id, { actor: "hermes" }),
        startTask(db, t2.id, { actor: "claude-code" }),
      ]);

      const allEvents = await listEvents(db, { entityType: "task", ascending: true });
      expect(allEvents.length).toBe(4); // 2 created + 2 started

      const t1Events = allEvents.filter((e) => e.entityId === t1.id);
      const t2Events = allEvents.filter((e) => e.entityId === t2.id);
      expect(t1Events.every((e) => e.actor === "hermes")).toBe(true);
      expect(t2Events.every((e) => e.actor === "claude-code")).toBe(true);
    } finally {
      await close();
    }
  });
});
