import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  createCommitment,
  createPrincipal,
  createResolutionContract,
  getCommitment,
  listArtifacts,
  listTaskEvidence,
  openDb,
  runKernelMigrations,
  startTaskAttempt,
  updateCommitment,
} from "@tasq-run/core";
import { createMutableClock } from "@tasq-run/schema";
import {
  buildOutcomeBundle,
  finalizeCapture,
  freezeCaptureSession,
  signOutcomeBundle,
  verifyOutcomeBundleFreshness,
  verifySignedOutcomeBundle,
  type ImmutableObjectStore,
  type OutcomeOmission,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function sha(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

class MemoryStore implements ImmutableObjectStore {
  corrupt = false;
  objects = new Map<string, Uint8Array>();
  async put(input: { key: string; bytes: Uint8Array; mediaType: string }) {
    this.objects.set(input.key, input.bytes.slice());
    return {
      uri: `https://objects.example.test/${input.key}`,
      digest: this.corrupt ? `sha256:${"0".repeat(64)}` : sha(input.bytes),
      byteLength: input.bytes.byteLength,
    };
  }
}

async function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `tasq-capture-${name}-`));
  roots.push(root);
  const handle = await openDb({ url: `file:${join(root, "db.sqlite")}`, wal: false });
  await runKernelMigrations(handle.client, { now: 1_000 });
  const workspaceId = `capture/${name}`;
  const clock = createMutableClock(2_000);
  const worker = await createPrincipal(handle.db, {
    tenantId: workspaceId, displayName: "Evidence worker", kind: "runtime", localAlias: "worker",
  }, { tenantId: workspaceId, actor: "admin", clock });
  const task = await createCommitment(handle.db, {
    title: "Inspect an exact target", description: "Capture exact bytes.",
    successCriteria: "The target state is visible.", completionPolicy: "evidence", validationRequired: true,
  }, { workspaceId, actor: "admin", clock });
  const contract = await createResolutionContract(handle.db, {
    taskId: task.id,
    criteria: [{ id: "target-visible", statement: "The target state is visible.", acceptedEvidenceKinds: ["captured_outcome"] }],
    policyKind: "deterministic",
    policyUri: "https://example.test/policies/exact-capture",
    policyVersion: 1,
    implementationDigest: `sha256:${"a".repeat(64)}`,
  }, { tenantId: workspaceId, actor: "admin", principalId: worker.id, clock });
  const claim = await acquireTaskClaim(handle.db, task.id, {
    tenantId: workspaceId, actor: "worker", principalId: worker.id, clock, idempotencyKey: `${name}:claim`,
  });
  const attempt = await startTaskAttempt(handle.db, task.id, {
    tenantId: workspaceId, actor: "worker", principalId: worker.id, clock, claimId: claim.id,
    idempotencyKey: `${name}:attempt`,
  });
  const current = await getCommitment(handle.db, task.id, workspaceId);
  if (!current) throw new Error("fixture task disappeared");
  const session = freezeCaptureSession({
    workspaceId, commitmentId: task.id, commitmentRevision: current.revision,
    attemptId: attempt.id, resolutionContractId: contract.id, criterionId: "target-visible",
    target: { typeUri: "https://example.test/targets/device", reference: "device:42", digest: `sha256:${"b".repeat(64)}` },
    source: { kind: "device_camera", reference: "camera:worker-phone" },
    bounds: { acceptedMediaTypes: ["image/jpeg"], maximumBytes: 1_000_000 },
    openedAt: 2_000, expiresAt: 20_000,
  });
  return { ...handle, workspaceId, worker, task: current, contract, attempt, clock, session };
}

const disclosure = {
  redactions: [{ method: "blur", scope: "bystander faces", reason: "privacy" }],
  original: { disposition: "never_stored" as const, reference: null },
  retention: { policyUri: "https://example.test/retention/30d", retainUntil: 2_592_005_000 },
  deletion: { policyUri: "https://example.test/deletion/on-expiry", status: "scheduled" as const, effectiveAt: 2_592_005_000 },
};

const omissions: OutcomeOmission[] = [
  { category: "authority", reasonCode: "not_exported", explanation: "Authority is held in an external access system." },
  { category: "custody", reasonCode: "not_applicable", explanation: "No physical custody transfer occurred." },
  { category: "raw_bytes", reasonCode: "content_addressed_uri_only", explanation: "The export carries the immutable URI and digest, not media bytes." },
];

async function capture(f: Awaited<ReturnType<typeof fixture>>, store = new MemoryStore(), key = "capture:one") {
  return finalizeCapture({
    db: f.db, session: f.session, bytes: Buffer.from("exact-image-bytes"), mediaType: "image/jpeg",
    name: "Device 42 state", observedAt: 4_000, disclosure, store,
    actor: "worker", principalId: f.worker.id, idempotencyKey: key, now: 5_000,
  });
}

