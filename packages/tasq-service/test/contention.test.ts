/**
 * The ledger recorded everything it allowed and nothing it prevented.
 *
 * Thirty-one event types and not one of them a refusal, while `tasq demo`
 * exists entirely to show three. These prove the refusals are counted, that
 * counting them cannot be mistaken for work happening, and that a repeated
 * refusal is one situation rather than a flood of rows.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  completeTask,
  contentionSummary,
  createTask,
  listContention,
  listEvents,
  openDb,
  runMigrations,
} from "../src/index.js";
import { createMutableClock } from "@tasq-run/schema";

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-contention-"));
  dirs.push(dir);
  const clock = createMutableClock(1_700_000_000_000);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client, { clock, installReferenceExtension: false });
  return { ...handle, clock, tenantId: "field/acme" };
}

describe("what the ledger refused", () => {
  test("counts a collision once, however many times it is retried", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "Contested" }, {
        tenantId: f.tenantId, actor: "human", clock: f.clock,
      });
      await acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "claude:opus", leaseMs: 60_000, now: f.clock.now(),
      });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(acquireTaskClaim(f.db, task.id, {
          tenantId: f.tenantId, actor: "codex:worker", leaseMs: 60_000, now: f.clock.now(),
        })).rejects.toThrow(/is claimed by claude:opus/);
      }

      // One standoff, four attempts. A polling agent turned away four hundred
      // times must not become four hundred rows.
      const rows = await listContention(f.db, f.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "claim_held_by_another",
        requestedByLabel: "codex:worker",
        holderLabel: "claude:opus",
        attempts: 4,
      });

      const summary = await contentionSummary(f.db, f.tenantId);
      expect(summary).toMatchObject({ situations: 1, attempts: 4, commitments: 1 });
    } finally {
      await f.close();
    }
  });

  test("records the caller's own name, which no principal row carries", async () => {
    // The refused caller's principal is created inside the transaction that
    // refuses, so the rollback takes it with it. Without the stored label the
    // one command about collisions would print a raw urn for exactly the
    // people it is about.
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "Contested" }, {
        tenantId: f.tenantId, actor: "human", clock: f.clock,
      });
      await acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "claude:opus", leaseMs: 60_000, now: f.clock.now(),
      });
      await expect(acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "codex:worker", leaseMs: 60_000, now: f.clock.now(),
      })).rejects.toThrow();

      const [row] = await listContention(f.db, f.tenantId);
      expect(row!.requestedByLabel).toBe("codex:worker");
      const principals = await f.client.execute({
        sql: "SELECT id FROM principal WHERE id = ?",
        args: [row!.requestedByPrincipalId],
      });
      expect(principals.rows).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test("counts a refusal with no holder at all", async () => {
    // WITHOUT ROWID forces NOT NULL on every primary key column, so the first
    // version of this silently dropped every no-holder refusal. The empty
    // string is the sentinel, and it has to keep counting.
    const f = await fixture();
    try {
      const task = await createTask(f.db, {
        title: "Needs proof", completionMode: "evidence", successCriteria: "A receipt exists",
      }, { tenantId: f.tenantId, actor: "human", clock: f.clock });
      await acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "claude:opus", leaseMs: 60_000, now: f.clock.now(),
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(completeTask(f.db, task.id, {
          tenantId: f.tenantId, actor: "claude:opus", clock: f.clock,
        })).rejects.toThrow(/requires explicit evidence/);
      }

      const rows = await listContention(f.db, f.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "complete_without_evidence", holderPrincipalId: "", attempts: 2,
      });
    } finally {
      await f.close();
    }
  });

  test("a refusal is not a mutation: no event, no revision, no claim change", async () => {
    // Everything downstream of the event journal describes work that HAPPENED.
    // A refusal is work that did not, and must never enter that stream.
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "Contested" }, {
        tenantId: f.tenantId, actor: "human", clock: f.clock,
      });
      const held = await acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "claude:opus", leaseMs: 60_000, now: f.clock.now(),
      });
      const before = await listEvents(f.db, { tenantId: f.tenantId });

      await expect(acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "codex:worker", leaseMs: 60_000, now: f.clock.now(),
      })).rejects.toThrow();

      const after = await listEvents(f.db, { tenantId: f.tenantId });
      expect(after.length).toBe(before.length);
      const claims = await f.client.execute({
        sql: "SELECT revision, expires_at FROM task_claim WHERE id = ?",
        args: [held.id],
      });
      expect(claims.rows[0]).toMatchObject({
        revision: held.revision, expires_at: held.expiresAt,
      });
    } finally {
      await f.close();
    }
  });

  test("a window answers what was prevented in a period", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "Contested" }, {
        tenantId: f.tenantId, actor: "human", clock: f.clock,
      });
      await acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "claude:opus", leaseMs: 3_600_000, now: f.clock.now(),
      });
      await expect(acquireTaskClaim(f.db, task.id, {
        tenantId: f.tenantId, actor: "codex:worker", leaseMs: 60_000, now: f.clock.now(),
      })).rejects.toThrow();

      const now = f.clock.now();
      expect((await contentionSummary(f.db, f.tenantId, now - 60_000)).situations).toBe(1);
      expect((await contentionSummary(f.db, f.tenantId, now + 1)).situations).toBe(0);
    } finally {
      await f.close();
    }
  });
});
