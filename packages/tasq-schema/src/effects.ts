/** Language-neutral effect request identity and canonicalization contract. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpsUri, Sha256Digest } from "./extensions.js";

const UuidV7 = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);

export const EFFECT_REQUEST_PROTOCOL = "tasq.effect-request.v1" as const;
export const EFFECT_REQUEST_CANONICALIZATION = "tasq.jcs-safe-integer.v1" as const;
export const EFFECT_REQUEST_DIGEST_ALGORITHM = "sha-256" as const;
export const EFFECT_REQUEST_DIGEST_DOMAIN = "tasq.effect-request-digest.v1\0" as const;
export const EFFECT_DISPATCH_KEY_DOMAIN = "tasq.effect-dispatch.v1\0" as const;

export const EFFECT_REQUEST_MAX_CANONICAL_BYTES = 65_536;
export const EFFECT_REQUEST_MAX_DEPTH = 32;
export const EFFECT_REQUEST_MAX_NODES = 10_000;

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const ScalarString = z.string().refine(hasOnlyUnicodeScalars, "must contain only Unicode scalar values");
function boundedScalarString(min: number, max: number) {
  return z.string().min(min).max(max)
    .refine(hasOnlyUnicodeScalars, "must contain only Unicode scalar values");
}
const SafeInteger = z.number().refine(
  (value) => Number.isSafeInteger(value) && !Object.is(value, -0),
  "must be a safe integer and not negative zero",
);

export type EffectJsonValue =
  | null
  | boolean
  | number
  | string
  | EffectJsonValue[]
  | { [key: string]: EffectJsonValue };

export const EffectJsonValue: z.ZodType<EffectJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  SafeInteger,
  ScalarString,
  z.array(EffectJsonValue),
  z.record(ScalarString, EffectJsonValue),
]));
export const EffectJsonObject = z.record(ScalarString, EffectJsonValue);
export type EffectJsonObject = z.infer<typeof EffectJsonObject>;

export const EffectSecretBinding = z.object({
  name: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
  ref: boundedScalarString(1, 512),
  version: boundedScalarString(1, 256),
  contentDigest: Sha256Digest.optional(),
}).strict();
export type EffectSecretBinding = z.infer<typeof EffectSecretBinding>;

export const EffectConnectorBinding = z.object({
  operationUri: HttpsUri,
  operationVersion: z.number().int().positive(),
  contractDigest: Sha256Digest,
  instanceRef: boundedScalarString(1, 512),
  bindingDigest: Sha256Digest,
}).strict();
export type EffectConnectorBinding = z.infer<typeof EffectConnectorBinding>;

export const EffectRequestEnvelope = z.object({
  protocol: z.literal(EFFECT_REQUEST_PROTOCOL),
  canonicalization: z.literal(EFFECT_REQUEST_CANONICALIZATION),
  digestAlgorithm: z.literal(EFFECT_REQUEST_DIGEST_ALGORITHM),
  workspaceId: boundedScalarString(1, 256),
  effectTypeUri: HttpsUri,
  effectSchemaVersion: z.number().int().positive(),
  connector: EffectConnectorBinding,
  parameters: z.record(ScalarString, EffectJsonValue),
  secretBindings: z.array(EffectSecretBinding).max(256),
}).strict();
export type EffectRequestEnvelope = z.infer<typeof EffectRequestEnvelope>;

export interface PreparedEffectRequest {
  request: EffectRequestEnvelope;
  canonicalRequest: string;
  requestDigest: string;
}

interface CanonicalizationBudget {
  nodes: number;
}

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertPlainDataObject(value: object): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Effect canonicalization requires plain JSON objects");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("Effect canonicalization does not support symbol keys");
    }
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      throw new Error(`Effect canonicalization rejects reserved object key: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Effect canonicalization requires enumerable data properties");
    }
  }
}

function serialize(value: unknown, depth: number, budget: CanonicalizationBudget): string {
  budget.nodes += 1;
  if (budget.nodes > EFFECT_REQUEST_MAX_NODES) {
    throw new Error(`Effect request exceeds ${EFFECT_REQUEST_MAX_NODES} JSON nodes`);
  }
  if (depth > EFFECT_REQUEST_MAX_DEPTH) {
    throw new Error(`Effect request exceeds depth ${EFFECT_REQUEST_MAX_DEPTH}`);
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (!hasOnlyUnicodeScalars(value)) {
      throw new Error("Effect canonicalization rejects lone Unicode surrogates");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Effect canonicalization accepts safe integers only and rejects negative zero");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error("Effect canonicalization rejects sparse arrays");
    }
    return `[${value.map((child) => serialize(child, depth + 1, budget)).join(",")}]`;
  }
  if (typeof value === "object") {
    assertPlainDataObject(value);
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => {
        if (!hasOnlyUnicodeScalars(key)) {
          throw new Error("Effect canonicalization rejects lone Unicode surrogates in object keys");
        }
        return `${JSON.stringify(key)}:${serialize(child, depth + 1, budget)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`Effect canonicalization does not support ${typeof value}`);
}

/**
 * Strict RFC 8785-compatible subset for authority-bearing effect requests.
 * Unlike the extension-manifest helper, this rejects undefined and all
 * non-integer JSON numbers rather than coercing or omitting them.
 */
