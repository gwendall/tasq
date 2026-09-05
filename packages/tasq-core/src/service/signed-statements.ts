/** Append-only signed proof acceptance. Verification is host-injected; signatures are never authority by themselves. */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AcceptedSigningCredentialSnapshotV1,
  SignatureVerificationRecordV1,
  StatementBinderDescriptorV1,
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
  type StatementBinderDescriptorV1 as BinderDescriptor,
  type SignedStatementBundleV1 as Bundle,
  type SignedStatementPayloadV1 as Payload,
  type StoredSignedStatement,
  type SigningCredentialV1 as Credential,
  type Sha256Digest, LEGACY_DEFAULT_WORKSPACE_ID } from "@tasq-run/schema";
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

export interface StatementBinderAssertion {
  tx: TasqDbOrTx;
  workspaceId: string;
  payload: Payload;
  binding: SignedStatementBinderInput;
}

export interface TrustedStatementBinder {
  descriptor: BinderDescriptor;
  assertTarget(input: StatementBinderAssertion): Promise<void>;
  assertAuthority?(input: StatementBinderAssertion): Promise<void>;
}

const descriptorIdentity = (value: BinderDescriptor) =>
  `${value.binderUri}@${value.binderVersion}#${value.binderImplementationDigest}`;
const purposeIdentity = (value: BinderDescriptor) =>
  `${value.purposeUri}@${value.purposeVersion}`;

/**
 * Closed-over trusted executable binders paired with open, portable data
 * descriptors. Stores never supply code and duplicate identities fail closed.
 */
export class StatementBinderRegistry {
  readonly #byKind = new Map<string, TrustedStatementBinder>();
  readonly #byPurpose = new Map<string, TrustedStatementBinder>();
  readonly #byImplementation = new Map<string, TrustedStatementBinder>();

  constructor(binders: readonly TrustedStatementBinder[]) {
    for (const candidate of binders) {
      const parsed = StatementBinderDescriptorV1.parse(candidate.descriptor);
      const binder = { ...candidate, descriptor: parsed };
      if (parsed.onlineAuthorizationRequired && !binder.assertAuthority) {
        throw new Error(`binder ${parsed.bindingKind} requires an authority assertion`);
      }
      const kindConflict = this.#byKind.get(parsed.bindingKind);
      const purposeConflict = this.#byPurpose.get(purposeIdentity(parsed));
      const implementationConflict = this.#byImplementation.get(descriptorIdentity(parsed));
      if (kindConflict || purposeConflict || implementationConflict) {
        throw new Error(`conflicting statement binder registration: ${parsed.bindingKind}`);
      }
      this.#byKind.set(parsed.bindingKind, binder);
      this.#byPurpose.set(purposeIdentity(parsed), binder);
      this.#byImplementation.set(descriptorIdentity(parsed), binder);
    }
  }

  resolve(binding: SignedStatementBinderInput): TrustedStatementBinder {
    const binder = this.#byKind.get(binding.bindingKind);
    if (!binder) throw new Error(`unknown statement binder: ${binding.bindingKind}`);
    const expected = binding.expectedBinder;
    const isBuiltin = Object.hasOwn(BUILTIN_STATEMENT_BINDER_DESCRIPTORS, binding.bindingKind);
    if (!expected && !isBuiltin) {
      throw new Error(`custom statement binder must be pinned: ${binding.bindingKind}`);
    }
    if (expected && (
      expected.uri !== binder.descriptor.binderUri ||
      expected.version !== binder.descriptor.binderVersion ||
      expected.implementationDigest !== binder.descriptor.binderImplementationDigest
    )) {
      throw new Error(`stale statement binder pin: ${binding.bindingKind}`);
    }
    return binder;
  }

