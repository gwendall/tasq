/** ADR-005/TQ-612 append-only completion resolution contracts and records. */

import { z } from "zod";
import { AbsoluteUri, Metadata, UnixMs, UuidV7 } from "./types.js";
import { Sha256Digest } from "./extensions.js";

export const EVIDENCE_AUTHENTICITY_CLASSES = [
  "unverified",
  "authenticated_principal",
  "authenticated_source",
  "provider_verified",
] as const;
export const EvidenceAuthenticityClass = z.enum(EVIDENCE_AUTHENTICITY_CLASSES);
export type EvidenceAuthenticityClass = z.infer<typeof EvidenceAuthenticityClass>;

export const EVIDENCE_TRUST_ACTIONS = ["attest", "revoke"] as const;
export const EvidenceTrustAction = z.enum(EVIDENCE_TRUST_ACTIONS);
export type EvidenceTrustAction = z.infer<typeof EvidenceTrustAction>;

export const RESOLUTION_POLICY_KINDS = [
  "deterministic",
  "attestation",
  "optimistic",
  "adjudicated",
] as const;
export const ResolutionPolicyKind = z.enum(RESOLUTION_POLICY_KINDS);
export type ResolutionPolicyKind = z.infer<typeof ResolutionPolicyKind>;

export const VALIDATION_OUTCOMES = [
  "accepted",
  "rejected",
  "too_early",
  "indeterminate",
  "challenged",
] as const;
export const ValidationOutcome = z.enum(VALIDATION_OUTCOMES);
export type ValidationOutcome = z.infer<typeof ValidationOutcome>;

const CriterionId = z.string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const PrincipalId = z.string().min(1).max(500);

export const ResolutionCriterion = z.object({
  id: CriterionId,
  statement: z.string().min(1).max(2_000),
  minimumEvidenceCount: z.number().int().positive().max(100).default(1),
  acceptedEvidenceKinds: z.array(z.string().min(1).max(80)).max(100).default([]),
  acceptedSources: z.array(z.string().min(1).max(500)).max(100).default([]),
  minimumAuthenticity: EvidenceAuthenticityClass.default("unverified"),
  maxAgeMs: z.number().int().nonnegative().nullable().default(null),
  minimumRetentionMs: z.number().int().nonnegative().default(0),
  evaluatorInput: Metadata.default({}),
}).strict();
export type ResolutionCriterion = z.infer<typeof ResolutionCriterion>;

export const ResolutionContract = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  taskRevision: z.number().int().positive(),
  successCriteriaSnapshot: z.string().min(1).max(2_000),
  criteria: z.array(ResolutionCriterion).min(1).max(100),
  criteriaDigest: Sha256Digest,
  policyKind: ResolutionPolicyKind,
  policyUri: AbsoluteUri,
  policyVersion: z.number().int().positive(),
  implementationDigest: Sha256Digest,
  notBefore: UnixMs.nullable(),
  challengeWindowMs: z.number().int().nonnegative(),
  allowSelfValidation: z.boolean(),
  eligibleValidatorPrincipalIds: z.array(PrincipalId).max(100),
  adjudicatorPrincipalIds: z.array(PrincipalId).max(100),
  contractDigest: Sha256Digest,
  createdByPrincipalId: PrincipalId,
  metadata: Metadata,
  createdAt: UnixMs,
});
export type ResolutionContract = z.infer<typeof ResolutionContract>;

export const ResolutionContractInsert = ResolutionContract.omit({
  id: true,
  tenantId: true,
  taskRevision: true,
  successCriteriaSnapshot: true,
  criteriaDigest: true,
  contractDigest: true,
  createdByPrincipalId: true,
  createdAt: true,
}).extend({
  id: UuidV7.optional(),
  notBefore: UnixMs.nullable().default(null),
  challengeWindowMs: z.number().int().nonnegative().default(0),
  allowSelfValidation: z.boolean().default(false),
  eligibleValidatorPrincipalIds: z.array(PrincipalId).max(100).default([]),
  adjudicatorPrincipalIds: z.array(PrincipalId).max(100).default([]),
  metadata: Metadata.default({}),
}).superRefine((value, ctx) => {
  const criterionIds = value.criteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criteria"], message: "criterion ids must be unique" });
  }
  if (value.policyKind === "optimistic" && value.challengeWindowMs <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["challengeWindowMs"],
      message: "optimistic policy requires a positive challenge window",
    });
  }
  if (value.policyKind === "attestation" && value.eligibleValidatorPrincipalIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eligibleValidatorPrincipalIds"],
      message: "attestation policy requires eligible validators",
    });
  }
  if (value.policyKind === "adjudicated" && value.adjudicatorPrincipalIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["adjudicatorPrincipalIds"],
      message: "adjudicated policy requires adjudicators",
    });
  }
});
export type ResolutionContractInsert = z.infer<typeof ResolutionContractInsert>;

