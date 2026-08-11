import { createHash } from "node:crypto";
import { z } from "zod";
import { TargetRefV1, canonicalizeEffectJson, prepareTargetRefV1 } from "@tasq-run/schema";

const Uri = z.string().url().max(2_000);
const Id = z.string().min(1).max(500);
const UnixMs = z.number().int().nonnegative();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const DelegatedActionProfileV1 = z.object({
  contractVersion: z.literal("tasq.delegated-action-profile.v1"),
  id: Id,
  version: z.number().int().positive(),
  capabilityUri: Uri,
  title: Id,
  targetResourceType: z.string().regex(/^[a-z][a-z0-9._-]{0,119}$/),
  criteria: z.array(z.object({
    id: Id,
    statement: z.string().min(1).max(2_000),
    acceptedEvidenceKinds: z.array(Id).min(1).max(20),
  }).strict()).min(1).max(20),
  attestationPurposes: z.array(z.object({ uri: Uri, version: z.number().int().positive() }).strict()).max(20),
  externalPermissionRequirements: z.array(Id).min(1).max(20),
  capture: z.object({
    acceptedMediaTypes: z.array(Id).min(1).max(20),
    maximumBytes: z.number().int().positive(),
    maximumObservationAgeMs: z.number().int().positive(),
    redactionRequired: z.boolean(),
  }).strict(),
  stopConditions: z.array(Id).min(1).max(30),
  review: z.object({ independent: z.literal(true), challengeSupported: z.literal(true) }).strict(),
  omissions: z.array(z.enum(["provider_supply", "marketplace", "pricing", "insurance", "site_access", "identity_proof", "physical_truth"])).min(1),
}).strict().superRefine((value, context) => {
  const unique = (items: string[], path: string) => {
    if (new Set(items).size !== items.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${path} must be unique` });
    }
  };
  unique(value.criteria.map(({ id }) => id), "criteria");
  unique(value.externalPermissionRequirements, "externalPermissionRequirements");
  unique(value.capture.acceptedMediaTypes, "capture.acceptedMediaTypes");
  unique(value.stopConditions, "stopConditions");
  unique(value.omissions, "omissions");
});
export type DelegatedActionProfileV1 = z.infer<typeof DelegatedActionProfileV1>;

export const PHYSICAL_VERIFICATION_PROFILE = deepFreeze(DelegatedActionProfileV1.parse({
  contractVersion: "tasq.delegated-action-profile.v1",
  id: "physical-verification/property-exterior",
  version: 1,
  capabilityUri: "https://tasq.run/capabilities/verify-property-exterior/v1",
  title: "Verify one property exterior",
  targetResourceType: "property_exterior",
  criteria: [
    { id: "target-match", statement: "Evidence depicts the exact authorized exterior target.", acceptedEvidenceKinds: ["target_context"] },
    { id: "fresh-observation", statement: "The exterior observation is fresh for the requested window.", acceptedEvidenceKinds: ["captured_outcome"] },
    { id: "requested-facts", statement: "Every requested observable fact is answered or explicitly unavailable.", acceptedEvidenceKinds: ["structured_report"] },
  ],
  attestationPurposes: [
    { uri: "https://tasq.run/purposes/exterior-observation-capability/v1", version: 1 },
  ],
  externalPermissionRequirements: ["requester_site_authority", "applicable_photography_authority"],
  capture: {
    acceptedMediaTypes: ["image/jpeg", "image/png", "application/json"],
    maximumBytes: 25_000_000,
    maximumObservationAgeMs: 15 * 60_000,
    redactionRequired: true,
  },
  stopConditions: [
    "no_access", "unsafe", "occupant_objects", "target_mismatch", "photography_not_authorized",
    "privacy_boundary_unclear", "requested_fact_not_observable", "authority_revoked", "timeout",
  ],
  review: { independent: true, challengeSupported: true },
  omissions: ["provider_supply", "marketplace", "pricing", "insurance", "site_access", "identity_proof", "physical_truth"],
}));

export const DelegatedActionOrderV1 = z.object({
  profileId: Id,
  profileVersion: z.number().int().positive(),
  target: TargetRefV1,
  requesterPrincipalId: Id,
  executorPrincipalId: Id,
  notBefore: UnixMs,
  dueAt: UnixMs,
  externalPermissionRefs: z.record(Id),
  requestedFacts: z.array(Id).min(1).max(50),
}).strict();
export type DelegatedActionOrderV1 = z.infer<typeof DelegatedActionOrderV1>;

export interface CompiledDelegatedActionOrderV1 {
  contractVersion: "tasq.compiled-delegated-action-order.v1";
  profile: { id: string; version: number; capabilityUri: string };
  target: ReturnType<typeof prepareTargetRefV1>;
  parties: { requesterPrincipalId: string; executorPrincipalId: string };
  commitment: {
    title: string;
    successCriteria: string;
    completionPolicy: "evidence";
    validationRequired: true;
    notBefore: number;
    dueAt: number;
  };
  resolution: {
    criteria: DelegatedActionProfileV1["criteria"];
    policyKind: "attestation";
    independentReviewRequired: true;
  };
  capture: DelegatedActionProfileV1["capture"];
  attestationPurposes: DelegatedActionProfileV1["attestationPurposes"];
  externalPermissions: Array<{ requirement: string; reference: string }>;
  requestedFacts: string[];
  stopConditions: string[];
  nonClaims: DelegatedActionProfileV1["omissions"];
  orderDigest: `sha256:${string}`;
}

export function compileDelegatedActionOrder(
  profileInput: DelegatedActionProfileV1,
  orderInput: DelegatedActionOrderV1,
): CompiledDelegatedActionOrderV1 {
  const profile = DelegatedActionProfileV1.parse(profileInput);
  const order = DelegatedActionOrderV1.parse(orderInput);
  if (order.profileId !== profile.id || order.profileVersion !== profile.version) {
    throw new Error("delegated-action order profile identity mismatch");
  }
  if (order.target.resourceType !== profile.targetResourceType) {
    throw new Error("delegated-action target resource type is outside the Profile");
  }
  if (order.requesterPrincipalId === order.executorPrincipalId) {
    throw new Error("delegated-action requester and executor must be distinct");
  }
  if (order.dueAt <= order.notBefore) throw new Error("delegated-action window must be positive");
  const suppliedPermissionNames = Object.keys(order.externalPermissionRefs).sort();
  const requiredPermissionNames = [...profile.externalPermissionRequirements].sort();
  if (canonicalizeEffectJson(suppliedPermissionNames) !== canonicalizeEffectJson(requiredPermissionNames)) {
    throw new Error("delegated-action permissions must match the Profile exactly");
  }
  const permissions = profile.externalPermissionRequirements.map((requirement) => {
    const reference = order.externalPermissionRefs[requirement]?.trim();
    if (!reference) throw new Error(`delegated-action permission missing: ${requirement}`);
    return { requirement, reference };
  });
  const target = prepareTargetRefV1(order.target);
  const requestedFacts = [...new Set(order.requestedFacts)].sort();
  const withoutDigest = {
    contractVersion: "tasq.compiled-delegated-action-order.v1" as const,
    profile: { id: profile.id, version: profile.version, capabilityUri: profile.capabilityUri },
    target,
    parties: { requesterPrincipalId: order.requesterPrincipalId, executorPrincipalId: order.executorPrincipalId },
    commitment: {
      title: profile.title,
      successCriteria: profile.criteria.map(({ statement }) => statement).join(" "),
      completionPolicy: "evidence" as const,
      validationRequired: true as const,
      notBefore: order.notBefore,
      dueAt: order.dueAt,
    },
    resolution: { criteria: profile.criteria, policyKind: "attestation" as const, independentReviewRequired: true as const },
    capture: profile.capture,
    attestationPurposes: profile.attestationPurposes,
    externalPermissions: permissions,
    requestedFacts,
    stopConditions: [...profile.stopConditions],
    nonClaims: [...profile.omissions],
  };
  const orderDigest = `sha256:${createHash("sha256").update(
    `tasq.compiled-delegated-action-order.v1\0${canonicalizeEffectJson(withoutDigest)}`,
  ).digest("hex")}` as const;
  return deepFreeze({ ...withoutDigest, orderDigest });
}