  descriptors(): BinderDescriptor[] {
    return [...this.#byKind.values()].map(({ descriptor: value }) => value);
  }
}

const descriptor = (
  bindingKind: keyof typeof SIGNED_STATEMENT_PURPOSES,
  recordType: string,
  subjectTypeUri: string,
  binderImplementationDigest: `sha256:${string}`,
): BinderDescriptor => StatementBinderDescriptorV1.parse({
  contractVersion: "tasq.statement-binder.v1",
  bindingKind,
  purposeUri: SIGNED_STATEMENT_PURPOSES[bindingKind],
  purposeVersion: 1,
  subjectTypeUri,
  allowedProfileUris: [],
  nonceMode: "unique",
  maximumAgeMs: null,
  expectedRevisionRequired: false,
  onlineAuthorizationRequired: false,
  binderUri: `https://schemas.tasq.dev/binders/${bindingKind.replaceAll("_", "-")}/v1`,
  binderVersion: 1,
  binderImplementationDigest,
  recordType,
});

export const BUILTIN_STATEMENT_BINDER_DESCRIPTORS = Object.freeze({
  artifact_authorship: descriptor(
    "artifact_authorship", "artifact", "https://schemas.tasq.dev/subjects/artifact/v1",
    "sha256:dd8c9cf781298b34919608b33ceb08cc9103ab3ad1a48c1be44e65eb70f425a5",
  ),
  artifact_acceptance: descriptor(
    "artifact_acceptance", "artifact", "https://schemas.tasq.dev/subjects/artifact/v1",
    "sha256:32b0e0599764f1eae7e85284a0fcf68ffd0eddf012d78ab2efb048a853ec5b73",
  ),
  completion_attestation: descriptor(
    "completion_attestation", "completion_proposal", "https://schemas.tasq.dev/subjects/completion-proposal/v1",
    "sha256:2c307cf49cafad16216b92cdae44dbc63cf147fea840ef1308999f050f4d90ae",
  ),
  effect_approval: descriptor(
    "effect_approval", "effect_approval", "https://schemas.tasq.dev/subjects/effect/v1",
    "sha256:839cd7d86cf0b156ac7b66647c37136a84a1c2fa2d5b37ff199f686a78443b9a",
  ),
  replication_operation_origin: descriptor(
    "replication_operation_origin", "replication_operation", "https://schemas.tasq.dev/subjects/replication-operation/v1",
    "sha256:aafde9467f270374a3b7ec9b95a18f0151711e0760e817c0e004113c6271ad44",
  ),
  workspace_checkpoint: descriptor(
    "workspace_checkpoint", "workspace_checkpoint", "https://schemas.tasq.dev/subjects/workspace-checkpoint/v1",
    "sha256:e80b9d76bc9e2d6d0dd1ee5a253cebb2fbb33bd2a1b0918a8bccc6c1735db92f",
  ),
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
/**
 * Digests here are `Sha256Digest`, not hand-rolled `sha256:${string}` template
 * literals. The schemas these mirror are regex-validated strings, so nothing
 * parsed from them could ever satisfy a template literal - it was a type no
 * producer in this codebase could produce, and every caller widened past it.
 */
export interface SignedStatementBinderInput {
  bindingKind: string;
  recordType: string;
  recordId: string;
  recordDigest: Sha256Digest;
  /** Pins non-built-in callers to the exact trusted host implementation. */
  expectedBinder?: {
    uri: string;
    version: number;
    implementationDigest: Sha256Digest;
  };
  metadata?: Metadata;
}
export interface AcceptSignedStatementInput {
  bundle: Bundle;
  expectedAudience: string;
  acceptedTrustRootDigests?: readonly string[];
  binding: SignedStatementBinderInput;
  binderRegistry?: StatementBinderRegistry;
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
    binderDescriptor: JSON.parse(row.binderDescriptorJson),
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
const artifactBinder = (kind: "artifact_authorship" | "artifact_acceptance"): TrustedStatementBinder => ({
  descriptor: BUILTIN_STATEMENT_BINDER_DESCRIPTORS[kind],
  async assertTarget({ tx, workspaceId, payload, binding }) {
    if (payload.subject.id !== binding.recordId) throw new Error("artifact statement binding identity mismatch");
    const rows = await tx.select().from(artifact).where(and(
      eq(artifact.tenantId, workspaceId), eq(artifact.id, binding.recordId),
    )).limit(1);
    if (!rows[0] || rows[0].digest !== binding.recordDigest) throw new Error("bound artifact digest not found");
  },
});

export const BUILTIN_STATEMENT_BINDERS: readonly TrustedStatementBinder[] = Object.freeze([
  artifactBinder("artifact_authorship"),
  artifactBinder("artifact_acceptance"),
  {
    descriptor: BUILTIN_STATEMENT_BINDER_DESCRIPTORS.completion_attestation,
    async assertTarget({ tx, workspaceId, payload, binding }) {
      if (payload.subject.id !== binding.recordId) throw new Error("completion statement binding identity mismatch");
      const rows = await tx.select().from(completionProposal).where(and(
        eq(completionProposal.tenantId, workspaceId), eq(completionProposal.id, binding.recordId),
      )).limit(1);
      if (!rows[0] || rows[0].proposalDigest !== binding.recordDigest) throw new Error("bound proposal digest not found");
    },
  },
  {
    descriptor: BUILTIN_STATEMENT_BINDER_DESCRIPTORS.effect_approval,
    async assertTarget({ tx, workspaceId, payload, binding }) {
      const rows = await tx.select().from(effectApproval).where(and(
        eq(effectApproval.tenantId, workspaceId), eq(effectApproval.id, binding.recordId),
      )).limit(1);
      if (!rows[0] || payload.subject.id !== rows[0].effectId || rows[0].requestDigest !== binding.recordDigest) {
        throw new Error("bound effect approval digest not found");
      }
    },
  },
  {
    descriptor: BUILTIN_STATEMENT_BINDER_DESCRIPTORS.replication_operation_origin,
    async assertTarget({ tx, workspaceId, payload, binding }) {
      const rows = await tx.select().from(replicationAccepted).where(and(
        eq(replicationAccepted.workspaceId, workspaceId),
        eq(replicationAccepted.operationDigest, binding.recordId),
      )).limit(1);
      if (!rows[0] || payload.subject.id !== binding.recordId || binding.recordDigest !== rows[0].operationDigest) {
        throw new Error("bound replication operation not found");
      }
    },
  },
  {
    descriptor: BUILTIN_STATEMENT_BINDER_DESCRIPTORS.workspace_checkpoint,
    async assertTarget({ tx, workspaceId, payload, binding }) {
      if (payload.subject.id !== binding.recordId) throw new Error("workspace checkpoint binding identity mismatch");
      const rows = await tx.select().from(workspaceCheckpoint).where(and(
        eq(workspaceCheckpoint.tenantId, workspaceId), eq(workspaceCheckpoint.id, binding.recordId),
      )).limit(1);
      if (!rows[0] || rows[0].rootDigest !== binding.recordDigest) {
        throw new Error("bound workspace checkpoint root not found");
      }
    },
  },
]);

export const createStatementBinderRegistry = (
  additional: readonly TrustedStatementBinder[] = [],
) => new StatementBinderRegistry([...BUILTIN_STATEMENT_BINDERS, ...additional]);

const DEFAULT_STATEMENT_BINDER_REGISTRY = createStatementBinderRegistry();

async function assertRegisteredTarget(
  tx: TasqDbOrTx,
  workspaceId: string,
  payload: Payload,
  binding: SignedStatementBinderInput,
  registry: StatementBinderRegistry,
  acceptedAt: number,
  profileUri: string,
): Promise<BinderDescriptor> {
  const binder = registry.resolve(binding);
  const { descriptor: value } = binder;
  if (payload.purpose.uri !== value.purposeUri || payload.purpose.version !== value.purposeVersion) {
    throw new Error("signed statement purpose does not match registered binder");
  }
  if (payload.subject.typeUri !== value.subjectTypeUri || binding.recordType !== value.recordType) {
    throw new Error("signed statement subject or record type does not match registered binder");
  }
  if (payload.subject.digest !== binding.recordDigest) {
    throw new Error("signed statement subject digest does not match bound record");
  }
  if (value.allowedProfileUris.length > 0 && !value.allowedProfileUris.includes(profileUri)) {
    throw new Error("signature profile is not allowed by registered binder");
  }
  if (value.expectedRevisionRequired && payload.expectedRevision == null) {
    throw new Error("registered statement binder requires expectedRevision");
  }
  if (value.maximumAgeMs != null) {
    const age = acceptedAt - Date.parse(payload.issuedAt);
    if (age < 0 || age > value.maximumAgeMs) throw new Error("signed statement is stale for registered binder");
  }
  const assertion = { tx, workspaceId, payload, binding };
  if (value.onlineAuthorizationRequired) await binder.assertAuthority!(assertion);
  await binder.assertTarget(assertion);
  return value;
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
  const tenantId = ctx.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
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
  binderRegistry: StatementBinderRegistry = DEFAULT_STATEMENT_BINDER_REGISTRY,
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
  const binderDescriptor = await assertRegisteredTarget(
    tx,
    tenantId,
    payload,
    bindingInput,
    binderRegistry,
    now,
    bundle.signature.profileUri,
  );
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
    const priorBinding = parseBinding(bindingRows[0]);
    if (
      priorBinding.bindingKind !== bindingInput.bindingKind ||
      priorBinding.recordType !== bindingInput.recordType ||
      priorBinding.recordId !== bindingInput.recordId ||
      priorBinding.recordDigest !== bindingInput.recordDigest ||
      canonicalizeEffectJson(priorBinding.binderDescriptor as never) !==
        canonicalizeEffectJson(binderDescriptor as never)
    ) {
      throw new Error("statement already accepted with a different registered binding");
    }
    return {
      statement: prior,
      verification: parseVerification(verificationRows[0]),
      binding: priorBinding,
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
    binderDescriptorJson: canonicalizeEffectJson(binderDescriptor as never),
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
    persistPreparedSignedStatementAcceptance(
      tx,
      prepared,
      input.binding,
      input.binderRegistry ?? DEFAULT_STATEMENT_BINDER_REGISTRY,
    ));
}
export async function getSignedStatement(db: TasqDbOrTx, statementId: string, tenantId = LEGACY_DEFAULT_WORKSPACE_ID) {
  const rows = await db.select().from(signedStatement).where(and(
    eq(signedStatement.tenantId, tenantId), eq(signedStatement.statementId, statementId),
  )).limit(1);
  return rows[0] ? parseStatement(rows[0]) : null;
}
export async function getSignedStatementBinding(db: TasqDbOrTx, id: string, tenantId = LEGACY_DEFAULT_WORKSPACE_ID) {
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
  const filters = [eq(signedStatementBinding.tenantId, input.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID)];
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
  tenantId = LEGACY_DEFAULT_WORKSPACE_ID,
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
