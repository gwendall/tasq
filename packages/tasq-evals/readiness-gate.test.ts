/** UK-008: executable compatibility and generic-readiness gate for TQ-107. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommitment,
  createPrincipal,
  createWaitCondition,
  diagnoseStore,
  getExtensionEvaluatorRegistration,
  getExtensionTypeRegistration,
  getTaskEvidence,
  ingestObservation,
  listEvents,
  listObservations,
  openDb,
  reconcileWaitObservation,
  runMigrations,
} from "@tasq-internal/local-service";

const workspaceId = "uk-008-readiness";
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("UK-008 compatibility and generic-readiness gate", () => {
  it("preserves v1 DTOs while universal identities, diagnostics and cursors remain inspectable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-uk-008-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({
      url: `file:${join(dir, "db.sqlite")}`,
      wal: false,
    });
    try {
      await runMigrations(client, { now: 10_000 });
      const gatePrincipal = await createPrincipal(db, {
        tenantId: workspaceId,
        kind: "runtime",
        displayName: "Readiness gate runtime",
      }, { now: 10_050 });
      const commitment = await createCommitment(db, {
        title: "Prove generic inspection readiness",
        completionPolicy: "evidence",
        successCriteria: "The registered external fact is reconciled",
      }, { workspaceId, actor: "gate", principalId: gatePrincipal.id, now: 10_100 });
      const condition = await createWaitCondition(db, {
        tenantId: workspaceId,
        taskId: commitment.id,
        kind: "http.response",
        parameters: {
          url: "https://gate.example.test/health",
          method: "GET",
          allowedStatuses: [200],
          bodyDigest: "sha256:healthy",
        },
      }, { tenantId: workspaceId, actor: "gate", now: 10_200 });
      const firstFact = await ingestObservation(db, {
        tenantId: workspaceId,
        source: "monitor:gate",
        externalEventId: "gate-1",
        kind: "http.check",
        payload: {
          url: "https://gate.example.test/health",
          method: "GET",
          statusCode: 200,
          bodyDigest: "sha256:healthy",
        },
        occurredAt: 10_300,
        verificationLevel: "authenticated_source",
        verificationMethod: "test-signature",
      }, { tenantId: workspaceId, actor: "monitor", now: 10_300 });
      const reconciliation = await reconcileWaitObservation(db, condition.id, firstFact.id, {
        tenantId: workspaceId,
        actor: "reconciler",
        principalId: gatePrincipal.id,
        now: 10_400,
      });
      expect((await getTaskEvidence(db, reconciliation.evidenceId!, workspaceId))?.principalId)
        .toBe(gatePrincipal.id);

      const storedCondition = await client.execute({
        sql: `SELECT type_uri, schema_version, evaluator_uri, evaluator_version,
                     evaluator_implementation_digest
              FROM wait_condition WHERE tenant_id = ? AND id = ?`,
        args: [workspaceId, condition.id],
      });
      const storedObservation = await client.execute({
        sql: `SELECT type_uri, schema_version FROM observation
              WHERE tenant_id = ? AND id = ?`,
        args: [workspaceId, firstFact.id],
      });
      const storedReconciliation = await client.execute({
        sql: `SELECT evaluator_uri, evaluator_version, evaluator_implementation_digest
              FROM reconciliation WHERE tenant_id = ? AND id = ?`,
        args: [workspaceId, reconciliation.id],
      });
      const conditionIdentity = storedCondition.rows[0]!;
      const observationIdentity = storedObservation.rows[0]!;
      const reconciliationIdentity = storedReconciliation.rows[0]!;

      expect(conditionIdentity.type_uri).toBe(
        "https://schemas.tasq.dev/conditions/http/response",
      );
      expect(observationIdentity.type_uri).toBe(
        "https://schemas.tasq.dev/observations/http/check",
      );
      expect(reconciliationIdentity.evaluator_uri).toBe(conditionIdentity.evaluator_uri);
      expect(reconciliationIdentity.evaluator_version).toBe(conditionIdentity.evaluator_version);
      expect(reconciliationIdentity.evaluator_implementation_digest)
        .toBe(conditionIdentity.evaluator_implementation_digest);
      expect(await getExtensionTypeRegistration(
        db,
        String(conditionIdentity.type_uri),
        Number(conditionIdentity.schema_version),
        workspaceId,
      )).not.toBeNull();
      expect(await getExtensionTypeRegistration(
        db,
        String(observationIdentity.type_uri),
        Number(observationIdentity.schema_version),
        workspaceId,
      )).not.toBeNull();
      expect(await getExtensionEvaluatorRegistration(
        db,
        String(conditionIdentity.evaluator_uri),
        Number(conditionIdentity.evaluator_version),
        workspaceId,
      )).not.toBeNull();

      // Compatibility is deliberate: v1 service DTOs retain their frozen
      // alias fields while TQ-107 adds a separate canonical inspection view.
      expect(condition).not.toHaveProperty("typeUri");
      expect(firstFact).not.toHaveProperty("typeUri");
      expect(reconciliation).not.toHaveProperty("evaluatorUri");

      const firstEventPage = await listEvents(db, {
        tenantId: workspaceId,
        ascending: true,
        limit: 2,
      });
      const resumedEvents = await listEvents(db, {
        tenantId: workspaceId,
        ascending: true,
        afterSequence: firstEventPage.at(-1)!.sequence,
      });
      expect(resumedEvents.every(
        (event) => event.sequence > firstEventPage.at(-1)!.sequence,
      )).toBe(true);
      expect(new Set([...firstEventPage, ...resumedEvents].map((event) => event.sequence)).size)
        .toBe(firstEventPage.length + resumedEvents.length);

      const secondFact = await ingestObservation(db, {
        tenantId: workspaceId,
        source: "monitor:gate",
        externalEventId: "gate-2",
        kind: "http.check",
        payload: {
          url: "https://gate.example.test/other",
          method: "GET",
          statusCode: 503,
          bodyDigest: null,
        },
        occurredAt: 10_500,
      }, { tenantId: workspaceId, actor: "monitor", now: 10_500 });
      const observationResume = await listObservations(db, {
        tenantId: workspaceId,
        after: { recordedAt: firstFact.recordedAt, id: firstFact.id },
      });
      expect(observationResume.map((fact) => fact.id)).toEqual([secondFact.id]);

      const report = await diagnoseStore(db, client, workspaceId);
      expect(report.ok, JSON.stringify(report.issues, null, 2)).toBe(true);
      expect(report.sqliteIntegrity).toBe("ok");
      expect(report.foreignKeyViolations).toBe(0);
    } finally {
      await close();
    }
  });
});
