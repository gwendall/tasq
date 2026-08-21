import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
}

describe("TQ-901–TQ-906 managed Cloud truth gate", () => {
  test("keeps every source candidate distinct from deployed availability", async () => {
    const matrix = await json("docs/concepts/PRODUCT_SURFACE_MATRIX.json");
    const backlog = await json("docs/roadmap/BACKLOG.json");
    const cloud = (matrix.productShapes as Array<Record<string, unknown>>)
      .find(({ id }) => id === "cloud");
    expect(cloud).toMatchObject({
      support: "implemented_candidate_not_published",
      publiclyDistributed: false,
    });
    const items = new Map(
      (backlog.items as Array<Record<string, unknown>>)
        .map((item) => [item.id, item]),
    );
    for (const id of ["TQ-901", "TQ-902", "TQ-903", "TQ-904", "TQ-905"]) {
      expect(items.get(id)?.status).toBe("candidate_done_external_gate");
      expect((items.get(id)?.remaining as unknown[]).length).toBeGreaterThan(0);
    }
    expect(items.get("TQ-906")?.status).toBe("pending_independent_review");
  });

  test("machine certificates preserve unavailable and effect-disabled truth", async () => {
    for (const id of ["901", "902", "903", "904", "905"]) {
      const matches = [
        `docs/contracts/TQ-${id}_CLOUD_CONTROL_PLANE_CERTIFICATION.json`,
        `docs/contracts/TQ-${id}_CLOUD_BFF_CERTIFICATION.json`,
        `docs/contracts/TQ-${id}_CLOUD_IDENTITY_CERTIFICATION.json`,
        `docs/contracts/TQ-${id}_CLOUD_OPERATIONS_CERTIFICATION.json`,
        `docs/contracts/TQ-${id}_CLOUD_HOSTILE_CERTIFICATION.json`,
      ];
      const path = matches[Number(id) - 901]!;
      const certificate = await json(path);
      expect(certificate.status).toBe("candidate_done_external_gate");
      expect(
        certificate.managedCloudAvailable ??
          certificate.hostedConsoleAvailable ??
          certificate.managedIdentityAvailable ??
          certificate.operatedCloudLifecycleAvailable,
      ).toBeFalse();
    }
    const effects = await json(
      "docs/contracts/TQ-906_REMOTE_EFFECTS_REVIEW_GATE.json",
    );
    expect(effects).toMatchObject({
      status: "pending_independent_review",
      canCurrentAuthorSelfApprove: false,
      remoteEffectsAvailable: false,
    });
    expect(effects.currentInvariant).toMatchObject({
      serverEffectsEnabled: false,
      cloudBffEffectsRoute: "denied",
      remoteDispatchOperationRegistered: false,
    });
  });

  test("Cloud stays private and Core never imports the control plane", async () => {
    const packageJson = await json("packages/tasq-cloud-control-plane/package.json");
    expect(packageJson.private).toBeTrue();
    const coreFiles = new Bun.Glob("packages/tasq-core/src/**/*.ts");
    for await (const path of coreFiles.scan({ cwd: root })) {
      const source = await readFile(resolve(root, path), "utf8");
      expect(source).not.toContain("tasq-cloud-control-plane");
    }
    const cloudSource = await readFile(
      resolve(root, "packages/tasq-cloud-control-plane/src/index.ts"),
      "utf8",
    );
    expect(cloudSource).toContain('code: "remote_effects_disabled"');
    expect(cloudSource).not.toContain("effect.dispatch");
  });

  test("keeps managed database migration create-only and deployment fail-closed", async () => {
    const certificate = await json(
      "docs/contracts/TQ-901_CLOUD_CONTROL_PLANE_CERTIFICATION.json",
    );
    expect(certificate.proof).toMatchObject({
      managedLibsqlConnectionCandidate: true,
      createOnlyMigrationSnapshot: true,
      schemaAndOrderedRowDigestVerification: true,
      failClosedMaintenanceCutover: true,
      liveManagedDatabaseMigration: "not_run",
    });
    const [snapshot, runtime, workflow, runbook] = await Promise.all([
      readFile(resolve(root,
        "packages/tasq-cloud-control-plane/src/database-snapshot.ts"), "utf8"),
      readFile(resolve(root,
        "packages/tasq-cloud-control-plane/src/runtime.ts"), "utf8"),
      readFile(resolve(root,
        ".github/workflows/deploy-fly-private-beta.yml"), "utf8"),
      readFile(resolve(root, "deploy/managed-cloud/README.md"), "utf8"),
    ]);
    expect(snapshot).toContain('sql: "VACUUM INTO ?"');
    expect(snapshot).toContain("fingerprintCloudDatabase");
    expect(snapshot).not.toContain("unlink(");
    expect(runtime).toContain("TASQ_CLOUD_DATABASE_URL");
    expect(runtime).toContain("TASQ_CLOUD_DATABASE_AUTH_TOKEN");
    expect(runtime).toContain("TASQ_CLOUD_MAINTENANCE");
    expect(workflow).toContain(
      "for required in TASQ_CLOUD_DATABASE_URL TASQ_CLOUD_DATABASE_AUTH_TOKEN",
    );
    expect(workflow).toContain("control_database_mode:");
    expect(workflow).toContain('--env TASQ_CLOUD_DATABASE_MODE="$INPUT_CONTROL_DATABASE_MODE"');
    expect(runbook).toMatch(/Never delete the\s+remote database, local volume/);
    expect(runbook).toContain("database_migration_in_progress");
    expect(runbook).toContain("it is not multi-region recovery evidence");
    expect(runbook).toMatch(/independent\s+multi-tenant infrastructure review/);
  });
});
