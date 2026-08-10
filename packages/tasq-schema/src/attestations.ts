/** Provider-neutral attestations and derived eligibility decisions. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { Metadata } from "./types.js";
import { Sha256Digest } from "./extensions.js";

const Portable = z.string().min(1).max(2_000)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    "must be trimmed and contain no control characters");
const AbsoluteUri = z.string().url().max(2_000);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonValue), z.record(z.string(), JsonValue),
]));

export const AttestationSubjectV1 = z.object({
  typeUri: AbsoluteUri,
  id: Portable,
  digest: Sha256Digest.nullable().default(null),
}).strict();
export type AttestationSubjectV1 = z.infer<typeof AttestationSubjectV1>;

export const AttestationPurposeV1 = z.object({
  uri: AbsoluteUri,
  version: z.number().int().positive(),
}).strict();
export type AttestationPurposeV1 = z.infer<typeof AttestationPurposeV1>;

export const AttestationScopeEntryV1 = z.object({
  typeUri: AbsoluteUri,
  value: Portable,
  digest: Sha256Digest.nullable().default(null),
}).strict();
export type AttestationScopeEntryV1 = z.infer<typeof AttestationScopeEntryV1>;

export const AttestationClaimV1 = z.object({
  typeUri: AbsoluteUri,
  version: z.number().int().positive(),
  value: JsonValue,
}).strict();
export type AttestationClaimV1 = z.infer<typeof AttestationClaimV1>;

export const AttestationEvidenceRefV1 = z.object({
  typeUri: AbsoluteUri,
  digest: Sha256Digest,
  uri: AbsoluteUri.nullable().default(null),
}).strict();
export type AttestationEvidenceRefV1 = z.infer<typeof AttestationEvidenceRefV1>;

const AttestationBody = z.object({
  contractVersion: z.literal("tasq.attestation.v1"),
  id: Portable,
  workspaceId: Portable,
  issuerPrincipalId: Portable,
  subject: AttestationSubjectV1,
  purpose: AttestationPurposeV1,
  scope: z.array(AttestationScopeEntryV1).max(64),
  claim: AttestationClaimV1,
  claimDigest: Sha256Digest,
  evidence: z.array(AttestationEvidenceRefV1).max(64),
  notBefore: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive().nullable(),
  supersedesAttestationId: Portable.nullable(),
  attestationDigest: Sha256Digest,
  issuedAt: z.number().int().nonnegative(),
  metadata: Metadata,
});

export const AttestationV1 = AttestationBody.strict().superRefine((value, ctx) => {
  if (value.expiresAt != null && value.expiresAt <= value.notBefore) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "must be after notBefore" });
  }
  const ordered = canonicalScope(value.scope);
  if (JSON.stringify(ordered) !== JSON.stringify(value.scope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "must be unique and canonically sorted" });
  }
});
export type AttestationV1 = z.infer<typeof AttestationV1>;

export const AttestationIssueInputV1 = z.object({
  id: Portable.optional(),
  subject: AttestationSubjectV1,
  purpose: AttestationPurposeV1,
  scope: z.array(AttestationScopeEntryV1).max(64).default([]),
  claim: AttestationClaimV1,
  evidence: z.array(AttestationEvidenceRefV1).max(64).default([]),
  notBefore: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().positive().nullable().default(null),
  supersedesAttestationId: Portable.nullable().default(null),
  metadata: Metadata.default({}),
}).strict();
export type AttestationIssueInputV1 = z.input<typeof AttestationIssueInputV1>;

export const AttestationRevocationV1 = z.object({
  contractVersion: z.literal("tasq.attestation-revocation.v1"),
  id: Portable,
  workspaceId: Portable,
  attestationId: Portable,
  revokerPrincipalId: Portable,
  reasonCode: z.string().min(1).max(120),
  explanation: z.string().max(4_000).nullable(),
  effectiveAt: z.number().int().nonnegative(),
  recordedAt: z.number().int().nonnegative(),
  revocationDigest: Sha256Digest,
  metadata: Metadata,
}).strict().superRefine((value, ctx) => {
  if (value.effectiveAt > value.recordedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveAt"], message: "cannot be after recordedAt" });
  }
});
export type AttestationRevocationV1 = z.infer<typeof AttestationRevocationV1>;

export const AttestationRequirementV1 = z.object({
  purpose: AttestationPurposeV1,
  claimTypeUri: AbsoluteUri,
  claimVersion: z.number().int().positive(),
  acceptedIssuerPrincipalIds: z.array(Portable).min(1).max(64),
  requiredScope: z.array(AttestationScopeEntryV1).max(64).default([]),
  claimDigest: Sha256Digest.nullable().default(null),
}).strict();
export type AttestationRequirementV1 = z.infer<typeof AttestationRequirementV1>;

export const AttestationEligibilityDecisionV1 = z.object({
  contractVersion: z.literal("tasq.attestation-eligibility-decision.v1"),
  workspaceId: Portable,
  subject: AttestationSubjectV1,
  authorityTime: z.number().int().nonnegative(),
  outcome: z.enum(["eligible", "ineligible"]),
  basisAttestationIds: z.array(Portable),
  unsatisfiedRequirementIndexes: z.array(z.number().int().nonnegative()),
  assurance: z.object({
    issuerAuthentication: z.literal("not_asserted_by_eligibility"),
    claimTruth: z.literal("not_asserted"),
    authority: z.literal("not_granted"),
    availability: z.literal("not_asserted"),
  }).strict(),
}).strict();
export type AttestationEligibilityDecisionV1 = z.infer<typeof AttestationEligibilityDecisionV1>;

export function canonicalScope(entries: readonly AttestationScopeEntryV1[]): AttestationScopeEntryV1[] {
  const keyed = entries.map((entry) => [JSON.stringify(entry), entry] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  if (new Set(keyed.map(([key]) => key)).size !== keyed.length) throw new Error("attestation scope contains duplicates");
  return keyed.map(([, entry]) => entry);
}

export function attestationDigest(value: Omit<AttestationV1, "attestationDigest">): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("tasq.attestation.v1\0" + canonical(value)).digest("hex")}`;
}

export function attestationClaimDigest(value: AttestationClaimV1): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("tasq.attestation-claim.v1\0" + canonical(value)).digest("hex")}`;
}

export function attestationRevocationDigest(value: Omit<AttestationRevocationV1, "revocationDigest">): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("tasq.attestation-revocation.v1\0" + canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  throw new Error("attestation canonical JSON only accepts JSON values");
}
