/**
 * Zod schemas + TS types — single source of truth for entity shapes.
 *
 * Mirrors `tables.ts` (Drizzle) one-to-one. The Drizzle tables are the
 * storage shape ; the Zod schemas here are the validation + API shape.
 * Drizzle is the only thing that should ever talk to the DB ; everything
 * else (CLI, service callers, future MCP) validates I/O with Zod first.
 */

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// Enums (kept as branded string unions — single source of truth)
// ──────────────────────────────────────────────────────────────────────

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const COMPLETION_MODES = ["assertion", "evidence"] as const;
export const CompletionMode = z.enum(COMPLETION_MODES);
export type CompletionMode = z.infer<typeof CompletionMode>;

export const ATTEMPT_STATUSES = [
  "running",
  "input_required",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const AttemptStatus = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const PRINCIPAL_KINDS = ["human", "agent", "service", "runtime"] as const;
export const PrincipalKind = z.enum(PRINCIPAL_KINDS);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const PRINCIPAL_STATUSES = ["enabled", "disabled"] as const;
export const PrincipalStatus = z.enum(PRINCIPAL_STATUSES);
export type PrincipalStatus = z.infer<typeof PrincipalStatus>;

export const ASSIGNMENT_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "revoked",
  "released",
] as const;
export const AssignmentStatus = z.enum(ASSIGNMENT_STATUSES);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

export const RELATION_TYPES = [
  "parent_of",
  "depends_on",
  "relates_to",
  "duplicates",
  "supersedes",
] as const;
export const RelationType = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationType>;

export const WAIT_CONDITION_STATUSES = [
  "waiting",
  "satisfied",
  "expired",
  "cancelled",
] as const;
export const WaitConditionStatus = z.enum(WAIT_CONDITION_STATUSES);
export type WaitConditionStatus = z.infer<typeof WaitConditionStatus>;

export const WAIT_CONDITION_KINDS = [
  "gmail.thread_reply",
  "github.pull_request_state",
  "mercury.transaction_state",
  "http.response",
  "filesystem.artifact",
] as const;
export const WaitConditionKind = z.enum(WAIT_CONDITION_KINDS);
export type WaitConditionKind = z.infer<typeof WaitConditionKind>;

export const WAIT_FALLBACK_KINDS = ["none", "create_task", "activate_task"] as const;
export const WaitFallbackKind = z.enum(WAIT_FALLBACK_KINDS);
export type WaitFallbackKind = z.infer<typeof WaitFallbackKind>;

export const OBSERVATION_KINDS = [
  "gmail.message",
  "github.pull_request",
  "mercury.transaction",
  "http.check",
  "filesystem.stat",
] as const;
export const ObservationKind = z.enum(OBSERVATION_KINDS);
export type ObservationKind = z.infer<typeof ObservationKind>;

export const VERIFICATION_LEVELS = [
  "unverified",
  "authenticated_source",
  "provider_verified",
] as const;
export const VerificationLevel = z.enum(VERIFICATION_LEVELS);
export type VerificationLevel = z.infer<typeof VerificationLevel>;

export const RECONCILIATION_DECISIONS = ["matched", "rejected", "ambiguous"] as const;
export const ReconciliationDecision = z.enum(RECONCILIATION_DECISIONS);
export type ReconciliationDecision = z.infer<typeof ReconciliationDecision>;

export const RECONCILIATION_EFFECTS = [
  "satisfied",
  "no_change",
  "condition_terminal",
] as const;
export const ReconciliationEffect = z.enum(RECONCILIATION_EFFECTS);
export type ReconciliationEffect = z.infer<typeof ReconciliationEffect>;

export const PROJECT_STATUSES = [
  "active",
  "blocked",
  "waiting",
  "done",
  "cancelled",
] as const;
export const ProjectStatus = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const GOAL_STATUSES = ["active", "paused", "done", "abandoned"] as const;
export const GoalStatus = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const ENTITY_TYPES = ["area", "goal", "project", "task"] as const;
export const EntityType = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityType>;

/**
 * Recurrence cadence units (SPEC §6.4-H). The minimal neutral stored-recurrence
 * primitive: a task with `recurrence != null` materializes the next instance on
 * completion (one cadence-step from its anchor). The scheduling *intelligence*
 * (which day, skip policy, etc.) stays L2 — L1 only steps the calendar.
 */
export const RECURRENCE_UNITS = ["daily", "weekly", "monthly", "yearly"] as const;
export const RecurrenceUnit = z.enum(RECURRENCE_UNITS);
export type RecurrenceUnit = z.infer<typeof RecurrenceUnit>;

/**
 * Which timestamp the next recurring instance is computed from:
 *   - `due`        — step from the completed instance's `due_at` (default).
 *   - `scheduled`  — step from its `scheduled_at`.
 *   - `completion` — step from the completion time (now).
 */
export const RECURRENCE_ANCHORS = ["due", "scheduled", "completion"] as const;
export const RecurrenceAnchor = z.enum(RECURRENCE_ANCHORS);
export type RecurrenceAnchor = z.infer<typeof RecurrenceAnchor>;

