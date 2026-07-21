import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMutableClock } from "@tasq/schema";
import {
  bootstrapCoordinationSpace,
  buildConsoleHealth,
  buildConsoleOverview,
  buildConsolePage,
  createCommitment,
  openDb,
  runKernelMigrations,
} from "@tasq/core";

const root = resolve(import.meta.dir, "../..");
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("TQ-701 public Console read contract", () => {
  test("an unbriefed consumer can discover and traverse every bounded section from Core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-console-eval-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(7_000);
    const workspaceId = "eval/console";
    try {
      await runKernelMigrations(handle.client, { clock });
      const actor = (await bootstrapCoordinationSpace(handle.db, {
        workspaceId, actor: "agent:new", clock,
      })).principal;
      for (let index = 0; index < 3; index++) {
        clock.advance(1);
        await createCommitment(handle.db, { title: `Unfamiliar commitment ${index}` }, {
          workspaceId, actor: "agent:new", principalId: actor.id, clock,
        });
      }

      const overview = await buildConsoleOverview(handle.db, { workspaceId, clock });
      expect(overview.contractVersion).toBe("tasq.console-overview.v1");
      expect(overview.workspaceExists).toBe(true);
      expect(Object.keys(overview.pages).sort()).toEqual([
        "actors", "audit", "claims", "effects", "resources", "waits", "work",
      ]);
      for (const section of Object.keys(overview.pages) as Array<keyof typeof overview.pages>) {
        const page = await buildConsolePage(handle.db, { workspaceId, section, limit: 1, clock });
        expect(page).toMatchObject({
          contractVersion: "tasq.console-page.v1",
          section,
          requestedLimit: 1,
          inspectedAt: clock.now(),
        });
      }
      const first = await buildConsolePage(handle.db, { workspaceId, section: "work", limit: 1, clock });
      const next = await buildConsolePage(handle.db, {
        workspaceId, section: "work", limit: 1, cursor: first.nextCursor, clock,
      });
      expect(first.items[0]?.id).not.toBe(next.items[0]?.id);

      const health = await buildConsoleHealth(handle.db, { workspaceId, clock });
      expect(health).toMatchObject({
        scope: "bounded_operational_signals",
        fullIntegrity: { checked: false, argv: ["tasq", "doctor", "--tenant", workspaceId] },
      });
    } finally {
      await handle.close();
    }
  });

  test("keeps the public surface, route set, bounds and no-ambient-clock rule reviewable", () => {
    const schema = readFileSync(resolve(root, "packages/tasq-schema/src/console.ts"), "utf8");
    const service = readFileSync(resolve(root, "packages/tasq-service/src/console-read-models.ts"), "utf8");
    const publicCore = readFileSync(resolve(root, "packages/tasq-core/src/console-read-models.ts"), "utf8");
    const server = readFileSync(resolve(root, "packages/tasq-inspector/src/server.ts"), "utf8");
    const docs = readFileSync(resolve(root, "TQ-701_CONSOLE_READ_MODELS.md"), "utf8");
    const migration = readFileSync(resolve(root,
      "packages/tasq-core/src/migrations/0025_console_read_indexes.sql"), "utf8");
    const backlog = JSON.parse(readFileSync(resolve(root, "BACKLOG.json"), "utf8")) as {
      items: Array<{ id: string; status: string }>;
    };

    expect(publicCore.trimEnd()).toBe(service.trimEnd());
    expect(schema).toContain("tasq.console-page.v1");
    expect(schema).toContain("operator_index_redaction");
    expect(service).toContain("limit + 1");
    expect(service).toContain("value.length > 2048");
    for (const index of ["work", "actors", "claims", "resources", "waits", "effects"]) {
      expect(migration).toContain(`idx_console_${index}`);
    }
    for (const forbidden of ["Date.now(", "new Date(", "systemClock", "performance.now("]) {
      expect(service, forbidden).not.toContain(forbidden);
      expect(publicCore, forbidden).not.toContain(forbidden);
    }
    for (const route of ["overview", "health", "work", "actors", "claims", "resources", "waits", "effects", "audit"]) {
      expect(`${schema}\n${server}\n${docs}`).toContain(route);
    }
    expect(backlog.items.find(({ id }) => id === "TQ-701")?.status).toBe("done");
  });
});
