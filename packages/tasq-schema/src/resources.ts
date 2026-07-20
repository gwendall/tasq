/** Provider- and domain-neutral exclusive resource lease contracts. */

import { z } from "zod";
import { BootstrapActorAlias, CoordinationSpaceId } from "./bootstrap.js";
import { UuidV7, Metadata } from "./types.js";

const UnixMs = z.number().int().nonnegative();
const encoder = new TextEncoder();

export const RESOURCE_KEY_MAX_BYTES = 512;
export const ResourceKey = z.string()
  .min(1)
  .refine((value) => value.trim() === value, "resource key must not have leading or trailing whitespace")
  .refine((value) => value.normalize("NFC") === value, "resource key must be NFC-normalized")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "resource key must not contain control characters")
  .refine((value) => encoder.encode(value).byteLength <= RESOURCE_KEY_MAX_BYTES,
    `resource key must be at most ${RESOURCE_KEY_MAX_BYTES} UTF-8 bytes`);
export type ResourceKey = z.infer<typeof ResourceKey>;

export const ResourceLease = z.object({
  id: UuidV7,
  workspaceId: CoordinationSpaceId,
  resourceKey: ResourceKey,
  holderActor: BootstrapActorAlias,
  holderPrincipalId: z.string().min(1).max(2_000),
  revision: z.number().int().positive(),
  fence: z.number().int().positive(),
  acquiredAt: UnixMs,
  heartbeatAt: UnixMs,
  expiresAt: UnixMs,
  releasedAt: UnixMs.nullable(),
  releaseReason: z.string().min(1).max(1_000).nullable(),
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict().superRefine((value, context) => {
  if (value.heartbeatAt < value.acquiredAt || value.expiresAt <= value.heartbeatAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lease chronology is invalid" });
  }
  if ((value.releasedAt === null) !== (value.releaseReason === null) ||
      value.releasedAt !== null && value.releasedAt < value.acquiredAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lease release state is invalid" });
  }
});
export type ResourceLease = z.infer<typeof ResourceLease>;

export const RESOURCE_EVENT_TYPES = [
  "resource_lease_acquired",
  "resource_lease_renewed",
  "resource_lease_released",
  "resource_lease_expired",
] as const;
export const ResourceEventType = z.enum(RESOURCE_EVENT_TYPES);
export type ResourceEventType = z.infer<typeof ResourceEventType>;

export const ResourceEvent = z.object({
  sequence: z.number().int().positive(),
  id: UuidV7,
  workspaceId: CoordinationSpaceId,
  resourceKey: ResourceKey,
  leaseId: UuidV7,
  actor: BootstrapActorAlias,
  principalId: z.string().min(1).max(2_000),
  eventType: ResourceEventType,
  payload: Metadata,
  createdAt: UnixMs,
}).strict();
export type ResourceEvent = z.infer<typeof ResourceEvent>;

export const ResourceLeaseEffectiveStatus = z.enum(["active", "expired", "released"]);
export type ResourceLeaseEffectiveStatus = z.infer<typeof ResourceLeaseEffectiveStatus>;

export const ResourceLeaseView = z.object({
  status: ResourceLeaseEffectiveStatus,
  observedAt: UnixMs,
  lease: ResourceLease,
}).strict();
export type ResourceLeaseView = z.infer<typeof ResourceLeaseView>;

export const RESOURCE_OPERATION_CONTRACT_VERSION = "tasq.resource-operation.v1" as const;
export const ResourceLeaseOperation = z.object({
  contractVersion: z.literal(RESOURCE_OPERATION_CONTRACT_VERSION),
  disposition: z.enum(["acquired", "already_held", "reclaimed", "renewed", "released", "expired"]),
  observedAt: UnixMs,
  lease: ResourceLease,
  eventCursor: z.object({ afterSequence: z.number().int().nonnegative() }).strict(),
}).strict();
export type ResourceLeaseOperation = z.infer<typeof ResourceLeaseOperation>;

export const RESOURCE_WORLD_CONTRACT_VERSION = "tasq.resource-world.v1" as const;
export const ResourceWorld = z.object({
  contractVersion: z.literal(RESOURCE_WORLD_CONTRACT_VERSION),
  workspaceId: CoordinationSpaceId,
  observedAt: UnixMs,
  leases: z.array(ResourceLeaseView).max(10_000),
  eventCursor: z.object({ afterSequence: z.number().int().nonnegative() }).strict(),
}).strict();
export type ResourceWorld = z.infer<typeof ResourceWorld>;

export const RESOURCE_EVENT_PAGE_CONTRACT_VERSION = "tasq.resource-events.v1" as const;
export const ResourceEventPage = z.object({
  contractVersion: z.literal(RESOURCE_EVENT_PAGE_CONTRACT_VERSION),
  workspaceId: CoordinationSpaceId,
  events: z.array(ResourceEvent).max(10_000),
  nextCursor: z.object({ afterSequence: z.number().int().nonnegative() }).strict(),
}).strict();
export type ResourceEventPage = z.infer<typeof ResourceEventPage>;

export const RESOURCE_FENCE_CONTRACT_VERSION = "tasq.resource-fence.v1" as const;
export const ResourceFenceVerification = z.object({
  contractVersion: z.literal(RESOURCE_FENCE_CONTRACT_VERSION),
  status: z.literal("valid"),
  workspaceId: CoordinationSpaceId,
  resourceKey: ResourceKey,
  leaseId: UuidV7,
  fence: z.number().int().positive(),
  holderPrincipalId: z.string().min(1).max(2_000),
  verifiedAt: UnixMs,
  expiresAt: UnixMs,
}).strict();
export type ResourceFenceVerification = z.infer<typeof ResourceFenceVerification>;

export const RESOURCE_PROBLEM_CODES = [
  "invalid_input", "space_not_found", "not_found", "contended", "not_holder",
  "stale_fence", "expired", "released", "clock_regression", "storage_error", "unavailable",
] as const;
export const ResourceProblemCode = z.enum(RESOURCE_PROBLEM_CODES);
export type ResourceProblemCode = z.infer<typeof ResourceProblemCode>;

export const RESOURCE_PROBLEM_CONTRACT_VERSION = "tasq.resource-problem.v1" as const;
export const ResourceProblem = z.object({
  contractVersion: z.literal(RESOURCE_PROBLEM_CONTRACT_VERSION),
  status: z.literal("error"),
  code: ResourceProblemCode,
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  workspaceId: CoordinationSpaceId.nullable(),
  resourceKey: ResourceKey.nullable(),
  currentLease: ResourceLeaseView.nullable(),
  nextActions: z.array(z.object({
    kind: z.enum(["inspect", "wait_until", "retry", "choose_alternative", "help"]),
    description: z.string().min(1).max(1_000),
    notBefore: UnixMs.optional(),
    argvTemplate: z.array(z.string().min(1).max(2_000)).min(2).max(64).optional(),
  }).strict()).max(8),
}).strict();
export type ResourceProblem = z.infer<typeof ResourceProblem>;

export const RESOURCE_SWEEP_CONTRACT_VERSION = "tasq.resource-sweep.v1" as const;
export const ResourceSweep = z.object({
  contractVersion: z.literal(RESOURCE_SWEEP_CONTRACT_VERSION),
  workspaceId: CoordinationSpaceId,
  observedAt: UnixMs,
  expired: z.array(ResourceLease).max(10_000),
  eventCursor: z.object({ afterSequence: z.number().int().nonnegative() }).strict(),
}).strict();
export type ResourceSweep = z.infer<typeof ResourceSweep>;
