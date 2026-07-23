import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { externalContextLink } from "@tasq-run/schema";
import {
  attachExternalContextLink,
  createCommitment,
  detachExternalContextLink,
  getExternalContextLink,
  inspectCommitment,
  listEvents,
  listExternalContextLinks,
  openDb,
  runKernelMigrations,
} from "../src/kernel.js";
import { assertDatabaseInvariantRejected } from "./support/database-invariant.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-context-links-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(handle.client, { now: 1_000 });
  return handle;
}

const runbook = {
  system: "https://memory.example.test",
  resourceType: "runbook",
  externalId: "robotics/calibration/arm-left",
  url: "https://memory.example.test/runbooks/arm-left",
  version: "7",
  digest: "sha256:4f98a0d3",
} as const;

describe("TQ-503 external context links", () => {
  it("reuses one external knowledge identity across unrelated commitments without making it a task", async () => {
    const { db, close } = await freshDb();
    try {
      const first = await createCommitment(db, { title: "Calibrate arm" }, {
        workspaceId: "lab", actor: "planner", now: 2_000,
      });
      const second = await createCommitment(db, { title: "Inspect arm drift" }, {
        workspaceId: "lab", actor: "planner", now: 2_001,
      });
      const a = await attachExternalContextLink(db, {
        workspaceId: "lab", commitmentId: first.id, target: runbook,
        expectedPreviousLinkId: null,
      }, { actor: "planner", idempotencyKey: "link-a", now: 3_000 });
      const b = await attachExternalContextLink(db, {
        workspaceId: "lab", commitmentId: second.id, target: runbook,
        expectedPreviousLinkId: null,
      }, { actor: "planner", idempotencyKey: "link-b", now: 3_001 });

      expect(a.id).not.toBe(b.id);
      expect(a).toMatchObject({ binding: "pinned", state: "active", target: runbook });
      expect(b).toMatchObject({ binding: "pinned", state: "active", target: runbook });
      expect((await inspectCommitment(db, first.id, { workspaceId: "lab", now: 4_000 }))!
        .externalContextLinks).toEqual([a]);
      expect((await listEvents(db, { tenantId: "lab", entityId: first.id }))
        .some((item) => item.eventType === "external_context_link_appended")).toBe(true);
    } finally {
      await close();
    }
  });

  it("exposes floating pointers, CAS updates, append-only detach and exact durable retry", async () => {
    const { db, close } = await freshDb();
    try {
      const commitment = await createCommitment(db, { title: "Deploy service" }, {
        workspaceId: "software", actor: "agent", now: 2_000,
      });
      const floatingTarget = {
        system: "https://docs.example.test",
        resourceType: "runbook",
        externalId: "deploy/service",
        url: "https://docs.example.test/deploy/service",
        version: null,
        digest: null,
      };
      const root = await attachExternalContextLink(db, {
        workspaceId: "software", commitmentId: commitment.id,
        target: floatingTarget, expectedPreviousLinkId: null,
      }, {
        actor: "agent", idempotencyKey: "root", now: 3_000,
        clock: { now: () => { throw new Error("explicit now must win"); } },
      });
      const retry = await attachExternalContextLink(db, {
        workspaceId: "software", commitmentId: commitment.id,
        target: floatingTarget, expectedPreviousLinkId: null,
      }, { actor: "agent", idempotencyKey: "root", now: 99_000 });
      expect(retry.id).toBe(root.id);
      expect(root.binding).toBe("floating");

      const pinned = await attachExternalContextLink(db, {
        workspaceId: "software", commitmentId: commitment.id,
        target: { ...floatingTarget, version: "commit:abc123" },
        expectedPreviousLinkId: root.id,
      }, { actor: "agent", idempotencyKey: "pin", now: 4_000 });
      expect(pinned).toMatchObject({ binding: "pinned", state: "active" });
      expect((await getExternalContextLink(db, root.id, "software"))?.state).toBe("superseded");
      await expect(attachExternalContextLink(db, {
        workspaceId: "software", commitmentId: commitment.id,
        target: { ...floatingTarget, version: "commit:def456" },
        expectedPreviousLinkId: root.id,
      }, { actor: "agent", idempotencyKey: "stale", now: 5_000 }))
        .rejects.toThrow(/Stale context-link chain/);

      const detached = await detachExternalContextLink(db, {
        workspaceId: "software", expectedPreviousLinkId: pinned.id,
      }, { actor: "agent", idempotencyKey: "detach", now: 6_000 });
      expect(detached.state).toBe("detached");
      expect(await listExternalContextLinks(db, {
        workspaceId: "software", commitmentId: commitment.id, currentOnly: true,
      })).toEqual([]);
      const history = await listExternalContextLinks(db, {
        workspaceId: "software", commitmentId: commitment.id,
      });
      expect(history.map((item) => item.state)).toEqual(["superseded", "superseded", "detached"]);

      await assertDatabaseInvariantRejected(
        Promise.resolve(db.update(externalContextLink).set({ version: "tampered" })
          .where(eq(externalContextLink.id, root.id))),
        /immutable/,
      );
      await assertDatabaseInvariantRejected(
        Promise.resolve(db.delete(externalContextLink)
          .where(eq(externalContextLink.id, root.id))),
        /append-only/,
      );
    } finally {
      await close();
    }
  });

  it("fails closed across workspaces and when retry identity changes", async () => {
    const { db, close } = await freshDb();
    try {
      const commitment = await createCommitment(db, { title: "Read method" }, {
        workspaceId: "research", actor: "reader", now: 2_000,
      });
      await attachExternalContextLink(db, {
        workspaceId: "research", commitmentId: commitment.id, target: runbook,
        expectedPreviousLinkId: null,
      }, { actor: "reader", idempotencyKey: "same", now: 3_000 });
      await expect(attachExternalContextLink(db, {
        workspaceId: "research", commitmentId: commitment.id,
        target: { ...runbook, version: "8" }, expectedPreviousLinkId: null,
      }, { actor: "reader", idempotencyKey: "same", now: 4_000 }))
        .rejects.toThrow(/different request/);
      await expect(attachExternalContextLink(db, {
        workspaceId: "other", commitmentId: commitment.id, target: runbook,
        expectedPreviousLinkId: null,
      }, { actor: "reader", idempotencyKey: "foreign", now: 5_000 }))
        .rejects.toThrow(/Commitment not found/);
    } finally {
      await close();
    }
  });
});
