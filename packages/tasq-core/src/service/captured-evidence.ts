/** Atomic append boundary for byte-bound evidence prepared by an external capture Module. */

import { ArtifactInsert, TaskEvidenceInsert, type Artifact, type Metadata, type TaskEvidence } from "@tasq-run/schema";
import type { TasqDb } from "../db.js";
import { runInTransaction } from "../db.js";
import { getCommitment } from "../commitments.js";
import type { ServiceContext } from "./context.js";
import { appendArtifact } from "./collaboration.js";
import { getTaskAttempt, addTaskEvidence } from "./agentic.js";
import { getResolutionContract } from "./resolution.js";

export interface RecordCapturedEvidenceInput {
  commitmentId: string;
  expectedCommitmentRevision: number;
  attemptId: string;
  resolutionContractId: string;
  criterionId: string;
  artifact: Omit<ArtifactInsert, "tenantId" | "taskId" | "attemptId">;
  evidence: Omit<TaskEvidenceInsert, "tenantId" | "taskId" | "attemptId">;
  bindingMetadata: Metadata;
  idempotencyKey: string;
}

export interface RecordCapturedEvidenceResult {
  artifact: Artifact;
  evidence: TaskEvidence;
}

/**
 * Validate the frozen capture binding and append both canonical records in one
 * database transaction. Upload/session state deliberately remains outside Core.
 */
export async function recordCapturedEvidence(
  db: TasqDb,
  input: RecordCapturedEvidenceInput,
  ctx: ServiceContext = {},
): Promise<RecordCapturedEvidenceResult> {
  const workspaceId = ctx.tenantId ?? "gwendall";
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("recordCapturedEvidence requires an idempotencyKey");
  if (!Number.isSafeInteger(input.expectedCommitmentRevision) || input.expectedCommitmentRevision < 1) {
    throw new Error("expectedCommitmentRevision must be a positive integer");
  }
  const artifactInput = ArtifactInsert.parse({
    ...input.artifact, tenantId: workspaceId, taskId: input.commitmentId, attemptId: input.attemptId,
    metadata: { ...input.artifact.metadata, captureBinding: input.bindingMetadata },
  });
  const evidenceInput = TaskEvidenceInsert.parse({
    ...input.evidence, tenantId: workspaceId, taskId: input.commitmentId, attemptId: input.attemptId,
    metadata: { ...input.evidence.metadata, captureBinding: input.bindingMetadata },
  });

  return runInTransaction(db, async (tx) => {
    const commitment = await getCommitment(tx, input.commitmentId, workspaceId);
    if (!commitment) throw new Error(`Commitment not found: ${input.commitmentId}`);
    if (commitment.revision !== input.expectedCommitmentRevision) {
      throw new Error(`Capture commitment revision is stale: expected ${input.expectedCommitmentRevision}, got ${commitment.revision}`);
    }
    const attempt = await getTaskAttempt(tx, input.attemptId, workspaceId);
    if (!attempt || attempt.taskId !== input.commitmentId) {
      throw new Error("Capture attempt does not belong to commitment");
    }
    const contract = await getResolutionContract(tx, input.resolutionContractId, workspaceId);
    if (!contract || contract.taskId !== input.commitmentId || contract.taskRevision !== input.expectedCommitmentRevision) {
      throw new Error("Capture resolution contract is absent, stale, or belongs to another commitment");
    }
    if (!contract.criteria.some((criterion) => criterion.id === input.criterionId)) {
      throw new Error(`Capture criterion is absent from resolution contract: ${input.criterionId}`);
    }
    const nestedDb = tx as unknown as TasqDb;
    const artifact = await appendArtifact(nestedDb, artifactInput, {
      ...ctx, tenantId: workspaceId, idempotencyKey: `${idempotencyKey}:artifact`,
    });
    const evidence = await addTaskEvidence(nestedDb, evidenceInput, {
      ...ctx, tenantId: workspaceId, idempotencyKey: `${idempotencyKey}:evidence`,
    });
    return { artifact, evidence };
  });
}
