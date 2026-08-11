/**
 * Bounded human-attention planning.
 *
 * The module is deliberately transport- and calendar-provider-neutral. A
 * policy owner materializes do-not-disturb rules into absolute half-open
 * intervals; the notifier only enforces them. Decision quality is supplied by
 * an external evaluator and is never inferred from delivery success.
 */

import { createHash } from "node:crypto";
import { canonicalizeEffectJson } from "@tasq-run/schema";
import { z } from "zod";
import type {
  AttentionDeliveryResult,
  AttentionWebhookSink,
} from "./index.js";

export const ATTENTION_BATCH_CONTRACT_VERSION = "tasq.attention-batch.v1" as const;
export const INPUT_REQUIRED_ATTENTION_KIND = "input_required" as const;
export const MAXIMUM_ATTENTION_BATCH_ITEMS = 50;
export const MAXIMUM_ATTENTION_BATCH_BYTES = 65_536;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const UnixMs = z.number().int().nonnegative().safe();

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeEffectJson(value as never))
    .digest("hex")}`;
}

const InputRequiredAttentionInput = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  eventId: z.string().trim().min(1).max(500),
  eventSequence: z.number().int().positive().safe(),
  recipientRef: z.string().trim().min(1).max(500),
  commitmentId: z.string().trim().min(1).max(500),
  attemptId: z.string().trim().min(1).max(500),
  reasonCode: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2_000),
  decisionContextDigest: Digest,
  requestedAt: UnixMs,
  respondBy: UnixMs.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.respondBy !== null && value.respondBy < value.requestedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["respondBy"],
      message: "respondBy must not precede requestedAt",
    });
  }
});

export interface InputRequiredAttentionRequest
  extends z.output<typeof InputRequiredAttentionInput> {
  contractVersion: "tasq.input-required-attention.v1";
  kind: typeof INPUT_REQUIRED_ATTENTION_KIND;
  requestId: string;
  payloadDigest: string;
}

export function createInputRequiredAttentionRequest(
  input: z.input<typeof InputRequiredAttentionInput>,
): Readonly<InputRequiredAttentionRequest> {
  const parsed = InputRequiredAttentionInput.parse(input);
  const content = {
    contractVersion: "tasq.input-required-attention.v1" as const,
    kind: INPUT_REQUIRED_ATTENTION_KIND,
    ...parsed,
  };
  const payloadDigest = digest(content);
  const requestId = `attention-request:${digest({
    workspaceId: parsed.workspaceId,
    eventId: parsed.eventId,
    eventSequence: parsed.eventSequence,
    recipientRef: parsed.recipientRef,
    commitmentId: parsed.commitmentId,
    attemptId: parsed.attemptId,
  }).slice("sha256:".length)}`;
  return Object.freeze({ ...content, requestId, payloadDigest });
}

const DoNotDisturbWindow = z.object({
  startsAt: UnixMs,
  endsAt: UnixMs,
  sourceRef: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  if (value.endsAt <= value.startsAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: "do-not-disturb window must have positive duration",
    });
  }
});

const AttentionPolicyDefinition = z.object({
  contractVersion: z.literal("tasq.attention-policy.v1").default("tasq.attention-policy.v1"),
  recipientRef: z.string().trim().min(1).max(500),
  maximumBatchItems: z.number().int().min(1).max(MAXIMUM_ATTENTION_BATCH_ITEMS).default(25),
  maximumBatchWaitMs: z.number().int().min(0).max(86_400_000).safe().default(300_000),
  maximumBatchBytes: z.number().int().min(4_096).max(MAXIMUM_ATTENTION_BATCH_BYTES).safe()
    .default(MAXIMUM_ATTENTION_BATCH_BYTES),
  doNotDisturbWindows: z.array(DoNotDisturbWindow).max(128).default([]),
}).strict();

export type AttentionPolicy = z.output<typeof AttentionPolicyDefinition> & { policyDigest: string };

export function defineAttentionPolicy(input: z.input<typeof AttentionPolicyDefinition>): Readonly<AttentionPolicy> {
  const parsed = AttentionPolicyDefinition.parse(input);
  const windows = [...parsed.doNotDisturbWindows]
    .sort((left, right) => left.startsAt - right.startsAt || left.endsAt - right.endsAt)
    .map((window) => Object.freeze({ ...window }));
  const definition = { ...parsed, doNotDisturbWindows: windows };
  return Object.freeze({
    ...definition,
    doNotDisturbWindows: Object.freeze(windows),
    policyDigest: digest(definition),
  }) as Readonly<AttentionPolicy>;
}

export interface AttentionBatchEnvelope {
  contractVersion: typeof ATTENTION_BATCH_CONTRACT_VERSION;
  deliveryId: string;
  workspaceId: string;
  recipientRef: string;
  policyDigest: string;
  requestIds: string[];
  requests: InputRequiredAttentionRequest[];
  firstRequestedAt: number;
  lastRequestedAt: number;
  payloadDigest: string;
}

function createAttentionBatchEnvelope(
  requests: InputRequiredAttentionRequest[],
  policy: AttentionPolicy,
): Readonly<AttentionBatchEnvelope> {
  const first = requests[0]!;
  const content = {
    contractVersion: ATTENTION_BATCH_CONTRACT_VERSION,
    workspaceId: first.workspaceId,
    recipientRef: first.recipientRef,
    policyDigest: policy.policyDigest,
    requestIds: requests.map((request) => request.requestId),
    requests,
    firstRequestedAt: requests[0]!.requestedAt,
    lastRequestedAt: requests.at(-1)!.requestedAt,
  };
  const payloadDigest = digest(content);
  const deliveryId = `attention-batch:${digest({
    workspaceId: content.workspaceId,
    recipientRef: content.recipientRef,
    policyDigest: content.policyDigest,
    requestDigests: requests.map((request) => request.payloadDigest),
  }).slice("sha256:".length)}`;
  return Object.freeze({ ...content, deliveryId, payloadDigest });
}

export type AttentionPlan =
  | Readonly<{
      outcome: "empty";
      batches: ReadonlyArray<never>;
      pendingRequestIds: ReadonlyArray<never>;
      nextEligibleAt: null;
    }>
  | Readonly<{
      outcome: "deferred";
      reason: "batch_window" | "do_not_disturb";
      batches: ReadonlyArray<never>;
      pendingRequestIds: ReadonlyArray<string>;
      nextEligibleAt: number;
      policyDigest: string;
    }>
  | Readonly<{
      outcome: "ready";
      batches: ReadonlyArray<Readonly<AttentionBatchEnvelope>>;
      pendingRequestIds: ReadonlyArray<never>;
      nextEligibleAt: null;
      policyDigest: string;
    }>;

function activeDoNotDisturbEnd(policy: AttentionPolicy, now: number): number | null {
  let end: number | null = null;
  for (const window of policy.doNotDisturbWindows) {
    if (window.startsAt > (end ?? now)) break;
    if (window.startsAt <= now && now < window.endsAt) end = Math.max(end ?? 0, window.endsAt);
    else if (end !== null && window.startsAt <= end) end = Math.max(end, window.endsAt);
  }
  return end;
}

function canonicalBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalizeEffectJson(value as never)).byteLength;
}

function packBatches(
  requests: InputRequiredAttentionRequest[],
  policy: AttentionPolicy,
): ReadonlyArray<Readonly<AttentionBatchEnvelope>> {
  const batches: AttentionBatchEnvelope[] = [];
  let cursor = 0;
  while (cursor < requests.length) {
    let end = Math.min(cursor + policy.maximumBatchItems, requests.length);
    let envelope = createAttentionBatchEnvelope(requests.slice(cursor, end), policy);
    while (canonicalBytes(envelope) > policy.maximumBatchBytes && end - cursor > 1) {
      end -= 1;
      envelope = createAttentionBatchEnvelope(requests.slice(cursor, end), policy);
    }
    if (canonicalBytes(envelope) > policy.maximumBatchBytes) {
      throw new Error(`Attention request exceeds the configured batch byte bound: ${requests[cursor]!.requestId}`);
    }
    batches.push(envelope);
    cursor = end;
  }
  return Object.freeze(batches);
}

/**
 * Plan one recipient's pending queue. DND always wins over fullness and
 * deadlines; only an explicit later policy revision can authorize interruption.
 */
export function planAttention(
  inputRequests: ReadonlyArray<InputRequiredAttentionRequest>,
  inputPolicy: AttentionPolicy,
  now: number,
): AttentionPlan {
  const { policyDigest, ...policyDefinition } = inputPolicy;
  const policy = defineAttentionPolicy(policyDefinition);
  if (policy.policyDigest !== policyDigest) throw new Error("Attention policy digest mismatch");
  UnixMs.parse(now);
  if (inputRequests.length === 0) {
    return Object.freeze({ outcome: "empty", batches: [], pendingRequestIds: [], nextEligibleAt: null });
  }
  const requests = inputRequests.map((request) => {
    const { contractVersion, kind, requestId, payloadDigest, ...raw } = request;
    const regenerated = createInputRequiredAttentionRequest(raw);
    if (contractVersion !== regenerated.contractVersion || kind !== regenerated.kind
      || requestId !== regenerated.requestId || payloadDigest !== regenerated.payloadDigest) {
      throw new Error(`Attention request identity or digest mismatch: ${requestId}`);
    }
    return regenerated as InputRequiredAttentionRequest;
  }).sort((left, right) => left.requestedAt - right.requestedAt
    || left.eventSequence - right.eventSequence || left.requestId.localeCompare(right.requestId));
  const first = requests[0]!;
  if (first.recipientRef !== policy.recipientRef) {
    throw new Error("Attention policy recipient does not match the pending queue");
  }
  if (requests.some((request) => request.workspaceId !== first.workspaceId
    || request.recipientRef !== first.recipientRef)) {
    throw new Error("One attention plan cannot mix workspaces or recipients");
  }
  if (new Set(requests.map((request) => request.requestId)).size !== requests.length) {
    throw new Error("Attention queue contains a duplicate request identity");
  }
  const dndEndsAt = activeDoNotDisturbEnd(policy, now);
  if (dndEndsAt !== null) {
    return Object.freeze({
      outcome: "deferred", reason: "do_not_disturb", batches: [],
      pendingRequestIds: requests.map((request) => request.requestId),
      nextEligibleAt: dndEndsAt, policyDigest: policy.policyDigest,
    });
  }
  const batchWindowEndsAt = first.requestedAt + policy.maximumBatchWaitMs;
  if (!Number.isSafeInteger(batchWindowEndsAt)) throw new Error("Attention batch window exceeds safe unix-ms range");
  const deadlineDue = requests.some((request) => request.respondBy !== null && request.respondBy <= now);
  if (requests.length < policy.maximumBatchItems && now < batchWindowEndsAt && !deadlineDue) {
    return Object.freeze({
      outcome: "deferred", reason: "batch_window", batches: [],
      pendingRequestIds: requests.map((request) => request.requestId),
      nextEligibleAt: batchWindowEndsAt, policyDigest: policy.policyDigest,
    });
  }
  return Object.freeze({
    outcome: "ready", batches: packBatches(requests, policy),
    pendingRequestIds: [], nextEligibleAt: null, policyDigest: policy.policyDigest,
  });
}

export type AttentionPlanDelivery =
  | { outcome: "not_delivered"; reason: "empty" | "batch_window" | "do_not_disturb"; nextEligibleAt: number | null }
  | { outcome: "delivered" | "partially_delivered"; results: AttentionDeliveryResult[] };

/** A notification surface that cannot call transport for a deferred plan. */
export async function deliverAttentionPlan(
  plan: AttentionPlan,
  sink: AttentionWebhookSink,
): Promise<AttentionPlanDelivery> {
  if (plan.outcome !== "ready") {
    return {
      outcome: "not_delivered",
      reason: plan.outcome === "empty" ? "empty" : plan.reason,
      nextEligibleAt: plan.nextEligibleAt,
    };
  }
  const results: AttentionDeliveryResult[] = [];
  for (const batch of plan.batches) {
    const result = await sink.deliver(batch);
    results.push(result);
    if (result.outcome !== "committed") {
      return { outcome: "partially_delivered", results };
    }
  }
  return { outcome: "delivered", results };
}

const CohortInput = z.object({
  workUnits: z.array(z.object({
    id: z.string().trim().min(1).max(500),
    decisionQualityMicros: z.number().int().min(0).max(1_000_000).nullable(),
  }).strict()).min(1).max(100_000),
  deliveries: z.array(z.object({
    deliveryId: z.string().trim().min(1).max(500),
    requestIds: z.array(z.string().trim().min(1).max(500)).min(1).max(MAXIMUM_ATTENTION_BATCH_ITEMS),
  }).strict()).max(100_000),
  requests: z.array(z.object({
    requestId: z.string().trim().min(1).max(500),
    workUnitId: z.string().trim().min(1).max(500),
  }).strict()).max(1_000_000),
}).strict();

export interface AttentionCohortMetrics {
  workUnitCount: number;
  requestCount: number;
  solicitationCount: number;
  deliveredRequestCount: number;
  deliveryCoverageMicros: number;
  solicitationsPerWorkUnitMicros: number;
  requestsPerSolicitationMicros: number | null;
  ratedDecisionCount: number;
  meanDecisionQualityMicros: number | null;
}

/** Measure delivery efficiency while keeping quality externally assessed. */
export function measureAttentionCohort(input: z.input<typeof CohortInput>): AttentionCohortMetrics {
  const parsed = CohortInput.parse(input);
  const workIds = new Set(parsed.workUnits.map((unit) => unit.id));
  if (workIds.size !== parsed.workUnits.length) throw new Error("Attention cohort has duplicate work-unit ids");
  const requestIds = new Set<string>();
  for (const request of parsed.requests) {
    if (!workIds.has(request.workUnitId)) throw new Error(`Attention request has unknown work unit: ${request.workUnitId}`);
    if (requestIds.has(request.requestId)) throw new Error(`Attention cohort has duplicate request: ${request.requestId}`);
    requestIds.add(request.requestId);
  }
  const delivered = new Set<string>();
  const deliveryIds = new Set<string>();
  for (const delivery of parsed.deliveries) {
    if (deliveryIds.has(delivery.deliveryId)) throw new Error(`Attention cohort has duplicate delivery: ${delivery.deliveryId}`);
    deliveryIds.add(delivery.deliveryId);
    for (const requestId of delivery.requestIds) {
      if (!requestIds.has(requestId)) throw new Error(`Attention delivery has unknown request: ${requestId}`);
      if (delivered.has(requestId)) throw new Error(`Attention request appears in multiple deliveries: ${requestId}`);
      delivered.add(requestId);
    }
  }
  const ratings = parsed.workUnits.flatMap((unit) => unit.decisionQualityMicros === null ? [] : [unit.decisionQualityMicros]);
  return {
    workUnitCount: parsed.workUnits.length,
    requestCount: parsed.requests.length,
    solicitationCount: parsed.deliveries.length,
    deliveredRequestCount: delivered.size,
    deliveryCoverageMicros: parsed.requests.length === 0 ? 1_000_000
      : Math.round(delivered.size * 1_000_000 / parsed.requests.length),
    solicitationsPerWorkUnitMicros: Math.round(parsed.deliveries.length * 1_000_000 / parsed.workUnits.length),
    requestsPerSolicitationMicros: parsed.deliveries.length === 0 ? null
      : Math.round(delivered.size * 1_000_000 / parsed.deliveries.length),
    ratedDecisionCount: ratings.length,
    meanDecisionQualityMicros: ratings.length === 0 ? null
      : Math.round(ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length),
  };
}

export function compareAttentionCohorts(
  baseline: AttentionCohortMetrics,
  candidate: AttentionCohortMetrics,
  maximumQualityLossMicros = 0,
) {
  if (!Number.isSafeInteger(maximumQualityLossMicros) || maximumQualityLossMicros < 0 || maximumQualityLossMicros > 1_000_000) {
    throw new Error("maximumQualityLossMicros must be an integer in 0..1000000");
  }
  const comparableQuality = baseline.meanDecisionQualityMicros !== null
    && candidate.meanDecisionQualityMicros !== null
    && baseline.ratedDecisionCount === baseline.workUnitCount
    && candidate.ratedDecisionCount === candidate.workUnitCount;
  const completeCoverage = baseline.deliveryCoverageMicros === 1_000_000
    && candidate.deliveryCoverageMicros === 1_000_000;
  return Object.freeze({
    contractVersion: "tasq.attention-cohort-comparison.v1" as const,
    coverageComparable: completeCoverage,
    solicitationsReduced: completeCoverage
      && candidate.solicitationsPerWorkUnitMicros < baseline.solicitationsPerWorkUnitMicros,
    solicitationReductionMicros: baseline.solicitationsPerWorkUnitMicros
      - candidate.solicitationsPerWorkUnitMicros,
    qualityComparable: comparableQuality,
    decisionQualityRetained: comparableQuality
      ? candidate.meanDecisionQualityMicros! + maximumQualityLossMicros >= baseline.meanDecisionQualityMicros!
      : false,
    baseline,
    candidate,
  });
}
