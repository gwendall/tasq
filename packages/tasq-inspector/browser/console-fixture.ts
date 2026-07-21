/** TQ-705 deterministic, process-isolated Console browser fixtures. */

import {
  acquireResourceLease,
  acquireTaskClaim,
  blockCommitment,
  bootstrapCoordinationSpace,
  createCommitment,
  createMutableClock,
  openDb,
  runKernelMigrations,
  startCommitment,
} from "@tasq/core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTasqInspectorServer } from "../src/index.js";

const FIXED_NOW = 1_735_689_600_000; // 2025-01-01T00:00:00.000Z
const LARGE_COMMITMENTS = 2_501;
const scenarios = ["empty", "mature", "hostile", "corrupt", "large"] as const;
type Scenario = (typeof scenarios)[number];

function usage(): never {
  throw new Error("usage: bun run console-fixture.ts <serve|mutate> <scenario> <directory>");
}

function deterministicUuid(unixMs: number, counter: number): string {
  const time = unixMs.toString(16).padStart(12, "0");
  const tail = counter.toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${tail}`;
}

async function seedLarge(client: Awaited<ReturnType<typeof openDb>>["client"], workspaceId: string) {
  await client.execute("BEGIN IMMEDIATE");
  try {
    for (let offset = 0; offset < LARGE_COMMITMENTS; offset += 250) {
      const size = Math.min(250, LARGE_COMMITMENTS - offset);
      const taskValues: string[] = [];
      const taskArgs: Array<string | number> = [];
      const eventValues: string[] = [];
      const eventArgs: Array<string | number | null> = [];
      for (let local = 0; local < size; local++) {
        const index = offset + local;
        const createdAt = FIXED_NOW - index - 1;
        const taskId = deterministicUuid(createdAt, index + 1);
        const eventId = deterministicUuid(createdAt, LARGE_COMMITMENTS + index + 1);
        taskValues.push("(?, ?, ?, 'open', ?, '{}', 1, ?, ?)");
        taskArgs.push(
          taskId,
          workspaceId,
          `Large commitment ${String(index + 1).padStart(4, "0")}`,
          (index % 5) + 1,
          createdAt,
          createdAt,
        );
        eventValues.push("(?, ?, 'large-fixture', NULL, 'task', ?, 'created', '{}', ?, ?)");
        eventArgs.push(eventId, workspaceId, taskId, createdAt, createdAt);
      }
      await client.execute({
        sql: `INSERT INTO task (id, tenant_id, title, status, priority, metadata, revision, created_at, updated_at) VALUES ${taskValues.join(",")}`,
        args: taskArgs,
      });
      await client.execute({
        sql: `INSERT INTO event (id, tenant_id, actor, principal_id, entity_type, entity_id, event_type, payload, occurred_at, created_at) VALUES ${eventValues.join(",")}`,
        args: eventArgs,
      });
    }
    await client.execute("COMMIT");
  } catch (error) {
    await client.execute("ROLLBACK");
    throw error;
  }
}

async function seedScenario(
  scenario: Scenario,
  opened: Awaited<ReturnType<typeof openDb>>,
  workspaceId: string,
) {
  const clock = createMutableClock(FIXED_NOW);
  const bootstrap = await bootstrapCoordinationSpace(opened.db, {
    workspaceId,
    actor: `${scenario}-operator`,
    clock,
  });
  if (scenario === "empty") return clock;
  if (scenario === "large") {
    await seedLarge(opened.client, workspaceId);
    return clock;
  }

  const common = {
    workspaceId,
    actor: `${scenario}-operator`,
    principalId: bootstrap.principal.id,
    clock,
  };
  const hostileTitle = `<script>globalThis.__tasqPwned=true</script><img src=x onerror=alert(1)>`;
  const primary = await createCommitment(opened.db, {
    title: scenario === "hostile" ? hostileTitle : "Verify robotic arm calibration",
    description: "Audit the external condition before releasing the workcell.",
    priority: 5,
    metadata: scenario === "hostile" ? { privateNote: "Foreign workspace secret" } : {},
  }, { ...common, idempotencyKey: `${scenario}-primary` });

  if (scenario === "hostile") return clock;
  const running = await createCommitment(opened.db, {
    title: "Run collision envelope simulation",
    priority: 3,
  }, { ...common, idempotencyKey: "mature-running" });
  await startCommitment(opened.db, running.id, { ...common, expectedRevision: running.revision });
  const blocked = await createCommitment(opened.db, {
    title: "Reserve shared workcell",
    priority: 4,
  }, { ...common, idempotencyKey: "mature-blocked" });
  await blockCommitment(opened.db, blocked.id, {
    ...common,
    expectedRevision: blocked.revision,
    reason: "Awaiting the current lease holder",
  });
  await acquireTaskClaim(opened.db, primary.id, {
    tenantId: workspaceId,
    actor: common.actor,
    principalId: common.principalId,
    idempotencyKey: "mature-claim",
    leaseMs: 60_000,
    clock,
  });
  await acquireResourceLease(opened.db, "robot:arm-a", {
    ...common,
    idempotencyKey: "mature-resource",
    leaseMs: 60_000,
  });
  if (scenario === "corrupt") {
    await opened.client.execute("PRAGMA ignore_check_constraints = ON");
    await opened.client.execute({
      sql: "UPDATE task SET status = 'alien', revision = revision + 1 WHERE id = ?",
      args: [primary.id],
    });
  }
  return clock;
}

async function main() {
  const mode = process.argv[2];
  const scenario = process.argv[3] as Scenario | undefined;
  const directory = process.argv[4];
  if ((mode !== "serve" && mode !== "mutate") || !scenario || !scenarios.includes(scenario) || !directory) usage();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspaceId = `console/${scenario}`;
  const opened = await openDb({ url: `file:${join(directory, "db.sqlite")}` });
  await runKernelMigrations(opened.client, { now: FIXED_NOW });

  if (mode === "mutate") {
    const clock = createMutableClock(FIXED_NOW + 10_000);
    await createCommitment(opened.db, {
      title: "Inspect new live calibration evidence",
      priority: 2,
    }, {
      workspaceId,
      actor: `${scenario}-operator`,
      idempotencyKey: `${scenario}-live-mutation`,
      clock,
    });
    await opened.close();
    return;
  }

  const clock = await seedScenario(scenario, opened, workspaceId);
  const server = startTasqInspectorServer({
    db: opened.db,
    workspaceId,
    clock,
    hostname: "127.0.0.1",
    port: 0,
    instanceId: `00000000-0000-4000-8000-00000000000${scenarios.indexOf(scenario) + 1}`,
    processId: 70_500 + scenarios.indexOf(scenario),
  });
  process.stdout.write(`${JSON.stringify({ scenario, url: server.url, now: clock.now() })}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await opened.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

await main();
