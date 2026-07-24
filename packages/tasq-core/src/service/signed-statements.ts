/** Append-only signed proof acceptance. Verification is host-injected; signatures are never authority by themselves. */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AcceptedSigningCredentialSnapshotV1,
  SignatureVerificationRecordV1,
  SignedStatementBinding as SignedStatementBindingZ,
  SignedStatementBundleV1,
  SignedStatementPayloadV1,
  StoredSignedStatement as StoredSignedStatementZ,
  acceptedSigningCredentialSnapshot,
  artifact,
  canonicalizeEffectJson,
  completionProposal,
  effectApproval,
  replicationAccepted,
  signatureVerificationRecord,
  signedStatement,
  signedStatementBinding,
  signedStatementNonce,
  workspaceCheckpoint,
  uuidv7,
  type Metadata,
  type AcceptedSigningCredentialSnapshotV1 as CredentialSnapshot,
  type SignatureVerificationRecordV1 as VerificationRecord,
  type SignedStatementBinding,
  type SignedStatementBundleV1 as Bundle,
  type SignedStatementPayloadV1 as Payload,
  type StoredSignedStatement,
  type SigningCredentialV1 as Credential,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import type { ServiceContext } from "./context.js";

export const SIGNED_STATEMENT_PURPOSES = Object.freeze({
  artifact_authorship: "https://schemas.tasq.dev/purposes/artifact-authorship/v1",
  artifact_acceptance: "https://schemas.tasq.dev/purposes/artifact-acceptance/v1",
  completion_attestation: "https://schemas.tasq.dev/purposes/completion-attestation/v1",
  effect_approval: "https://schemas.tasq.dev/purposes/effect-approval/v1",
  replication_operation_origin: "https://schemas.tasq.dev/purposes/replication-operation-origin/v1",
  workspace_checkpoint: "https://schemas.tasq.dev/purposes/workspace-checkpoint/v1",
} as const);