/**
 * Peer task-dependency edge types (SPEC §4.5).
 *   - `blocks`      — v1 compatibility label: `from` depends on `to`;
 *                     transitive and cycle-guarded. The universal target stores
 *                     the unambiguous relation name `depends_on`.
 *   - `relates_to`  — informational link, non-transitive.
 *   - `duplicates`  — informational link, non-transitive.
 */
export const DEPENDENCY_TYPES = ["blocks", "relates_to", "duplicates"] as const;
export const DependencyType = z.enum(DEPENDENCY_TYPES);
export type DependencyType = z.infer<typeof DependencyType>;

/**
 * Event types are an open vocabulary — anything an actor wants to record.
 * Canonical types are listed for documentation + autocomplete, but the
 * column is plain text to allow new types without migration.
 */
export const CANONICAL_EVENT_TYPES = [
  "attempt_cancelled",
  "attempt_failed",
  "attempt_input_required",
  "attempt_running",
  "attempt_started",
  "attempt_succeeded",
  "artifact_appended",
  "assignment_accepted",
  "assignment_proposed",
  "assignment_rejected",
  "assignment_released",
  "assignment_revoked",
  "blocked",
  "cancelled",
  "claim_acquired",
  "claim_released",
  "claim_renewed",
  "completed",
  "commitment_summary_appended",
  "external_context_link_appended",
  "created",
  "deleted",
  "dependency_added",
  "dependency_removed",
  "effect_approval_recorded",
  "effect_authority_withdrawn",
  "effect_authorized",
  "effect_cancelled",
  "effect_execution_started",
  "effect_proposed",
  "effect_receipt_recorded",
  "evidence_added",
  "evidence_trust_attested",
  "evidence_trust_revoked",
  "external_ref_appended",
  "instance_generated", // recurrence materialized the next instance (SPEC §6.4-H)
  "linked", // task ↔ source_ref / project / goal (reserved, not currently emitted)
  "note_added", // reserved, not currently emitted
  "reconciliation_recorded",
  "relation_added",
  "relation_ended",
  "resolution_contract_created",
  "restored",
  "scope_rederived",
  "started",
  "status_changed",
  "unblocked",
  "completion_proposed",
  "completion_challenged",
  "validation_decided",
  "uncancelled",
  "updated",
  "wait_cancelled",
  "wait_created",
  "wait_expired",
  "wait_fallback_activated",
  "wait_satisfied",
] as const;
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

// ──────────────────────────────────────────────────────────────────────
// Common primitives
// ──────────────────────────────────────────────────────────────────────

/** UUIDv7 in canonical 8-4-4-4-12 hex form. Validated lazily. */
export const UuidV7 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    { message: "Must be a UUIDv7" },
  );
export type UuidV7 = z.infer<typeof UuidV7>;

/** Short slug: lower-case kebab, used for human-friendly area lookups. */
export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "Slug must be lower-case alphanumeric with hyphens",
  });
export type Slug = z.infer<typeof Slug>;

/** Unix-ms timestamp. */
export const UnixMs = z.number().int().nonnegative();

/** Importance score 1–5. */
export const Importance = z.number().int().min(1).max(5);

/** Priority score 1–5 (optional on task). */
export const Priority = z.number().int().min(1).max(5);

/** Free-form JSON-storable metadata. */
export const Metadata = z.record(z.unknown());
export type Metadata = z.infer<typeof Metadata>;

/** Absolute namespaced identifier (https:, urn:, did:, and future schemes). */
export const AbsoluteUri = z.string().min(3).max(2_000).regex(
  /^[a-z][a-z0-9+.-]*:/i,
  "Expected an absolute URI",
);

export const IDEMPOTENCY_DIGEST_VERSIONS = [
  "tasq.jcs.sha256.v1",
  "tasq.legacy.sha256.v0",
] as const;
export const IdempotencyDigestVersion = z.enum(IDEMPOTENCY_DIGEST_VERSIONS);
export type IdempotencyDigestVersion = z.infer<typeof IdempotencyDigestVersion>;

export const IDEMPOTENCY_RETENTION_CLASSES = ["standard", "durable"] as const;
export const IdempotencyRetentionClass = z.enum(IDEMPOTENCY_RETENTION_CLASSES);
export type IdempotencyRetentionClass = z.infer<typeof IdempotencyRetentionClass>;

/** Durable acknowledgement of one accepted mutation identity. */
export const IdempotencyRecord = z.object({
  tenantId: z.string().min(1).max(500),
  callerScope: z.string().min(1).max(1_000),
  operation: z.string().min(1).max(200),
  key: z.string().min(1).max(500),
  digestVersion: IdempotencyDigestVersion,
  requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  resultType: z.string().min(1).max(200),
  resultId: z.string().min(1).max(2_000),
  resultStatus: z.string().min(1).max(200).nullable(),
  resultRevision: z.number().int().positive().nullable(),
  eventSequence: z.number().int().positive().nullable(),
  retentionClass: IdempotencyRetentionClass,
  expiresAt: UnixMs.nullable(),
  createdAt: UnixMs,
}).superRefine((value, ctx) => {
  if (value.retentionClass === "durable" && value.expiresAt !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "durable records do not expire" });
  }
  if (value.retentionClass === "standard" &&
    (value.expiresAt === null || value.expiresAt <= value.createdAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "standard records require a future expiry" });
  }
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecord>;

