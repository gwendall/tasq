import { afterEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq/schema";
import {
  acquireTaskClaim,
  blockCommitment,
  buildContextPacket,
  createCommitment,
  openDb,
  runKernelMigrations,
  startCommitment,
} from "../src/kernel.js";
import { canonicalJson } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-context-"));
  dirs.push(dir);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(opened.client, { now: 1_000 });
  return opened;
}

describe("bounded context packets", () => {
  it("orders neutral commitment facts, traces reasons and uses only the injected clock", async () => {
    const { db, close } = await fixture();
    const workspaceId = "robotics/lab";
    const actor = "agent:new";
    const forbiddenClock = { now: () => { throw new Error("raw clock read"); } };
    try {
      const progressing = await createCommitment(db, {
        title: "Calibrate arm",
        priority: 1,
      }, { workspaceId, actor, now: 1_100 });
      const blocked = await createCommitment(db, {
        title: "Inspect blocked actuator",
        priority: 5,
        dueAt: 1_500,
      }, { workspaceId, actor, now: 1_200 });
      await createCommitment(db, {
        title: "Open overdue work",
        priority: 5,
        dueAt: 1_400,
      }, { workspaceId, actor, now: 1_300 });
      await createCommitment(db, {
        title: "Deferred work",
        notBefore: 9_000,
      }, { workspaceId, actor, now: 1_350 });
      await startCommitment(db, progressing.id, {
        workspaceId, actor, expectedRevision: progressing.revision, now: 1_400,
      });
      await blockCommitment(db, blocked.id, {
        workspaceId, actor, expectedRevision: blocked.revision, reason: "Hardware unavailable", now: 1_450,
      });
      await acquireTaskClaim(db, progressing.id, {
        tenantId: workspaceId,
        actor,
        leaseMs: 10_000,
        now: 1_500,
      });

      const packet = await buildContextPacket(db, {
        workspaceId,
        actor,
        maxRecords: 2,
        maxTokens: 8_192,
        now: 2_000,
        clock: forbiddenClock,
      });
      expect(packet.items.map((item) => item.commitment.title)).toEqual([
        "Calibrate arm",
        "Inspect blocked actuator",
      ]);
      expect(packet.items[0]?.coordination.activeClaim).toMatchObject({
        actorAlias: actor,
        ownedByRequestingActor: true,
      });
      expect(packet.items[0]?.reasonTrace.map((reason) => reason.code)).toContain(
        "coordination.claimed_by_requester",
      );
      expect(packet.items[1]?.reasonTrace.map((reason) => reason.code)).toContain("deadline.overdue");
      expect(packet.selection).toMatchObject({
        eligibleRecords: 3,
        evaluatedRecords: 3,
        selectedRecords: 2,
        omitted: { recordBudget: 1, tokenBudget: 0, candidateScanLimit: 0 },
      });
      expect(packet.resumeCursor.afterEventSequence).toBeGreaterThan(0);
      expect(packet.budget.usedTokens).toBe(Buffer.byteLength(canonicalJson(packet), "utf8"));
      expect(packet.budget.usedTokens).toBeLessThanOrEqual(packet.budget.maxTokens);
      expect(canonicalJson(packet)).not.toContain("nextAction");

      const repeated = await buildContextPacket(db, {
        workspaceId, actor, maxRecords: 2, maxTokens: 8_192, now: 2_000,
      });
      expect(repeated).toEqual(packet);
      const withDeferred = await buildContextPacket(db, {
        workspaceId, actor, maxRecords: 10, maxTokens: 20_000,
        includeDeferred: true, now: 2_000,
      });
      expect(withDeferred.selection.eligibleRecords).toBe(4);
    } finally {
      await close();
    }
  });

  it("truncates large fields visibly and omits whole records when the token envelope is full", async () => {
    const { db, close } = await fixture();
    const workspaceId = "unicode";
    try {
      await createCommitment(db, {
        title: "Résumé 🚀",
        description: "é".repeat(2_000),
        successCriteria: "界".repeat(800),
      }, { workspaceId, actor: "agent", now: 1_100 });
      const roomy = await buildContextPacket(db, {
        workspaceId, actor: "agent", maxRecords: 5, maxTokens: 8_192, now: 2_000,
      });
      expect(roomy.items).toHaveLength(1);
      expect(roomy.items[0]?.truncatedFields.map((item) => item.field).sort()).toEqual([
        "description", "successCriteria",
      ]);
      expect(roomy.budget.usedTokens).toBeLessThanOrEqual(8_192);

      const tiny = await buildContextPacket(db, {
        workspaceId, actor: "agent", maxRecords: 5, maxTokens: 1_024, now: 2_000,
      });
      expect(tiny.items).toEqual([]);
      expect(tiny.selection.omitted.tokenBudget).toBe(1);
      expect(tiny.budget.usedTokens).toBeLessThanOrEqual(1_024);
    } finally {
      await close();
    }
  });

  it("bounds candidate evaluation on a mature ledger and accounts for every omission", async () => {
    const { db, close } = await fixture();
    const workspaceId = "large";
    try {
      for (let index = 0; index < 205; index += 1) {
        await createCommitment(db, { title: `Commitment ${index}` }, {
          workspaceId, actor: "seed", now: 1_000 + index,
        });
      }
      const packet = await buildContextPacket(db, {
        workspaceId, actor: "reader", maxRecords: 1, maxTokens: 8_192, now: 2_000,
      });
      expect(packet.selection).toMatchObject({
        eligibleRecords: 205,
        evaluatedRecords: 200,
        selectedRecords: 1,
        candidateScanLimit: 200,
        omitted: { recordBudget: 199, tokenBudget: 0, candidateScanLimit: 5 },
      });
      const accounted = packet.selection.selectedRecords +
        packet.selection.omitted.recordBudget +
        packet.selection.omitted.tokenBudget +
        packet.selection.omitted.candidateScanLimit;
      expect(accounted).toBe(packet.selection.eligibleRecords);
    } finally {
      await close();
    }
  }, 20_000);

  it("follows a mutable injected clock across calls", async () => {
    const { db, close } = await fixture();
    const clock = createMutableClock(1_000);
    try {
      await createCommitment(db, { title: "Not yet", notBefore: 2_000 }, {
        workspaceId: "clock", actor: "seed", clock,
      });
      expect((await buildContextPacket(db, { workspaceId: "clock", clock })).items).toEqual([]);
      clock.set(2_000);
      expect((await buildContextPacket(db, { workspaceId: "clock", clock })).items).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