export const EvidenceTrustRecord = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  evidenceId: UuidV7,
  action: EvidenceTrustAction,
  authenticity: EvidenceAuthenticityClass,
  authorityUri: AbsoluteUri,
  authorityVersion: z.number().int().positive(),
  authorityDigest: Sha256Digest,
  supersedesTrustRecordId: UuidV7.nullable(),
  reason: z.string().min(1).max(2_000),
  verifiedAt: UnixMs,
  validUntil: UnixMs.nullable(),
  retentionUntil: UnixMs.nullable(),
  recordedByPrincipalId: PrincipalId,
  createdAt: UnixMs,
}).superRefine((value, ctx) => {
  if (value.validUntil != null && value.validUntil < value.verifiedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "must not precede verifiedAt" });
  }
  if (value.retentionUntil != null && value.retentionUntil < value.verifiedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retentionUntil"], message: "must not precede verifiedAt" });
  }
  if (value.action === "revoke" && value.supersedesTrustRecordId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersedesTrustRecordId"],
      message: "revocation must supersede the current trust record",
    });
  }
});
export type EvidenceTrustRecord = z.infer<typeof EvidenceTrustRecord>;

export const EvidenceTrustAttestationInsert = z.object({
  id: UuidV7.optional(),
  taskId: UuidV7,
  evidenceId: UuidV7,
  authenticity: EvidenceAuthenticityClass,
  authorityUri: AbsoluteUri,
  authorityVersion: z.number().int().positive(),
  authorityDigest: Sha256Digest,
  reason: z.string().min(1).max(2_000),
  verifiedAt: UnixMs,
  validUntil: UnixMs.nullable().default(null),
  retentionUntil: UnixMs.nullable().default(null),
});
export type EvidenceTrustAttestationInsert = z.infer<typeof EvidenceTrustAttestationInsert>;

export const CompletionCriterionEvidence = z.object({
  criterionId: CriterionId,
  evidenceIds: z.array(UuidV7).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceIds"], message: "evidence ids must be unique" });
  }
});
export type CompletionCriterionEvidence = z.infer<typeof CompletionCriterionEvidence>;

export const CompletionProposal = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  resolutionContractId: UuidV7,
  contractDigest: Sha256Digest,
  proposerPrincipalId: PrincipalId,
  criterionEvidence: z.array(CompletionCriterionEvidence).min(1).max(100),
  summary: z.string().min(1).max(2_000).nullable(),
  proposalDigest: Sha256Digest,
  proposedAt: UnixMs,
});
export type CompletionProposal = z.infer<typeof CompletionProposal>;

export const CompletionProposalInsert = CompletionProposal.pick({
  taskId: true,
  resolutionContractId: true,
  criterionEvidence: true,
  summary: true,
}).extend({
  id: UuidV7.optional(),
  summary: z.string().min(1).max(2_000).nullable().default(null),
});
export type CompletionProposalInsert = z.infer<typeof CompletionProposalInsert>;

export const CompletionChallenge = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  proposalId: UuidV7,
  challengerPrincipalId: PrincipalId,
  reasonCode: z.string().min(1).max(120),
  explanation: z.string().min(1).max(2_000),
  counterEvidenceIds: z.array(UuidV7).max(100),
  challengedAt: UnixMs,
});
export type CompletionChallenge = z.infer<typeof CompletionChallenge>;

export const CompletionChallengeInsert = CompletionChallenge.pick({
  proposalId: true,
  reasonCode: true,
  explanation: true,
  counterEvidenceIds: true,
}).extend({
  id: UuidV7.optional(),
  counterEvidenceIds: z.array(UuidV7).max(100).default([]),
});
export type CompletionChallengeInsert = z.infer<typeof CompletionChallengeInsert>;

export const ValidationDecision = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  resolutionContractId: UuidV7,
  proposalId: UuidV7,
  outcome: ValidationOutcome,
  policyUri: AbsoluteUri,
  policyVersion: z.number().int().positive(),
  implementationDigest: Sha256Digest,
  policyInputDigest: Sha256Digest,
  evidenceIds: z.array(UuidV7),
  trustRecordIds: z.array(UuidV7),
  supersedesDecisionId: UuidV7.nullable(),
  decidedByPrincipalId: PrincipalId,
  reasonCode: z.string().min(1).max(120),
  explanation: z.string().min(1).max(2_000),
  decidedAt: UnixMs,
});
export type ValidationDecision = z.infer<typeof ValidationDecision>;

export const ManualValidationDecisionInsert = ValidationDecision.pick({
  proposalId: true,
  outcome: true,
  reasonCode: true,
  explanation: true,
  supersedesDecisionId: true,
}).extend({
  id: UuidV7.optional(),
  supersedesDecisionId: UuidV7.nullable().default(null),
});
export type ManualValidationDecisionInsert = z.infer<typeof ManualValidationDecisionInsert>;

export const CompletionResolutionChain = z.object({
  contract: ResolutionContract,
  proposals: z.array(CompletionProposal),
  challenges: z.array(CompletionChallenge),
  decisions: z.array(ValidationDecision),
  trustRecords: z.array(EvidenceTrustRecord),
});
export type CompletionResolutionChain = z.infer<typeof CompletionResolutionChain>;

export const AUTHENTICITY_RANK: Readonly<Record<EvidenceAuthenticityClass, number>> =
  Object.freeze({
    unverified: 0,
    authenticated_principal: 1,
    authenticated_source: 2,
    provider_verified: 3,
  });