// ──────────────────────────────────────────────────────────────────────
// Universal collaboration identities
// ──────────────────────────────────────────────────────────────────────

export const Principal = z.object({
  id: z.string().min(1).max(500),
  tenantId: z.string().min(1),
  kind: PrincipalKind,
  displayName: z.string().min(1).max(200),
  /** Local compatibility attribution only; never authentication/authority. */
  localAlias: z.string().min(1).max(200).nullable(),
  status: PrincipalStatus,
  metadata: Metadata,
  revision: z.number().int().positive(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
});
export type Principal = z.infer<typeof Principal>;

export const PrincipalInsert = Principal.omit({
  id: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  id: z.string().min(1).max(500).optional(),
  tenantId: z.string().min(1).default("gwendall"),
  kind: PrincipalKind.default("agent"),
  localAlias: z.string().min(1).max(200).nullable().default(null),
  status: PrincipalStatus.default("enabled"),
  metadata: Metadata.default({}),
});
export type PrincipalInsert = z.infer<typeof PrincipalInsert>;

// ──────────────────────────────────────────────────────────────────────
// Area
// ──────────────────────────────────────────────────────────────────────

export const Area = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  name: z.string().min(1).max(120),
  slug: Slug,
  importance: Importance,
  cadenceTarget: z.string().nullable(),
  description: z.string().nullable(),
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
  deletedAt: UnixMs.nullable(),
});
export type Area = z.infer<typeof Area>;

export const AreaInsert = Area.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  importance: Importance.default(3),
  cadenceTarget: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  metadata: Metadata.default({}),
});
export type AreaInsert = z.infer<typeof AreaInsert>;

export const AreaUpdate = Area.pick({
  name: true,
  slug: true,
  importance: true,
  cadenceTarget: true,
  description: true,
  metadata: true,
}).partial();
export type AreaUpdate = z.infer<typeof AreaUpdate>;

// ──────────────────────────────────────────────────────────────────────
// Goal
// ──────────────────────────────────────────────────────────────────────

export const Goal = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  areaId: UuidV7,
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  horizon: z.string().nullable(), // "5 years", "Q2 2027", "lifelong"
  importance: Importance,
  status: GoalStatus,
  targetDate: UnixMs.nullable(),
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
  deletedAt: UnixMs.nullable(),
});
export type Goal = z.infer<typeof Goal>;

export const GoalInsert = Goal.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  description: z.string().nullable().default(null),
  horizon: z.string().nullable().default(null),
  importance: Importance.default(3),
  status: GoalStatus.default("active"),
  targetDate: UnixMs.nullable().default(null),
  metadata: Metadata.default({}),
});
export type GoalInsert = z.infer<typeof GoalInsert>;

export const GoalUpdate = Goal.pick({
  title: true,
  description: true,
  horizon: true,
  importance: true,
  status: true,
  targetDate: true,
  metadata: true,
}).partial();
export type GoalUpdate = z.infer<typeof GoalUpdate>;

// ──────────────────────────────────────────────────────────────────────
// Project
// ──────────────────────────────────────────────────────────────────────

export const Project = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  goalId: UuidV7.nullable(),
  areaId: UuidV7.nullable(),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  status: ProjectStatus,
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
  deletedAt: UnixMs.nullable(),
});
export type Project = z.infer<typeof Project>;

export const ProjectInsert = Project.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  goalId: UuidV7.nullable().default(null),
  areaId: UuidV7.nullable().default(null),
  description: z.string().nullable().default(null),
  status: ProjectStatus.default("active"),
  metadata: Metadata.default({}),
});
export type ProjectInsert = z.infer<typeof ProjectInsert>;

export const ProjectUpdate = Project.pick({
  title: true,
  description: true,
  status: true,
  goalId: true,
  areaId: true,
  metadata: true,
}).partial();
export type ProjectUpdate = z.infer<typeof ProjectUpdate>;

// ──────────────────────────────────────────────────────────────────────
// Task
// ──────────────────────────────────────────────────────────────────────