export function canonicalizeEffectJson(value: unknown): string {
  const canonical = serialize(value, 0, { nodes: 0 });
  if (new TextEncoder().encode(canonical).byteLength > EFFECT_REQUEST_MAX_CANONICAL_BYTES) {
    throw new Error(`Effect request exceeds ${EFFECT_REQUEST_MAX_CANONICAL_BYTES} canonical bytes`);
  }
  return canonical;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function prepareEffectRequest(input: unknown): PreparedEffectRequest {
  // Validate the unmodified input before Zod clones it. This prevents a parser
  // or object library from silently erasing a dangerous-but-meaningful key.
  canonicalizeEffectJson(input);
  const parsed = EffectRequestEnvelope.parse(input);
  parsed.secretBindings.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (let index = 1; index < parsed.secretBindings.length; index += 1) {
    if (parsed.secretBindings[index - 1]?.name === parsed.secretBindings[index]?.name) {
      throw new Error(`Duplicate effect secret binding: ${parsed.secretBindings[index]?.name}`);
    }
  }
  const canonicalRequest = canonicalizeEffectJson(parsed);
  const requestDigest = `sha256:${sha256Hex(EFFECT_REQUEST_DIGEST_DOMAIN + canonicalRequest)}`;
  return deepFreeze({ request: parsed, canonicalRequest, requestDigest });
}

/** Stable across connector retries for one effect; distinct for a new intentional occurrence. */
export function deriveEffectDispatchKey(
  effectId: string,
  prepared: Pick<PreparedEffectRequest, "request" | "requestDigest">,
): string {
  UuidV7.parse(effectId);
  Sha256Digest.parse(prepared.requestDigest);
  const preimage = [
    EFFECT_DISPATCH_KEY_DOMAIN,
    prepared.request.workspaceId,
    "\0",
    effectId,
    "\0",
    prepared.requestDigest,
  ].join("");
  const encoded = createHash("sha256").update(preimage, "utf8").digest("base64url");
  return `tqfx1_${encoded}`;
}

export const EFFECT_STATUSES = [
  "proposed",
  "authorized",
  "executing",
  "committed",
  "failed",
  "indeterminate",
  "cancelled",
] as const;
export const EffectStatus = z.enum(EFFECT_STATUSES);
export type EffectStatus = z.infer<typeof EffectStatus>;

export const APPROVAL_DECISIONS = ["approved", "denied", "revoked"] as const;
export const ApprovalDecision = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const APPROVAL_VERIFICATION_LEVELS = [
  "self_asserted",
  "authenticated_context",
  "cryptographic",
] as const;
export const ApprovalVerificationLevel = z.enum(APPROVAL_VERIFICATION_LEVELS);
export type ApprovalVerificationLevel = z.infer<typeof ApprovalVerificationLevel>;

const UnixMs = z.number().int().nonnegative();

export const Effect = z.object({
  id: UuidV7,
  tenantId: boundedScalarString(1, 256),
  taskId: UuidV7,
  attemptId: UuidV7.nullable(),
  request: EffectRequestEnvelope,
  canonicalRequest: z.string().min(1),
  requestDigest: Sha256Digest,
  dispatchIdempotencyKey: z.string().regex(/^tqfx1_[A-Za-z0-9_-]{43}$/),
  status: EffectStatus,
  authorizedByApprovalId: UuidV7.nullable(),
  outcomeReceiptId: UuidV7.nullable(),
  claimId: UuidV7.nullable(),
  fence: z.number().int().positive().nullable(),
  supersedesEffectId: UuidV7.nullable(),
  compensationOfEffectId: UuidV7.nullable(),
  createdByPrincipalId: z.string().min(1),
  revision: z.number().int().positive(),
  authorizedAt: UnixMs.nullable(),
  executionStartedAt: UnixMs.nullable(),
  indeterminateAt: UnixMs.nullable(),
  resolvedAt: UnixMs.nullable(),
  cancelledAt: UnixMs.nullable(),
  cancelReason: z.string().min(1).nullable(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).superRefine((value, ctx) => {
  const present = (field: keyof typeof value) => value[field] != null;
  const requirePresent = (field: keyof typeof value) => {
    if (!present(field)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `required for ${value.status}` });
  };
  const requireAbsent = (field: keyof typeof value) => {
    if (present(field)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `must be absent for ${value.status}` });
  };
  if (value.updatedAt < value.createdAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["updatedAt"], message: "must not precede createdAt" });
  }
  if (value.authorizedAt != null && value.authorizedAt < value.createdAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authorizedAt"], message: "must not precede createdAt" });
  }
  if (value.executionStartedAt != null && (value.authorizedAt == null || value.executionStartedAt < value.authorizedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executionStartedAt"], message: "must not precede authorization" });
  }
  if (value.indeterminateAt != null && (value.executionStartedAt == null || value.indeterminateAt < value.executionStartedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["indeterminateAt"], message: "must not precede execution" });
  }
  if (value.resolvedAt != null && (value.executionStartedAt == null || value.resolvedAt < value.executionStartedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resolvedAt"], message: "must not precede execution" });
  }
  if (value.cancelledAt != null && value.cancelledAt < value.createdAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cancelledAt"], message: "must not precede createdAt" });
  }

  const authorityFields = ["authorizedByApprovalId", "authorizedAt"] as const;
  const executionFields = ["claimId", "fence", "executionStartedAt"] as const;
  const cancellationFields = ["cancelledAt", "cancelReason"] as const;
  if (value.status === "proposed") {
    for (const field of [...authorityFields, ...executionFields, "outcomeReceiptId", "indeterminateAt", "resolvedAt", ...cancellationFields] as const) requireAbsent(field);
  } else if (value.status === "authorized") {
    for (const field of authorityFields) requirePresent(field);
    for (const field of [...executionFields, "outcomeReceiptId", "indeterminateAt", "resolvedAt", ...cancellationFields] as const) requireAbsent(field);
  } else if (value.status === "executing") {
    for (const field of [...authorityFields, ...executionFields] as const) requirePresent(field);
    for (const field of ["outcomeReceiptId", "indeterminateAt", "resolvedAt", ...cancellationFields] as const) requireAbsent(field);
  } else if (value.status === "indeterminate") {
    for (const field of [...authorityFields, ...executionFields, "outcomeReceiptId", "indeterminateAt"] as const) requirePresent(field);
    for (const field of ["resolvedAt", ...cancellationFields] as const) requireAbsent(field);
  } else if (value.status === "committed" || value.status === "failed") {
    for (const field of [...authorityFields, ...executionFields, "outcomeReceiptId", "resolvedAt"] as const) requirePresent(field);
    for (const field of cancellationFields) requireAbsent(field);
  } else {
    for (const field of [...authorityFields, ...executionFields, "outcomeReceiptId", "indeterminateAt", "resolvedAt"] as const) requireAbsent(field);
    for (const field of cancellationFields) requirePresent(field);
    if (!value.cancelReason?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cancelReason"], message: "must not be blank" });
    }
  }
});
export type Effect = z.infer<typeof Effect>;

