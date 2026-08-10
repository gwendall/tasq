import { z } from "zod";
import { Sha256Digest } from "./extensions.js";
import { AbsoluteUri, Metadata } from "./types.js";

const Portable = z.string().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
  message: "portable identity contains control characters",
});
const Base64Url = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/);
const Rfc3339 = z.string().datetime({ offset: true });

export const SignedStatementPayloadV1 = z.object({
  contractVersion: z.literal("tasq.signed-statement.v1"),
  statementId: Portable,
  workspaceId: Portable,
  audience: AbsoluteUri,
  issuerPrincipalId: Portable,
  credentialId: Portable,
  purpose: z.object({ uri: AbsoluteUri, version: z.number().int().positive() }).strict(),
  subject: z.object({
    typeUri: AbsoluteUri,
    id: Portable,
    revision: z.number().int().positive().optional(),
    digest: Sha256Digest,
  }).strict(),
  actionUri: AbsoluteUri.optional(),
  payloadDigest: Sha256Digest.optional(),
  expectedRevision: z.number().int().positive().optional(),
  nonce: Portable,
  issuedAt: Rfc3339,
  notBefore: Rfc3339.optional(),
  expiresAt: Rfc3339.optional(),
  metadata: Metadata,
}).strict().superRefine((value, ctx) => {
  const issuedAt = Date.parse(value.issuedAt);
  const notBefore = value.notBefore ? Date.parse(value.notBefore) : null;
  const expiresAt = value.expiresAt ? Date.parse(value.expiresAt) : null;
  if (notBefore != null && expiresAt != null && expiresAt <= notBefore) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after notBefore" });
  }
  if (expiresAt != null && expiresAt <= issuedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
  }
  if (new TextEncoder().encode(JSON.stringify(value.metadata)).byteLength > 8_192) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["metadata"], message: "metadata exceeds 8192 bytes" });
  }
});
export type SignedStatementPayloadV1 = z.infer<typeof SignedStatementPayloadV1>;

export const SignedStatementBundleV1 = z.object({
  envelopeVersion: z.literal("tasq.signed-statement-envelope.v1"),
  payloadType: z.literal("application/vnd.tasq.signed-statement.v1+json"),
  payload: Base64Url,
  signature: z.object({
    profileUri: AbsoluteUri,
    profileVersion: z.number().int().positive(),
    keyId: Portable,
    value: Base64Url,
  }).strict(),
  supportingProofs: z.array(z.object({
    typeUri: AbsoluteUri,
    version: z.number().int().positive(),
    digest: Sha256Digest,
    bundle: z.unknown(),
  }).strict()).max(16),
}).strict();
export type SignedStatementBundleV1 = z.infer<typeof SignedStatementBundleV1>;

export const SigningCredentialStatus = z.enum([
  "pending", "active", "suspended", "revoked", "compromised", "retired",
]);
export const SigningCredentialIsolationClass = z.enum([
  "shared_user_software",
  "isolated_process",
  "hardware",
  "kms",
  "webauthn",
  "workload_identity",
]);
export const SigningCredentialV1 = z.object({
  credentialId: Portable,
  workspaceId: Portable,
  principalId: Portable,
  profileUri: AbsoluteUri,
  profileVersion: z.number().int().positive(),
  publicMaterial: z.unknown(),
  publicMaterialDigest: Sha256Digest,
  trustRootDigest: Sha256Digest,
  isolationClass: SigningCredentialIsolationClass,
  status: SigningCredentialStatus,
  revision: z.number().int().positive(),
  validFrom: Rfc3339,
  expiresAt: Rfc3339.optional(),
  replacesCredentialId: Portable.optional(),
  enrollmentMethod: z.string().min(1).max(200),
  enrollmentEvidenceDigest: Sha256Digest,
}).strict();
export type SigningCredentialV1 = z.infer<typeof SigningCredentialV1>;

export const AcceptedSigningCredentialSnapshotV1 = z.object({
  contractVersion: z.literal("tasq.accepted-signing-credential-snapshot.v1"),
  workspaceId: Portable,
  credential: SigningCredentialV1,
  credentialDigest: Sha256Digest,
  capturedAt: z.number().int().nonnegative(),
}).strict();
export type AcceptedSigningCredentialSnapshotV1 =
  z.infer<typeof AcceptedSigningCredentialSnapshotV1>;