export const Task = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  projectId: UuidV7.nullable(),
  goalId: UuidV7.nullable(),
  areaId: UuidV7.nullable(),
  parentTaskId: UuidV7.nullable(),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  nextAction: z.string().nullable(),
  successCriteria: z.string().min(1).max(2_000).nullable(),
  completionMode: CompletionMode,
  validationRequired: z.boolean(),
  status: TaskStatus,
  priority: Priority.nullable(),
  estimatedMinutes: z.number().int().positive().nullable(),
  scheduledAt: UnixMs.nullable(),
  dueAt: UnixMs.nullable(),
  startedAt: UnixMs.nullable(),
  completedAt: UnixMs.nullable(),
  // Recurrence (SPEC §6.4-H) — neutral cadence-enum + anchor. NULL recurrence =
  // one-shot (the pre-v0.3 default). On completion of a recurring task the
  // service materializes the next instance; `lastDoneAt`/`streak` are
  // engine-owned signals fed to the prioritizer (surfaced, not reweighted).
  recurrence: RecurrenceUnit.nullable(),
  recurrenceInterval: z.number().int().positive(),
  recurrenceAnchor: RecurrenceAnchor,
  lastDoneAt: UnixMs.nullable(),
  streak: z.number().int().nonnegative(),
  recurrenceParentId: UuidV7.nullable(),
  metadata: Metadata,
  revision: z.number().int().positive(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
  deletedAt: UnixMs.nullable(),
});
export type Task = z.infer<typeof Task>;

/**
 * Hierarchy fields are optional without a default so `createTask` can derive
 * the canonical chain. Children inherit their parent's complete scope;
 * project → goal/area and goal → area are also derived by the service.
 */
export const TaskInsert = Task.omit({
  id: true,
  startedAt: true,
  completedAt: true,
  // streak / lastDoneAt are engine-owned (like startedAt/completedAt) — set by
  // the recurrence materializer, never by a direct caller.
  lastDoneAt: true,
  streak: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  revision: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  projectId: UuidV7.nullable().optional(),
  goalId: UuidV7.nullable().optional(),
  areaId: UuidV7.nullable().optional(),
  parentTaskId: UuidV7.nullable().optional(),
  description: z.string().nullable().default(null),
  nextAction: z.string().nullable().default(null),
  successCriteria: z.string().nullable().default(null),
  completionMode: CompletionMode.default("assertion"),
  validationRequired: z.boolean().default(false),
  status: TaskStatus.default("open"),
  priority: Priority.nullable().default(null),
  estimatedMinutes: z.number().int().positive().nullable().default(null),
  scheduledAt: UnixMs.nullable().default(null),
  dueAt: UnixMs.nullable().default(null),
  recurrence: RecurrenceUnit.nullable().default(null),
  recurrenceInterval: z.number().int().positive().default(1),
  recurrenceAnchor: RecurrenceAnchor.default("due"),
  // Set by the materializer when spawning the next instance (chain root id);
  // a direct caller may also pass it but normally leaves it undefined → null.
  recurrenceParentId: UuidV7.nullable().optional(),
  metadata: Metadata.default({}),
});
export type TaskInsert = z.infer<typeof TaskInsert>;

export const TaskUpdate = Task.pick({
  title: true,
  description: true,
  nextAction: true,
  successCriteria: true,
  completionMode: true,
  validationRequired: true,
  priority: true,
  estimatedMinutes: true,
  scheduledAt: true,
  dueAt: true,
  projectId: true,
  goalId: true,
  areaId: true,
  parentTaskId: true,
  // Recurrence config is editable on the template; the engine-owned signals
  // (streak/lastDoneAt) and chain identity (recurrenceParentId) are NOT.
  recurrence: true,
  recurrenceInterval: true,
  recurrenceAnchor: true,
  metadata: true,
}).partial();
export type TaskUpdate = z.infer<typeof TaskUpdate>;

/**
 * Hard limit on task hierarchy depth. Beyond this, callers should model
 * with a `project` instead. Enforced in the service layer.
 */
export const MAX_TASK_DEPTH = 5;

// ──────────────────────────────────────────────────────────────────────
// Task dependency — first-class peer edge (SPEC §4.5)
// ──────────────────────────────────────────────────────────────────────

export const TaskDependency = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  fromTaskId: UuidV7,
  toTaskId: UuidV7,
  type: DependencyType,
  createdAt: UnixMs,
  updatedAt: UnixMs,
  deletedAt: UnixMs.nullable(),
});
export type TaskDependency = z.infer<typeof TaskDependency>;

export const TaskDependencyInsert = TaskDependency.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  type: DependencyType.default("blocks"),
});
export type TaskDependencyInsert = z.infer<typeof TaskDependencyInsert>;

// ──────────────────────────────────────────────────────────────────────
// Universal collaboration records
// ──────────────────────────────────────────────────────────────────────

export const CommitmentRelation = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  fromTaskId: UuidV7,
  relationType: z.union([RelationType, AbsoluteUri]),
  toTaskId: UuidV7,
  revision: z.number().int().positive(),
  createdByPrincipalId: z.string().min(1),
  createdAt: UnixMs,
  endedByPrincipalId: z.string().min(1).nullable(),
  endedAt: UnixMs.nullable(),
});
export type CommitmentRelation = z.infer<typeof CommitmentRelation>;

export const CommitmentRelationInsert = CommitmentRelation.omit({
  id: true,
  revision: true,
  createdByPrincipalId: true,
  createdAt: true,
  endedByPrincipalId: true,
  endedAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
});
export type CommitmentRelationInsert = z.infer<typeof CommitmentRelationInsert>;

