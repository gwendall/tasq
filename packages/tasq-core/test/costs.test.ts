import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CostBoundError,
  ATTEMPT_COST_OBSERVATION_URI,
  appendExternalRef,
  acquireTaskClaim,
  configureTaskCostBudget,
  createCommitment,
  createMutableClock,
  getActiveTaskClaim,
  getTaskCostSummary,
  openDb,
  recordAttemptCost,
  runKernelMigrations,
  startTaskAttempt,
} from "../src/kernel.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tasq-costs-"));
  roots.push(root);
  const opened = await openDb({ url: `file:${join(root, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(2_200_000_000_000);
  await runKernelMigrations(opened.client, { clock });
  const workspaceId = "costs/test";
  const actor = "runtime:test";
  const commitment = await createCommitment(opened.db, { title: "Bounded run" }, {
    workspaceId, actor, clock,
  });
  return { ...opened, clock, workspaceId, actor, commitment };
}

async function boundedFixture(options: { metering?: "required" | "best_effort"; reserve?: string } = {}) {
  const f = await fixture();
  await configureTaskCostBudget(f.db, f.commitment.id, {
    contract: "tasq.task-cost-budget.v1",
    currency: "USD",
    maxGrossMicros: "1000000",
    renewalReserveMicros: options.reserve ?? "100000",
    metering: options.metering ?? "required",
  }, { tenantId: f.workspaceId, actor: f.actor, clock: f.clock });
  const claim = await acquireTaskClaim(f.db, f.commitment.id, {
    tenantId: f.workspaceId, actor: f.actor, clock: f.clock, leaseMs: 60_000,
  });
  const attempt = await startTaskAttempt(f.db, f.commitment.id, {
    tenantId: f.workspaceId, actor: f.actor, clock: f.clock, claimId: claim.id,
  });
  return { ...f, claim, attempt };
}

function observation(f: Awaited<ReturnType<typeof boundedFixture>>, overrides: Record<string, unknown> = {}) {
  return {
    meterUri: "https://meter.example.test/openai",
    observationId: "usage-1",
    currency: "USD",
    grossMicros: "0",
    observedAt: f.clock.now(),
    basis: "provider_receipt",
    ...overrides,
  };
}

describe("TQ-618 observed attempt cost", () => {
  test("requires an explicit meter receipt before renewing a strict claim", async () => {
    const f = await boundedFixture();
    try {
      f.clock.advance(1);
      await expect(acquireTaskClaim(f.db, f.commitment.id, {
        tenantId: f.workspaceId, actor: f.actor, clock: f.clock, leaseMs: 60_000,
      })).rejects.toBeInstanceOf(CostBoundError);
      const recorded = await recordAttemptCost(f.db, f.attempt.id, observation(f), {
        tenantId: f.workspaceId,
        actor: f.actor,
        clock: f.clock,
        idempotencyKey: "usage-1",
      });
      expect(recorded.claimReleased).toBeFalse();
      f.clock.advance(1);
      const renewed = await acquireTaskClaim(f.db, f.commitment.id, {
        tenantId: f.workspaceId, actor: f.actor, clock: f.clock, leaseMs: 60_000,
      });
      expect(renewed.id).toBe(f.claim.id);
      expect((await getTaskCostSummary(f.db, f.commitment.id, {
        tenantId: f.workspaceId, clock: f.clock,
      })).renewal).toMatchObject({ allowed: true, reason: "within_bound" });
    } finally {
      await f.close();
    }
  });

  test("records spend even when it exhausts the reserve, then releases and refuses", async () => {
    const f = await boundedFixture();
    try {
      const result = await recordAttemptCost(f.db, f.attempt.id, observation(f, {
        grossMicros: "950001",
      }), {
        tenantId: f.workspaceId,
        actor: f.actor,
        clock: f.clock,
        idempotencyKey: "usage-over-reserve",
      });
      expect(result.claimReleased).toBeTrue();
      expect(result.summary.renewal).toMatchObject({
        allowed: false,
        reason: "bound_reached",
        observedGrossMicros: "950001",
        remainingMicros: "49999",
      });
      expect(await getActiveTaskClaim(f.db, f.commitment.id, f.workspaceId, f.clock.now()))
        .toBeNull();
      f.clock.advance(1);
      await expect(acquireTaskClaim(f.db, f.commitment.id, {
        tenantId: f.workspaceId, actor: f.actor, clock: f.clock, leaseMs: 60_000,
      })).rejects.toMatchObject({ code: "cost_bound_reached" });
    } finally {
      await f.close();
    }
  });

  test("serializes a threshold receipt racing claim renewal to no active authority", async () => {
    const f = await boundedFixture({ reserve: "0" });
    try {
      await recordAttemptCost(f.db, f.attempt.id, observation(f), {
        tenantId: f.workspaceId, actor: f.actor, clock: f.clock, idempotencyKey: "usage-zero",
      });
      f.clock.advance(1);
      const outcomes = await Promise.allSettled([
        acquireTaskClaim(f.db, f.commitment.id, {
          tenantId: f.workspaceId, actor: f.actor, clock: f.clock, leaseMs: 60_000,
        }),
        recordAttemptCost(f.db, f.attempt.id, observation(f, {
          observationId: "usage-threshold",
          grossMicros: "1000000",
        }), {
          tenantId: f.workspaceId, actor: f.actor, clock: f.clock,
          idempotencyKey: "usage-threshold",
        }),
      ]);
      expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBeTrue();
      expect(await getActiveTaskClaim(f.db, f.commitment.id, f.workspaceId, f.clock.now()))
        .toBeNull();
      expect((await getTaskCostSummary(f.db, f.commitment.id, {
        tenantId: f.workspaceId, clock: f.clock,
      })).renewal).toMatchObject({ allowed: false, reason: "bound_reached" });
    } finally {
      await f.close();
    }
  });

  test("deduplicates provider identity and rejects changed bytes", async () => {
    const f = await boundedFixture({ metering: "best_effort" });
    try {
      const input = observation(f, { grossMicros: "125000" });
      const first = await recordAttemptCost(f.db, f.attempt.id, input, {
        tenantId: f.workspaceId, actor: f.actor, clock: f.clock,
      });
      const replay = await recordAttemptCost(f.db, f.attempt.id, input, {
        tenantId: f.workspaceId, actor: "meter:replay", clock: f.clock,
      });
      expect(replay.replayed).toBeTrue();
      expect(replay.externalRef.id).toBe(first.externalRef.id);
      expect(replay.summary.observationCount).toBe(1);
      await expect(recordAttemptCost(f.db, f.attempt.id, {
        ...input, grossMicros: "125001",
      }, { tenantId: f.workspaceId, actor: f.actor, clock: f.clock }))
        .rejects.toThrow(/different bytes/);
    } finally {
      await f.close();
    }
  });

  test("allows best-effort renewal while still enforcing the monetary bound", async () => {
    const f = await boundedFixture({ metering: "best_effort", reserve: "1" });
    try {
      f.clock.advance(1);
      expect((await acquireTaskClaim(f.db, f.commitment.id, {
        tenantId: f.workspaceId, actor: f.actor, clock: f.clock, leaseMs: 60_000,
      })).id).toBe(f.claim.id);
      const summary = await getTaskCostSummary(f.db, f.commitment.id, {
        tenantId: f.workspaceId, clock: f.clock,
      });
      expect(summary.currentClaimMetered).toBeFalse();
      expect(summary.renewal).toMatchObject({ allowed: true, reason: "within_bound" });
    } finally {
      await f.close();
    }
  });

  test("reserves the cost receipt type from generic external-ref insertion", async () => {
    const f = await boundedFixture();
    try {
      await expect(appendExternalRef(f.db, {
        tenantId: f.workspaceId,
        recordType: "attempt",
        recordId: f.attempt.id,
        system: "https://meter.example.test/provider",
        resourceType: ATTEMPT_COST_OBSERVATION_URI,
        externalId: "bypass",
        digest: `sha256:${"0".repeat(64)}`,
      }, { tenantId: f.workspaceId, actor: f.actor, clock: f.clock }))
        .rejects.toThrow(/must use recordAttemptCost/);
    } finally {
      await f.close();
    }
  });
});
