import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq-run/schema";
import {
  bootstrapCoordinationSpace,
  getCoordinationSpace,
  localPrincipalId,
  openDb,
  runMigrations,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("coordination space bootstrap", () => {
  it("creates once, joins idempotently and uses only the injected clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-space-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(42_000);
    try {
      await runMigrations(handle.client, { clock, installReferenceExtension: false });
      await expect(bootstrapCoordinationSpace(handle.db, {
        workspaceId: "missing-clock",
        actor: "agent",
      } as any)).rejects.toThrow(/clock is required/);
      const created = await bootstrapCoordinationSpace(handle.db, {
        workspaceId: "robotics/team-a",
        actor: "agent-one",
        clock,
      });
      expect(created).toMatchObject({
        disposition: "created",
        space: { workspaceId: "robotics/team-a", createdAt: 42_000 },
        principal: { tenantId: "robotics/team-a", localAlias: "agent-one", createdAt: 42_000 },
      });

      clock.set(99_000);
      const joined = await bootstrapCoordinationSpace(handle.db, {
        workspaceId: "robotics/team-a",
        actor: "agent-two",
        clock,
      });
      expect(joined.disposition).toBe("joined");
      expect(joined.space).toEqual(created.space);
      expect(joined.principal.createdAt).toBe(99_000);
      expect(await getCoordinationSpace(handle.db, "robotics/team-a")).toEqual(created.space);
    } finally {
      await handle.close();
    }
  });

  it("has exactly one creator under a real cross-connection first-join race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-space-race-"));
    tmpDirs.push(dir);
    const url = `file:${join(dir, "db.sqlite")}`;
    const first = await openDb({ url });
    const second = await openDb({ url });
    const clock = createMutableClock(123_456);
    try {
      await runMigrations(first.client, { clock, installReferenceExtension: false });
      const results = await Promise.all([
        bootstrapCoordinationSpace(first.db, { workspaceId: "shared", actor: "alpha", clock }),
        bootstrapCoordinationSpace(second.db, { workspaceId: "shared", actor: "beta", clock }),
      ]);
      expect(results.map((result) => result.disposition).sort()).toEqual(["created", "joined"]);
      expect(new Set(results.map((result) => result.space.createdByPrincipalId)).size).toBe(1);
      expect(results[0]!.space).toEqual(results[1]!.space);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("rejects ambiguous identifiers and makes established space identity immutable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-space-immutable-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(7_000);
    try {
      await runMigrations(handle.client, { clock, installReferenceExtension: false });
      await expect(bootstrapCoordinationSpace(handle.db, {
        workspaceId: "space with shell ambiguity",
        actor: "agent",
        clock,
      })).rejects.toThrow(/space must start/);
      await bootstrapCoordinationSpace(handle.db, { workspaceId: "immutable", actor: "agent", clock });
      await expect(handle.client.execute(
        "UPDATE coordination_space SET created_at = 8 WHERE workspace_id = 'immutable'",
      )).rejects.toThrow(/immutable/);
      await expect(handle.client.execute(
        "DELETE FROM coordination_space WHERE workspace_id = 'immutable'",
      )).rejects.toThrow(/immutable/);
    } finally {
      await handle.close();
    }
  });

  it("accepts the advertised maximum space and actor boundaries without overflowing derived identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-space-max-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(8_000);
    const workspaceId = `s${"x".repeat(199)}`;
    const actor = `a${"界".repeat(199)}`;
    try {
      await runMigrations(handle.client, { clock, installReferenceExtension: false });
      const result = await bootstrapCoordinationSpace(handle.db, { workspaceId, actor, clock });
      expect(result).toMatchObject({
        disposition: "created",
        space: { workspaceId },
        principal: { tenantId: workspaceId, localAlias: actor, displayName: actor },
      });
      expect(result.principal.id).toBe(localPrincipalId(workspaceId, actor));
      expect(result.principal.id).toMatch(/^urn:tasq:local-principal:sha256:[a-f0-9]{64}$/);
      expect(result.principal.id.length).toBeLessThanOrEqual(500);
      expect(localPrincipalId("short", "actor")).toBe(
        `urn:tasq:local-principal:${Buffer.from("short").toString("hex")}:${Buffer.from("actor").toString("hex")}`,
      );
    } finally {
      await handle.close();
    }
  });
});
