import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forbidden = /tasq-(?:life-planning-profile|reference-extension)|\/(?:areas|goals|projects|recurrence)\.js$/;
Bun.plugin({
  name: "reject-bundled-profiles",
  setup(build) {
    build.onResolve({ filter: forbidden }, (args) => {
      throw new Error(`minimal kernel loaded forbidden profile module: ${args.path}`);
    });
  },
});

const kernel = await import("../../src/kernel.ts");
const exposed = Object.keys(kernel);
for (const forbiddenExport of [
  "createArea",
  "createGoal",
  "createProject",
  "nextOccurrence",
  "pickNext",
  "renderProjection",
]) {
  if (exposed.includes(forbiddenExport)) {
    throw new Error(`minimal kernel exposes profile API: ${forbiddenExport}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "tasq-minimal-kernel-"));
try {
  const handle = await kernel.openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = kernel.createMutableClock(1_900_000_000_000);
  try {
    await kernel.runKernelMigrations(handle.client, { clock });
    const context = { workspaceId: "robotics-lab", actor: "runtime:planner", clock };
    let profileInputRejected = false;
    try {
      await kernel.createCommitment(handle.db, {
        title: "Invalid profile-shaped input",
        areaId: "01800000-0000-7000-8000-000000000001",
      }, context);
    } catch {
      profileInputRejected = true;
    }
    const created = await kernel.createCommitment(handle.db, {
      title: "Calibrate arm joint",
      successCriteria: "Calibration receipt is attached",
      completionPolicy: "assertion",
    }, context);
    clock.advance(1_000);
    await kernel.startCommitment(handle.db, created.id, context);
    clock.advance(1_000);
    const completed = await kernel.completeCommitment(handle.db, created.id, context);
    const inspection = await kernel.inspectCommitment(handle.db, created.id, {
      workspaceId: context.workspaceId,
      clock,
    });

    const registry = await handle.client.execute("SELECT COUNT(*) AS count FROM extension_release");
    const planning = await handle.client.execute(`
      SELECT
        (SELECT COUNT(*) FROM area) AS areas,
        (SELECT COUNT(*) FROM goal) AS goals,
        (SELECT COUNT(*) FROM project) AS projects
    `);
    const row = planning.rows[0]!;
    process.stdout.write(JSON.stringify({
      status: completed.status,
      workspaceId: completed.workspaceId,
      profileFieldsExposed: Object.keys(completed).some((key) =>
        ["areaId", "goalId", "projectId", "recurrence", "nextAction"].includes(key)
      ),
      profileInputRejected,
      inspectionContract: inspection?.contractVersion,
      inspectionProfileFieldsExposed: Object.keys(inspection?.commitment ?? {}).some((key) =>
        ["areaId", "goalId", "projectId", "recurrence", "nextAction"].includes(key)
      ),
      referenceExtensions: Number(registry.rows[0]?.["count"] ?? -1),
      planningRows: Number(row["areas"]) + Number(row["goals"]) + Number(row["projects"]),
    }));
  } finally {
    await handle.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