export const SignatureVerificationRecordV1 = z.object({
  id: Portable,
  workspaceId: Portable,
  statementId: Portable,
  statementDigest: Sha256Digest,
  bundleDigest: Sha256Digest,
  credentialId: Portable,
  credentialRevision: z.number().int().positive(),
  credentialDigest: Sha256Digest,
  principalId: Portable,
  trustRootDigest: Sha256Digest,
  profileUri: AbsoluteUri,
  profileVersion: z.number().int().positive(),
  verifierImplementationDigest: Sha256Digest,
  verifiedAt: Rfc3339,
  credentialStateAtVerification: SigningCredentialStatus,
  outcome: z.enum(["valid", "invalid", "indeterminate"]),
  reasonCode: z.string().min(1).max(120),
  supportingProofDigests: z.array(Sha256Digest).max(16),
}).strict();
export type SignatureVerificationRecordV1 = z.infer<typeof SignatureVerificationRecordV1>;

export const StatementPurposeDescriptorV1 = z.object({
  contractVersion: z.literal("tasq.statement-purpose.v1"),
  purposeUri: AbsoluteUri,
  purposeVersion: z.number().int().positive(),
  subjectTypeUri: AbsoluteUri,
  // Empty means that the host verifier owns profile policy. A binder may make
  // the set narrower, but can never make an unverified profile acceptable.
  allowedProfileUris: z.array(AbsoluteUri).max(16),
  nonceMode: z.enum(["unique", "single_use_challenge"]),
  maximumAgeMs: z.number().int().positive().nullable(),
  expectedRevisionRequired: z.boolean(),
  onlineAuthorizationRequired: z.boolean(),
  binderUri: AbsoluteUri,
  binderVersion: z.number().int().positive(),
  binderImplementationDigest: Sha256Digest,
}).strict();
export type StatementPurposeDescriptorV1 = z.infer<typeof StatementPurposeDescriptorV1>;

/**
 * Portable identity of trusted host code that binds one signed purpose to one
 * exact record shape. The descriptor is data; executable binder code is never
 * loaded from a workspace store.
 */
export const StatementBinderDescriptorV1 = StatementPurposeDescriptorV1.extend({
  contractVersion: z.literal("tasq.statement-binder.v1"),
  bindingKind: Portable,
  recordType: z.string().min(1).max(120),
}).strict();
export type StatementBinderDescriptorV1 = z.infer<typeof StatementBinderDescriptorV1>;

/** Built-in compatibility names. The registry itself accepts open portable names. */
export const BUILTIN_SIGNED_STATEMENT_BINDING_KINDS = [
  "artifact_authorship",
  "artifact_acceptance",
  "completion_attestation",
  "effect_approval",
  "replication_operation_origin",
  "workspace_checkpoint",
] as const;
export const SignedStatementBindingKind = Portable;

export const StoredSignedStatement = z.object({
  statementId: Portable,
  tenantId: Portable,
  issuerPrincipalId: Portable,
  credentialId: Portable,
  purposeUri: AbsoluteUri,
  purposeVersion: z.number().int().positive(),
  subjectTypeUri: AbsoluteUri,
  subjectId: Portable,
  subjectDigest: Sha256Digest,
  payload: SignedStatementPayloadV1,
  payloadDigest: Sha256Digest,
  bundle: SignedStatementBundleV1,
  bundleDigest: Sha256Digest,
  acceptedAt: z.number().int().nonnegative(),
}).strict();
export type StoredSignedStatement = z.infer<typeof StoredSignedStatement>;

export const SignedStatementBinding = z.object({
  id: Portable,
  tenantId: Portable,
  statementId: Portable,
  verificationId: Portable,
  bindingKind: SignedStatementBindingKind,
  binderDescriptor: StatementBinderDescriptorV1,
  recordType: z.string().min(1).max(120),
  recordId: Portable,
  recordDigest: Sha256Digest,
  createdByPrincipalId: Portable,
  createdAt: z.number().int().nonnegative(),
  metadata: Metadata,
}).strict().superRefine((value, ctx) => {
  if (value.bindingKind !== value.binderDescriptor.bindingKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binderDescriptor", "bindingKind"],
      message: "binder descriptor kind does not match binding",
    });
  }
  if (value.recordType !== value.binderDescriptor.recordType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binderDescriptor", "recordType"],
      message: "binder descriptor record type does not match binding",
    });
  }
});
export type SignedStatementBinding = z.infer<typeof SignedStatementBinding>;

export const WorkspaceCheckpointV1 = z.object({
  contractVersion: z.literal("tasq.workspace-checkpoint.v1"),
  id: Portable,
  workspaceId: Portable,
  authorityEpoch: Portable,
  eventCursor: z.number().int().nonnegative(),
  rootContract: z.object({
    uri: AbsoluteUri,
    version: z.number().int().positive(),
  }).strict(),
  rootDigest: Sha256Digest,
  exportedRecordCount: z.number().int().nonnegative(),
  createdByPrincipalId: Portable,
  createdAt: z.number().int().nonnegative(),
  metadata: Metadata,
}).strict();
export type WorkspaceCheckpointV1 = z.infer<typeof WorkspaceCheckpointV1>;