export const EffectProposal = z.object({
  id: UuidV7.optional(),
  tenantId: boundedScalarString(1, 256).default("gwendall"),
  taskId: UuidV7,
  attemptId: UuidV7.nullable().default(null),
  request: EffectRequestEnvelope,
  supersedesEffectId: UuidV7.nullable().default(null),
  compensationOfEffectId: UuidV7.nullable().default(null),
}).strict().refine(
  (value) => value.supersedesEffectId == null || value.compensationOfEffectId == null,
  "An effect cannot be both a correction and a compensation",
);
export type EffectProposal = z.infer<typeof EffectProposal>;

export const EffectApproval = z.object({
  id: UuidV7,
  tenantId: boundedScalarString(1, 256),
  effectId: UuidV7,
  requestDigest: Sha256Digest,
  approverPrincipalId: z.string().min(1),
  decision: ApprovalDecision,
  scope: EffectJsonObject,
  limits: EffectJsonObject,
  validFrom: UnixMs.nullable(),
  expiresAt: UnixMs.nullable(),
  verificationLevel: ApprovalVerificationLevel,
  verificationMethod: z.string().min(1),
  verification: EffectJsonObject,
  supersedesApprovalId: UuidV7.nullable(),
  decidedAt: UnixMs,
}).superRefine((value, ctx) => {
  if (value.decision === "revoked" && value.supersedesApprovalId == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supersedesApprovalId"], message: "required for revocation" });
  }
  if (value.expiresAt != null && value.expiresAt <= value.decidedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "must be after decidedAt" });
  }
  if (value.validFrom != null && value.expiresAt != null && value.expiresAt <= value.validFrom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "must be after validFrom" });
  }
});
export type EffectApproval = z.infer<typeof EffectApproval>;