export const Assignment = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  assignerPrincipalId: z.string().min(1),
  assigneePrincipalId: z.string().min(1),
  role: z.union([z.enum(["owner", "contributor", "reviewer", "approver"]), AbsoluteUri]),
  status: AssignmentStatus,
  instructionsRef: z.string().min(1).max(2_000).nullable(),
  acceptedAt: UnixMs.nullable(),
  endedAt: UnixMs.nullable(),
  revision: z.number().int().positive(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
});
export type Assignment = z.infer<typeof Assignment>;

export const AssignmentInsert = Assignment.omit({
  id: true,
  status: true,
  acceptedAt: true,
  endedAt: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  instructionsRef: z.string().min(1).max(2_000).nullable().default(null),
});
export type AssignmentInsert = z.infer<typeof AssignmentInsert>;

export const ExternalRef = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  recordType: z.string().min(1).max(80),
  recordId: z.string().min(1).max(500),
  system: AbsoluteUri,
  resourceType: z.string().min(1).max(120),
  externalId: z.string().min(1).max(1_000),
  url: AbsoluteUri.nullable(),
  version: z.string().min(1).max(500).nullable(),
  digest: z.string().min(1).max(500).nullable(),
  metadata: Metadata,
  createdByPrincipalId: z.string().min(1),
  createdAt: UnixMs,
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const ExternalRefInsert = ExternalRef.omit({
  id: true,
  createdByPrincipalId: true,
  createdAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  url: AbsoluteUri.nullable().default(null),
  version: z.string().min(1).max(500).nullable().default(null),
  digest: z.string().min(1).max(500).nullable().default(null),
  metadata: Metadata.default({}),
});
export type ExternalRefInsert = z.infer<typeof ExternalRefInsert>;

// ──────────────────────────────────────────────────────────────────────
// Agentic execution primitives — claim, attempt, evidence
// ──────────────────────────────────────────────────────────────────────

/** A time-bounded, exclusive coordination claim on a commitment. */
export const TaskClaim = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  actor: z.string().min(1),
  principalId: z.string().min(1).nullable(),
  revision: z.number().int().positive(),
  /** Monotone per task; stale workers carry a lower fencing token. */
  fence: z.number().int().positive(),
  acquiredAt: UnixMs,
  heartbeatAt: UnixMs,
  expiresAt: UnixMs,
  releasedAt: UnixMs.nullable(),
  releaseReason: z.string().nullable(),
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
});
export type TaskClaim = z.infer<typeof TaskClaim>;

export const TaskClaimInsert = TaskClaim.omit({
  id: true,
  fence: true,
  acquiredAt: true,
  heartbeatAt: true,
  releasedAt: true,
  releaseReason: true,
  createdAt: true,
  updatedAt: true,
  principalId: true,
  revision: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  metadata: Metadata.default({}),
});
export type TaskClaimInsert = z.infer<typeof TaskClaimInsert>;

/** One concrete execution attempt against a durable task commitment. */
export const TaskAttempt = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  claimId: UuidV7.nullable(),
  actor: z.string().min(1),
  principalId: z.string().min(1).nullable(),
  revision: z.number().int().positive(),
  runtime: z.string().min(1).max(80),
  externalId: z.string().nullable(),
  contextId: z.string().nullable(),
  status: AttemptStatus,
  statusMessage: z.string().nullable(),
  startedAt: UnixMs,
  endedAt: UnixMs.nullable(),
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
});
export type TaskAttempt = z.infer<typeof TaskAttempt>;

export const TaskAttemptInsert = TaskAttempt.omit({
  id: true,
  actor: true,
  status: true,
  statusMessage: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
  principalId: true,
  revision: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  claimId: UuidV7.nullable().default(null),
  runtime: z.string().min(1).max(80).default("local"),
  externalId: z.string().nullable().default(null),
  contextId: z.string().nullable().default(null),
  metadata: Metadata.default({}),
});
export type TaskAttemptInsert = z.infer<typeof TaskAttemptInsert>;

/** Append-only evidence captured for a task, optionally by one attempt. */
export const TaskEvidence = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  attemptId: UuidV7.nullable(),
  supersedesEvidenceId: UuidV7.nullable(),
  actor: z.string().min(1),
  principalId: z.string().min(1).nullable(),
  kind: z.string().min(1).max(80),
  summary: z.string().nullable(),
  uri: z.string().nullable(),
  digest: z.string().nullable(),
  source: z.string().nullable(),
  observedAt: UnixMs,
  metadata: Metadata,
  createdAt: UnixMs,
});
export type TaskEvidence = z.infer<typeof TaskEvidence>;

export const TaskEvidenceInsert = TaskEvidence.omit({
  id: true,
  actor: true,
  observedAt: true,
  createdAt: true,
  principalId: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  attemptId: UuidV7.nullable().default(null),
  supersedesEvidenceId: UuidV7.nullable().default(null),
  summary: z.string().min(1).nullable().default(null),
  uri: z.string().min(1).nullable().default(null),
  digest: z.string().min(1).nullable().default(null),
  source: z.string().min(1).nullable().default(null),
  observedAt: UnixMs.optional(),
  metadata: Metadata.default({}),
}).refine((value) => value.summary != null || value.uri != null, {
  message: "Evidence requires a summary or URI",
});
export type TaskEvidenceInsert = z.infer<typeof TaskEvidenceInsert>;

