import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock, timestampFromUuidv7 } from "@tasq/schema";
import {
  createTask,
  listEvents,
  openDb,
  runMigrations,
  startTask,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("clock injection", () => {
  it("drives migrations, state rows, UUIDs and audit events from one controlled clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-clock-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(1_800_000_000_000);

    try {
      await runMigrations(handle.client, { clock });
      const created = await createTask(
        handle.db,
        { title: "Deterministic task" },
        { actor: "clock-test", clock },
      );
      expect(created.createdAt).toBe(clock.now());
      expect(created.updatedAt).toBe(clock.now());
      expect(timestampFromUuidv7(created.id)).toBe(clock.now());

      let events = await listEvents(handle.db, { ascending: true });
      expect(events.at(-1)?.createdAt).toBe(clock.now());

      clock.advance(12_345);
      const started = await startTask(handle.db, created.id, { actor: "clock-test", clock });
      expect(started.startedAt).toBe(clock.now());
      expect(started.updatedAt).toBe(clock.now());

      events = await listEvents(handle.db, { ascending: true });
      expect(events.at(-1)?.eventType).toBe("started");
      expect(events.at(-1)?.createdAt).toBe(clock.now());
    } finally {
      await handle.close();
    }
  });
});
