import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  appendArtifact,
  createCommitment,
  createPrincipal,
  createWaitCondition,
  ingestObservation,
  installExtension,
  inspectCommitment,
  openDb,
  proposeEffect,
  reconcileWaitObservation,
  recordEffectApproval,
  renderCommitmentInspection,
  runMigrations,
  startTaskAttempt,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("canonical commitment inspection", () => {
  it("returns a provider-neutral graph and workspace-level resume cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-inspection-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const workspaceId = "inspection-test";
    try {
      await runMigrations(client, { now: 1_000 });
      const runtime = await createPrincipal(db, {
        tenantId: workspaceId,
        kind: "runtime",
        displayName: "Runtime",
      }, { now: 1_100 });
      const commitment = await createCommitment(db, {
        title: "Inspect external truth",
        completionPolicy: "evidence",
        successCriteria: "Authenticated endpoint matches digest",
      }, { workspaceId, actor: "runtime", principalId: runtime.id, now: 1_200 });
      await installExtension(db, {
        extensionUri: "https://example.test/extensions/deployment",
        version: "1.0.0",
        types: [{
          recordKind: "effect",
          typeUri: "https://example.test/effects/deploy",
          schemaVersion: 1,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { artifactRef: { type: "string" } },
            required: ["artifactRef"],
          },
        }],
        evaluators: [],
      }, { tenantId: workspaceId, actor: "runtime", principalId: runtime.id, now: 1_250 });
      const claim = await acquireTaskClaim(db, commitment.id, {
        tenantId: workspaceId,
        actor: "runtime",
        principalId: runtime.id,
        leaseMs: 10_000,
        now: 1_300,
      });
      const attempt = await startTaskAttempt(db, commitment.id, {
        tenantId: workspaceId,
        actor: "runtime",
        principalId: runtime.id,
        claimId: claim.id,
        runtime: "a2a",
        occurredAt: 1_400,
      });
      await appendArtifact(db, {
        tenantId: workspaceId,
        taskId: commitment.id,
        attemptId: attempt.id,
        typeUri: "https://example.test/types/deployment",
        name: "deployment.json",
        inlineDataRef: "urn:blob:deployment",
        digest: "sha256:deployment",
      }, { tenantId: workspaceId, actor: "runtime", principalId: runtime.id, now: 1_500 });
      const condition = await createWaitCondition(db, {
        tenantId: workspaceId,
        taskId: commitment.id,
        kind: "http.response",
        parameters: {
          url: "https://example.test/health",
          method: "GET",
          allowedStatuses: [200],
        },
      }, { tenantId: workspaceId, actor: "runtime", now: 1_600 });
      const fact = await ingestObservation(db, {
        tenantId: workspaceId,
        source: "monitor",
        externalEventId: "health-1",
        kind: "http.check",
        payload: {
          url: "https://example.test/health",
          method: "GET",
          statusCode: 200,
          bodyDigest: null,
        },
        occurredAt: 1_700,
      }, { tenantId: workspaceId, actor: "monitor", now: 1_700 });
      await reconcileWaitObservation(db, condition.id, fact.id, {
        tenantId: workspaceId,
        actor: "runtime",
        principalId: runtime.id,
        now: 1_800,
      });
      const effect = await proposeEffect(db, {
        tenantId: workspaceId,
        taskId: commitment.id,
        request: {
          protocol: "tasq.effect-request.v1",
          canonicalization: "tasq.jcs-safe-integer.v1",
          digestAlgorithm: "sha-256",
          workspaceId,
          effectTypeUri: "https://example.test/effects/deploy",
          effectSchemaVersion: 1,
          connector: {
            operationUri: "https://example.test/connectors/deploy",
            operationVersion: 1,
            contractDigest: `sha256:${"a".repeat(64)}`,
            instanceRef: "connector:deploy:test",
            bindingDigest: `sha256:${"b".repeat(64)}`,
          },
          parameters: { artifactRef: "urn:blob:deployment" },
          secretBindings: [],
        },
      }, { principalId: runtime.id, now: 1_850 });
      const approval = await recordEffectApproval(db, {
        tenantId: workspaceId,
        effectId: effect.id,
        decision: "approved",
      }, { principalId: runtime.id, now: 1_875 });

      const snapshot = await inspectCommitment(db, commitment.id, { workspaceId, now: 1_900 });
      expect(snapshot).not.toBeNull();
      expect(snapshot).toMatchObject({
        contractVersion: "tasq.inspect.v1",
        inspectedAt: 1_900,
        workspaceId,
        commitment: { id: commitment.id, workspaceId },
      });
      expect(snapshot!.principals.map((item) => item.id)).toContain(runtime.id);
      expect(snapshot!.claims[0]).toMatchObject({ commitmentId: commitment.id, principalId: runtime.id });
      expect(snapshot!.claims[0]).not.toHaveProperty("tenantId");
      expect(snapshot!.claims[0]).not.toHaveProperty("taskId");
      expect(snapshot!.claims[0]).not.toHaveProperty("actor");
      expect(snapshot!.attempts[0]).toMatchObject({ commitmentId: commitment.id, runtime: "a2a" });
      expect(snapshot!.artifacts[0]).toMatchObject({
        commitmentId: commitment.id,
        type: { uri: "https://example.test/types/deployment", schemaVersion: 1 },
      });
      expect(snapshot!.effects[0]).toMatchObject({
        id: effect.id,
        commitmentId: commitment.id,
        requestDigest: effect.requestDigest,
        type: { uri: "https://example.test/effects/deploy", schemaVersion: 1 },
        connector: { instanceRef: "connector:deploy:test" },
        request: { parameters: { artifactRef: "urn:blob:deployment" } },
      });
      expect(snapshot!.effectApprovals[0]).toMatchObject({
        id: approval.id,
        effectId: effect.id,
        decision: "approved",
      });
      expect(snapshot!.effectReceipts).toEqual([]);
      expect(snapshot!.conditions[0]).toMatchObject({
        commitmentId: commitment.id,
        type: { uri: "https://schemas.tasq.dev/conditions/http/response", schemaVersion: 1 },
        evaluator: { uri: "https://schemas.tasq.dev/evaluators/http/response", version: 1 },
      });
      expect(snapshot!.conditions[0]).not.toHaveProperty("typeUri");
      expect(snapshot!.conditions[0]).not.toHaveProperty("evaluatorUri");
      expect(snapshot!.conditions[0]).not.toHaveProperty("kind");
      expect(snapshot!.observations[0]).toMatchObject({
        type: { uri: "https://schemas.tasq.dev/observations/http/check", schemaVersion: 1 },
      });
      expect(snapshot!.reconciliations[0]?.evaluator.uri)
        .toBe(snapshot!.conditions[0]?.evaluator.uri);
      expect(snapshot!.resumeCursor.afterEventSequence).toBeGreaterThan(0);
      expect(snapshot!.resumeCursor.afterObservation).toEqual({
        id: fact.id,
        recordedAt: fact.recordedAt,
      });
      expect(renderCommitmentInspection(snapshot!)).toContain(
        "https://schemas.tasq.dev/conditions/http/response@1",
      );
      expect(renderCommitmentInspection(snapshot!)).toContain("Effects / approvals / receipts: 1 / 1 / 0");
      expect(await inspectCommitment(db, "00000000-0000-7000-8000-000000000000", {
        workspaceId,
        now: 2_000,
      })).toBeNull();
    } finally {
      await close();
    }
  });
});
