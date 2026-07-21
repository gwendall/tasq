/** Bounded, redacted read contracts for the local operator Console. */

import { z } from "zod";
import {
  PrincipalKind,
  PrincipalStatus,
  TaskStatus,
  UuidV7,
  WaitConditionStatus,
} from "./types.js";
import { EffectStatus } from "./effects.js";

export const CONSOLE_PAGE_CONTRACT_VERSION = "tasq.console-page.v1" as const;
export const CONSOLE_OVERVIEW_CONTRACT_VERSION = "tasq.console-overview.v1" as const;
export const CONSOLE_HEALTH_CONTRACT_VERSION = "tasq.console-health.v1" as const;

const Count = z.number().int().nonnegative();
const UnixMs = z.number().int().nonnegative();
const WorkspaceId = z.string().trim().min(1).max(500);
const OpaqueCursor = z.string().min(1).max(2048);
const PrincipalId = z.string().min(1).max(500);
const OptionalPrincipalId = PrincipalId.nullable();

export const ConsoleSection = z.enum([
  "work",
  "actors",
  "claims",
  "resources",
  "waits",
  "effects",
  "audit",
]);
export type ConsoleSection = z.infer<typeof ConsoleSection>;

export const ConsoleWorkItem = z.object({
  id: UuidV7,
  title: z.string().min(1).max(500),
  status: TaskStatus,
  revision: z.number().int().positive(),
  priority: z.number().int().min(1).max(5).nullable(),
  dueAt: UnixMs.nullable(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict();

export const ConsoleActorItem = z.object({
  id: PrincipalId,
  kind: PrincipalKind,
  displayName: z.string().min(1).max(500),
  localAlias: z.string().min(1).max(500).nullable(),
  status: PrincipalStatus,
  revision: z.number().int().positive(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict();

export const ConsoleClaimItem = z.object({
  id: UuidV7,
  commitmentId: UuidV7,
  commitmentTitle: z.string().min(1).max(500),
  actor: z.string().min(1).max(500),
  principalId: OptionalPrincipalId,
  revision: z.number().int().positive(),
  fence: z.number().int().positive(),
  acquiredAt: UnixMs,
  heartbeatAt: UnixMs,
  expiresAt: UnixMs,
  temporalStatus: z.enum(["active", "expired"]),
}).strict();

export const ConsoleResourceItem = z.object({
  id: UuidV7,
  resourceKey: z.string().min(1).max(512),
  holderActor: z.string().min(1).max(200),
  holderPrincipalId: PrincipalId,
  revision: z.number().int().positive(),
  fence: z.number().int().positive(),
  acquiredAt: UnixMs,
  heartbeatAt: UnixMs,
  expiresAt: UnixMs,
  temporalStatus: z.enum(["active", "expired"]),
}).strict();

export const ConsoleWaitItem = z.object({
  id: UuidV7,
  commitmentId: UuidV7,
  commitmentTitle: z.string().min(1).max(500),
  kind: z.string().min(1).max(500),
  status: WaitConditionStatus,
  notBefore: UnixMs,
  deadlineAt: UnixMs.nullable(),
  overdue: z.boolean(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict();

export const ConsoleEffectItem = z.object({
  id: UuidV7,
  commitmentId: UuidV7,
  commitmentTitle: z.string().min(1).max(500),
  status: EffectStatus,
  effectTypeUri: z.string().min(1).max(2000),
  requestDigest: z.string().min(1).max(500),
  revision: z.number().int().positive(),
  createdByPrincipalId: PrincipalId,
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict();

export const ConsoleAuditItem = z.object({
  sequence: z.number().int().positive(),
  id: UuidV7,
  actor: z.string().min(1).max(500),
  principalId: OptionalPrincipalId,
  entityType: z.enum(["area", "goal", "project", "task"]),
  entityId: z.string().min(1).max(2000),
  eventType: z.string().min(1).max(500),
  occurredAt: UnixMs.nullable(),
  createdAt: UnixMs,
  payload: z.object({ omitted: z.literal(true), reason: z.literal("operator_index_redaction") }).strict(),
}).strict();

const pageShape = {
  contractVersion: z.literal(CONSOLE_PAGE_CONTRACT_VERSION),
  workspaceId: WorkspaceId,
  inspectedAt: UnixMs,
  requestedLimit: z.number().int().min(1).max(100),
  returned: Count,
  hasMore: z.boolean(),
  nextCursor: OpaqueCursor.nullable(),
};

function page<S extends ConsoleSection, T extends z.ZodTypeAny>(section: S, item: T) {
  return z.object({
    ...pageShape,
    section: z.literal(section),
    items: z.array(item).max(100),
  }).strict();
}

export const ConsoleWorkPage = page("work", ConsoleWorkItem);
export const ConsoleActorPage = page("actors", ConsoleActorItem);
export const ConsoleClaimPage = page("claims", ConsoleClaimItem);
export const ConsoleResourcePage = page("resources", ConsoleResourceItem);
export const ConsoleWaitPage = page("waits", ConsoleWaitItem);
export const ConsoleEffectPage = page("effects", ConsoleEffectItem);
export const ConsoleAuditPage = page("audit", ConsoleAuditItem);

export const ConsolePage = z.discriminatedUnion("section", [
  ConsoleWorkPage,
  ConsoleActorPage,
  ConsoleClaimPage,
  ConsoleResourcePage,
  ConsoleWaitPage,
  ConsoleEffectPage,
  ConsoleAuditPage,
]).superRefine((value, context) => {
  if (value.returned !== value.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["returned"], message: "returned must equal items.length" });
  }
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextCursor"], message: "hasMore must disclose a continuation cursor" });
  }
});
export type ConsolePage = z.infer<typeof ConsolePage>;

const StatusCounts = z.record(z.string(), Count);

export const ConsoleOperationalCounts = z.object({
  commitments: StatusCounts,
  actors: z.object({ enabled: Count, disabled: Count }).strict(),
  claims: z.object({ active: Count, expiredHeld: Count }).strict(),
  resources: z.object({ active: Count, expiredHeld: Count }).strict(),
  waits: z.object({ waiting: Count, overdue: Count }).strict(),
  effects: StatusCounts,
  delivery: z.object({ pending: Count, delivering: Count, delivered: Count, quarantined: Count }).strict(),
  replication: z.object({ pendingOutgoing: Count, unresolvedConflicts: Count }).strict(),
}).strict();
export type ConsoleOperationalCounts = z.infer<typeof ConsoleOperationalCounts>;

export const ConsoleOverview = z.object({
  contractVersion: z.literal(CONSOLE_OVERVIEW_CONTRACT_VERSION),
  workspaceId: WorkspaceId,
  inspectedAt: UnixMs,
  counts: ConsoleOperationalCounts,
  attention: z.array(z.enum([
    "workspace_missing",
    "disabled_actors",
    "expired_claims",
    "expired_resources",
    "overdue_waits",
    "indeterminate_effects",
    "quarantined_delivery",
    "replication_conflicts",
  ])).max(8),
  workspaceExists: z.boolean(),
  pages: z.record(ConsoleSection, z.string().startsWith("/api/console/")),
  canonicalCommitmentDetailTemplate: z.literal("/api/commitments/{commitmentId}"),
}).strict();
export type ConsoleOverview = z.infer<typeof ConsoleOverview>;

export const ConsoleHealth = z.object({
  contractVersion: z.literal(CONSOLE_HEALTH_CONTRACT_VERSION),
  workspaceId: WorkspaceId,
  inspectedAt: UnixMs,
  assessment: z.enum(["nominal_signals", "attention"]),
  scope: z.literal("bounded_operational_signals"),
  fullIntegrity: z.object({
    checked: z.literal(false),
    reason: z.literal("full_doctor_is_explicit_and_not_request_bounded"),
    argv: z.tuple([
      z.literal("tasq"), z.literal("doctor"), z.literal("--tenant"), WorkspaceId,
    ]),
  }).strict(),
  workspaceExists: z.boolean(),
  counts: ConsoleOperationalCounts,
  cursors: z.object({ eventSequence: Count, resourceEventSequence: Count }).strict(),
  attention: ConsoleOverview.shape.attention,
}).strict();
export type ConsoleHealth = z.infer<typeof ConsoleHealth>;