describe("evidence capture", () => {
  test("binds exact bytes, source time, attempt, target and criterion and replays without duplicates", async () => {
    const f = await fixture("exact");
    const first = await capture(f);
    const replay = await capture(f);
    expect(first.ok).toBeTrue();
    expect(replay).toEqual(first);
    expect(await listArtifacts(f.db, { tenantId: f.workspaceId, taskId: f.task.id })).toHaveLength(1);
    const evidence = await listTaskEvidence(f.db, f.task.id, { tenantId: f.workspaceId });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.metadata.captureBinding).toMatchObject({
      attemptId: f.attempt.id,
      target: f.session.target,
      resolution: { contractId: f.contract.id, criterionId: "target-visible" },
      disclosure,
    });
  });

  test("rejects store integrity mismatch before ledger mutation", async () => {
    const f = await fixture("store-mismatch");
    const store = new MemoryStore();
    store.corrupt = true;
    const result = await capture(f, store);
    expect(result).toMatchObject({ ok: false, failure: { code: "storage_integrity_mismatch", stage: "storage" } });
    expect(await listArtifacts(f.db, { tenantId: f.workspaceId, taskId: f.task.id })).toHaveLength(0);
    expect(await listTaskEvidence(f.db, f.task.id, { tenantId: f.workspaceId })).toHaveLength(0);
  });

  test("rolls back artifact when a late evidence database write fails", async () => {
    const f = await fixture("rollback");
    await f.client.execute("CREATE TRIGGER reject_test_evidence BEFORE INSERT ON task_evidence BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
    const result = await capture(f);
    expect(result).toMatchObject({ ok: false, failure: { code: "ledger_rejected", stage: "ledger" } });
    expect(await listArtifacts(f.db, { tenantId: f.workspaceId, taskId: f.task.id })).toHaveLength(0);
  });

  test("rejects stale commitment, target, criterion and session bindings", async () => {
    const f = await fixture("stale");
    await updateCommitment(f.db, f.task.id, { description: "changed" }, {
      workspaceId: f.workspaceId, actor: "admin", expectedRevision: f.task.revision, clock: f.clock,
    });
    expect(await capture(f)).toMatchObject({ ok: false, failure: { code: "ledger_rejected" } });
    const tampered = { ...f.session, criterionId: "other" };
    expect(await finalizeCapture({
      db: f.db, session: tampered, bytes: Buffer.from("x"), mediaType: "image/jpeg", name: "x",
      observedAt: 4_000, disclosure, store: new MemoryStore(), actor: "worker", principalId: f.worker.id,
      idempotencyKey: "tampered", now: 5_000,
    })).toMatchObject({ ok: false, failure: { stage: "validation" } });
  });
});

describe("outcome bundles", () => {
  test("exports stable exact references, required omissions, and detects stale or missing records", async () => {
    const f = await fixture("bundle");
    expect((await capture(f)).ok).toBeTrue();
    const bundle = await buildOutcomeBundle({ db: f.db, workspaceId: f.workspaceId, commitmentId: f.task.id, generatedAt: 6_000, omissions });
    const replay = await buildOutcomeBundle({ db: f.db, workspaceId: f.workspaceId, commitmentId: f.task.id, generatedAt: 6_000, omissions });
    expect(replay).toEqual(bundle);
    expect(bundle.records.map(({ recordType }) => recordType)).toContain("commitment");
    expect(bundle.records.map(({ recordType }) => recordType)).toContain("attempt");
    expect(bundle.records.map(({ recordType }) => recordType)).toContain("evidence");
    expect(bundle.records.map(({ recordType }) => recordType)).toContain("resolution_contract");
    expect(await verifyOutcomeBundleFreshness(f.db, bundle)).toMatchObject({ outcome: "current" });
    const current = await getCommitment(f.db, f.task.id, f.workspaceId);
    await updateCommitment(f.db, f.task.id, { description: "new revision" }, {
      workspaceId: f.workspaceId, actor: "admin", expectedRevision: current!.revision, clock: f.clock,
    });
    expect(await verifyOutcomeBundleFreshness(f.db, bundle)).toMatchObject({ outcome: "stale", stale: [{ recordType: "commitment", id: f.task.id }] });
    const artifact = bundle.records.find(({ recordType }) => recordType === "artifact")!;
    // Corrupt only this disposable database to prove the verifier distinguishes absence.
    await f.client.execute("DROP TRIGGER artifact_no_delete");
    await f.client.execute({ sql: "DELETE FROM artifact WHERE id = ?", args: [artifact.id] });
    expect(await verifyOutcomeBundleFreshness(f.db, bundle)).toMatchObject({ outcome: "missing", missing: [{ recordType: "artifact", id: artifact.id }] });
  });

  test("requires authority, custody and raw-byte disclosure", async () => {
    const f = await fixture("omissions");
    await expect(buildOutcomeBundle({
      db: f.db, workspaceId: f.workspaceId, commitmentId: f.task.id, generatedAt: 6_000,
    })).rejects.toThrow("authority reference or omission");
  });

  test("signature authenticates canonical bundle bytes only", async () => {
    const f = await fixture("signature");
    const bundle = await buildOutcomeBundle({ db: f.db, workspaceId: f.workspaceId, commitmentId: f.task.id, generatedAt: 6_000, omissions });
    const keys = generateKeyPairSync("ed25519");
    const envelope = await signOutcomeBundle(bundle, { keyId: "test-key", sign: (bytes) => sign(null, bytes, keys.privateKey) });
    expect(envelope.assurance).toBe("signature_authenticates_exact_bundle_bytes_not_real_world_truth");
    expect(await verifySignedOutcomeBundle({
      envelope, verify: (_keyId, bytes, signature) => verify(null, bytes, keys.publicKey, signature),
    })).toMatchObject({ outcome: "valid", reasonCode: "exact_bundle_bytes_authenticated", bundle });
    const corrupted = { ...envelope, payload: `${envelope.payload.slice(0, -1)}A` };
    expect(await verifySignedOutcomeBundle({
      envelope: corrupted, verify: (_keyId, bytes, signature) => verify(null, bytes, keys.publicKey, signature),
    })).toMatchObject({ outcome: "invalid" });
  });
});
