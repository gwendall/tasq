import { z } from "zod";

export const CERTIFIED_SCENARIO_DOMAINS = [
  "physical_verification",
  "remote_hands",
  "software_deployment",
  "procurement",
  "custody",
  "compromised_agent",
] as const;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Id = z.string().min(1).max(500);

export const DelegatedActionScenarioTraceV1 = z.object({
  contractVersion: z.literal("tasq.delegated-action-scenario-trace.v1"),
  domain: z.enum(CERTIFIED_SCENARIO_DOMAINS),
  targetDigests: z.object({
    order: Digest,
    authority: Digest,
    agreement: Digest,
    attempt: Digest,
    evidence: Digest,
  }).strict(),
  authority: z.enum(["allowed", "denied", "revoked"]),
  access: z.enum(["granted", "no_access"]),
  attempt: z.enum(["not_started", "running", "succeeded", "failed", "timed_out"]),
  outcome: z.enum(["complete", "partial", "none"]),
  completion: z.enum(["open", "blocked", "done"]),
  executorPrincipalId: Id,
  review: z.object({
    required: z.boolean(),
    reviewerPrincipalId: Id.nullable(),
    decision: z.enum(["pending", "accepted", "rejected"]),
  }).strict(),
  connectorRoutesOpened: z.number().int().nonnegative(),
  externalEffect: z.boolean(),
  restart: z.object({ exactReplay: z.boolean(), providerLookupBeforeRedispatch: z.boolean() }).strict(),
  portable: z.object({ coreVerified: z.boolean(), custodyVerified: z.boolean().nullable() }).strict(),
  custodySuccessorIds: z.array(Id).max(2),
}).strict();
export type DelegatedActionScenarioTraceV1 = z.infer<typeof DelegatedActionScenarioTraceV1>;

export type ScenarioFailureCode =
  | "target_drift"
  | "denied_route_opened"
  | "denied_action_completed"
  | "no_access_completed"
  | "partial_or_timeout_completed"
  | "runtime_success_implied_completion"
  | "independent_review_missing"
  | "restart_replay_unproven"
  | "provider_lookup_unproven"
  | "portable_core_unproven"
  | "portable_custody_unproven"
  | "concurrent_custody_successors";

export interface ScenarioCertificationResult {
  contractVersion: "tasq.delegated-action-scenario-certification.v1";
  domain: DelegatedActionScenarioTraceV1["domain"];
  passed: boolean;
  failures: ScenarioFailureCode[];
}

export function certifyDelegatedActionScenario(input: unknown): ScenarioCertificationResult {
  const trace = DelegatedActionScenarioTraceV1.parse(input);
  const failures: ScenarioFailureCode[] = [];
  if (new Set(Object.values(trace.targetDigests)).size !== 1) failures.push("target_drift");
  if (trace.authority !== "allowed" && trace.connectorRoutesOpened !== 0) failures.push("denied_route_opened");
  if (trace.authority !== "allowed" && trace.completion === "done") failures.push("denied_action_completed");
  if (trace.access === "no_access" && trace.completion === "done") failures.push("no_access_completed");
  if ((trace.outcome === "partial" || trace.attempt === "timed_out") && trace.completion === "done") {
    failures.push("partial_or_timeout_completed");
  }
  if (trace.attempt === "succeeded" && trace.review.decision !== "accepted" && trace.completion === "done") {
    failures.push("runtime_success_implied_completion");
  }
  if (trace.review.required && (trace.review.decision !== "accepted" ||
    trace.review.reviewerPrincipalId === null || trace.review.reviewerPrincipalId === trace.executorPrincipalId) &&
    trace.completion === "done") {
    failures.push("independent_review_missing");
  }
  if (!trace.restart.exactReplay) failures.push("restart_replay_unproven");
  if (trace.externalEffect && !trace.restart.providerLookupBeforeRedispatch) failures.push("provider_lookup_unproven");
  if (!trace.portable.coreVerified) failures.push("portable_core_unproven");
  if (trace.domain === "custody" && trace.portable.custodyVerified !== true) failures.push("portable_custody_unproven");
  if (trace.custodySuccessorIds.length > 1) failures.push("concurrent_custody_successors");
  return {
    contractVersion: "tasq.delegated-action-scenario-certification.v1",
    domain: trace.domain,
    passed: failures.length === 0,
    failures,
  };
}
