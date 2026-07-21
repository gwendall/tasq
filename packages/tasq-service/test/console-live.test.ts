import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createMutableClock, event } from "@tasq/schema";
import {
  buildConsoleEventBatch,
  ConsoleLiveCursorError,
  createCommitment,
  openDb,
  runMigrations,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-console-live-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(10_000);
  await runMigrations(handle.client, { clock, installReferenceExtension: false });
  return { ...handle, clock, workspaceId: "console/live-a" };
}

describe("bounded Console live feed", () => {
  it("captures an injected-time snapshot and resumes exclusively without a lost boundary", async () => {
    const h = await fresh();
    try {
      await expect(buildConsoleEventBatch(h.db, { workspaceId: h.workspaceId }))
        .rejects.toThrow(/require an injected clock/);
      const initial = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId,
        now: 20_000,
        limit: 2,
      });
      expect(initial).toMatchObject({
        contractVersion: "tasq.console-event-batch.v1",
        workspaceId: h.workspaceId,
        inspectedAt: 20_000,
        mode: "snapshot",
        returned: 0,
        hasMore: false,
        events: [],
        snapshot: { contractVersion: "tasq.console-overview.v1" },
      });

      h.clock.set(21_000);
      const created = await createCommitment(h.db, { title: "After snapshot" }, {
        workspaceId: h.workspaceId,
        actor: "runtime",
        clock: h.clock,
      });
      const changes = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId,
        clock: h.clock,
        cursor: initial.nextCursor,
        limit: 2,
      });
      expect(changes).toMatchObject({
        inspectedAt: 21_000,
        mode: "changes",
        returned: 1,
        hasMore: false,
        snapshot: null,
        events: [{ entityId: created.id, payload: { omitted: true, reason: "operator_stream_redaction" } }],
      });
      expect(JSON.stringify(changes)).not.toContain("After snapshot");

      const replay = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId,
        now: 22_000,
        cursor: changes.nextCursor,
      });
      expect(replay).toMatchObject({ returned: 0, nextCursor: changes.nextCursor });
    } finally {
      await h.close();
    }
  });

  it("paginates monotonically, binds cursors to the workspace and signals overflow", async () => {
    const h = await fresh();
    try {
      const initial = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId,
        clock: h.clock,
      });
      for (const title of ["One", "Two", "Three"]) {
        h.clock.advance(1);
        await createCommitment(h.db, { title }, {
          workspaceId: h.workspaceId,
          actor: "runtime",
          clock: h.clock,
        });
      }
      const first = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId,
        clock: h.clock,
        cursor: initial.nextCursor,
        limit: 2,
      });
      expect(first).toMatchObject({ returned: 2, hasMore: true });
      expect(first.events[0]!.sequence).toBeLessThan(first.events[1]!.sequence);
      const second = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId,
        clock: h.clock,
        cursor: first.nextCursor,
        limit: 2,
      });
      expect(second).toMatchObject({ returned: 1, hasMore: false });
      expect(second.events[0]!.sequence).toBeGreaterThan(first.events[1]!.sequence);

      await expect(buildConsoleEventBatch(h.db, {
        workspaceId: "console/live-b",
        clock: h.clock,
        cursor: first.nextCursor,
      })).rejects.toThrow(/does not match this workspace/);
    } finally {
      await h.close();
    }
  });

  it("returns typed recovery for an ahead cursor and a pruned cursor", async () => {
    const h = await fresh();
    try {
      const empty = await buildConsoleEventBatch(h.db, { workspaceId: h.workspaceId, clock: h.clock });
      await createCommitment(h.db, { title: "First" }, {
        workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
      });
      const first = await buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId, clock: h.clock, cursor: empty.nextCursor,
      });

      // A cursor from the now-later state becomes ahead after restoring the
      // older empty ledger: this must not silently look current.
      await h.db.delete(event).where(eq(event.tenantId, h.workspaceId));
      let ahead: unknown;
      try {
        await buildConsoleEventBatch(h.db, {
          workspaceId: h.workspaceId, clock: h.clock, cursor: first.nextCursor,
        });
      } catch (error) { ahead = error; }
      expect(ahead).toBeInstanceOf(ConsoleLiveCursorError);
      expect((ahead as ConsoleLiveCursorError).problem).toMatchObject({
        code: "cursor_ahead",
        recovery: { action: "refresh_snapshot", href: "/api/console/events" },
      });

      await createCommitment(h.db, { title: "Second" }, {
        workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
      });
      await expect(buildConsoleEventBatch(h.db, {
        workspaceId: h.workspaceId, clock: h.clock, cursor: first.nextCursor,
      })).rejects.toMatchObject({ problem: { code: "cursor_expired" } });
    } finally {
      await h.close();
    }
  });
});