export const EffectApprovalDecision = z.object({
  id: UuidV7.optional(),
  tenantId: boundedScalarString(1, 256).default("gwendall"),
  effectId: UuidV7,
  decision: ApprovalDecision,
  scope: EffectJsonObject.default({}),
  limits: EffectJsonObject.default({}),
  validFrom: UnixMs.nullable().default(null),
  expiresAt: UnixMs.nullable().default(null),
  supersedesApprovalId: UuidV7.nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.decision === "revoked" && value.supersedesApprovalId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersedesApprovalId"],
      message: "Revocation must supersede an approval",
    });
  }
  if (value.validFrom != null && value.expiresAt != null && value.expiresAt <= value.validFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must be after validFrom",
    });
  }
});
export type EffectApprovalDecision = z.infer<typeof EffectApprovalDecision>;

export const EFFECT_DISPATCH_PERMIT_CONTRACT = "tasq.effect-dispatch-permit.v1" as const;

export const EffectDispatchPermitPayload = z.object({
  contractVersion: z.literal(EFFECT_DISPATCH_PERMIT_CONTRACT),
  issuedAt: UnixMs,
  workspaceId: boundedScalarString(1, 256),
  effectId: UuidV7,
  effectRevision: z.number().int().positive(),
  effectStatus: z.literal("executing"),
  taskId: UuidV7,
  attemptId: UuidV7,
  request: EffectRequestEnvelope,
  canonicalRequest: z.string().min(1),
  requestDigest: Sha256Digest,
  dispatchIdempotencyKey: z.string().regex(/^tqfx1_[A-Za-z0-9_-]{43}$/),
  approval: z.object({
    id: UuidV7,
    requestDigest: Sha256Digest,
    approverPrincipalId: z.string().min(1),
    decision: z.literal("approved"),
    scope: EffectJsonObject,
    limits: EffectJsonObject,
    validFrom: UnixMs.nullable(),
    expiresAt: UnixMs.nullable(),
    verificationLevel: ApprovalVerificationLevel,
    verificationMethod: z.string().min(1),
    verification: EffectJsonObject,
    decidedAt: UnixMs,
  }).strict(),
  claim: z.object({
    id: UuidV7,
    fence: z.number().int().positive(),
    principalId: z.string().min(1),
    expiresAt: UnixMs,
  }).strict(),
  executionStartedAt: UnixMs,
}).strict().superRefine((value, ctx) => {
  if (value.workspaceId !== value.request.workspaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceId"], message: "must match request workspace" });
  }
  if (value.approval.requestDigest !== value.requestDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "requestDigest"], message: "must match request digest" });
  }
  if (value.executionStartedAt !== value.issuedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executionStartedAt"], message: "must equal issuedAt" });
  }
  if (value.claim.expiresAt <= value.issuedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["claim", "expiresAt"], message: "claim must be live when issued" });
  }
  if (value.approval.validFrom != null && value.issuedAt < value.approval.validFrom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "validFrom"], message: "approval is not valid when issued" });
  }
  if (value.approval.expiresAt != null && value.issuedAt >= value.approval.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "expiresAt"], message: "approval is expired when issued" });
  }
});
export type EffectDispatchPermitPayload = z.infer<typeof EffectDispatchPermitPayload>;

export const EffectDispatchPermit = z.object({
  payload: EffectDispatchPermitPayload,
  authentication: z.object({
    algorithm: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    keyId: boundedScalarString(1, 256),
    signature: z.string().regex(/^[A-Za-z0-9_-]{32,1024}$/),
  }).strict(),
}).strict();
export type EffectDispatchPermit = z.infer<typeof EffectDispatchPermit>;

export const EFFECT_RECEIPT_PROTOCOL = "tasq.effect-receipt.v1" as const;
export const EFFECT_RECEIPT_DIGEST_DOMAIN = "tasq.effect-receipt-digest.v1\0" as const;
export const EFFECT_RECEIPT_OUTCOMES = ["committed", "failed", "indeterminate"] as const;
export const EffectReceiptOutcome = z.enum(EFFECT_RECEIPT_OUTCOMES);
export type EffectReceiptOutcome = z.infer<typeof EffectReceiptOutcome>;