/** Immutable output produced or referenced by one execution attempt. */
export const Artifact = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  attemptId: UuidV7.nullable(),
  typeUri: AbsoluteUri,
  schemaVersion: z.number().int().positive(),
  name: z.string().min(1).max(500),
  mediaType: z.string().min(1).max(200).nullable(),
  uri: AbsoluteUri.nullable(),
  digest: z.string().min(1).max(500).nullable(),
  inlineDataRef: z.string().min(1).max(2_000).nullable(),
  createdByPrincipalId: z.string().min(1),
  metadata: Metadata,
  createdAt: UnixMs,
});
export type Artifact = z.infer<typeof Artifact>;

export const ArtifactInsert = Artifact.omit({
  id: true,
  createdByPrincipalId: true,
  createdAt: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  attemptId: UuidV7.nullable().default(null),
  schemaVersion: z.number().int().positive().default(1),
  mediaType: z.string().min(1).max(200).nullable().default(null),
  uri: AbsoluteUri.nullable().default(null),
  digest: z.string().min(1).max(500).nullable().default(null),
  inlineDataRef: z.string().min(1).max(2_000).nullable().default(null),
  metadata: Metadata.default({}),
}).superRefine((value, ctx) => {
  if (value.uri == null && value.inlineDataRef == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uri"], message: "Artifact requires a URI or inlineDataRef" });
  }
  if (value.digest == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "Artifact requires an immutable digest" });
  }
});
export type ArtifactInsert = z.infer<typeof ArtifactInsert>;

export const CompletionRecord = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  resultingRevision: z.number().int().positive(),
  completionPolicyUri: AbsoluteUri,
  completionPolicyVersion: z.number().int().positive(),
  policyInputDigest: z.string().min(1),
  evidenceIds: z.array(UuidV7),
  resolutionContractId: UuidV7.nullable(),
  validationDecisionId: UuidV7.nullable(),
  decidedByPrincipalId: z.string().min(1),
  decidedAt: UnixMs,
});
export type CompletionRecord = z.infer<typeof CompletionRecord>;

// ──────────────────────────────────────────────────────────────────────
// Wait condition — durable typed expectation attached to one task
// ──────────────────────────────────────────────────────────────────────

/** Minimal ledger-only task template used by a future deadline fallback. */
export const WaitCreateTaskFallbackSpec = z.object({
  title: z.string().min(1).max(500),
  nextAction: z.string().min(1).max(2_000),
  priority: Priority.nullable().default(null),
  scheduledAt: UnixMs.nullable().default(null),
  dueAt: UnixMs.nullable().default(null),
  // Omitted hierarchy means "inherit from the condition's task"; explicit
  // null means "detach this level". Preserve that distinction for TQ-105.
  projectId: UuidV7.nullable().optional(),
  goalId: UuidV7.nullable().optional(),
  areaId: UuidV7.nullable().optional(),
  parentTaskId: UuidV7.nullable().optional(),
  metadata: Metadata.default({}),
}).strict();
export type WaitCreateTaskFallbackSpec = z.infer<typeof WaitCreateTaskFallbackSpec>;

const WaitConditionShape = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  taskId: UuidV7,
  kind: WaitConditionKind,
  schemaVersion: z.number().int().positive(),
  parameters: Metadata,
  status: WaitConditionStatus,
  notBefore: UnixMs,
  deadlineAt: UnixMs.nullable(),
  fallbackKind: WaitFallbackKind,
  fallbackSpec: WaitCreateTaskFallbackSpec.nullable(),
  /** Immutable target configured for activate_task. */
  fallbackTargetTaskId: UuidV7.nullable(),
  /** Engine-owned task affected or created when expiry commits. */
  fallbackResultTaskId: UuidV7.nullable(),
  supersedesConditionId: UuidV7.nullable(),
  satisfiedAt: UnixMs.nullable(),
  satisfiedByObservationId: UuidV7.nullable(),
  expiredAt: UnixMs.nullable(),
  cancelledAt: UnixMs.nullable(),
  cancelReason: z.string().min(1).nullable(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
});

function validateFallbackShape(
  value: {
    fallbackKind: WaitFallbackKind;
    fallbackSpec: WaitCreateTaskFallbackSpec | null;
    fallbackTargetTaskId: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const valid =
    (value.fallbackKind === "none" && value.fallbackSpec == null && value.fallbackTargetTaskId == null) ||
    (value.fallbackKind === "create_task" && value.fallbackSpec != null && value.fallbackTargetTaskId == null) ||
    (value.fallbackKind === "activate_task" && value.fallbackSpec == null && value.fallbackTargetTaskId != null);
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fallbackKind"],
      message: "Fallback kind, spec, and target task are inconsistent",
    });
  }
}