export interface VerifiedStatementProof {
  outcome: "valid" | "invalid" | "indeterminate";
  reasonCode: string;
  payload: Payload | null;
  statementDigest: `sha256:${string}` | null;
  bundleDigest: `sha256:${string}`;
  credential: Credential | null;
  verifierImplementationDigest: `sha256:${string}`;
}
export interface SignedStatementBinderInput {
  bindingKind: keyof typeof SIGNED_STATEMENT_PURPOSES;
  recordType: string;
  recordId: string;
  recordDigest: `sha256:${string}`;
  metadata?: Metadata;
}
export interface AcceptSignedStatementInput {
  bundle: Bundle;
  expectedAudience: string;
  acceptedTrustRootDigests?: readonly string[];
  binding: SignedStatementBinderInput;
  verify(input: {
    bundle: Bundle;
    expectedWorkspaceId: string;
    expectedAudience: string;
    acceptanceTime: string;
    acceptedTrustRootDigests?: readonly string[];
  }): Promise<VerifiedStatementProof>;
}
function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalizeEffectJson(value as never),
  ).digest("hex")}`;
}
function parseStatement(row: typeof signedStatement.$inferSelect): StoredSignedStatement {
  return StoredSignedStatementZ.parse({
    statementId: row.statementId, tenantId: row.tenantId,
    issuerPrincipalId: row.issuerPrincipalId, credentialId: row.credentialId,
    purposeUri: row.purposeUri, purposeVersion: row.purposeVersion,
    subjectTypeUri: row.subjectTypeUri, subjectId: row.subjectId,
    subjectDigest: row.subjectDigest, payload: JSON.parse(row.payloadJson),
    payloadDigest: row.payloadDigest, bundle: JSON.parse(row.bundleJson),
    bundleDigest: row.bundleDigest, acceptedAt: row.acceptedAt,
  });
}
function parseBinding(row: typeof signedStatementBinding.$inferSelect): SignedStatementBinding {
  return SignedStatementBindingZ.parse({
    id: row.id, tenantId: row.tenantId, statementId: row.statementId,
    verificationId: row.verificationId, bindingKind: row.bindingKind,
    recordType: row.recordType, recordId: row.recordId,
    recordDigest: row.recordDigest, createdByPrincipalId: row.createdByPrincipalId,
    createdAt: row.createdAt, metadata: JSON.parse(row.metadataJson),
  });
}
function parseVerification(
  row: typeof signatureVerificationRecord.$inferSelect,
): VerificationRecord {
  return SignatureVerificationRecordV1.parse({
    id: row.id,
    workspaceId: row.tenantId,
    statementId: row.statementId,
    statementDigest: row.statementDigest,
    bundleDigest: row.bundleDigest,
    credentialId: row.credentialId,
    credentialRevision: row.credentialRevision,
    credentialDigest: row.credentialDigest,
    principalId: row.principalId,
    trustRootDigest: row.trustRootDigest,
    profileUri: row.profileUri,
    profileVersion: row.profileVersion,
    verifierImplementationDigest: row.verifierImplementationDigest,
    verifiedAt: new Date(row.verifiedAt).toISOString(),
    credentialStateAtVerification: row.credentialStateAtVerification,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    supportingProofDigests: JSON.parse(row.supportingProofDigestsJson),
  });
}
function parseCredentialSnapshot(
  row: typeof acceptedSigningCredentialSnapshot.$inferSelect,
): CredentialSnapshot {
  return AcceptedSigningCredentialSnapshotV1.parse({
    contractVersion: "tasq.accepted-signing-credential-snapshot.v1",
    workspaceId: row.tenantId,
    credential: {
      credentialId: row.credentialId,
      workspaceId: row.tenantId,
      principalId: row.principalId,
      profileUri: row.profileUri,
      profileVersion: row.profileVersion,
      publicMaterial: JSON.parse(row.publicMaterialJson),
      publicMaterialDigest: row.publicMaterialDigest,
      trustRootDigest: row.trustRootDigest,
      isolationClass: row.isolationClass,
      status: row.statusAtAcceptance,
      revision: row.credentialRevision,
      validFrom: row.validFrom,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(row.replacesCredentialId
        ? { replacesCredentialId: row.replacesCredentialId }
        : {}),
      enrollmentMethod: row.enrollmentMethod,
      enrollmentEvidenceDigest: row.enrollmentEvidenceDigest,
    },
    credentialDigest: row.credentialDigest,
    capturedAt: row.capturedAt,
  });
}
async function assertTypedTarget(
  tx: TasqDbOrTx, tenantId: string, payload: Payload, binding: SignedStatementBinderInput,
): Promise<void> {
  if (payload.purpose.uri !== SIGNED_STATEMENT_PURPOSES[binding.bindingKind]) {
    throw new Error("signed statement purpose does not match typed binder");
  }
  if (payload.subject.digest !== binding.recordDigest) throw new Error("signed statement subject digest does not match bound record");
  if (binding.bindingKind === "artifact_authorship" || binding.bindingKind === "artifact_acceptance") {
    if (binding.recordType !== "artifact" || payload.subject.id !== binding.recordId) throw new Error("artifact statement binding identity mismatch");
    const rows = await tx.select().from(artifact).where(and(eq(artifact.tenantId, tenantId), eq(artifact.id, binding.recordId))).limit(1);
    if (!rows[0] || rows[0].digest !== binding.recordDigest) throw new Error("bound artifact digest not found");
    return;
  }
  if (binding.bindingKind === "completion_attestation") {
    if (binding.recordType !== "completion_proposal" || payload.subject.id !== binding.recordId) throw new Error("completion statement binding identity mismatch");
    const rows = await tx.select().from(completionProposal).where(and(eq(completionProposal.tenantId, tenantId), eq(completionProposal.id, binding.recordId))).limit(1);
    if (!rows[0] || rows[0].proposalDigest !== binding.recordDigest) throw new Error("bound proposal digest not found");
    return;
  }
  if (binding.bindingKind === "effect_approval") {
    if (binding.recordType !== "effect_approval") throw new Error("effect statement record type mismatch");
    const rows = await tx.select().from(effectApproval).where(and(eq(effectApproval.tenantId, tenantId), eq(effectApproval.id, binding.recordId))).limit(1);
    if (!rows[0] || payload.subject.id !== rows[0].effectId || rows[0].requestDigest !== binding.recordDigest) throw new Error("bound effect approval digest not found");
    return;
  }
  if (binding.bindingKind === "replication_operation_origin") {
    if (binding.recordType !== "replication_operation") throw new Error("replication statement record type mismatch");
    const rows = await tx.select().from(replicationAccepted).where(and(
      eq(replicationAccepted.workspaceId, tenantId), eq(replicationAccepted.operationDigest, binding.recordId),
    )).limit(1);
    if (!rows[0] || payload.subject.id !== binding.recordId || binding.recordDigest !== rows[0].operationDigest) throw new Error("bound replication operation not found");
    return;
  }
  if (binding.bindingKind === "workspace_checkpoint") {
    if (binding.recordType !== "workspace_checkpoint" || payload.subject.id !== binding.recordId) {
      throw new Error("workspace checkpoint binding identity mismatch");
    }
    const rows = await tx.select().from(workspaceCheckpoint).where(and(
      eq(workspaceCheckpoint.tenantId, tenantId),
      eq(workspaceCheckpoint.id, binding.recordId),
    )).limit(1);
    if (!rows[0] || rows[0].rootDigest !== binding.recordDigest) {
      throw new Error("bound workspace checkpoint root not found");
    }
  }
}
export interface PreparedSignedStatementAcceptance {
  tenantId: string;
  acceptedAt: number;
  bundle: Bundle;
  proof: VerifiedStatementProof;
  payload: Payload;
  credential: Credential;
  statementDigest: `sha256:${string}`;
}

/**
 * Verify and freeze one acceptance candidate without mutating the ledger.
 * A trusted host may prepare a batch, then persist each candidate inside the
 * same domain transaction as its typed target.
 */
export async function prepareSignedStatementAcceptance(
  input: AcceptSignedStatementInput,
  ctx: ServiceContext = {},
): Promise<PreparedSignedStatementAcceptance> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const now = serviceNow(ctx, ctx.now);
  const bundle = SignedStatementBundleV1.parse(input.bundle);
  const proof = await input.verify({
    bundle, expectedWorkspaceId: tenantId, expectedAudience: input.expectedAudience,
    acceptanceTime: new Date(now).toISOString(),
    acceptedTrustRootDigests: input.acceptedTrustRootDigests,
  });
  if (proof.outcome !== "valid" || !proof.payload || !proof.credential || !proof.statementDigest) {
    throw new Error(`signed statement verification did not pass: ${proof.reasonCode}`);
  }
  const credential = proof.credential;
  const statementDigest = proof.statementDigest;
  const payload = SignedStatementPayloadV1.parse(proof.payload);
  if (payload.workspaceId !== tenantId || payload.credentialId !== credential.credentialId ||
    payload.issuerPrincipalId !== credential.principalId ||
    credential.workspaceId !== tenantId || credential.status !== "active") {
    throw new Error("verified statement credential binding mismatch");
  }
  if (proof.bundleDigest !== sha(bundle)) throw new Error("verified bundle digest mismatch");
  return {
    tenantId,
    acceptedAt: now,
    bundle,
    proof,
    payload,
    credential,
    statementDigest,
  };
}

/** Persist a prepared proof and its typed binding inside the caller's transaction. */
export async function persistPreparedSignedStatementAcceptance(
  tx: TasqDbOrTx,
  prepared: PreparedSignedStatementAcceptance,
  bindingInput: SignedStatementBinderInput,
): Promise<{
  statement: StoredSignedStatement;
  verification: VerificationRecord;
  binding: SignedStatementBinding;
}> {
  const {
    tenantId,
    acceptedAt: now,
    bundle,
    proof,
    payload,
    credential,
    statementDigest,
  } = prepared;
  await assertTypedTarget(tx, tenantId, payload, bindingInput);
  const priorRows = await tx.select().from(signedStatement)
    .where(eq(signedStatement.statementId, payload.statementId)).limit(1);
  if (priorRows[0]) {
    const prior = parseStatement(priorRows[0]);
    if (prior.payloadDigest !== statementDigest || prior.bundleDigest !== proof.bundleDigest) {
      throw new Error("statement identity reused with different signed bytes");
    }
    const verificationRows = await tx.select().from(signatureVerificationRecord).where(and(
      eq(signatureVerificationRecord.tenantId, tenantId),
      eq(signatureVerificationRecord.statementId, payload.statementId),
    )).orderBy(asc(signatureVerificationRecord.verifiedAt)).limit(1);
    const bindingRows = await tx.select().from(signedStatementBinding).where(and(
      eq(signedStatementBinding.tenantId, tenantId),
      eq(signedStatementBinding.statementId, payload.statementId),
    )).orderBy(asc(signedStatementBinding.createdAt)).limit(1);
    if (!verificationRows[0] || !bindingRows[0]) {
      throw new Error("signed statement acceptance is incomplete");
    }
    return {
      statement: prior,
      verification: parseVerification(verificationRows[0]),
      binding: parseBinding(bindingRows[0]),
    };
  }
  await tx.insert(signedStatement).values({
    statementId: payload.statementId,
    tenantId,
    issuerPrincipalId: payload.issuerPrincipalId,
    credentialId: payload.credentialId,
    purposeUri: payload.purpose.uri,
    purposeVersion: payload.purpose.version,
    subjectTypeUri: payload.subject.typeUri,
    subjectId: payload.subject.id,
    subjectDigest: payload.subject.digest,
    payloadJson: canonicalizeEffectJson(payload as never),
    payloadDigest: statementDigest,
    bundleJson: canonicalizeEffectJson(bundle as never),
    bundleDigest: proof.bundleDigest,
    acceptedAt: now,
  });
  const credentialDigest = sha(credential);
  const snapshotRows = await tx.select().from(acceptedSigningCredentialSnapshot).where(and(
    eq(acceptedSigningCredentialSnapshot.tenantId, tenantId),
    eq(acceptedSigningCredentialSnapshot.credentialId, credential.credentialId),
    eq(acceptedSigningCredentialSnapshot.credentialRevision, credential.revision),
  )).limit(1);
  if (snapshotRows[0]) {
    if (snapshotRows[0].credentialDigest !== credentialDigest) {
      throw new Error("accepted credential revision reused with different public state");
    }
  } else {
    await tx.insert(acceptedSigningCredentialSnapshot).values({
      tenantId,
      credentialId: credential.credentialId,
      credentialRevision: credential.revision,
      principalId: credential.principalId,
      profileUri: credential.profileUri,
      profileVersion: credential.profileVersion,
      publicMaterialJson: canonicalizeEffectJson(credential.publicMaterial as never),
      publicMaterialDigest: credential.publicMaterialDigest,
      trustRootDigest: credential.trustRootDigest,
      isolationClass: credential.isolationClass,
      statusAtAcceptance: credential.status,
      validFrom: credential.validFrom,
      expiresAt: credential.expiresAt ?? null,
      replacesCredentialId: credential.replacesCredentialId ?? null,
      enrollmentMethod: credential.enrollmentMethod,
      enrollmentEvidenceDigest: credential.enrollmentEvidenceDigest,
      credentialDigest,
      capturedAt: now,
    });
  }
  await tx.insert(signedStatementNonce).values({
    tenantId,
    purposeUri: payload.purpose.uri,
    nonce: payload.nonce,
    statementId: payload.statementId,
    consumedAt: now,
  });
  const verificationId = uuidv7(now);
  await tx.insert(signatureVerificationRecord).values({
    id: verificationId,
    tenantId,
    statementId: payload.statementId,
    statementDigest,
    bundleDigest: proof.bundleDigest,
    credentialId: credential.credentialId,
    credentialRevision: credential.revision,
    credentialDigest,
    principalId: credential.principalId,
    trustRootDigest: credential.trustRootDigest,
    profileUri: credential.profileUri,
    profileVersion: credential.profileVersion,
    verifierImplementationDigest: proof.verifierImplementationDigest,
    verifiedAt: now,
    credentialStateAtVerification: credential.status,
    outcome: "valid",
    reasonCode: proof.reasonCode,
    supportingProofDigestsJson: "[]",
  });
  const bindingId = uuidv7(now + 1);
  await tx.insert(signedStatementBinding).values({
    id: bindingId,
    tenantId,
    statementId: payload.statementId,
    verificationId,
    bindingKind: bindingInput.bindingKind,
    recordType: bindingInput.recordType,
    recordId: bindingInput.recordId,
    recordDigest: bindingInput.recordDigest,
    createdByPrincipalId: credential.principalId,
    createdAt: now,
    metadataJson: canonicalizeEffectJson((bindingInput.metadata ?? {}) as never),
  });
  const statement = await getSignedStatement(tx, payload.statementId, tenantId);
  const binding = await getSignedStatementBinding(tx, bindingId, tenantId);
  if (!statement || !binding) throw new Error("failed to read signed statement acceptance");
  return {
    statement,
    verification: SignatureVerificationRecordV1.parse({
      id: verificationId,
      workspaceId: tenantId,
      statementId: payload.statementId,
      statementDigest,
      bundleDigest: proof.bundleDigest,
      credentialId: credential.credentialId,
      credentialRevision: credential.revision,
      credentialDigest,
      principalId: credential.principalId,
      trustRootDigest: credential.trustRootDigest,
      profileUri: credential.profileUri,
      profileVersion: credential.profileVersion,
      verifierImplementationDigest: proof.verifierImplementationDigest,
      verifiedAt: new Date(now).toISOString(),
      credentialStateAtVerification: "active",
      outcome: "valid",
      reasonCode: proof.reasonCode,
      supportingProofDigests: [],
    }),
    binding,
  };
}

export async function acceptSignedStatement(
  db: TasqDb,
  input: AcceptSignedStatementInput,
  ctx: ServiceContext = {},
): Promise<{
  statement: StoredSignedStatement;
  verification: VerificationRecord;
  binding: SignedStatementBinding;
}> {
  const prepared = await prepareSignedStatementAcceptance(input, ctx);
  return runInTransaction(db, (tx) =>
    persistPreparedSignedStatementAcceptance(tx, prepared, input.binding));
}
export async function getSignedStatement(db: TasqDbOrTx, statementId: string, tenantId = "gwendall") {
  const rows = await db.select().from(signedStatement).where(and(
    eq(signedStatement.tenantId, tenantId), eq(signedStatement.statementId, statementId),
  )).limit(1);
  return rows[0] ? parseStatement(rows[0]) : null;
}
export async function getSignedStatementBinding(db: TasqDbOrTx, id: string, tenantId = "gwendall") {
  const rows = await db.select().from(signedStatementBinding).where(and(
    eq(signedStatementBinding.tenantId, tenantId), eq(signedStatementBinding.id, id),
  )).limit(1);
  return rows[0] ? parseBinding(rows[0]) : null;
}
export async function listSignedStatementBindings(
  db: TasqDbOrTx, input: {
    tenantId?: string;
    recordType?: string;
    recordId?: string;
    statementId?: string;
  } = {},
) {
  const filters = [eq(signedStatementBinding.tenantId, input.tenantId ?? "gwendall")];
  if (input.recordType) filters.push(eq(signedStatementBinding.recordType, input.recordType));
  if (input.recordId) filters.push(eq(signedStatementBinding.recordId, input.recordId));
  if (input.statementId) filters.push(eq(signedStatementBinding.statementId, input.statementId));
  return (await db.select().from(signedStatementBinding).where(and(...filters))
    .orderBy(asc(signedStatementBinding.createdAt))).map(parseBinding);
}

/** Exact accepted proof, including the frozen verification context and every typed binding. */
export async function getSignedStatementProof(
  db: TasqDbOrTx,
  statementId: string,
  tenantId = "gwendall",
): Promise<{
  statement: StoredSignedStatement;
  credentialSnapshot: CredentialSnapshot;
  verifications: VerificationRecord[];
  bindings: SignedStatementBinding[];
  assurance: {
    signature: "valid_at_acceptance";
    currentCredentialState: "not_asserted_by_workspace_store";
    semanticTruth: "not_asserted_by_signature";
    authorization: "not_granted_by_signature";
  };
} | null> {
  const statement = await getSignedStatement(db, statementId, tenantId);
  if (!statement) return null;
  const verificationRows = await db.select().from(signatureVerificationRecord).where(and(
    eq(signatureVerificationRecord.tenantId, tenantId),
    eq(signatureVerificationRecord.statementId, statementId),
  )).orderBy(asc(signatureVerificationRecord.verifiedAt), asc(signatureVerificationRecord.id));
  if (verificationRows.length === 0) {
    throw new Error("signed statement is missing its accepted verification record");
  }
  const bindings = await listSignedStatementBindings(db, { tenantId, statementId });
  const snapshotRows = await db.select().from(acceptedSigningCredentialSnapshot).where(and(
    eq(acceptedSigningCredentialSnapshot.tenantId, tenantId),
    eq(acceptedSigningCredentialSnapshot.credentialId, statement.credentialId),
    inArray(
      acceptedSigningCredentialSnapshot.credentialRevision,
      verificationRows.map((row) => row.credentialRevision),
    ),
  )).orderBy(asc(acceptedSigningCredentialSnapshot.credentialRevision)).limit(1);
  if (!snapshotRows[0]) throw new Error("signed statement is missing its accepted public credential snapshot");
  return {
    statement,
    credentialSnapshot: parseCredentialSnapshot(snapshotRows[0]),
    verifications: verificationRows.map(parseVerification),
    bindings,
    assurance: {
      signature: "valid_at_acceptance",
      currentCredentialState: "not_asserted_by_workspace_store",
      semanticTruth: "not_asserted_by_signature",
      authorization: "not_granted_by_signature",
    },
  };
}