export const EFFECT_RECEIPT_COVERAGE = [
  "provider_account",
  "provider_operation",
  "request_identity",
  "outcome",
] as const;
export const EffectReceiptCoverage = z.enum(EFFECT_RECEIPT_COVERAGE);
export type EffectReceiptCoverage = z.infer<typeof EffectReceiptCoverage>;

export const EffectReceiptReport = z.object({
  protocol: z.literal(EFFECT_RECEIPT_PROTOCOL),
  workspaceId: boundedScalarString(1, 256),
  effectId: UuidV7,
  requestDigest: Sha256Digest,
  dispatchIdempotencyKey: z.string().regex(/^tqfx1_[A-Za-z0-9_-]{43}$/),
  approvalId: UuidV7,
  claimId: UuidV7,
  fence: z.number().int().positive(),
  connectorInstanceRef: boundedScalarString(1, 512),
  connectorBindingDigest: Sha256Digest,
  externalReceiptId: boundedScalarString(1, 512),
  providerOperationId: boundedScalarString(1, 512).nullable(),
  outcome: EffectReceiptOutcome,
  occurredAt: UnixMs,
  rawRef: boundedScalarString(1, 2_048),
  rawDigest: Sha256Digest,
  payload: EffectJsonObject,
  resolvesReceiptId: UuidV7.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.outcome !== "indeterminate" && value.providerOperationId == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerOperationId"], message: "required for a terminal provider outcome" });
  }
  if (value.outcome === "indeterminate" && value.providerOperationId != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerOperationId"], message: "must be absent while the provider outcome is unknown" });
  }
  if (value.outcome === "indeterminate" && value.resolvesReceiptId != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resolvesReceiptId"], message: "an uncertainty report cannot resolve another receipt" });
  }
});
export type EffectReceiptReport = z.infer<typeof EffectReceiptReport>;

export interface PreparedEffectReceiptReport {
  report: EffectReceiptReport;
  canonicalReport: string;
  receiptDigest: string;
}

export function prepareEffectReceiptReport(input: unknown): PreparedEffectReceiptReport {
  canonicalizeEffectJson(input);
  const report = EffectReceiptReport.parse(input);
  const canonicalReport = canonicalizeEffectJson(report);
  const receiptDigest = `sha256:${sha256Hex(EFFECT_RECEIPT_DIGEST_DOMAIN + canonicalReport)}`;
  return deepFreeze({ report, canonicalReport, receiptDigest });
}

export const EffectReceipt = z.object({
  id: UuidV7,
  tenantId: boundedScalarString(1, 256),
  effectId: UuidV7,
  taskId: UuidV7,
  attemptId: UuidV7,
  approvalId: UuidV7,
  evidenceId: UuidV7,
  report: EffectReceiptReport,
  canonicalReport: z.string().min(1),
  receiptDigest: Sha256Digest,
  verificationLevel: ApprovalVerificationLevel,
  verificationMethod: z.string().min(1),
  coverage: z.array(EffectReceiptCoverage).max(EFFECT_RECEIPT_COVERAGE.length),
  verification: EffectJsonObject,
  recordedByPrincipalId: z.string().min(1),
  recordedAt: UnixMs,
}).superRefine((value, ctx) => {
  if (value.tenantId !== value.report.workspaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tenantId"], message: "must match report workspace" });
  }
  if (value.effectId !== value.report.effectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectId"], message: "must match report effect" });
  }
  if (value.approvalId !== value.report.approvalId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approvalId"], message: "must match report approval" });
  }
  if (new Set(value.coverage).size !== value.coverage.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage"], message: "must not contain duplicates" });
  }
  if (value.report.outcome !== "indeterminate") {
    if (value.verificationLevel === "self_asserted") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verificationLevel"], message: "terminal outcomes require independent verification" });
    }
    for (const required of EFFECT_RECEIPT_COVERAGE) {
      if (!value.coverage.includes(required)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage"], message: `terminal outcome is missing ${required}` });
      }
    }
  }
});
export type EffectReceipt = z.infer<typeof EffectReceipt>;

export const EffectReceiptInput = z.object({
  id: UuidV7.optional(),
  evidenceId: UuidV7.optional(),
  report: EffectReceiptReport,
}).strict();
export type EffectReceiptInput = z.infer<typeof EffectReceiptInput>;
