/** Exact multi-party agreements that compile to existing commitments and resolution policy. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { EffectJsonObject } from "./effects.js";
import { Sha256Digest } from "./extensions.js";
import { ResolutionCriterion, ResolutionPolicyKind } from "./resolution.js";
import { Metadata, Priority, UnixMs, UuidV7 } from "./types.js";

const Portable = z.string().min(1).max(500)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const AbsoluteUri = z.string().url().max(2_000);

export const AgreementPartyV1 = z.object({
  principalId: Portable,
  roleUri: AbsoluteUri,
}).strict();
export type AgreementPartyV1 = z.infer<typeof AgreementPartyV1>;

export const AgreementResolutionPolicyV1 = z.object({
  criteria: z.array(ResolutionCriterion).min(1).max(100),
  policyKind: ResolutionPolicyKind,
  policyUri: AbsoluteUri,
  policyVersion: z.number().int().positive(),
  implementationDigest: Sha256Digest,
  notBefore: UnixMs.nullable().default(null),
  challengeWindowMs: z.number().int().nonnegative().default(0),
  allowSelfValidation: z.boolean().default(false),
  eligibleValidatorPrincipalIds: z.array(Portable).max(100).default([]),
  adjudicatorPrincipalIds: z.array(Portable).max(100).default([]),
  metadata: Metadata.default({}),
}).strict();
export type AgreementResolutionPolicyV1 = z.infer<typeof AgreementResolutionPolicyV1>;

export const AgreementObligationV1 = z.object({
  id: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  obligorPrincipalId: Portable,
  beneficiaryPrincipalId: Portable,
  commitment: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10_000).nullable().default(null),
    successCriteria: z.string().min(1).max(2_000),
    notBefore: UnixMs.nullable().default(null),
    dueAt: UnixMs.nullable().default(null),
    priority: Priority.nullable().default(null),
    metadata: Metadata.default({}),
  }).strict(),
  resolutionPolicy: AgreementResolutionPolicyV1,
}).strict().superRefine((value, ctx) => {
  if (value.obligorPrincipalId === value.beneficiaryPrincipalId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beneficiaryPrincipalId"], message: "obligor and beneficiary must differ" });
  }
  if (value.commitment.notBefore !== null && value.commitment.dueAt !== null &&
      value.commitment.notBefore >= value.commitment.dueAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commitment", "dueAt"], message: "dueAt must follow notBefore" });
  }
});
export type AgreementObligationV1 = z.infer<typeof AgreementObligationV1>;

export const AgreementTermsV1 = z.object({
  contractVersion: z.literal("tasq.agreement-terms.v1"),
  title: z.string().min(1).max(500),
  purposeUri: AbsoluteUri,
  parties: z.array(AgreementPartyV1).min(2).max(32),
  obligations: z.array(AgreementObligationV1).min(2).max(100),
  terms: EffectJsonObject.default({}),
}).strict().superRefine((value, ctx) => {
  const partyIds = value.parties.map(({ principalId }) => principalId);
  if (partyIds.some((id, index) => index > 0 && partyIds[index - 1]! >= id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parties"], message: "parties must be sorted by unique principalId" });
  }
  const obligationIds = value.obligations.map(({ id }) => id);
  if (obligationIds.some((id, index) => index > 0 && obligationIds[index - 1]! >= id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["obligations"], message: "obligations must be sorted by unique id" });
  }
  const known = new Set(partyIds);
  for (const [index, obligation] of value.obligations.entries()) {
    if (!known.has(obligation.obligorPrincipalId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["obligations", index, "obligorPrincipalId"], message: "must name a party" });
    if (!known.has(obligation.beneficiaryPrincipalId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["obligations", index, "beneficiaryPrincipalId"], message: "must name a party" });
  }
  for (const [index, principalId] of partyIds.entries()) {
    if (!value.obligations.some(({ obligorPrincipalId }) => obligorPrincipalId === principalId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parties", index], message: "reciprocal agreement requires each party to owe an obligation" });
    }
    if (!value.obligations.some(({ beneficiaryPrincipalId }) => beneficiaryPrincipalId === principalId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parties", index], message: "reciprocal agreement requires each party to receive an obligation" });
    }
  }
});
export type AgreementTermsV1 = z.infer<typeof AgreementTermsV1>;

export const AgreementOfferV1 = z.object({
  contractVersion: z.literal("tasq.agreement-offer.v1"),
  id: UuidV7,
  workspaceId: Portable,
  offerorPrincipalId: Portable,
  terms: AgreementTermsV1,
  termsDigest: Sha256Digest,
  expiresAt: UnixMs,
  supersedesOfferId: UuidV7.nullable(),
  offeredAt: UnixMs,
  metadata: Metadata,
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.offeredAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "must follow offeredAt" });
  if (!value.terms.parties.some(({ principalId }) => principalId === value.offerorPrincipalId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offerorPrincipalId"], message: "offeror must be a party" });
  }
});
export type AgreementOfferV1 = z.infer<typeof AgreementOfferV1>;

export const AgreementOfferInputV1 = z.object({
  id: UuidV7.optional(),
  terms: AgreementTermsV1,
  expiresAt: UnixMs,
  supersedesOfferId: UuidV7.nullable().default(null),
  metadata: Metadata.default({}),
}).strict();
export type AgreementOfferInputV1 = z.input<typeof AgreementOfferInputV1>;

export const AgreementAcceptanceV1 = z.object({
  contractVersion: z.literal("tasq.agreement-acceptance.v1"),
  id: UuidV7,
  workspaceId: Portable,
  offerId: UuidV7,
  partyPrincipalId: Portable,
  termsDigest: Sha256Digest,
  acceptanceDigest: Sha256Digest,
  acceptedAt: UnixMs,
  metadata: Metadata,
}).strict();
export type AgreementAcceptanceV1 = z.infer<typeof AgreementAcceptanceV1>;

export const AgreementTerminationV1 = z.object({
  contractVersion: z.literal("tasq.agreement-termination.v1"),
  id: UuidV7,
  workspaceId: Portable,
  offerId: UuidV7,
  actorPrincipalId: Portable,
  action: z.enum(["withdrawn", "rejected"]),
  termsDigest: Sha256Digest,
  reason: z.string().min(1).max(2_000),
  terminatedAt: UnixMs,
  metadata: Metadata,
}).strict();
export type AgreementTerminationV1 = z.infer<typeof AgreementTerminationV1>;

export const AgreementCompilationV1 = z.object({
  obligationId: z.string().min(1).max(120),
  commitmentId: UuidV7,
  resolutionContractId: UuidV7,
}).strict();

export const AgreementActivationV1 = z.object({
  contractVersion: z.literal("tasq.agreement-activation.v1"),
  id: UuidV7,
  workspaceId: Portable,
  offerId: UuidV7,
  termsDigest: Sha256Digest,
  acceptanceIds: z.array(UuidV7).min(2).max(32),
  compilations: z.array(AgreementCompilationV1).min(2).max(100),
  supersedesActivationId: UuidV7.nullable(),
  activatedAt: UnixMs,
  activationDigest: Sha256Digest,
}).strict();
export type AgreementActivationV1 = z.infer<typeof AgreementActivationV1>;

export const AgreementStateV1 = z.enum(["offered", "withdrawn", "rejected", "expired", "accepted", "superseded"]);
export type AgreementStateV1 = z.infer<typeof AgreementStateV1>;

export const AgreementViewV1 = z.object({
  contractVersion: z.literal("tasq.agreement-view.v1"),
  offer: AgreementOfferV1,
  state: AgreementStateV1,
  acceptances: z.array(AgreementAcceptanceV1),
  termination: AgreementTerminationV1.nullable(),
  activation: AgreementActivationV1.nullable(),
  supersededByOfferId: UuidV7.nullable(),
  authorityTime: UnixMs,
  assurance: z.object({
    assignmentAcceptanceIsAgreement: z.literal(false),
    effectAuthorityGranted: z.literal(false),
  }).strict(),
}).strict();
export type AgreementViewV1 = z.infer<typeof AgreementViewV1>;

export function agreementTermsDigest(value: AgreementTermsV1): `sha256:${string}` {
  return hash("tasq.agreement-terms.v1\0", value);
}

export function agreementAcceptanceDigest(value: Omit<AgreementAcceptanceV1, "acceptanceDigest">): `sha256:${string}` {
  return hash("tasq.agreement-acceptance.v1\0", value);
}

export function agreementActivationDigest(value: Omit<AgreementActivationV1, "activationDigest">): `sha256:${string}` {
  return hash("tasq.agreement-activation.v1\0", value);
}

function hash(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(domain + canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("agreement JSON numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  throw new Error("agreement canonical JSON only accepts portable JSON values");
}
