/** UK-011: black-box universal-kernel acceptance across two unfamiliar runtimes. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntimeRegistry, defineExtensionRuntime } from "@tasq-run/extension-sdk";
import { createMutableClock, type ExtensionManifest, type Metadata } from "@tasq-run/schema";
import {
  TASQ_PROTOCOL_ADAPTER_MANIFEST,
  syncA2ATask,
  syncMcpTask,
} from "@tasq-run/protocol-adapters";
import {
  getDiscoverySchema,
  getTasqDiscovery,
  installExtension,
  negotiateOnboarding,
} from "@tasq-internal/local-service";
import {
  acceptAssignment,
  acquireTaskClaim,
  addTaskEvidence,
  completeCommitment,
  createCommitment,
  createPrincipal,
  getCommitment,
  inspectCommitment,
  listArtifacts,
  listAssignments,
  listCompletionRecords,
  listEvents,
  listTaskAttempts,
  listTaskEvidence,
  openDb,
  proposeAssignment,
  runKernelMigrations,
  startCommitment,
} from "@tasq-run/core";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const CONDITION_URI = "https://kinetic.example/conditions/pose-window";
const OBSERVATION_URI = "https://kinetic.example/observations/pose-sample";
const EVALUATOR_URI = "https://kinetic.example/evaluators/pose-window";
const IMPLEMENTATION_DIGEST = `sha256:${"7".repeat(64)}`;

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const manifest: ExtensionManifest = {
  extensionUri: "https://kinetic.example/extensions/pose-verification",
  version: "1.0.0",
  types: [
    {
      recordKind: "condition",
      typeUri: CONDITION_URI,
      schemaVersion: 1,
      schema: objectSchema({
        station: { type: "string" },
        targetMicrons: { type: "integer" },
        toleranceMicrons: { type: "integer", minimum: 0 },
      }, ["station", "targetMicrons", "toleranceMicrons"]),
    },
    {
      recordKind: "observation",
      typeUri: OBSERVATION_URI,
      schemaVersion: 1,
      schema: objectSchema({
        station: { type: "string" },
        measuredMicrons: { type: "integer" },
      }, ["station", "measuredMicrons"]),
    },
  ],
  evaluators: [{
    evaluatorUri: EVALUATOR_URI,
    evaluatorVersion: 1,
    conditionTypeUri: CONDITION_URI,
    conditionSchemaVersion: 1,
    acceptedObservationTypes: [{ typeUri: OBSERVATION_URI, schemaVersion: 1 }],
    implementationDigest: IMPLEMENTATION_DIGEST,
  }],
};

function parseObject(value: unknown): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object payload");
  return value as Metadata;
}

const extension = defineExtensionRuntime({
  manifest,
  conditions: [{ typeUri: CONDITION_URI, schemaVersion: 1, parse: parseObject }],
  observations: [{
    typeUri: OBSERVATION_URI,
    schemaVersion: 1,
    parse: parseObject,
    subjectRef: (value) => `urn:station:${String(value.station)}`,
    routeKeys: (value) => [`station:${String(value.station)}`],
  }],
  evaluators: [{
    evaluatorUri: EVALUATOR_URI,
    evaluatorVersion: 1,
    implementationDigest: IMPLEMENTATION_DIGEST,
    conditionType: { typeUri: CONDITION_URI, schemaVersion: 1 },
    acceptedObservationTypes: [{ typeUri: OBSERVATION_URI, schemaVersion: 1 }],
    conditionRouteKeys: (value) => [`station:${String(value.station)}`],
    evaluate: (condition, observation) => {
      const sameStation = condition.station === observation.station;
      const withinTolerance = Math.abs(
        Number(observation.measuredMicrons) - Number(condition.targetMicrons),
      ) <= Number(condition.toleranceMicrons);
      const matched = sameStation && withinTolerance;
      return {
        decision: matched ? "matched" : "rejected",
        reasonCode: matched ? "pose_within_window" : "pose_outside_window",
        explanation: matched ? "The typed sample is inside the requested window." : "The sample is outside it.",
      };
    },
  }],
});

async function runFixture(name: string, input: unknown): Promise<any> {
  const path = new URL(`./fixtures/${name}`, import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "run", path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${name} failed: ${stderr}`);
  return JSON.parse(stdout);
}

async function schemaFingerprint(client: any): Promise<string> {
  const result = await client.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
  );
  return createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
}

function lastSequence(events: Array<{ sequence: number }>): number {
  return events.at(-1)?.sequence ?? 0;
}

describe("UK-011 universal-kernel acceptance", () => {
  it("cold-starts two unrelated runtimes, coordinates, disconnects and resumes without kernel schema changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-universal-acceptance-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(1_000);
    try {
      await runKernelMigrations(client, { clock });
      const pristineSchema = await schemaFingerprint(client);
      const runtimeRegistry = new ExtensionRuntimeRegistry([extension]);
      clock.set(1_100);
      await installExtension(db, manifest, { actor: "extension-admin", clock });
      expect(await schemaFingerprint(client)).toBe(pristineSchema);

      clock.set(1_200);
      const coordinator = await createPrincipal(db, {
        displayName: "Cold-start coordinator runtime",
        kind: "runtime",
        metadata: { executionProtocol: "mcp:2025-11-25" },
      }, { actor: "bootstrap", idempotencyKey: "runtime-coordinator", clock });
      clock.set(1_300);
      const worker = await createPrincipal(db, {
        displayName: "Cold-start worker runtime",
        kind: "runtime",
        metadata: { executionProtocol: "a2a:1.0" },
      }, { actor: "bootstrap", idempotencyKey: "runtime-worker", clock });

      clock.set(1_400);
      const document = await getTasqDiscovery(db, {
        workspaceId: "gwendall",
        capabilityProfile: "kernel",
        transportBoundary: "authenticated_remote",
        clock,
      });
      const schemas = await Promise.all(document.extensions.flatMap((candidate) => candidate.types)
        .map((type) => getDiscoverySchema(db, type.resourceId, { workspaceId: "gwendall" })));
      expect(schemas.every(Boolean)).toBe(true);
      const discoveredEvaluator = document.extensions
        .find((candidate) => candidate.extensionUri === manifest.extensionUri)
        ?.evaluators.find((candidate) => candidate.evaluatorUri === EVALUATOR_URI);
      expect(discoveredEvaluator).toMatchObject({
        evaluatorVersion: 1,
        implementationDigest: IMPLEMENTATION_DIGEST,
        conditionTypeUri: CONDITION_URI,
        acceptedObservationTypes: [{ typeUri: OBSERVATION_URI, schemaVersion: 1 }],
      });
      const runtimeInput = {
        document,
        schemas,
        adapterManifest: TASQ_PROTOCOL_ADAPTER_MANIFEST,
      };

      for (const fixture of [
        "unfamiliar-runtime-common.ts",
        "unfamiliar-mcp-runtime.ts",
        "unfamiliar-a2a-runtime.ts",
      ]) {
        const source = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8").toLowerCase();
        expect(source).not.toContain("@kami/");
        expect(source).not.toContain("kinetic");
      }
      const mcpSource = readFileSync(new URL("./fixtures/unfamiliar-mcp-runtime.ts", import.meta.url), "utf8");
      const a2aSource = readFileSync(new URL("./fixtures/unfamiliar-a2a-runtime.ts", import.meta.url), "utf8");
      expect(mcpSource.toLowerCase()).not.toContain("a2a");
      expect(a2aSource.toLowerCase()).not.toContain("mcp");

      clock.set(1_500);
      const commitment = await createCommitment(db, {
        title: "Verify a typed physical measurement",
        successCriteria: "A discovered evaluator accepts a digest-bound runtime artifact",
        completionPolicy: "evidence",
      }, {
        workspaceId: "gwendall",
        actor: "runtime:coordinator",
        principalId: coordinator.id,
        idempotencyKey: "universal-commitment",
        clock,
      });

      const conditionPacket = {
        typeUri: CONDITION_URI,
        schemaVersion: 1,
        payload: { station: "bay-7", targetMicrons: 1_200, toleranceMicrons: 25 },
      };
      const observationPacket = {
        typeUri: OBSERVATION_URI,
        schemaVersion: 1,
        payload: { station: "bay-7", measuredMicrons: 1_212 },
      };
      const planInput = {
        ...runtimeInput,
        phase: "plan",
        taskId: "remote-plan-1",
        startedAt: "1970-01-01T00:00:01.500Z",
        completedAt: "1970-01-01T00:00:01.600Z",
        packet: conditionPacket,
        requestedOutput: { typeUri: OBSERVATION_URI, schemaVersion: 1 },
      };
      await expect(runFixture("unfamiliar-mcp-runtime.ts", {
        ...planInput,
        adapterManifest: { ...TASQ_PROTOCOL_ADAPTER_MANIFEST, completionAuthority: "commitment" },
      })).rejects.toThrow(/unexpectedly has commitment authority/);
      const planned = await runFixture("unfamiliar-mcp-runtime.ts", planInput);
      expect(negotiateOnboarding(document, planned.hello).status).toBe("compatible");
      clock.set(1_600);
      const planExecution = await syncMcpTask(db, commitment.id, planned.task, {
        remoteSystem: "https://runtime-one.example.test",
        actor: "runtime:coordinator",
        principalId: coordinator.id,
        clock,
      });
      expect(planExecution.attempt.status).toBe("succeeded");
      expect((await getCommitment(db, commitment.id, "gwendall"))?.status).toBe("open");

      clock.set(1_700);
      const assignment = await proposeAssignment(db, {
        taskId: commitment.id,
        assignerPrincipalId: coordinator.id,
        assigneePrincipalId: worker.id,
        role: "contributor",
        instructionsRef: planExecution.artifacts[0]!.uri,
      }, {
        actor: "runtime:coordinator",
        principalId: coordinator.id,
        idempotencyKey: "universal-assignment",
        clock,
      });
      const workerStart = await runFixture("unfamiliar-a2a-runtime.ts", {
        ...runtimeInput,
        phase: "start",
        assignment,
        packet: observationPacket,
        taskId: "remote-work-1",
        contextId: "shared-context-1",
        occurredAt: "1970-01-01T00:00:01.800Z",
      });
      expect(negotiateOnboarding(document, workerStart.hello).status).toBe("compatible");
      expect(workerStart.acceptAssignment).toBe(true);
      clock.set(1_800);
      await acceptAssignment(db, assignment.id, {
        actor: "runtime:worker",
        principalId: worker.id,
        expectedRevision: assignment.revision,
        clock,
      });
      clock.set(1_900);
      const claim = await acquireTaskClaim(db, commitment.id, {
        actor: "runtime:worker",
        principalId: worker.id,
        leaseMs: 100_000,
        idempotencyKey: "universal-claim",
        clock,
      });
      const working = await syncA2ATask(db, commitment.id, workerStart.task, {
        remoteSystem: "https://runtime-two.example.test",
        actor: "runtime:worker",
        principalId: worker.id,
        claimId: claim.id,
        clock,
      });
      expect(working.attempt.status).toBe("running");

      // The worker process disappears. Only negotiated identities and an exclusive cursor survive.
      const workerSeen = await listEvents(db, { ascending: true });
      const workerCursor = lastSequence(workerSeen);
      clock.set(2_000);
      const started = await startCommitment(db, commitment.id, {
        workspaceId: "gwendall",
        actor: "runtime:coordinator",
        principalId: coordinator.id,
        expectedRevision: commitment.revision,
        clock,
      });
      const workerDelta = await listEvents(db, { afterSequence: workerCursor, ascending: true });
      expect(workerDelta.map((event) => event.sequence)).toEqual([workerCursor + 1]);

      const resumedWorker = await runFixture("unfamiliar-a2a-runtime.ts", {
        ...runtimeInput,
        phase: "resume",
        afterSequence: workerCursor,
        events: workerDelta,
        packet: observationPacket,
        taskId: "remote-work-1",
        contextId: "shared-context-1",
        artifactId: "typed-sample-1",
        occurredAt: "1970-01-01T00:00:02.100Z",
      });
      expect(resumedWorker.resumeSequence).toBe(workerCursor + 1);
      clock.set(2_100);
      const completed = await syncA2ATask(db, commitment.id, resumedWorker.task, {
        remoteSystem: "https://runtime-two.example.test",
        actor: "runtime:worker",
        principalId: worker.id,
        claimId: claim.id,
        clock,
      });
      expect(completed.attempt.status).toBe("succeeded");
      expect(await listTaskEvidence(db, commitment.id)).toHaveLength(0);
      expect(await listCompletionRecords(db, commitment.id)).toHaveLength(0);

      const condition = runtimeRegistry.condition(CONDITION_URI, 1).parse(conditionPacket.payload);
      const observation = runtimeRegistry.observation(OBSERVATION_URI, 1).parse(observationPacket.payload);
      const evaluation = runtimeRegistry.evaluator(EVALUATOR_URI, 1).evaluate(condition, observation);
      expect(evaluation).toMatchObject({ decision: "matched", reasonCode: "pose_within_window" });

      // The coordinator also restarts and resumes only from its saved cursor.
      const coordinatorCursor = workerCursor;
      const coordinatorDelta = await listEvents(db, { afterSequence: coordinatorCursor, ascending: true });
      const reviewed = await runFixture("unfamiliar-mcp-runtime.ts", {
        ...runtimeInput,
        phase: "review",
        afterSequence: coordinatorCursor,
        events: coordinatorDelta,
        evaluation,
        artifact: completed.artifacts[0],
      });
      expect(reviewed).toMatchObject({
        approveEvidence: true,
        artifactId: completed.artifacts[0]!.id,
        artifactDigest: completed.artifacts[0]!.digest,
      });

      clock.set(2_200);
      const evidence = await addTaskEvidence(db, {
        taskId: commitment.id,
        attemptId: completed.attempt.id,
        kind: "extension_evaluator_match",
        summary: `${EVALUATOR_URI}@1 accepted the discovered typed output`,
        uri: completed.artifacts[0]!.uri,
        digest: completed.artifacts[0]!.digest,
        source: "https://runtime-two.example.test",
        observedAt: 2_100,
        metadata: { evaluatorUri: EVALUATOR_URI, evaluatorVersion: 1, reasonCode: evaluation.reasonCode },
      }, {
        actor: "runtime:coordinator",
        principalId: coordinator.id,
        idempotencyKey: "universal-evidence",
        clock,
      });
      clock.set(2_300);
      const done = await completeCommitment(db, commitment.id, {
        workspaceId: "gwendall",
        actor: "runtime:coordinator",
        principalId: coordinator.id,
        expectedRevision: started.revision,
        evidenceIds: [evidence.id],
        occurredAt: 2_300,
        clock,
      });
      expect(done.status).toBe("done");

      const replay = await syncA2ATask(db, commitment.id, resumedWorker.task, {
        remoteSystem: "https://runtime-two.example.test",
        actor: "runtime:worker",
        principalId: worker.id,
        claimId: claim.id,
        clock,
      });
      expect(replay.attempt.id).toBe(completed.attempt.id);
      expect(replay.artifacts[0]?.id).toBe(completed.artifacts[0]?.id);
      expect(await listTaskAttempts(db, commitment.id)).toHaveLength(2);
      expect(await listArtifacts(db, { taskId: commitment.id })).toHaveLength(2);
      expect(await listAssignments(db, { taskId: commitment.id })).toHaveLength(1);
      expect(await listCompletionRecords(db, commitment.id)).toHaveLength(1);
      const inspection = await inspectCommitment(db, commitment.id, { workspaceId: "gwendall", clock });
      expect(inspection?.resumeCursor.afterEventSequence).toBeGreaterThan(reviewed.resumeSequence);
      expect(await schemaFingerprint(client)).toBe(pristineSchema);
    } finally {
      await close();
    }
  });
});