export const WaitCondition = WaitConditionShape.superRefine((value, ctx) => {
  validateFallbackShape(value, ctx);
  if (value.deadlineAt != null && value.deadlineAt <= value.notBefore) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deadlineAt"],
      message: "deadlineAt must be strictly after notBefore",
    });
  }
  if (value.updatedAt < value.createdAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["updatedAt"],
      message: "updatedAt must not precede createdAt",
    });
  }
  const waiting = value.status === "waiting"
    && value.satisfiedAt == null
    && value.satisfiedByObservationId == null
    && value.expiredAt == null
    && value.cancelledAt == null
    && value.cancelReason == null
    && value.fallbackResultTaskId == null;
  const satisfied = value.status === "satisfied"
    && value.satisfiedAt != null
    && value.satisfiedAt >= value.createdAt
    && value.satisfiedByObservationId != null
    && value.expiredAt == null
    && value.cancelledAt == null
    && value.cancelReason == null
    && value.fallbackResultTaskId == null;
  const expired = value.status === "expired"
    && value.satisfiedAt == null
    && value.satisfiedByObservationId == null
    && value.expiredAt != null
    && value.expiredAt >= value.createdAt
    && value.deadlineAt != null
    && value.expiredAt >= value.deadlineAt
    && value.cancelledAt == null
    && value.cancelReason == null
    && (
      (value.fallbackKind === "none" && value.fallbackResultTaskId == null) ||
      (value.fallbackKind !== "none" && value.fallbackResultTaskId != null)
    );
  const cancelled = value.status === "cancelled"
    && value.satisfiedAt == null
    && value.satisfiedByObservationId == null
    && value.expiredAt == null
    && value.cancelledAt != null
    && value.cancelledAt >= value.createdAt
    && value.cancelReason != null
    && value.fallbackResultTaskId == null;
  if (!waiting && !satisfied && !expired && !cancelled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Wait condition status and terminal fields are inconsistent",
    });
  }
});
export type WaitCondition = z.infer<typeof WaitCondition>;

export const WaitConditionInsert = z.object({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  taskId: UuidV7,
  kind: WaitConditionKind,
  schemaVersion: z.number().int().positive().default(1),
  parameters: Metadata,
  notBefore: UnixMs.optional(),
  deadlineAt: UnixMs.nullable().default(null),
  fallbackKind: WaitFallbackKind.default("none"),
  fallbackSpec: WaitCreateTaskFallbackSpec.nullable().default(null),
  fallbackTargetTaskId: UuidV7.nullable().default(null),
  supersedesConditionId: UuidV7.nullable().default(null),
}).superRefine((value, ctx) => {
  validateFallbackShape(value, ctx);
  if (value.notBefore != null && value.deadlineAt != null && value.deadlineAt <= value.notBefore) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deadlineAt"],
      message: "deadlineAt must be strictly after notBefore",
    });
  }
});
export type WaitConditionInsert = z.infer<typeof WaitConditionInsert>;

// ──────────────────────────────────────────────────────────────────────
// Observation — immutable normalized external fact
// ──────────────────────────────────────────────────────────────────────

export const Observation = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  source: z.string().min(1).max(500),
  externalEventId: z.string().min(1).max(1_000),
  kind: ObservationKind,
  schemaVersion: z.number().int().positive(),
  subjectRef: z.string().min(1).max(10_000),
  payload: Metadata,
  occurredAt: UnixMs,
  recordedAt: UnixMs,
  recordedBy: z.string().min(1).max(500),
  verificationLevel: VerificationLevel,
  verificationMethod: z.string().min(1).max(500).nullable(),
  rawRef: z.string().min(1).max(4_096).nullable(),
  digest: z.string().min(1).max(500).nullable(),
  metadata: Metadata,
}).superRefine((value, ctx) => {
  if (value.verificationLevel !== "unverified" && value.verificationMethod == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verificationMethod"],
      message: "Verified observations require a verification method",
    });
  }
  if (value.rawRef != null && value.digest == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["digest"],
      message: "rawRef requires a binding digest",
    });
  }
});
export type Observation = z.infer<typeof Observation>;

export const ObservationInsert = z.object({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  source: z.string().min(1).max(500),
  externalEventId: z.string().min(1).max(1_000),
  kind: ObservationKind,
  schemaVersion: z.number().int().positive().default(1),
  payload: Metadata,
  occurredAt: UnixMs,
  verificationLevel: VerificationLevel.default("unverified"),
  verificationMethod: z.string().min(1).max(500).nullable().default(null),
  rawRef: z.string().min(1).max(4_096).nullable().default(null),
  digest: z.string().min(1).max(500).nullable().default(null),
  metadata: Metadata.default({}),
}).superRefine((value, ctx) => {
  if (value.verificationLevel !== "unverified" && value.verificationMethod == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verificationMethod"],
      message: "Verified observations require a verification method",
    });
  }
  if (value.rawRef != null && value.digest == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["digest"],
      message: "rawRef requires a binding digest",
    });
  }
});
export type ObservationInsert = z.infer<typeof ObservationInsert>;

