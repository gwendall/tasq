/** Versioned settlement and recourse decisions over exact durable facts. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { EffectRequestEnvelope, EffectStatus, canonicalizeEffectJson } from "./effects.js";
import { Sha256Digest } from "./extensions.js";
import { ValidationOutcome } from "./resolution.js";
import { AttemptStatus, Metadata, TaskStatus, UnixMs, UuidV7 } from "./types.js";

const Portable = z.string().min(1).max(500)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const AbsoluteUri = z.string().url().max(2_000);
const RuleId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const SETTLEMENT_CLASSIFICATIONS = [
  "full",
  "partial",
  "show_up",
  "cancellation",
  "rework",
  "credit",
  "indeterminate",
] as const;
export const SettlementClassificationV1 = z.enum(SETTLEMENT_CLASSIFICATIONS);
export type SettlementClassificationV1 = z.infer<typeof SettlementClassificationV1>;

export const SettlementTaskSnapshotV1 = z.object({
  id: UuidV7,
  revision: z.number().int().positive(),
  status: TaskStatus,
}).strict();

export const SettlementAttemptSnapshotV1 = z.object({
  id: UuidV7,
  revision: z.number().int().positive(),
  status: AttemptStatus,
}).strict();

export const SettlementValidationSnapshotV1 = z.object({
  id: UuidV7,
  outcome: ValidationOutcome,
  reasonCode: Portable,
  policyInputDigest: Sha256Digest,
  decidedAt: UnixMs,
}).strict();

export const SettlementEffectSnapshotV1 = z.object({
  id: UuidV7,
  revision: z.number().int().positive(),
  status: EffectStatus,
  requestDigest: Sha256Digest,
}).strict();

export const SettlementBasisV1 = z.object({
  contractVersion: z.literal("tasq.settlement-basis.v1"),
  agreementOfferId: UuidV7,
  activationId: UuidV7,
  activationDigest: Sha256Digest,
  termsDigest: Sha256Digest,
  obligationId: RuleId,
  resolutionContractId: UuidV7,
  task: SettlementTaskSnapshotV1,
  attempts: z.array(SettlementAttemptSnapshotV1).max(100),
  validation: SettlementValidationSnapshotV1.nullable(),
  effects: z.array(SettlementEffectSnapshotV1).max(100),
  priorSettlementDecisionId: UuidV7.nullable(),
}).strict().superRefine((value, ctx) => {
  for (const [path, rows] of [["attempts", value.attempts], ["effects", value.effects]] as const) {
    if (rows.some((row, index) => index > 0 && rows[index - 1]!.id >= row.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "must be sorted by unique id" });
    }
  }
  if (value.priorSettlementDecisionId === null && value.effects.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effects"], message: "effect facts require a prior settlement decision" });
  }
});
export type SettlementBasisV1 = z.infer<typeof SettlementBasisV1>;

const EntitlementTaskV1 = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).nullable().default(null),
  successCriteria: z.string().min(1).max(2_000),
  dueAt: UnixMs.nullable().default(null),
  metadata: Metadata.default({}),
}).strict();

export const SettlementEntitlementV1 = z.object({
  id: RuleId,
  obligorPrincipalId: Portable,
  beneficiaryPrincipalId: Portable,
  task: EntitlementTaskV1,
  effect: z.object({
    request: EffectRequestEnvelope,
    compensationOfEffectId: UuidV7.nullable().default(null),
  }).strict().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.obligorPrincipalId === value.beneficiaryPrincipalId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beneficiaryPrincipalId"], message: "obligor and beneficiary must differ" });
  }
});
export type SettlementEntitlementV1 = z.infer<typeof SettlementEntitlementV1>;

export const SettlementRuleConditionV1 = z.object({
  taskStatuses: z.array(TaskStatus).max(5).default([]),
  anyAttemptStatuses: z.array(AttemptStatus).max(8).default([]),
  validationOutcomes: z.array(ValidationOutcome).max(5).default([]),
  validationReasonCodes: z.array(Portable).max(100).default([]),
  anyEffectStatuses: z.array(EffectStatus).max(7).default([]),
}).strict();
export type SettlementRuleConditionV1 = z.infer<typeof SettlementRuleConditionV1>;

export const SettlementPolicyRuleV1 = z.object({
  id: RuleId,
  when: SettlementRuleConditionV1,
  classification: SettlementClassificationV1,
  entitlements: z.array(SettlementEntitlementV1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = value.entitlements.map(({ id }) => id);
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entitlements"], message: "must be sorted by unique id" });
  }
});
export type SettlementPolicyRuleV1 = z.infer<typeof SettlementPolicyRuleV1>;

export const SettlementPolicyV1 = z.object({
  contractVersion: z.literal("tasq.settlement-policy.v1"),
  policyUri: AbsoluteUri,
  policyVersion: z.number().int().positive(),
  implementationDigest: Sha256Digest,
  rules: z.array(SettlementPolicyRuleV1).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = value.rules.map(({ id }) => id);
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules"], message: "must be sorted by unique id" });
  }
});
export type SettlementPolicyV1 = z.infer<typeof SettlementPolicyV1>;

export const SettlementDecisionKindV1 = z.enum(["settlement", "recourse"]);
export type SettlementDecisionKindV1 = z.infer<typeof SettlementDecisionKindV1>;

export const SettlementDecisionV1 = z.object({
  contractVersion: z.literal("tasq.settlement-decision.v1"),
  id: UuidV7,
  workspaceId: Portable,
  decisionKind: SettlementDecisionKindV1,
  basis: SettlementBasisV1,
  basisDigest: Sha256Digest,
  policy: SettlementPolicyV1,
  policyDigest: Sha256Digest,
  matchedRuleId: RuleId,
  classification: SettlementClassificationV1,
  entitlements: z.array(SettlementEntitlementV1).max(100),
  supersedesDecisionId: UuidV7.nullable(),
  decidedByPrincipalId: Portable,
  decidedAt: UnixMs,
  decisionDigest: Sha256Digest,
}).strict();
export type SettlementDecisionV1 = z.infer<typeof SettlementDecisionV1>;

export const SettlementMaterializationV1 = z.object({
  contractVersion: z.literal("tasq.settlement-materialization.v1"),
  id: UuidV7,
  workspaceId: Portable,
  decisionId: UuidV7,
  entitlementId: RuleId,
  commitmentId: UuidV7,
  effectId: UuidV7.nullable(),
  createdAt: UnixMs,
}).strict();
export type SettlementMaterializationV1 = z.infer<typeof SettlementMaterializationV1>;

export const SettlementViewV1 = z.object({
  contractVersion: z.literal("tasq.settlement-view.v1"),
  decision: SettlementDecisionV1,
  materializations: z.array(SettlementMaterializationV1),
  supersededByDecisionId: UuidV7.nullable(),
  assurance: z.object({
    completionRewritten: z.literal(false),
    effectAuthorityGranted: z.literal(false),
    escrowOrRecordRoleAsserted: z.literal(false),
  }).strict(),
}).strict();
export type SettlementViewV1 = z.infer<typeof SettlementViewV1>;

export const SettlementEvaluationInputV1 = z.object({
  agreementOfferId: UuidV7,
  obligationId: RuleId,
  attemptIds: z.array(UuidV7).max(100).default([]),
  validationDecisionId: UuidV7.nullable().default(null),
  effectIds: z.array(UuidV7).max(100).default([]),
  priorSettlementDecisionId: UuidV7.nullable().default(null),
  supersedesDecisionId: UuidV7.nullable().default(null),
  policy: SettlementPolicyV1,
}).strict();
export type SettlementEvaluationInputV1 = z.input<typeof SettlementEvaluationInputV1>;

export function settlementBasisDigest(value: SettlementBasisV1): `sha256:${string}` {
  return digest("tasq.settlement-basis.v1\0", value);
}

export function settlementPolicyDigest(value: SettlementPolicyV1): `sha256:${string}` {
  return digest("tasq.settlement-policy.v1\0", value);
}

export function settlementDecisionDigest(
  value: Omit<SettlementDecisionV1, "decisionDigest">,
): `sha256:${string}` {
  return digest("tasq.settlement-decision.v1\0", value);
}

function digest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(domain + canonicalizeEffectJson(value)).digest("hex")}`;
}
