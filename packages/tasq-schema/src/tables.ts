/**
 * Drizzle table definitions — the storage shape.
 *
 * One LibSQL file ; SQLite dialect via @libsql/client. All tables carry
 * `tenant_id` (default 'gwendall' in v0.1) for forward-compat with the
 * full v0.9 multi-tenant model.
 *
 * Schema mirrors `types.ts` one-to-one. The service layer is the only
 * thing that mutates these tables ; nothing else writes SQL directly.
 *
 * Conventions:
 *   - text PKs (UUIDv7 hex)
 *   - integer timestamps (unix-ms — JS Number-safe up to year 2255)
 *   - JSON columns stored as text and parsed in the service layer
 *   - tombstones via deleted_at, never DELETE
 *   - status / type enums kept as text + CHECK constraints
 */

import { sql } from "drizzle-orm";
import { check, sqliteTable, text, integer, index, uniqueIndex, primaryKey, foreignKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────────────────────────────
// Principal — stable attribution identity; authority remains a separate guard
// ──────────────────────────────────────────────────────────────────────

export const principal = sqliteTable(
  "principal",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    localAlias: text("local_alias"),
    status: text("status").notNull().default("enabled"),
    metadata: text("metadata").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    localAliasUniq: uniqueIndex("uniq_principal_local_alias").on(t.tenantId, t.localAlias),
    statusIdx: index("idx_principal_status").on(t.tenantId, t.status, t.updatedAt),
    consoleIdx: index("idx_console_actors").on(t.tenantId, t.createdAt, t.id),
    kindCheck: check("principal_kind_check", sql`${t.kind} IN ('human','agent','service','runtime')`),
    statusCheck: check("principal_status_check", sql`${t.status} IN ('enabled','disabled')`),
    revisionCheck: check("principal_revision_check", sql`${t.revision} > 0`),
    metadataJsonCheck: check("principal_metadata_json_check", sql`json_valid(${t.metadata})`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Coordination space — explicit durable workspace existence
// ──────────────────────────────────────────────────────────────────────

/**
 * A workspace must exist independently of any particular commitment. This
 * lets a cold actor distinguish "I created this coordination context" from
 * "I joined an existing one" without inferring existence from unrelated
 * rows or mutable local configuration.
 */
export const coordinationSpace = sqliteTable(
  "coordination_space",
  {
    workspaceId: text("workspace_id").primaryKey(),
    createdByPrincipalId: text("created_by_principal_id")
      .notNull()
      .references(() => principal.id),
    createdAt: integer("created_at").notNull(),
  },
);

// ──────────────────────────────────────────────────────────────────────
// Generic resource leases — opaque coordination identity, never fake work
// ──────────────────────────────────────────────────────────────────────

export const resourceLease = sqliteTable(
  "resource_lease",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => coordinationSpace.workspaceId),
    resourceKey: text("resource_key").notNull(),
    holderActor: text("holder_actor").notNull(),
    holderPrincipalId: text("holder_principal_id").notNull().references(() => principal.id),
    revision: integer("revision").notNull().default(1),
    fence: integer("fence").notNull(),
    acquiredAt: integer("acquired_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    releasedAt: integer("released_at"),
    releaseReason: text("release_reason"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    activeUniq: uniqueIndex("uniq_resource_lease_active").on(t.workspaceId, t.resourceKey)
      .where(sql`${t.releasedAt} IS NULL`),
    fenceUniq: uniqueIndex("uniq_resource_lease_fence").on(t.workspaceId, t.resourceKey, t.fence),
    worldIdx: index("idx_resource_lease_world").on(t.workspaceId, t.releasedAt, t.resourceKey),
    consoleActiveIdx: index("idx_console_resources").on(t.workspaceId, t.acquiredAt, t.id)
      .where(sql`${t.releasedAt} IS NULL`),
    holderIdx: index("idx_resource_lease_holder").on(t.workspaceId, t.holderPrincipalId, t.expiresAt),
    chronologyCheck: check("resource_lease_chronology_check",
      sql`${t.heartbeatAt} >= ${t.acquiredAt} AND ${t.expiresAt} > ${t.heartbeatAt}`),
    keyCheck: check("resource_lease_key_check",
      sql`length(CAST(${t.resourceKey} AS BLOB)) BETWEEN 1 AND 512 AND ${t.resourceKey} = trim(${t.resourceKey}) AND instr(${t.resourceKey}, char(0)) = 0 AND instr(${t.resourceKey}, char(9)) = 0 AND instr(${t.resourceKey}, char(10)) = 0 AND instr(${t.resourceKey}, char(13)) = 0`),
    actorCheck: check("resource_lease_actor_check",
      sql`length(${t.holderActor}) BETWEEN 1 AND 200 AND ${t.holderActor} = trim(${t.holderActor})`),
    releaseCheck: check("resource_lease_release_check",
      sql`(${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL) OR (${t.releasedAt} IS NOT NULL AND ${t.releaseReason} IS NOT NULL AND ${t.releasedAt} >= ${t.acquiredAt} AND length(trim(${t.releaseReason})) > 0)`),
    fenceCheck: check("resource_lease_fence_check", sql`${t.fence} > 0`),
    revisionCheck: check("resource_lease_revision_check", sql`${t.revision} > 0`),
    metadataCheck: check("resource_lease_metadata_check", sql`json_valid(${t.metadata}) AND json_type(${t.metadata}) = 'object' AND length(CAST(${t.metadata} AS BLOB)) <= 16384`),
  }),
);

export const resourceEvent = sqliteTable(
  "resource_event",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => coordinationSpace.workspaceId),
    resourceKey: text("resource_key").notNull(),
    leaseId: text("lease_id").notNull().references(() => resourceLease.id),
    actor: text("actor").notNull(),
    principalId: text("principal_id").notNull().references(() => principal.id),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    idUniq: uniqueIndex("uniq_resource_event_id").on(t.id),
    streamIdx: index("idx_resource_event_stream").on(t.workspaceId, t.sequence),
    resourceIdx: index("idx_resource_event_resource").on(t.workspaceId, t.resourceKey, t.sequence),
    typeCheck: check("resource_event_type_check",
      sql`${t.eventType} IN ('resource_lease_acquired','resource_lease_renewed','resource_lease_released','resource_lease_expired')`),
    payloadCheck: check("resource_event_payload_check", sql`json_valid(${t.payload}) AND json_type(${t.payload}) = 'object'`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Area
// ──────────────────────────────────────────────────────────────────────

export const area = sqliteTable(
  "area",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    importance: integer("importance").notNull().default(3),
    // Free-form advisory cadence text ("3x/week", "1/month"). ADVISORY ONLY —
    // no engine reads it (interpreting it would be L2 metric interpretation,
    // anti-pattern #19). The real engine recurrence signal is the task-level
    // `recurrence` enum below (SPEC §6.4-H).
    cadenceTarget: text("cadence_target"),
    description: text("description"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    slugUniq: uniqueIndex("uniq_area_tenant_slug").on(t.tenantId, t.slug),
    nameUniq: uniqueIndex("uniq_area_tenant_name").on(t.tenantId, t.name),
    importanceCheck: check("area_importance_check", sql`${t.importance} BETWEEN 1 AND 5`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Goal
// ──────────────────────────────────────────────────────────────────────

export const goal = sqliteTable(
  "goal",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    areaId: text("area_id")
      .notNull()
      .references(() => area.id),
    title: text("title").notNull(),
    description: text("description"),
    horizon: text("horizon"),
    importance: integer("importance").notNull().default(3),
    status: text("status").notNull().default("active"),
    targetDate: integer("target_date"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    areaIdx: index("idx_goal_area").on(t.tenantId, t.areaId, t.status),
    statusIdx: index("idx_goal_status").on(t.tenantId, t.status, t.deletedAt),
    importanceCheck: check("goal_importance_check", sql`${t.importance} BETWEEN 1 AND 5`),
    statusCheck: check("goal_status_check", sql`${t.status} IN ('active','paused','done','abandoned')`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Project
// ──────────────────────────────────────────────────────────────────────

export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    goalId: text("goal_id").references(() => goal.id),
    areaId: text("area_id").references(() => area.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    statusIdx: index("idx_project_status").on(t.tenantId, t.status, t.deletedAt),
    goalIdx: index("idx_project_goal").on(t.tenantId, t.goalId, t.status),
    areaIdx: index("idx_project_area").on(t.tenantId, t.areaId, t.status),
    statusCheck: check("project_status_check", sql`${t.status} IN ('active','blocked','waiting','done','cancelled')`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Task
// ──────────────────────────────────────────────────────────────────────

export const task = sqliteTable(
  "task",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    projectId: text("project_id").references(() => project.id),
    goalId: text("goal_id").references(() => goal.id),
    areaId: text("area_id").references(() => area.id),
    // Self-referential FK for sub-task hierarchy.
    // NULL = top-level task. App-level invariants: no cycles, max depth 5.
    // Use `service.createTask` / `service.updateTask` which enforce both.
    parentTaskId: text("parent_task_id").references((): AnySQLiteColumn => task.id),
    title: text("title").notNull(),
    description: text("description"),
    nextAction: text("next_action"),
    successCriteria: text("success_criteria"),
    completionMode: text("completion_mode").notNull().default("assertion"),
    validationRequired: integer("validation_required", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("open"),
    priority: integer("priority"),
    estimatedMinutes: integer("estimated_minutes"),
    scheduledAt: integer("scheduled_at"),
    dueAt: integer("due_at"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    // Recurrence (SPEC §6.4-H). NULL recurrence = one-shot (pre-v0.3 default).
    // On completion the service materializes the next instance one cadence-step
    // from the chosen anchor. `lastDoneAt`/`streak` are engine-owned signals.
    recurrence: text("recurrence"),
    recurrenceInterval: integer("recurrence_interval").notNull().default(1),
    recurrenceAnchor: text("recurrence_anchor").notNull().default("due"),
    lastDoneAt: integer("last_done_at"),
    streak: integer("streak").notNull().default(0),
    // Points a materialized instance at its chain root (the first template);
    // NULL on the root. Indexed for chain queries.
    recurrenceParentId: text("recurrence_parent_id"),
    metadata: text("metadata").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    statusIdx: index("idx_task_status").on(t.tenantId, t.status, t.deletedAt),
    consoleActiveIdx: index("idx_console_work").on(t.tenantId, t.createdAt, t.id)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} NOT IN ('done','cancelled')`),
    goalIdx: index("idx_task_goal").on(t.tenantId, t.goalId, t.status),
    areaIdx: index("idx_task_area").on(t.tenantId, t.areaId, t.status),
    projectIdx: index("idx_task_project").on(t.tenantId, t.projectId, t.status),
    parentIdx: index("idx_task_parent").on(t.tenantId, t.parentTaskId, t.status),
    recurrenceParentIdx: index("idx_task_recurrence_parent").on(t.tenantId, t.recurrenceParentId),
    scheduledIdx: index("idx_task_scheduled").on(t.tenantId, t.scheduledAt),
    dueIdx: index("idx_task_due").on(t.tenantId, t.dueAt),
    statusCheck: check("task_status_check", sql`${t.status} IN ('open','in_progress','blocked','done','cancelled')`),
    completionModeCheck: check("task_completion_mode_check", sql`${t.completionMode} IN ('assertion','evidence')`),
    priorityCheck: check("task_priority_check", sql`${t.priority} IS NULL OR ${t.priority} BETWEEN 1 AND 5`),
    estimateCheck: check("task_estimate_check", sql`${t.estimatedMinutes} IS NULL OR ${t.estimatedMinutes} > 0`),
    recurrenceCheck: check("task_recurrence_check", sql`${t.recurrence} IS NULL OR ${t.recurrence} IN ('daily','weekly','monthly','yearly')`),
    recurrenceIntervalCheck: check("task_recurrence_interval_check", sql`${t.recurrenceInterval} > 0`),
    recurrenceAnchorCheck: check("task_recurrence_anchor_check", sql`${t.recurrenceAnchor} IN ('due','scheduled','completion')`),
    revisionCheck: check("task_revision_check", sql`${t.revision} > 0`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Commitment summary — append-only, source-bound terminal projection
// ──────────────────────────────────────────────────────────────────────

export const commitmentSummary = sqliteTable(
  "commitment_summary",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    taskId: text("task_id").notNull().references(() => task.id),
    supersedesSummaryId: text("supersedes_summary_id")
      .references((): AnySQLiteColumn => commitmentSummary.id),
    summary: text("summary").notNull(),
    summaryDigest: text("summary_digest").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceStatus: text("source_status").notNull(),
    sourceEventSequence: integer("source_event_sequence").notNull(),
    sourceDigest: text("source_digest").notNull(),
    sourceRefs: text("source_refs").notNull(),
    actor: text("actor").notNull(),
    principalId: text("principal_id").notNull().references(() => principal.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    rootUniq: uniqueIndex("uniq_commitment_summary_root").on(t.tenantId, t.taskId)
      .where(sql`${t.supersedesSummaryId} IS NULL`),
    childUniq: uniqueIndex("uniq_commitment_summary_child").on(t.tenantId, t.supersedesSummaryId)
      .where(sql`${t.supersedesSummaryId} IS NOT NULL`),
    taskIdx: index("idx_commitment_summary_task").on(t.tenantId, t.taskId, t.createdAt),
    sourceCheck: check("commitment_summary_source_check",
      sql`${t.sourceRevision} > 0 AND ${t.sourceEventSequence} >= 0 AND ${t.sourceStatus} IN ('done','cancelled')`),
    summaryCheck: check("commitment_summary_text_check",
      sql`length(trim(${t.summary})) BETWEEN 1 AND 8000`),
    digestCheck: check("commitment_summary_digest_check",
      sql`${t.summaryDigest} GLOB 'sha256:[0-9a-f]*' AND length(${t.summaryDigest}) = 71 AND ${t.sourceDigest} GLOB 'sha256:[0-9a-f]*' AND length(${t.sourceDigest}) = 71`),
    refsCheck: check("commitment_summary_refs_check",
      sql`json_valid(${t.sourceRefs}) AND json_type(${t.sourceRefs}) = 'object'`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Event — append-only, immutable
// ──────────────────────────────────────────────────────────────────────

export const event = sqliteTable(
  "event",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    actor: text("actor").notNull().default("system"),
    principalId: text("principal_id").references(() => principal.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull().default("{}"),
    occurredAt: integer("occurred_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    idUniq: uniqueIndex("uniq_event_id").on(t.id),
    entityIdx: index("idx_event_entity").on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.sequence,
    ),
    recentIdx: index("idx_event_recent").on(t.tenantId, t.sequence),
    actorIdx: index("idx_event_actor").on(t.tenantId, t.actor, t.sequence),
    principalIdx: index("idx_event_principal").on(t.tenantId, t.principalId, t.sequence),
    typeCheck: check("event_type_check", sql`${t.entityType} IN ('area','goal','project','task')`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Durable delivery — local-only sinks and transactional event outbox
// ──────────────────────────────────────────────────────────────────────

/**
 * Local operational delivery target. It is deliberately not a domain record
 * and must never be replicated: different hosts can have different sinks.
 * The target configuration remains outside the DB; only its digest is stored.
 */
export const deliverySink = sqliteTable(
  "delivery_sink",
  {
    id: text("id").notNull(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    kind: text("kind").notNull(),
    configurationDigest: text("configuration_digest").notNull(),
    status: text("status").notNull().default("enabled"),
    startAfterSequence: integer("start_after_sequence").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    tenantStatusIdx: index("idx_delivery_sink_status").on(t.tenantId, t.status, t.id),
    statusCheck: check("delivery_sink_status_check", sql`${t.status} IN ('enabled','disabled')`),
    digestCheck: check(
      "delivery_sink_digest_check",
      sql`${t.configurationDigest} GLOB 'sha256:[0-9a-f]*' AND length(${t.configurationDigest}) = 71`,
    ),
    cursorCheck: check("delivery_sink_cursor_check", sql`${t.startAfterSequence} >= 0`),
  }),
);

/**
 * One durable delivery intent per enabled sink and immutable event. A SQLite
 * trigger creates this row in the exact transaction that inserts the event.
 */
export const deliveryOutbox = sqliteTable(
  "delivery_outbox",
  {
    id: text("id").notNull(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    sinkId: text("sink_id").notNull(),
    eventSequence: integer("event_sequence").notNull().references(() => event.sequence),
    eventId: text("event_id").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: integer("available_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    lastError: text("last_error"),
    deliveredAt: integer("delivered_at"),
    quarantinedAt: integer("quarantined_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    sinkFk: foreignKey({
      columns: [t.tenantId, t.sinkId],
      foreignColumns: [deliverySink.tenantId, deliverySink.id],
    }),
    eventSinkUniq: uniqueIndex("uniq_delivery_outbox_event_sink").on(
      t.tenantId,
      t.sinkId,
      t.eventSequence,
    ),
    dueIdx: index("idx_delivery_outbox_due").on(
      t.tenantId,
      t.sinkId,
      t.status,
      t.availableAt,
      t.eventSequence,
    ),
    statusIdx: index("idx_console_delivery_status").on(t.tenantId, t.status),
    eventIdx: index("idx_delivery_outbox_event").on(t.tenantId, t.eventSequence),
    statusCheck: check(
      "delivery_outbox_status_check",
      sql`${t.status} IN ('pending','delivering','delivered','quarantined')`,
    ),
    attemptsCheck: check("delivery_outbox_attempts_check", sql`${t.attemptCount} >= 0`),
    lifecycleCheck: check(
      "delivery_outbox_lifecycle_check",
      sql`(${t.status} = 'pending' AND ${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL AND ${t.deliveredAt} IS NULL AND ${t.quarantinedAt} IS NULL) OR (${t.status} = 'delivering' AND ${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL AND ${t.deliveredAt} IS NULL AND ${t.quarantinedAt} IS NULL) OR (${t.status} = 'delivered' AND ${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL AND ${t.deliveredAt} IS NOT NULL AND ${t.quarantinedAt} IS NULL) OR (${t.status} = 'quarantined' AND ${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL AND ${t.deliveredAt} IS NULL AND ${t.quarantinedAt} IS NOT NULL)`,
    ),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Task dependency — first-class peer edge (SPEC §4.5)
// ──────────────────────────────────────────────────────────────────────

/**
 * A directed dependency edge between two tasks (SPEC §4.5). `type='blocks'`
 * means `from_task_id` depends on `to_task_id` — i.e. `to_task_id` must resolve
 * before `from_task_id` is actionable. `relates_to` / `duplicates` are
 * informational (non-transitive, no cycle guard).
 *
 * Dependencies have no `cancelled` state — DELETE is a soft-delete (SPEC §5.3),
 * so the UNIQUE index is PARTIAL (WHERE deleted_at IS NULL) to let an edge be
 * re-added after removal; `dependTask` reactivates a soft-deleted match rather
 * than inserting a duplicate.
 *
 * A `blocks` edge does NOT auto-flip the dependent task's status to `blocked`
 * (SPEC §4.5 "no automatic coupling"); it only feeds the prioritizer's
 * W_blocked down-weight (§5.2.1).
 */
export const taskDependency = sqliteTable(
  "task_dependency",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    fromTaskId: text("from_task_id")
      .notNull()
      .references(() => task.id),
    toTaskId: text("to_task_id")
      .notNull()
      .references(() => task.id),
    type: text("type").notNull().default("blocks"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    // Partial UNIQUE: an edge can be re-added after a soft-delete (SPEC §5.3).
    uniq: uniqueIndex("uniq_task_dep")
      .on(t.tenantId, t.fromTaskId, t.toTaskId, t.type)
      .where(sql`${t.deletedAt} IS NULL`),
    // who-blocks-X / unresolved-blocker count.
    toIdx: index("idx_task_dep_to").on(t.tenantId, t.toTaskId, t.type, t.deletedAt),
    // what-X-blocks + the cycle walk.
    fromIdx: index("idx_task_dep_from").on(t.tenantId, t.fromTaskId, t.type, t.deletedAt),
    typeCheck: check("task_dep_type_check", sql`${t.type} IN ('blocks','relates_to','duplicates')`),
  }),
);

export const commitmentRelation = sqliteTable(
  "commitment_relation",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    fromTaskId: text("from_task_id").notNull().references(() => task.id),
    relationType: text("relation_type").notNull(),
    toTaskId: text("to_task_id").notNull().references(() => task.id),
    revision: integer("revision").notNull().default(1),
    createdByPrincipalId: text("created_by_principal_id").notNull().references(() => principal.id),
    createdAt: integer("created_at").notNull(),
    endedByPrincipalId: text("ended_by_principal_id").references(() => principal.id),
    endedAt: integer("ended_at"),
  },
  (t) => ({
    activeUniq: uniqueIndex("uniq_commitment_relation_active")
      .on(t.tenantId, t.fromTaskId, t.relationType, t.toTaskId)
      .where(sql`${t.endedAt} IS NULL`),
    fromIdx: index("idx_commitment_relation_from").on(t.tenantId, t.fromTaskId, t.relationType, t.endedAt),
    toIdx: index("idx_commitment_relation_to").on(t.tenantId, t.toTaskId, t.relationType, t.endedAt),
    noSelfCheck: check("commitment_relation_no_self_check", sql`${t.fromTaskId} <> ${t.toTaskId}`),
    revisionCheck: check("commitment_relation_revision_check", sql`${t.revision} > 0`),
    lifecycleCheck: check(
      "commitment_relation_lifecycle_check",
      sql`(${t.endedAt} IS NULL AND ${t.endedByPrincipalId} IS NULL) OR (${t.endedAt} IS NOT NULL AND ${t.endedByPrincipalId} IS NOT NULL AND ${t.endedAt} >= ${t.createdAt})`,
    ),
  }),
);

export const assignment = sqliteTable(
  "assignment",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    assignerPrincipalId: text("assigner_principal_id").notNull().references(() => principal.id),
    assigneePrincipalId: text("assignee_principal_id").notNull().references(() => principal.id),
    role: text("role").notNull(),
    status: text("status").notNull().default("proposed"),
    instructionsRef: text("instructions_ref"),
    acceptedAt: integer("accepted_at"),
    endedAt: integer("ended_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_assignment_task").on(t.tenantId, t.taskId, t.status, t.createdAt),
    assigneeIdx: index("idx_assignment_assignee").on(t.tenantId, t.assigneePrincipalId, t.status, t.updatedAt),
    statusCheck: check("assignment_status_check", sql`${t.status} IN ('proposed','accepted','rejected','revoked','released')`),
    revisionCheck: check("assignment_revision_check", sql`${t.revision} > 0`),
    lifecycleCheck: check(
      "assignment_lifecycle_check",
      sql`(${t.status} = 'proposed' AND ${t.acceptedAt} IS NULL AND ${t.endedAt} IS NULL) OR (${t.status} = 'accepted' AND ${t.acceptedAt} IS NOT NULL AND ${t.endedAt} IS NULL) OR (${t.status} IN ('rejected','revoked') AND ${t.acceptedAt} IS NULL AND ${t.endedAt} IS NOT NULL) OR (${t.status} = 'released' AND ${t.acceptedAt} IS NOT NULL AND ${t.endedAt} IS NOT NULL)`,
    ),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Idempotency — durable command deduplication
// ──────────────────────────────────────────────────────────────────────

export const idempotencyKey = sqliteTable(
  "idempotency_key",
  {
    tenantId: text("tenant_id").notNull(),
    callerScope: text("caller_scope").notNull(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    digestVersion: text("digest_version").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultType: text("result_type").notNull(),
    resultId: text("result_id").notNull(),
    resultStatus: text("result_status"),
    resultRevision: integer("result_revision"),
    eventSequence: integer("event_sequence"),
    retentionClass: text("retention_class").notNull(),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.callerScope, t.operation, t.key] }),
    expiryIdx: index("idx_idempotency_expiry").on(t.tenantId, t.retentionClass, t.expiresAt),
    requestDigestCheck: check(
      "idempotency_request_digest_check",
      sql`substr(${t.requestDigest}, 1, 7) = 'sha256:' AND length(${t.requestDigest}) = 71 AND substr(${t.requestDigest}, 8) NOT GLOB '*[^0-9a-f]*'`,
    ),
    digestVersionCheck: check(
      "idempotency_digest_version_check",
      sql`${t.digestVersion} IN ('tasq.jcs.sha256.v1','tasq.legacy.sha256.v0')`,
    ),
    identityCheck: check(
      "idempotency_identity_check",
      sql`length(trim(${t.tenantId})) BETWEEN 1 AND 500 AND length(trim(${t.callerScope})) BETWEEN 1 AND 1000 AND length(trim(${t.operation})) BETWEEN 1 AND 200 AND length(trim(${t.key})) BETWEEN 1 AND 500`,
    ),
    resultCheck: check(
      "idempotency_result_check",
      sql`length(trim(${t.resultType})) BETWEEN 1 AND 200 AND length(trim(${t.resultId})) BETWEEN 1 AND 2000 AND (${t.resultStatus} IS NULL OR length(trim(${t.resultStatus})) BETWEEN 1 AND 200) AND (${t.resultRevision} IS NULL OR ${t.resultRevision} > 0) AND (${t.eventSequence} IS NULL OR ${t.eventSequence} > 0)`,
    ),
    retentionCheck: check(
      "idempotency_retention_check",
      sql`${t.createdAt} >= 0 AND ((${t.retentionClass} = 'durable' AND ${t.expiresAt} IS NULL) OR (${t.retentionClass} = 'standard' AND ${t.expiresAt} IS NOT NULL AND ${t.expiresAt} > ${t.createdAt}))`,
    ),
  }),
);

export const externalRef = sqliteTable(
  "external_ref",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    system: text("system").notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    version: text("version"),
    digest: text("digest"),
    metadata: text("metadata").notNull().default("{}"),
    createdByPrincipalId: text("created_by_principal_id").notNull().references(() => principal.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    externalIdentityUniq: uniqueIndex("uniq_external_ref_identity").on(
      t.tenantId,
      t.system,
      t.resourceType,
      t.externalId,
    ),
    recordIdx: index("idx_external_ref_record").on(t.tenantId, t.recordType, t.recordId, t.createdAt),
    metadataJsonCheck: check("external_ref_metadata_json_check", sql`json_valid(${t.metadata})`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// External context links — append-only associations, never memory content
// ──────────────────────────────────────────────────────────────────────

export const externalContextLink = sqliteTable(
  "external_context_link",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    taskId: text("task_id").notNull().references(() => task.id),
    purposeUri: text("purpose_uri").notNull(),
    action: text("action").notNull(),
    supersedesLinkId: text("supersedes_link_id")
      .references((): AnySQLiteColumn => externalContextLink.id),
    system: text("system").notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    version: text("version"),
    digest: text("digest"),
    actor: text("actor").notNull(),
    principalId: text("principal_id").notNull().references(() => principal.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    rootUniq: uniqueIndex("uniq_external_context_link_root").on(
      t.tenantId, t.taskId, t.purposeUri, t.system, t.resourceType, t.externalId,
    ).where(sql`${t.supersedesLinkId} IS NULL`),
    childUniq: uniqueIndex("uniq_external_context_link_child").on(t.tenantId, t.supersedesLinkId)
      .where(sql`${t.supersedesLinkId} IS NOT NULL`),
    taskIdx: index("idx_external_context_link_task").on(t.tenantId, t.taskId, t.createdAt),
    targetIdx: index("idx_external_context_link_target").on(
      t.tenantId, t.system, t.resourceType, t.externalId,
    ),
    actionCheck: check("external_context_link_action_check", sql`${t.action} IN ('attach','detach')`),
    detachCheck: check("external_context_link_detach_check",
      sql`${t.action} = 'attach' OR ${t.supersedesLinkId} IS NOT NULL`),
    identityCheck: check("external_context_link_identity_check", sql`
      length(trim(${t.purposeUri})) BETWEEN 1 AND 2000 AND
      length(trim(${t.system})) BETWEEN 1 AND 2000 AND
      length(trim(${t.resourceType})) BETWEEN 1 AND 120 AND
      length(trim(${t.externalId})) BETWEEN 1 AND 1000 AND
      (${t.url} IS NULL OR length(trim(${t.url})) BETWEEN 1 AND 2000) AND
      (${t.version} IS NULL OR length(trim(${t.version})) BETWEEN 1 AND 500) AND
      (${t.digest} IS NULL OR length(trim(${t.digest})) BETWEEN 1 AND 500) AND
      length(trim(${t.actor})) BETWEEN 1 AND 500 AND
      ${t.createdAt} >= 0
    `),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Agentic execution primitives
// ──────────────────────────────────────────────────────────────────────

export const taskClaim = sqliteTable(
  "task_claim",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    actor: text("actor").notNull(),
    principalId: text("principal_id").references(() => principal.id),
    revision: integer("revision").notNull().default(1),
    fence: integer("fence").notNull(),
    acquiredAt: integer("acquired_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    releasedAt: integer("released_at"),
    releaseReason: text("release_reason"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    activeUniq: uniqueIndex("uniq_task_claim_active")
      .on(t.tenantId, t.taskId)
      .where(sql`${t.releasedAt} IS NULL`),
    consoleActiveIdx: index("idx_console_claims").on(t.tenantId, t.acquiredAt, t.id)
      .where(sql`${t.releasedAt} IS NULL`),
    fenceUniq: uniqueIndex("uniq_task_claim_fence").on(t.tenantId, t.taskId, t.fence),
    actorIdx: index("idx_task_claim_actor").on(t.tenantId, t.actor, t.expiresAt),
    principalIdx: index("idx_task_claim_principal").on(t.tenantId, t.principalId, t.expiresAt),
    taskIdx: index("idx_task_claim_task").on(t.tenantId, t.taskId, t.createdAt),
    expiryCheck: check("task_claim_expiry_check", sql`${t.expiresAt} > ${t.acquiredAt}`),
    chronologyCheck: check(
      "task_claim_chronology_check",
      sql`${t.heartbeatAt} >= ${t.acquiredAt} AND ${t.expiresAt} > ${t.heartbeatAt}`,
    ),
    releaseCheck: check(
      "task_claim_release_check",
      sql`(${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL) OR (${t.releasedAt} IS NOT NULL AND ${t.releaseReason} IS NOT NULL AND ${t.releasedAt} >= ${t.acquiredAt} AND length(trim(${t.releaseReason})) > 0)`,
    ),
    fenceCheck: check("task_claim_fence_check", sql`${t.fence} > 0`),
    revisionCheck: check("task_claim_revision_check", sql`${t.revision} > 0`),
  }),
);

export const taskAttempt = sqliteTable(
  "task_attempt",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    claimId: text("claim_id").references(() => taskClaim.id),
    actor: text("actor").notNull(),
    principalId: text("principal_id").references(() => principal.id),
    revision: integer("revision").notNull().default(1),
    runtime: text("runtime").notNull().default("local"),
    externalId: text("external_id"),
    contextId: text("context_id"),
    status: text("status").notNull().default("running"),
    statusMessage: text("status_message"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_task_attempt_task").on(t.tenantId, t.taskId, t.startedAt),
    externalIdx: index("idx_task_attempt_external").on(t.tenantId, t.runtime, t.externalId),
    statusIdx: index("idx_task_attempt_status").on(t.tenantId, t.status, t.updatedAt),
    principalIdx: index("idx_task_attempt_principal").on(t.tenantId, t.principalId, t.updatedAt),
    statusCheck: check("task_attempt_status_check", sql`${t.status} IN ('running','input_required','succeeded','failed','cancelled')`),
    lifecycleCheck: check(
      "task_attempt_lifecycle_check",
      sql`((${t.status} IN ('running','input_required')) AND ${t.endedAt} IS NULL) OR ((${t.status} IN ('succeeded','failed','cancelled')) AND ${t.endedAt} IS NOT NULL AND ${t.endedAt} >= ${t.startedAt})`,
    ),
    revisionCheck: check("task_attempt_revision_check", sql`${t.revision} > 0`),
  }),
);

export const taskEvidence = sqliteTable(
  "task_evidence",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    attemptId: text("attempt_id").references(() => taskAttempt.id),
    supersedesEvidenceId: text("supersedes_evidence_id").references((): AnySQLiteColumn => taskEvidence.id),
    actor: text("actor").notNull(),
    principalId: text("principal_id").references(() => principal.id),
    kind: text("kind").notNull(),
    summary: text("summary"),
    uri: text("uri"),
    digest: text("digest"),
    source: text("source"),
    observedAt: integer("observed_at").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_task_evidence_task").on(t.tenantId, t.taskId, t.createdAt),
    attemptIdx: index("idx_task_evidence_attempt").on(t.tenantId, t.attemptId),
    kindIdx: index("idx_task_evidence_kind").on(t.tenantId, t.kind, t.observedAt),
    principalIdx: index("idx_task_evidence_principal").on(t.tenantId, t.principalId, t.createdAt),
    contentCheck: check(
      "task_evidence_content_check",
      sql`(${t.summary} IS NOT NULL AND length(trim(${t.summary})) > 0) OR (${t.uri} IS NOT NULL AND length(trim(${t.uri})) > 0)`,
    ),
    supersessionCheck: check(
      "task_evidence_no_self_supersession_check",
      sql`${t.supersedesEvidenceId} IS NULL OR ${t.supersedesEvidenceId} <> ${t.id}`,
    ),
  }),
);

export const artifact = sqliteTable(
  "artifact",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    attemptId: text("attempt_id").references(() => taskAttempt.id),
    typeUri: text("type_uri").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    name: text("name").notNull(),
    mediaType: text("media_type"),
    uri: text("uri"),
    digest: text("digest").notNull(),
    inlineDataRef: text("inline_data_ref"),
    createdByPrincipalId: text("created_by_principal_id").notNull().references(() => principal.id),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_artifact_task").on(t.tenantId, t.taskId, t.createdAt),
    attemptIdx: index("idx_artifact_attempt").on(t.tenantId, t.attemptId, t.createdAt),
    digestIdx: index("idx_artifact_digest").on(t.tenantId, t.digest),
    schemaVersionCheck: check("artifact_schema_version_check", sql`${t.schemaVersion} > 0`),
    contentCheck: check("artifact_content_check", sql`${t.uri} IS NOT NULL OR ${t.inlineDataRef} IS NOT NULL`),
    metadataJsonCheck: check("artifact_metadata_json_check", sql`json_valid(${t.metadata})`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// ADR-005 independently validated completion — immutable resolution chain
// ──────────────────────────────────────────────────────────────────────

export const resolutionContract = sqliteTable(
  "resolution_contract",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    taskRevision: integer("task_revision").notNull(),
    successCriteriaSnapshot: text("success_criteria_snapshot").notNull(),
    criteriaJson: text("criteria_json").notNull(),
    criteriaDigest: text("criteria_digest").notNull(),
    policyKind: text("policy_kind").notNull(),
    policyUri: text("policy_uri").notNull(),
    policyVersion: integer("policy_version").notNull(),
    implementationDigest: text("implementation_digest").notNull(),
    notBefore: integer("not_before"),
    challengeWindowMs: integer("challenge_window_ms").notNull().default(0),
    allowSelfValidation: integer("allow_self_validation", { mode: "boolean" }).notNull().default(false),
    eligibleValidatorPrincipalIds: text("eligible_validator_principal_ids").notNull().default("[]"),
    adjudicatorPrincipalIds: text("adjudicator_principal_ids").notNull().default("[]"),
    contractDigest: text("contract_digest").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull().references(() => principal.id),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_resolution_contract_task").on(t.tenantId, t.taskId, t.createdAt),
    digestUniq: uniqueIndex("uniq_resolution_contract_digest").on(t.tenantId, t.contractDigest),
    revisionCheck: check("resolution_contract_revision_check", sql`${t.taskRevision} > 0`),
    policyCheck: check(
      "resolution_contract_policy_check",
      sql`${t.policyKind} IN ('deterministic','attestation','optimistic','adjudicated')`,
    ),
    policyVersionCheck: check("resolution_contract_policy_version_check", sql`${t.policyVersion} > 0`),
    challengeCheck: check("resolution_contract_challenge_check", sql`${t.challengeWindowMs} >= 0`),
    jsonCheck: check(
      "resolution_contract_json_check",
      sql`json_valid(${t.criteriaJson}) AND json_type(${t.criteriaJson}) = 'array'
        AND json_array_length(${t.criteriaJson}) > 0
        AND json_valid(${t.eligibleValidatorPrincipalIds}) AND json_type(${t.eligibleValidatorPrincipalIds}) = 'array'
        AND json_valid(${t.adjudicatorPrincipalIds}) AND json_type(${t.adjudicatorPrincipalIds}) = 'array'
        AND json_valid(${t.metadata}) AND json_type(${t.metadata}) = 'object'`,
    ),
  }),
);

export const evidenceTrustRecord = sqliteTable(
  "evidence_trust_record",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    evidenceId: text("evidence_id").notNull().references(() => taskEvidence.id),
    action: text("action").notNull(),
    authenticity: text("authenticity").notNull(),
    authorityUri: text("authority_uri").notNull(),
    authorityVersion: integer("authority_version").notNull(),
    authorityDigest: text("authority_digest").notNull(),
    supersedesTrustRecordId: text("supersedes_trust_record_id").references(
      (): AnySQLiteColumn => evidenceTrustRecord.id,
    ),
    reason: text("reason").notNull(),
    verifiedAt: integer("verified_at").notNull(),
    validUntil: integer("valid_until"),
    retentionUntil: integer("retention_until"),
    recordedByPrincipalId: text("recorded_by_principal_id").notNull().references(() => principal.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    evidenceIdx: index("idx_evidence_trust_evidence").on(t.tenantId, t.evidenceId, t.createdAt),
    rootUniq: uniqueIndex("uniq_evidence_trust_root").on(t.tenantId, t.evidenceId)
      .where(sql`${t.supersedesTrustRecordId} IS NULL`),
    childUniq: uniqueIndex("uniq_evidence_trust_child").on(t.tenantId, t.supersedesTrustRecordId)
      .where(sql`${t.supersedesTrustRecordId} IS NOT NULL`),
    actionCheck: check("evidence_trust_action_check", sql`${t.action} IN ('attest','revoke')`),
    authenticityCheck: check(
      "evidence_trust_authenticity_check",
      sql`${t.authenticity} IN ('unverified','authenticated_principal','authenticated_source','provider_verified')`,
    ),
    chronologyCheck: check(
      "evidence_trust_chronology_check",
      sql`(${t.validUntil} IS NULL OR ${t.validUntil} >= ${t.verifiedAt})
        AND (${t.retentionUntil} IS NULL OR ${t.retentionUntil} >= ${t.verifiedAt})`,
    ),
    supersessionCheck: check(
      "evidence_trust_supersession_check",
      sql`(${t.action} = 'attest' AND ${t.supersedesTrustRecordId} IS NULL)
        OR (${t.action} = 'revoke' AND ${t.supersedesTrustRecordId} IS NOT NULL
          AND ${t.supersedesTrustRecordId} <> ${t.id})`,
    ),
  }),
);

export const completionProposal = sqliteTable(
  "completion_proposal",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    resolutionContractId: text("resolution_contract_id").notNull().references(() => resolutionContract.id),
    contractDigest: text("contract_digest").notNull(),
    proposerPrincipalId: text("proposer_principal_id").notNull().references(() => principal.id),
    criterionEvidence: text("criterion_evidence").notNull(),
    summary: text("summary"),
    proposalDigest: text("proposal_digest").notNull(),
    proposedAt: integer("proposed_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_completion_proposal_task").on(t.tenantId, t.taskId, t.proposedAt),
    contractIdx: index("idx_completion_proposal_contract").on(t.tenantId, t.resolutionContractId, t.proposedAt),
    digestUniq: uniqueIndex("uniq_completion_proposal_digest").on(t.tenantId, t.proposalDigest),
    evidenceJsonCheck: check(
      "completion_proposal_evidence_json_check",
      sql`json_valid(${t.criterionEvidence}) AND json_type(${t.criterionEvidence}) = 'array'
        AND json_array_length(${t.criterionEvidence}) > 0`,
    ),
  }),
);

export const completionChallenge = sqliteTable(
  "completion_challenge",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    proposalId: text("proposal_id").notNull().references(() => completionProposal.id),
    challengerPrincipalId: text("challenger_principal_id").notNull().references(() => principal.id),
    reasonCode: text("reason_code").notNull(),
    explanation: text("explanation").notNull(),
    counterEvidenceIds: text("counter_evidence_ids").notNull().default("[]"),
    challengedAt: integer("challenged_at").notNull(),
  },
  (t) => ({
    proposalIdx: index("idx_completion_challenge_proposal").on(t.tenantId, t.proposalId, t.challengedAt),
    counterEvidenceJsonCheck: check(
      "completion_challenge_evidence_json_check",
      sql`json_valid(${t.counterEvidenceIds}) AND json_type(${t.counterEvidenceIds}) = 'array'`,
    ),
  }),
);

export const validationDecision = sqliteTable(
  "validation_decision",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    resolutionContractId: text("resolution_contract_id").notNull().references(() => resolutionContract.id),
    proposalId: text("proposal_id").notNull().references(() => completionProposal.id),
    outcome: text("outcome").notNull(),
    policyUri: text("policy_uri").notNull(),
    policyVersion: integer("policy_version").notNull(),
    implementationDigest: text("implementation_digest").notNull(),
    policyInputDigest: text("policy_input_digest").notNull(),
    evidenceIds: text("evidence_ids").notNull().default("[]"),
    trustRecordIds: text("trust_record_ids").notNull().default("[]"),
    supersedesDecisionId: text("supersedes_decision_id").references(
      (): AnySQLiteColumn => validationDecision.id,
    ),
    decidedByPrincipalId: text("decided_by_principal_id").notNull().references(() => principal.id),
    reasonCode: text("reason_code").notNull(),
    explanation: text("explanation").notNull(),
    decidedAt: integer("decided_at").notNull(),
  },
  (t) => ({
    proposalIdx: index("idx_validation_decision_proposal").on(t.tenantId, t.proposalId, t.decidedAt),
    rootUniq: uniqueIndex("uniq_validation_decision_root").on(t.tenantId, t.proposalId)
      .where(sql`${t.supersedesDecisionId} IS NULL`),
    childUniq: uniqueIndex("uniq_validation_decision_child").on(t.tenantId, t.supersedesDecisionId)
      .where(sql`${t.supersedesDecisionId} IS NOT NULL`),
    outcomeCheck: check(
      "validation_decision_outcome_check",
      sql`${t.outcome} IN ('accepted','rejected','too_early','indeterminate','challenged')`,
    ),
    policyVersionCheck: check("validation_decision_policy_version_check", sql`${t.policyVersion} > 0`),
    supersessionCheck: check(
      "validation_decision_supersession_check",
      sql`${t.supersedesDecisionId} IS NULL OR ${t.supersedesDecisionId} <> ${t.id}`,
    ),
    jsonCheck: check(
      "validation_decision_json_check",
      sql`json_valid(${t.evidenceIds}) AND json_type(${t.evidenceIds}) = 'array'
        AND json_valid(${t.trustRecordIds}) AND json_type(${t.trustRecordIds}) = 'array'`,
    ),
  }),
);

export const completionRecord = sqliteTable(
  "completion_record",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    resultingRevision: integer("resulting_revision").notNull(),
    completionPolicyUri: text("completion_policy_uri").notNull(),
    completionPolicyVersion: integer("completion_policy_version").notNull(),
    policyInputDigest: text("policy_input_digest").notNull(),
    evidenceIds: text("evidence_ids").notNull().default("[]"),
    resolutionContractId: text("resolution_contract_id").references(
      () => resolutionContract.id,
    ),
    validationDecisionId: text("validation_decision_id").references(
      () => validationDecision.id,
    ),
    decidedByPrincipalId: text("decided_by_principal_id").notNull().references(() => principal.id),
    decidedAt: integer("decided_at").notNull(),
  },
  (t) => ({
    taskRevisionUniq: uniqueIndex("uniq_completion_record_task_revision").on(
      t.tenantId,
      t.taskId,
      t.resultingRevision,
    ),
    taskIdx: index("idx_completion_record_task").on(t.tenantId, t.taskId, t.resultingRevision),
    revisionCheck: check("completion_record_revision_check", sql`${t.resultingRevision} > 0`),
    policyVersionCheck: check("completion_record_policy_version_check", sql`${t.completionPolicyVersion} > 0`),
    evidenceJsonCheck: check(
      "completion_record_evidence_json_check",
      sql`json_valid(${t.evidenceIds}) AND json_type(${t.evidenceIds}) = 'array'`,
    ),
    resolutionLinkCheck: check(
      "completion_record_resolution_link_check",
      sql`(${t.resolutionContractId} IS NULL AND ${t.validationDecisionId} IS NULL)
        OR (${t.resolutionContractId} IS NOT NULL AND ${t.validationDecisionId} IS NOT NULL)`,
    ),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Universal extension registry — immutable trusted meaning snapshots
// ──────────────────────────────────────────────────────────────────────

export const extensionRelease = sqliteTable(
  "extension_release",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    extensionUri: text("extension_uri").notNull(),
    version: text("version").notNull(),
    manifestJson: text("manifest_json").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    installedAt: integer("installed_at").notNull(),
    installedBy: text("installed_by").notNull(),
  },
  (t) => ({
    identityUniq: uniqueIndex("uniq_extension_release_identity").on(
      t.tenantId,
      t.extensionUri,
      t.version,
    ),
    manifestJsonCheck: check("extension_release_manifest_json_check", sql`json_valid(${t.manifestJson})`),
  }),
);

export const extensionType = sqliteTable(
  "extension_type",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    extensionReleaseId: text("extension_release_id").notNull().references(() => extensionRelease.id),
    recordKind: text("record_kind").notNull(),
    typeUri: text("type_uri").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    schemaJson: text("schema_json").notNull(),
    schemaDigest: text("schema_digest").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    identityUniq: uniqueIndex("uniq_extension_type_identity").on(
      t.tenantId,
      t.typeUri,
      t.schemaVersion,
    ),
    releaseIdx: index("idx_extension_type_release").on(t.tenantId, t.extensionReleaseId),
    recordKindCheck: check(
      "extension_type_record_kind_check",
      sql`${t.recordKind} IN ('condition','observation','evidence','artifact','effect')`,
    ),
    schemaVersionCheck: check("extension_type_schema_version_check", sql`${t.schemaVersion} > 0`),
    schemaJsonCheck: check("extension_type_schema_json_check", sql`json_valid(${t.schemaJson})`),
  }),
);

export const extensionEvaluator = sqliteTable(
  "extension_evaluator",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    extensionReleaseId: text("extension_release_id").notNull().references(() => extensionRelease.id),
    evaluatorUri: text("evaluator_uri").notNull(),
    evaluatorVersion: integer("evaluator_version").notNull(),
    conditionTypeUri: text("condition_type_uri").notNull(),
    conditionSchemaVersion: integer("condition_schema_version").notNull(),
    acceptedObservationTypes: text("accepted_observation_types").notNull(),
    implementationDigest: text("implementation_digest").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    identityUniq: uniqueIndex("uniq_extension_evaluator_identity").on(
      t.tenantId,
      t.evaluatorUri,
      t.evaluatorVersion,
    ),
    releaseIdx: index("idx_extension_evaluator_release").on(t.tenantId, t.extensionReleaseId),
    evaluatorVersionCheck: check("extension_evaluator_version_check", sql`${t.evaluatorVersion} > 0`),
    conditionVersionCheck: check(
      "extension_evaluator_condition_version_check",
      sql`${t.conditionSchemaVersion} > 0`,
    ),
    acceptedTypesJsonCheck: check(
      "extension_evaluator_accepted_types_json_check",
      sql`json_valid(${t.acceptedObservationTypes}) AND json_type(${t.acceptedObservationTypes}) = 'array'`,
    ),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Wait condition — monotone typed expectation lifecycle
// ──────────────────────────────────────────────────────────────────────

export const waitCondition = sqliteTable(
  "wait_condition",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    kind: text("kind").notNull(),
    typeUri: text("type_uri").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    evaluatorUri: text("evaluator_uri").notNull(),
    evaluatorVersion: integer("evaluator_version").notNull(),
    evaluatorImplementationDigest: text("evaluator_implementation_digest").notNull(),
    parameters: text("parameters").notNull(),
    status: text("status").notNull().default("waiting"),
    notBefore: integer("not_before").notNull(),
    deadlineAt: integer("deadline_at"),
    fallbackKind: text("fallback_kind").notNull().default("none"),
    fallbackSpec: text("fallback_spec"),
    fallbackTargetTaskId: text("fallback_target_task_id").references(() => task.id),
    fallbackResultTaskId: text("fallback_result_task_id").references(() => task.id),
    supersedesConditionId: text("supersedes_condition_id").references(
      (): AnySQLiteColumn => waitCondition.id,
    ),
    // Added before observation existed; migration 0009 uses triggers for the
    // cross-row tenant check rather than rebuilding this populated table.
    satisfiedByObservationId: text("satisfied_by_observation_id"),
    satisfiedAt: integer("satisfied_at"),
    expiredAt: integer("expired_at"),
    cancelledAt: integer("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    taskStatusIdx: index("idx_wait_condition_task_status").on(
      t.tenantId,
      t.taskId,
      t.status,
      t.createdAt,
    ),
    consoleWaitingIdx: index("idx_console_waits").on(t.tenantId, t.createdAt, t.id)
      .where(sql`${t.status} = 'waiting'`),
    dueIdx: index("idx_wait_condition_due").on(t.tenantId, t.status, t.deadlineAt),
    candidateIdx: index("idx_wait_condition_kind").on(
      t.tenantId,
      t.kind,
      t.schemaVersion,
      t.status,
    ),
    supersedesUniq: uniqueIndex("uniq_wait_condition_supersedes")
      .on(t.tenantId, t.supersedesConditionId)
      .where(sql`${t.supersedesConditionId} IS NOT NULL`),
    statusCheck: check(
      "wait_condition_status_check",
      sql`${t.status} IN ('waiting','satisfied','expired','cancelled')`,
    ),
    kindCheck: check(
      "wait_condition_kind_check",
      sql`${t.kind} IN ('gmail.thread_reply','github.pull_request_state','mercury.transaction_state','http.response','filesystem.artifact')`,
    ),
    schemaVersionCheck: check("wait_condition_schema_version_check", sql`${t.schemaVersion} > 0`),
    deadlineCheck: check(
      "wait_condition_deadline_check",
      sql`${t.deadlineAt} IS NULL OR ${t.deadlineAt} > ${t.notBefore}`,
    ),
    fallbackKindCheck: check(
      "wait_condition_fallback_kind_check",
      sql`${t.fallbackKind} IN ('none','create_task','activate_task')`,
    ),
    fallbackShapeCheck: check(
      "wait_condition_fallback_shape_check",
      sql`(${t.fallbackKind} = 'none' AND ${t.fallbackSpec} IS NULL AND ${t.fallbackTargetTaskId} IS NULL) OR (${t.fallbackKind} = 'create_task' AND ${t.fallbackSpec} IS NOT NULL AND ${t.fallbackTargetTaskId} IS NULL) OR (${t.fallbackKind} = 'activate_task' AND ${t.fallbackSpec} IS NULL AND ${t.fallbackTargetTaskId} IS NOT NULL)`,
    ),
    noSelfSupersessionCheck: check(
      "wait_condition_no_self_supersession_check",
      sql`${t.supersedesConditionId} IS NULL OR ${t.supersedesConditionId} <> ${t.id}`,
    ),
    lifecycleCheck: check(
      "wait_condition_lifecycle_check",
      sql`(${t.status} = 'waiting' AND ${t.satisfiedAt} IS NULL AND ${t.satisfiedByObservationId} IS NULL AND ${t.expiredAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL AND ${t.fallbackResultTaskId} IS NULL) OR (${t.status} = 'satisfied' AND ${t.satisfiedAt} IS NOT NULL AND ${t.satisfiedByObservationId} IS NOT NULL AND ${t.expiredAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL AND ${t.fallbackResultTaskId} IS NULL) OR (${t.status} = 'expired' AND ${t.satisfiedAt} IS NULL AND ${t.satisfiedByObservationId} IS NULL AND ${t.expiredAt} IS NOT NULL AND ${t.deadlineAt} IS NOT NULL AND ${t.expiredAt} >= ${t.deadlineAt} AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL AND ((${t.fallbackKind} = 'none' AND ${t.fallbackResultTaskId} IS NULL) OR (${t.fallbackKind} IN ('create_task','activate_task') AND ${t.fallbackResultTaskId} IS NOT NULL))) OR (${t.status} = 'cancelled' AND ${t.satisfiedAt} IS NULL AND ${t.satisfiedByObservationId} IS NULL AND ${t.expiredAt} IS NULL AND ${t.cancelledAt} IS NOT NULL AND ${t.cancelledAt} >= ${t.createdAt} AND ${t.cancelReason} IS NOT NULL AND length(trim(${t.cancelReason})) > 0 AND ${t.fallbackResultTaskId} IS NULL)`,
    ),
    chronologyCheck: check(
      "wait_condition_chronology_check",
      sql`${t.updatedAt} >= ${t.createdAt} AND (${t.satisfiedAt} IS NULL OR ${t.satisfiedAt} >= ${t.createdAt}) AND (${t.expiredAt} IS NULL OR ${t.expiredAt} >= ${t.createdAt})`,
    ),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Observation — immutable normalized fact from a watcher/connector
// ──────────────────────────────────────────────────────────────────────

export const observation = sqliteTable(
  "observation",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    source: text("source").notNull(),
    externalEventId: text("external_event_id").notNull(),
    kind: text("kind").notNull(),
    typeUri: text("type_uri").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    subjectRef: text("subject_ref").notNull(),
    payload: text("payload").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    recordedBy: text("recorded_by").notNull(),
    verificationLevel: text("verification_level").notNull().default("unverified"),
    verificationMethod: text("verification_method"),
    rawRef: text("raw_ref"),
    digest: text("digest"),
    metadata: text("metadata").notNull().default("{}"),
  },
  (t) => ({
    deliveryUniq: uniqueIndex("uniq_observation_delivery").on(
      t.tenantId,
      t.source,
      t.externalEventId,
    ),
    candidateIdx: index("idx_observation_candidate").on(
      t.tenantId,
      t.kind,
      t.subjectRef,
      t.occurredAt,
    ),
    recordedIdx: index("idx_observation_recorded").on(t.tenantId, t.recordedAt, t.id),
    kindCheck: check(
      "observation_kind_check",
      sql`${t.kind} IN ('gmail.message','github.pull_request','mercury.transaction','http.check','filesystem.stat')`,
    ),
    schemaVersionCheck: check("observation_schema_version_check", sql`${t.schemaVersion} > 0`),
    verificationLevelCheck: check(
      "observation_verification_level_check",
      sql`${t.verificationLevel} IN ('unverified','authenticated_source','provider_verified')`,
    ),
    verificationMethodCheck: check(
      "observation_verification_method_check",
      sql`${t.verificationLevel} = 'unverified' OR (${t.verificationMethod} IS NOT NULL AND length(trim(${t.verificationMethod})) > 0)`,
    ),
    rawBindingCheck: check(
      "observation_raw_binding_check",
      sql`${t.rawRef} IS NULL OR (${t.digest} IS NOT NULL AND length(trim(${t.digest})) > 0)`,
    ),
    payloadJsonCheck: check("observation_payload_json_check", sql`json_valid(${t.payload})`),
    metadataJsonCheck: check("observation_metadata_json_check", sql`json_valid(${t.metadata})`),
    timestampCheck: check(
      "observation_timestamp_check",
      sql`${t.occurredAt} >= 0 AND ${t.recordedAt} >= 0`,
    ),
  }),
);

export const observationRoute = sqliteTable(
  "observation_route",
  {
    observationId: text("observation_id").notNull().references(() => observation.id),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    routeKey: text("route_key").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.observationId, t.routeKey] }),
    lookupIdx: index("idx_observation_route_lookup").on(
      t.tenantId,
      t.kind,
      t.routeKey,
      t.observationId,
    ),
  }),
);

export const reconciliation = sqliteTable(
  "reconciliation",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    conditionId: text("condition_id").notNull().references(() => waitCondition.id),
    observationId: text("observation_id").notNull().references(() => observation.id),
    matcherKind: text("matcher_kind").notNull(),
    matcherVersion: integer("matcher_version").notNull(),
    evaluatorUri: text("evaluator_uri").notNull(),
    evaluatorVersion: integer("evaluator_version").notNull(),
    evaluatorImplementationDigest: text("evaluator_implementation_digest").notNull(),
    decision: text("decision").notNull(),
    effect: text("effect").notNull(),
    reasonCode: text("reason_code").notNull(),
    explanation: text("explanation").notNull(),
    evidenceId: text("evidence_id").references(() => taskEvidence.id),
    reconciledAt: integer("reconciled_at").notNull(),
    reconciledBy: text("reconciled_by").notNull(),
  },
  (t) => ({
    naturalUniq: uniqueIndex("uniq_reconciliation_evaluation").on(
      t.tenantId,
      t.conditionId,
      t.observationId,
      t.matcherVersion,
    ),
    conditionIdx: index("idx_reconciliation_condition").on(
      t.tenantId,
      t.conditionId,
      t.reconciledAt,
    ),
    observationIdx: index("idx_reconciliation_observation").on(
      t.tenantId,
      t.observationId,
      t.reconciledAt,
    ),
    matcherVersionCheck: check("reconciliation_matcher_version_check", sql`${t.matcherVersion} > 0`),
    decisionCheck: check(
      "reconciliation_decision_check",
      sql`${t.decision} IN ('matched','rejected','ambiguous')`,
    ),
    effectCheck: check(
      "reconciliation_effect_check",
      sql`${t.effect} IN ('satisfied','no_change','condition_terminal')`,
    ),
    outcomeCheck: check(
      "reconciliation_outcome_check",
      sql`(${t.decision} = 'matched' AND ${t.effect} = 'satisfied' AND ${t.evidenceId} IS NOT NULL) OR (${t.decision} = 'matched' AND ${t.effect} IN ('no_change','condition_terminal') AND ${t.evidenceId} IS NULL) OR (${t.decision} IN ('rejected','ambiguous') AND ${t.effect} = 'no_change' AND ${t.evidenceId} IS NULL)`,
    ),
    timestampCheck: check("reconciliation_timestamp_check", sql`${t.reconciledAt} >= 0`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// K2 effect ledger — exact request, immutable approvals and monotone state
// ──────────────────────────────────────────────────────────────────────

export const effect = sqliteTable(
  "effect",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    taskId: text("task_id").notNull().references(() => task.id),
    attemptId: text("attempt_id").references(() => taskAttempt.id),
    canonicalRequest: text("canonical_request").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestProtocol: text("request_protocol").notNull(),
    canonicalization: text("canonicalization").notNull(),
    digestAlgorithm: text("digest_algorithm").notNull(),
    effectTypeUri: text("effect_type_uri").notNull(),
    effectSchemaVersion: integer("effect_schema_version").notNull(),
    connectorOperationUri: text("connector_operation_uri").notNull(),
    connectorOperationVersion: integer("connector_operation_version").notNull(),
    connectorContractDigest: text("connector_contract_digest").notNull(),
    connectorInstanceRef: text("connector_instance_ref").notNull(),
    connectorBindingDigest: text("connector_binding_digest").notNull(),
    dispatchIdempotencyKey: text("dispatch_idempotency_key").notNull(),
    status: text("status").notNull().default("proposed"),
    authorizedByApprovalId: text("authorized_by_approval_id"),
    outcomeReceiptId: text("outcome_receipt_id"),
    claimId: text("claim_id").references(() => taskClaim.id),
    fence: integer("fence"),
    supersedesEffectId: text("supersedes_effect_id").references(
      (): AnySQLiteColumn => effect.id,
    ),
    compensationOfEffectId: text("compensation_of_effect_id").references(
      (): AnySQLiteColumn => effect.id,
    ),
    createdByPrincipalId: text("created_by_principal_id").notNull().references(() => principal.id),
    revision: integer("revision").notNull().default(1),
    authorizedAt: integer("authorized_at"),
    executionStartedAt: integer("execution_started_at"),
    indeterminateAt: integer("indeterminate_at"),
    resolvedAt: integer("resolved_at"),
    cancelledAt: integer("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    taskIdx: index("idx_effect_task").on(t.tenantId, t.taskId, t.createdAt),
    statusIdx: index("idx_effect_status").on(t.tenantId, t.status, t.updatedAt),
    consoleUnresolvedIdx: index("idx_console_effects").on(t.tenantId, t.createdAt, t.id)
      .where(sql`${t.status} IN ('proposed','authorized','executing','indeterminate')`),
    digestIdx: index("idx_effect_digest").on(t.tenantId, t.requestDigest),
    dispatchUniq: uniqueIndex("uniq_effect_dispatch_key").on(t.tenantId, t.dispatchIdempotencyKey),
    supersedesUniq: uniqueIndex("uniq_effect_supersedes")
      .on(t.tenantId, t.supersedesEffectId)
      .where(sql`${t.supersedesEffectId} IS NOT NULL`),
    statusCheck: check(
      "effect_status_check",
      sql`${t.status} IN ('proposed','authorized','executing','committed','failed','indeterminate','cancelled')`,
    ),
    versionCheck: check(
      "effect_versions_check",
      sql`${t.effectSchemaVersion} > 0 AND ${t.connectorOperationVersion} > 0`,
    ),
    requestJsonCheck: check("effect_request_json_check", sql`json_valid(${t.canonicalRequest})`),
    revisionCheck: check("effect_revision_check", sql`${t.revision} > 0`),
    noSelfRelationCheck: check(
      "effect_no_self_relation_check",
      sql`(${t.supersedesEffectId} IS NULL OR ${t.supersedesEffectId} <> ${t.id}) AND (${t.compensationOfEffectId} IS NULL OR ${t.compensationOfEffectId} <> ${t.id})`,
    ),
    oneRelationCheck: check(
      "effect_one_relation_check",
      sql`${t.supersedesEffectId} IS NULL OR ${t.compensationOfEffectId} IS NULL`,
    ),
    fenceShapeCheck: check(
      "effect_fence_shape_check",
      sql`(${t.claimId} IS NULL AND ${t.fence} IS NULL) OR (${t.claimId} IS NOT NULL AND ${t.fence} IS NOT NULL AND ${t.fence} > 0)`,
    ),
    chronologyCheck: check(
      "effect_chronology_check",
      sql`${t.updatedAt} >= ${t.createdAt} AND (${t.authorizedAt} IS NULL OR ${t.authorizedAt} >= ${t.createdAt}) AND (${t.executionStartedAt} IS NULL OR ${t.executionStartedAt} >= ${t.authorizedAt}) AND (${t.indeterminateAt} IS NULL OR ${t.indeterminateAt} >= ${t.executionStartedAt}) AND (${t.resolvedAt} IS NULL OR ${t.resolvedAt} >= ${t.executionStartedAt}) AND (${t.cancelledAt} IS NULL OR ${t.cancelledAt} >= ${t.createdAt})`,
    ),
    lifecycleCheck: check(
      "effect_lifecycle_check",
      sql`(${t.status} = 'proposed' AND ${t.authorizedByApprovalId} IS NULL AND ${t.authorizedAt} IS NULL AND ${t.claimId} IS NULL AND ${t.executionStartedAt} IS NULL AND ${t.indeterminateAt} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL) OR (${t.status} = 'authorized' AND ${t.authorizedByApprovalId} IS NOT NULL AND ${t.authorizedAt} IS NOT NULL AND ${t.claimId} IS NULL AND ${t.executionStartedAt} IS NULL AND ${t.indeterminateAt} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL) OR (${t.status} = 'executing' AND ${t.authorizedByApprovalId} IS NOT NULL AND ${t.authorizedAt} IS NOT NULL AND ${t.claimId} IS NOT NULL AND ${t.executionStartedAt} IS NOT NULL AND ${t.indeterminateAt} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL) OR (${t.status} = 'indeterminate' AND ${t.authorizedByApprovalId} IS NOT NULL AND ${t.authorizedAt} IS NOT NULL AND ${t.claimId} IS NOT NULL AND ${t.executionStartedAt} IS NOT NULL AND ${t.indeterminateAt} IS NOT NULL AND ${t.resolvedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL) OR (${t.status} IN ('committed','failed') AND ${t.authorizedByApprovalId} IS NOT NULL AND ${t.authorizedAt} IS NOT NULL AND ${t.claimId} IS NOT NULL AND ${t.executionStartedAt} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND ${t.cancelledAt} IS NULL AND ${t.cancelReason} IS NULL) OR (${t.status} = 'cancelled' AND ${t.authorizedByApprovalId} IS NULL AND ${t.authorizedAt} IS NULL AND ${t.claimId} IS NULL AND ${t.executionStartedAt} IS NULL AND ${t.indeterminateAt} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.cancelledAt} IS NOT NULL AND ${t.cancelReason} IS NOT NULL AND length(trim(${t.cancelReason})) > 0)`,
    ),
  }),
);

export const effectApproval = sqliteTable(
  "effect_approval",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    effectId: text("effect_id").notNull().references(() => effect.id),
    requestDigest: text("request_digest").notNull(),
    approverPrincipalId: text("approver_principal_id").notNull().references(() => principal.id),
    decision: text("decision").notNull(),
    scope: text("scope").notNull().default("{}"),
    limits: text("limits").notNull().default("{}"),
    validFrom: integer("valid_from"),
    expiresAt: integer("expires_at"),
    verificationLevel: text("verification_level").notNull(),
    verificationMethod: text("verification_method").notNull(),
    verification: text("verification").notNull().default("{}"),
    supersedesApprovalId: text("supersedes_approval_id").references(
      (): AnySQLiteColumn => effectApproval.id,
    ),
    decidedAt: integer("decided_at").notNull(),
  },
  (t) => ({
    effectIdx: index("idx_effect_approval_effect").on(t.tenantId, t.effectId, t.decidedAt),
    approverIdx: index("idx_effect_approval_approver").on(t.tenantId, t.approverPrincipalId, t.decidedAt),
    rootUniq: uniqueIndex("uniq_effect_approval_root")
      .on(t.tenantId, t.effectId)
      .where(sql`${t.supersedesApprovalId} IS NULL`),
    supersedesUniq: uniqueIndex("uniq_effect_approval_supersedes")
      .on(t.tenantId, t.supersedesApprovalId)
      .where(sql`${t.supersedesApprovalId} IS NOT NULL`),
    decisionCheck: check(
      "effect_approval_decision_check",
      sql`${t.decision} IN ('approved','denied','revoked')`,
    ),
    verificationCheck: check(
      "effect_approval_verification_check",
      sql`${t.verificationLevel} IN ('self_asserted','authenticated_context','cryptographic')`,
    ),
    jsonCheck: check(
      "effect_approval_json_check",
      sql`json_valid(${t.scope}) AND json_type(${t.scope}) = 'object' AND json_valid(${t.limits}) AND json_type(${t.limits}) = 'object' AND json_valid(${t.verification}) AND json_type(${t.verification}) = 'object'`,
    ),
    validityCheck: check(
      "effect_approval_validity_check",
      sql`(${t.validFrom} IS NULL OR ${t.validFrom} >= 0) AND (${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.decidedAt}) AND (${t.validFrom} IS NULL OR ${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.validFrom})`,
    ),
    revocationCheck: check(
      "effect_approval_revocation_check",
      sql`${t.decision} <> 'revoked' OR ${t.supersedesApprovalId} IS NOT NULL`,
    ),
  }),
);

export const effectReceipt = sqliteTable(
  "effect_receipt",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("gwendall"),
    effectId: text("effect_id").notNull().references(() => effect.id),
    taskId: text("task_id").notNull().references(() => task.id),
    attemptId: text("attempt_id").notNull().references(() => taskAttempt.id),
    approvalId: text("approval_id").notNull().references(() => effectApproval.id),
    evidenceId: text("evidence_id").notNull().references(() => taskEvidence.id),
    canonicalReport: text("canonical_report").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    connectorInstanceRef: text("connector_instance_ref").notNull(),
    externalReceiptId: text("external_receipt_id").notNull(),
    providerOperationId: text("provider_operation_id"),
    outcome: text("outcome").notNull(),
    resolvesReceiptId: text("resolves_receipt_id").references(
      (): AnySQLiteColumn => effectReceipt.id,
    ),
    verificationLevel: text("verification_level").notNull(),
    verificationMethod: text("verification_method").notNull(),
    coverage: text("coverage").notNull().default("[]"),
    verification: text("verification").notNull().default("{}"),
    recordedByPrincipalId: text("recorded_by_principal_id").notNull().references(() => principal.id),
    occurredAt: integer("occurred_at").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (t) => ({
    deliveryUniq: uniqueIndex("uniq_effect_receipt_delivery").on(
      t.tenantId, t.connectorInstanceRef, t.externalReceiptId,
    ),
    effectIdx: index("idx_effect_receipt_effect").on(t.tenantId, t.effectId, t.recordedAt),
    providerIdx: index("idx_effect_receipt_provider_operation").on(
      t.tenantId, t.connectorInstanceRef, t.providerOperationId,
    ),
    evidenceUniq: uniqueIndex("uniq_effect_receipt_evidence").on(t.tenantId, t.evidenceId),
    digestCheck: check("effect_receipt_digest_check", sql`${t.receiptDigest} GLOB 'sha256:[0-9a-f]*' AND length(${t.receiptDigest}) = 71`),
    outcomeCheck: check("effect_receipt_outcome_check", sql`${t.outcome} IN ('committed','failed','indeterminate')`),
    verificationCheck: check(
      "effect_receipt_verification_check",
      sql`${t.verificationLevel} IN ('self_asserted','authenticated_context','cryptographic') AND length(trim(${t.verificationMethod})) > 0`,
    ),
    jsonCheck: check(
      "effect_receipt_json_check",
      sql`json_valid(${t.canonicalReport}) AND json_type(${t.canonicalReport}) = 'object' AND json_valid(${t.coverage}) AND json_type(${t.coverage}) = 'array' AND json_valid(${t.verification}) AND json_type(${t.verification}) = 'object'`,
    ),
    timestampCheck: check(
      "effect_receipt_timestamp_check",
      sql`${t.occurredAt} >= 0 AND ${t.recordedAt} >= 0`,
    ),
    resolutionCheck: check(
      "effect_receipt_resolution_check",
      sql`(${t.outcome} = 'indeterminate' AND ${t.resolvesReceiptId} IS NULL AND ${t.providerOperationId} IS NULL) OR (${t.outcome} IN ('committed','failed') AND ${t.providerOperationId} IS NOT NULL)`,
    ),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// ADR-003 replication — explicit operations, authority log and conflicts
// ──────────────────────────────────────────────────────────────────────

export const replicationAuthority = sqliteTable(
  "replication_authority",
  {
    workspaceId: text("workspace_id").primaryKey(),
    authorityReplicaId: text("authority_replica_id").notNull(),
    authorityEpoch: text("authority_epoch").notNull(),
    currentSequence: integer("current_sequence").notNull().default(0),
    minimumRetainedSequence: integer("minimum_retained_sequence").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    sequenceCheck: check(
      "replication_authority_sequence_check",
      sql`${t.currentSequence} >= 0 AND ${t.minimumRetainedSequence} >= 0 AND ${t.minimumRetainedSequence} <= ${t.currentSequence}`,
    ),
  }),
);

/** Durable proof that a restored authority rotated epoch before accepting work. */
export const replicationAuthorityRecovery = sqliteTable(
  "replication_authority_recovery",
  {
    workspaceId: text("workspace_id").notNull(),
    authorityEpoch: text("authority_epoch").notNull(),
    authorityReplicaId: text("authority_replica_id").notNull(),
    priorAuthorityEpoch: text("prior_authority_epoch").notNull(),
    restoredSequence: integer("restored_sequence").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    reason: text("reason").notNull(),
    recoveredAt: integer("recovered_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.authorityEpoch] }),
    timeIdx: index("idx_replication_authority_recovery_time").on(t.workspaceId, t.recoveredAt),
    sequenceCheck: check(
      "replication_authority_recovery_sequence_check",
      sql`${t.restoredSequence} >= 0`,
    ),
    reasonCheck: check(
      "replication_authority_recovery_reason_check",
      sql`length(trim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  }),
);

/** One store-local generation and its durable outgoing counter/observed base. */
export const replicationLocalReplica = sqliteTable(
  "replication_local_replica",
  {
    workspaceId: text("workspace_id").primaryKey(),
    replicaId: text("replica_id").notNull(),
    generationId: text("generation_id").notNull(),
    nextCounter: integer("next_counter").notNull().default(1),
    previousDigest: text("previous_digest"),
    authorityReplicaId: text("authority_replica_id").notNull(),
    authorityEpoch: text("authority_epoch").notNull(),
    observedSequence: integer("observed_sequence").notNull().default(0),
    pullCursor: text("pull_cursor"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    counterCheck: check("replication_local_counter_check", sql`${t.nextCounter} > 0`),
    sequenceCheck: check("replication_local_sequence_check", sql`${t.observedSequence} >= 0`),
  }),
);

/** Authority-side authenticated generation registry and accepted frontier. */
export const replicationReplica = sqliteTable(
  "replication_replica",
  {
    workspaceId: text("workspace_id").notNull(),
    replicaId: text("replica_id").notNull(),
    generationId: text("generation_id").notNull(),
    status: text("status").notNull().default("active"),
    acceptedCounter: integer("accepted_counter").notNull().default(0),
    acceptedDigest: text("accepted_digest"),
    acknowledgedSequence: integer("acknowledged_sequence").notNull().default(0),
    registeredAt: integer("registered_at").notNull(),
    lastContactAt: integer("last_contact_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.replicaId, t.generationId] }),
    statusIdx: index("idx_replication_replica_status").on(t.workspaceId, t.status, t.lastContactAt),
    statusCheck: check("replication_replica_status_check", sql`${t.status} IN ('active','stale','revoked')`),
    frontierCheck: check(
      "replication_replica_frontier_check",
      sql`${t.acceptedCounter} >= 0 AND ${t.acknowledgedSequence} >= 0
        AND ((${t.acceptedCounter} = 0 AND ${t.acceptedDigest} IS NULL)
          OR (${t.acceptedCounter} > 0 AND ${t.acceptedDigest} IS NOT NULL))`,
    ),
  }),
);

export const replicationOutgoing = sqliteTable(
  "replication_outgoing_operation",
  {
    workspaceId: text("workspace_id").notNull(),
    replicaId: text("replica_id").notNull(),
    generationId: text("generation_id").notNull(),
    counter: integer("counter").notNull(),
    operationDigest: text("operation_digest").notNull(),
    previousDigest: text("previous_digest"),
    operationJson: text("operation_json").notNull(),
    status: text("status").notNull().default("pending"),
    authoritySequence: integer("authority_sequence"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.replicaId, t.generationId, t.counter] }),
    digestUniq: uniqueIndex("uniq_replication_outgoing_digest").on(t.workspaceId, t.operationDigest),
    pendingIdx: index("idx_replication_outgoing_pending").on(
      t.workspaceId, t.replicaId, t.generationId, t.status, t.counter,
    ),
    statusIdx: index("idx_console_replication_outgoing_status").on(t.workspaceId, t.status),
    counterCheck: check("replication_outgoing_counter_check", sql`${t.counter} > 0`),
    statusCheck: check(
      "replication_outgoing_status_check",
      sql`${t.status} IN ('pending','applied','equivalent','conflicted','rejected')`,
    ),
    jsonCheck: check("replication_outgoing_json_check", sql`json_valid(${t.operationJson})`),
  }),
);

export const replicationAccepted = sqliteTable(
  "replication_accepted_operation",
  {
    workspaceId: text("workspace_id").notNull(),
    authoritySequence: integer("authority_sequence").notNull(),
    replicaId: text("replica_id").notNull(),
    generationId: text("generation_id").notNull(),
    counter: integer("counter").notNull(),
    operationDigest: text("operation_digest").notNull(),
    operationJson: text("operation_json").notNull(),
    disposition: text("disposition").notNull(),
    resultJson: text("result_json").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.authoritySequence] }),
    dotUniq: uniqueIndex("uniq_replication_accepted_dot").on(
      t.workspaceId, t.replicaId, t.generationId, t.counter,
    ),
    digestUniq: uniqueIndex("uniq_replication_accepted_digest").on(t.workspaceId, t.operationDigest),
    originIdx: index("idx_replication_accepted_origin").on(
      t.workspaceId, t.replicaId, t.generationId, t.counter,
    ),
    sequenceCheck: check("replication_accepted_sequence_check", sql`${t.authoritySequence} > 0`),
    dispositionCheck: check(
      "replication_accepted_disposition_check",
      sql`${t.disposition} IN ('applied','equivalent','conflicted')`,
    ),
    jsonCheck: check(
      "replication_accepted_json_check",
      sql`json_valid(${t.operationJson}) AND json_valid(${t.resultJson})`,
    ),
  }),
);

export const replicationConflict = sqliteTable(
  "replication_conflict",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    authoritySequence: integer("authority_sequence").notNull(),
    replicaId: text("replica_id").notNull(),
    generationId: text("generation_id").notNull(),
    counter: integer("counter").notNull(),
    operationDigest: text("operation_digest").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    reason: text("reason").notNull(),
    baseSnapshotJson: text("base_snapshot_json"),
    authoritySnapshotJson: text("authority_snapshot_json"),
    incomingSnapshotJson: text("incoming_snapshot_json"),
    principalId: text("principal_id").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    resolvedByOperationDigest: text("resolved_by_operation_digest"),
  },
  (t) => ({
    sequenceUniq: uniqueIndex("uniq_replication_conflict_sequence").on(t.workspaceId, t.authoritySequence),
    unresolvedIdx: index("idx_replication_conflict_unresolved").on(
      t.workspaceId, t.resolvedByOperationDigest, t.authoritySequence,
    ),
    reasonCheck: check(
      "replication_conflict_reason_check",
      sql`${t.reason} IN ('concurrent_mutation','retired_identity')`,
    ),
    recordTypeCheck: check("replication_conflict_record_type_check", sql`${t.recordType} = 'commitment'`),
    jsonCheck: check(
      "replication_conflict_json_check",
      sql`(${t.baseSnapshotJson} IS NULL OR json_valid(${t.baseSnapshotJson})) AND (${t.authoritySnapshotJson} IS NULL OR json_valid(${t.authoritySnapshotJson})) AND (${t.incomingSnapshotJson} IS NULL OR json_valid(${t.incomingSnapshotJson}))`,
    ),
  }),
);

export const replicationRetiredIdentity = sqliteTable(
  "replication_retired_identity",
  {
    workspaceId: text("workspace_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    tombstoneDigest: text("tombstone_digest").notNull(),
    retiredAt: integer("retired_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.recordType, t.recordId] }),
    retiredIdx: index("idx_replication_retired_at").on(t.workspaceId, t.retiredAt),
    typeCheck: check("replication_retired_type_check", sql`${t.recordType} = 'commitment'`),
  }),
);

/** Records installed from canonical snapshots; local-only rows are untouched. */
export const replicationMaterializedRecord = sqliteTable(
  "replication_materialized_record",
  {
    workspaceId: text("workspace_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    stateDigest: text("state_digest").notNull(),
    coveredSequence: integer("covered_sequence").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.recordType, t.recordId] }),
    typeCheck: check("replication_materialized_type_check", sql`${t.recordType} = 'commitment'`),
    sequenceCheck: check("replication_materialized_sequence_check", sql`${t.coveredSequence} >= 0`),
  }),
);

// ──────────────────────────────────────────────────────────────────────
// Schema bag (for drizzle migrations + service usage)
// ──────────────────────────────────────────────────────────────────────

export const schema = {
  principal,
  coordinationSpace,
  resourceLease,
  resourceEvent,
  area,
  goal,
  project,
  task,
  commitmentSummary,
  event,
  deliverySink,
  deliveryOutbox,
  taskDependency,
  commitmentRelation,
  assignment,
  idempotencyKey,
  externalRef,
  externalContextLink,
  taskClaim,
  taskAttempt,
  taskEvidence,
  artifact,
  resolutionContract,
  evidenceTrustRecord,
  completionProposal,
  completionChallenge,
  validationDecision,
  completionRecord,
  extensionRelease,
  extensionType,
  extensionEvaluator,
  waitCondition,
  observation,
  observationRoute,
  reconciliation,
  effect,
  effectApproval,
  effectReceipt,
  replicationAuthority,
  replicationAuthorityRecovery,
  replicationLocalReplica,
  replicationReplica,
  replicationOutgoing,
  replicationAccepted,
  replicationConflict,
  replicationRetiredIdentity,
  replicationMaterializedRecord,
};