/** Derived multi-key routing index; immutable and engine-owned. */
export const ObservationRoute = z.object({
  observationId: UuidV7,
  tenantId: z.string().min(1),
  kind: ObservationKind,
  routeKey: z.string().min(1).max(10_000),
});
export type ObservationRoute = z.infer<typeof ObservationRoute>;

/** Immutable result of one frozen matcher evaluation. */
export const Reconciliation = z.object({
  id: UuidV7,
  tenantId: z.string().min(1),
  conditionId: UuidV7,
  observationId: UuidV7,
  matcherKind: WaitConditionKind,
  matcherVersion: z.number().int().positive(),
  decision: ReconciliationDecision,
  effect: ReconciliationEffect,
  reasonCode: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2_000),
  evidenceId: UuidV7.nullable(),
  reconciledAt: UnixMs,
  reconciledBy: z.string().min(1).max(500),
}).superRefine((value, ctx) => {
  const valid =
    (value.decision === "matched" && value.effect === "satisfied" && value.evidenceId != null) ||
    (value.decision === "matched" && value.effect === "condition_terminal" && value.evidenceId == null) ||
    (value.decision === "matched" && value.effect === "no_change" && value.evidenceId == null) ||
    (value.decision !== "matched" && value.effect === "no_change" && value.evidenceId == null);
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effect"],
      message: "Reconciliation decision, effect, and evidence are inconsistent",
    });
  }
});
export type Reconciliation = z.infer<typeof Reconciliation>;

// ──────────────────────────────────────────────────────────────────────
// Event (append-only, immutable)
// ──────────────────────────────────────────────────────────────────────

export const EventPayload = z.object({
  before: Metadata.optional(),
  after: Metadata.optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
  source: z.string().optional(), // free-form, e.g. "watcher:mercury", "user:cli", "agent:hermes"
});
export type EventPayload = z.infer<typeof EventPayload>;

export const Event = z.object({
  sequence: z.number().int().positive(),
  id: UuidV7,
  tenantId: z.string().min(1),
  actor: z.string().min(1), // 'gwendall' | 'hermes' | 'claude-code' | 'system' | ...
  principalId: z.string().min(1).nullable(),
  entityType: EntityType,
  entityId: UuidV7,
  eventType: z.string().min(1),
  payload: EventPayload,
  /** Domain time supplied by the caller; null means "same as recorded". */
  occurredAt: UnixMs.nullable(),
  createdAt: UnixMs,
});
export type Event = z.infer<typeof Event>;

export const EventInsert = Event.omit({
  sequence: true,
  id: true,
  createdAt: true,
  principalId: true,
}).extend({
  id: UuidV7.optional(),
  tenantId: z.string().min(1).default("gwendall"),
  actor: z.string().min(1).default("system"),
  principalId: z.string().min(1).nullable().optional(),
  payload: EventPayload.default({}),
  occurredAt: UnixMs.nullable().default(null),
});
export type EventInsert = z.infer<typeof EventInsert>;

// ──────────────────────────────────────────────────────────────────────
// Durable delivery — local sink registry + transactional event outbox
// ──────────────────────────────────────────────────────────────────────

export const DELIVERY_SINK_STATUSES = ["enabled", "disabled"] as const;
export const DeliverySinkStatus = z.enum(DELIVERY_SINK_STATUSES);
export type DeliverySinkStatus = z.infer<typeof DeliverySinkStatus>;

export const DELIVERY_OUTBOX_STATUSES = [
  "pending",
  "delivering",
  "delivered",
  "quarantined",
] as const;
export const DeliveryOutboxStatus = z.enum(DELIVERY_OUTBOX_STATUSES);
export type DeliveryOutboxStatus = z.infer<typeof DeliveryOutboxStatus>;

/**
 * A local operational consumer of committed events. The configuration itself
 * stays with the host; Tasq persists only a digest so a different target
 * cannot silently consume an existing queue.
 */
export const DeliverySink = z.object({
  id: z.string().min(1).max(500),
  tenantId: z.string().min(1),
  kind: z.string().min(1).max(500),
  configurationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: DeliverySinkStatus,
  startAfterSequence: z.number().int().nonnegative(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
});
export type DeliverySink = z.infer<typeof DeliverySink>;

/**
 * Mutable delivery control state for one immutable event/sink pair. Event
 * content is never copied here: the append-only `event` row remains truth.
 */
export const DeliveryOutbox = z.object({
  id: z.string().min(1).max(1_100),
  tenantId: z.string().min(1),
  sinkId: z.string().min(1).max(500),
  eventSequence: z.number().int().positive(),
  eventId: UuidV7,
  status: DeliveryOutboxStatus,
  attemptCount: z.number().int().nonnegative(),
  availableAt: UnixMs,
  leaseOwner: z.string().min(1).max(500).nullable(),
  leaseExpiresAt: UnixMs.nullable(),
  lastError: z.string().max(4_000).nullable(),
  deliveredAt: UnixMs.nullable(),
  quarantinedAt: UnixMs.nullable(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
});
export type DeliveryOutbox = z.infer<typeof DeliveryOutbox>;
