/**
 * Eval: replacement agents deliver one ordered stream through the generic
 * outbox contract, including the two boundaries operators actually face:
 * effect-before-ack process loss and a poison record that needs repair.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock, type Clock } from "@tasq-run/schema";
import {
  completeDelivery,
  createCommitment,
  ensureDeliverySink,
  failDelivery,
  leaseNextDelivery,
  listDeliveryOutbox,
  openDb,
  repairDelivery,
  runKernelMigrations,
  type LeasedDelivery,
  type TasqDb,
} from "@tasq-run/core";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-outbox-eval-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(1_930_000_000_000);
  await runKernelMigrations(handle.client, { clock });
  const sinkId = "robot-fleet:ordered-telemetry";
  await ensureDeliverySink(handle.db, {
    id: sinkId,
    kind: "urn:robot-fleet:sink:ordered-telemetry:v1",
    configurationDigest: `sha256:${"e".repeat(64)}`,
  }, { clock });
  return { ...handle, clock, sinkId };
}

async function drainForAgent(
  db: TasqDb,
  sinkId: string,
  clock: Clock,
  owner: string,
  apply: (event: LeasedDelivery["event"]) => "applied" | "already_applied",
  options: { maxAttempts?: number; baseBackoffMs?: number } = {},
) {
  const output = { applied: 0, alreadyApplied: 0, failed: 0 };
  for (let index = 0; index < 100; index++) {
    const leased = await leaseNextDelivery(db, sinkId, {
      leaseOwner: owner,
      leaseMs: 100,
      clock,
    });
    if (!leased) break;
    try {
      const result = apply(leased.event);
      await completeDelivery(db, leased.delivery.id, { leaseOwner: owner, clock });
      if (result === "applied") output.applied++;
      else output.alreadyApplied++;
    } catch (error) {
      await failDelivery(db, leased.delivery.id, {
        leaseOwner: owner,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: options.maxAttempts,
        baseBackoffMs: options.baseBackoffMs,
        clock,
      });
      output.failed++;
      break;
    }
  }
  return output;
}

describe("generic outbox replacement-agent recovery", () => {
  it("deduplicates an effect that happened immediately before the first agent crashed", async () => {
    const { db, close, clock, sinkId } = await setup();
    try {
      const first = await createCommitment(db, {
        title: "Move robot arm to inspection pose",
      }, { workspaceId: "gwendall", actor: "cell-coordinator", clock });
      clock.advance(1);
      const second = await createCommitment(db, {
        title: "Capture inspection image",
      }, { workspaceId: "gwendall", actor: "cell-coordinator", clock });

      // Agent A applies the first effect to an idempotent external sink, then
      // disappears before acknowledging SQLite.
      const crashed = await leaseNextDelivery(db, sinkId, {
        leaseOwner: "agent-a",
        leaseMs: 100,
        clock,
      });
      const external = new Map<string, number>();
      external.set(crashed!.event.id, crashed!.event.sequence);

      // Agent B has no callback history. After expiry it replays the head,
      // observes the sink identity, acknowledges it, then advances in order.
      clock.advance(100);
      const replacementOutput = await drainForAgent(
        db,
        sinkId,
        clock,
        "agent-b",
        (event) => {
          if (external.get(event.id) === event.sequence) return "already_applied";
          external.set(event.id, event.sequence);
          return "applied";
        },
      );

      expect(replacementOutput).toEqual({ applied: 1, alreadyApplied: 1, failed: 0 });
      expect([...external.values()]).toEqual([...external.values()].sort((a, b) => a - b));
      expect([...external.keys()]).toEqual([crashed!.event.id, expect.any(String)]);
      expect(new Set(external.keys()).size).toBe(2);
      expect((await listDeliveryOutbox(db, { sinkId, ascending: true })).map((row) => ({
        entity: row.eventId,
        status: row.status,
      }))).toEqual([
        { entity: crashed!.event.id, status: "delivered" },
        { entity: expect.any(String), status: "delivered" },
      ]);
      expect(first.id).not.toBe(second.id);
    } finally {
      await close();
    }
  });

  it("blocks after a poison record and resumes the complete stream only after repair", async () => {
    const { db, close, clock, sinkId } = await setup();
    try {
      await createCommitment(db, { title: "Publish invalid calibration" }, {
        workspaceId: "gwendall",
        actor: "cell-coordinator",
        clock,
      });
      clock.advance(1);
      await createCommitment(db, { title: "Publish subsequent telemetry" }, {
        workspaceId: "gwendall",
        actor: "cell-coordinator",
        clock,
      });

      const rejectPoison = () => {
        throw new Error("telemetry schema rejected");
      };
      expect(await drainForAgent(db, sinkId, clock, "agent-a", rejectPoison, {
        maxAttempts: 2,
        baseBackoffMs: 10,
      })).toEqual({ applied: 0, alreadyApplied: 0, failed: 1 });
      clock.advance(10);
      expect(await drainForAgent(db, sinkId, clock, "agent-b", rejectPoison, {
        maxAttempts: 2,
        baseBackoffMs: 10,
      })).toEqual({ applied: 0, alreadyApplied: 0, failed: 1 });

      const blocked = await listDeliveryOutbox(db, { sinkId, ascending: true });
      expect(blocked.map((row) => row.status)).toEqual(["quarantined", "pending"]);
      expect(await leaseNextDelivery(db, sinkId, {
        leaseOwner: "agent-c",
        leaseMs: 100,
        clock,
      })).toBeNull();

      clock.advance(1);
      await repairDelivery(db, blocked[0]!.id, "retry", { clock });
      const visible = new Array<number>();
      const repairedOutput = await drainForAgent(
        db,
        sinkId,
        clock,
        "agent-c",
        (event) => {
          visible.push(event.sequence);
          return "applied";
        },
      );

      expect(repairedOutput).toEqual({ applied: 2, alreadyApplied: 0, failed: 0 });
      expect(visible).toEqual([...visible].sort((a, b) => a - b));
      expect((await listDeliveryOutbox(db, { sinkId, ascending: true }))
        .map((row) => row.status)).toEqual(["delivered", "delivered"]);
    } finally {
      await close();
    }
  });
});
