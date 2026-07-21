/**
 * @tasq-internal/local-service — public surface.
 *
 * Layered access:
 *   - `openDb` / `defaultDbUrl` — connection management
 *   - `runMigrations`           — schema bootstrap (idempotent)
 *   - service functions          — planning, coordination, execution and facts;
 *                                  task-scoped mutations emit audit events
 *   - `listEvents` / `getEvent` — read-only audit log access
 *   - `pickNext`                — the `tasq next` prioritizer
 *   - `renderProjection`        — DB → markdown
 *
 * Future surfaces (CLI, MCP, REST) consume from here. No SQL is written
 * outside this package.
 */

// Connection
export { openDb, defaultDbUrl, committedMutationCount, verifyDatabaseFile } from "./db.js";
export type { TasqDb, TasqDbOrTx, OpenedDb, OpenDbOptions, DatabaseVerification } from "./db.js";

// Canonical profile-neutral commitment surface. The historical task/planning
// API remains below for compatibility; minimal hosts import `./kernel`.
export {
  createCommitment,
  getCommitment,
  listCommitments,
  updateCommitment,
  startCommitment,
  completeCommitment,
  blockCommitment,
  unblockCommitment,
  cancelCommitment,
  reopenCommitment,
  CommitmentStatus,
} from "./commitments.js";
export type {
  Commitment,
  KernelContext,
  ListCommitmentsOptions,
  CommitmentTransitionOptions,
} from "./commitments.js";

export {
  INSPECTION_CONTRACT_VERSION,
  inspectCommitment,
  renderCommitmentInspection,
} from "./inspection.js";
export type { InspectCommitmentOptions, CommitmentInspection } from "./inspection.js";

export { buildInspectorIndex } from "./inspector-index.js";
export type { BuildInspectorIndexOptions } from "./inspector-index.js";

export {
  buildConsoleOverview,
  buildConsolePage,
  buildConsoleHealth,
} from "./console-read-models.js";
export type { ConsoleReadOptions, ConsolePageOptions } from "./console-read-models.js";

export {
  buildConsoleEventBatch,
  ConsoleLiveCursorError,
} from "./console-live.js";
export type { ConsoleEventBatchOptions } from "./console-live.js";

export { buildContextPacket } from "./context-packet.js";
export type { BuildContextPacketOptions } from "./context-packet.js";

export {
  COMMITMENT_SUMMARY_EVENT_TYPE,
  deriveCommitmentSummarySource,
  appendCommitmentSummary,
  getCommitmentSummary,
  listCommitmentSummaries,
  listCurrentCommitmentSummaries,
} from "./service/summaries.js";
export type {
  CommitmentSummaryContext,
  ListCommitmentSummariesOptions,
  ListCurrentCommitmentSummariesOptions,
} from "./service/summaries.js";

export {
  EXTERNAL_CONTEXT_LINK_EVENT_TYPE,
  attachExternalContextLink,
  detachExternalContextLink,
  getExternalContextLink,
  listExternalContextLinks,
} from "./service/context-links.js";
export type {
  ExternalContextLinkContext,
  ListExternalContextLinksOptions,
} from "./service/context-links.js";

export {
  TASQ_PROTOCOL_URI,
  EVENT_CURSOR_URI,
  OBSERVATION_CURSOR_URI,
  RESOURCE_EVENT_CURSOR_URI,
  REPLICATION_CURSOR_URI,
  REPLICATION_CAPABILITY_URI,
  DISCOVERY_LIMITS,
  DISCOVERY_CACHE_MS,
  DISCOVERY_CAPABILITY_IMPLEMENTATIONS,
  getTasqDiscovery,
  getDiscoverySchema,
  negotiateOnboarding,
} from "./discovery.js";
export type { GetTasqDiscoveryOptions, GetDiscoverySchemaOptions } from "./discovery.js";

export {
  createPrincipal,
  getPrincipal,
  listPrincipals,
  setPrincipalStatus,
  localPrincipalId,
} from "./service/principals.js";

export {
  bootstrapCoordinationSpace,
  getCoordinationSpace,
} from "./service/spaces.js";
export type {
  BootstrapCoordinationSpaceInput,
  BootstrapCoordinationSpaceResult,
} from "./service/spaces.js";

export * from "./service/resources.js";

export {
  proposeAssignment,
  getAssignment,
  listAssignments,
  acceptAssignment,
  rejectAssignment,
  revokeAssignment,
  releaseAssignment,
  addCommitmentRelation,
  getCommitmentRelation,
  listCommitmentRelations,
  endCommitmentRelation,
  appendArtifact,
  getArtifact,
  listArtifacts,
  appendExternalRef,
  getExternalRef,
  listExternalRefs,
  getCompletionRecord,
  listCompletionRecords,
} from "./service/collaboration.js";
export type { PrincipalContext } from "./service/collaboration.js";

export {
  proposeEffect,
  getEffect,
  listEffects,
  recordEffectApproval,
  getEffectApproval,
  listEffectApprovals,
  getEffectiveEffectApproval,
  authorizeEffect,
  beginEffectExecution,
  recordEffectReceipt,
  getEffectReceipt,
  listEffectReceipts,
  cancelEffect,
} from "./service/effects.js";
export type {
  EffectAuthorityContext,
  BeginEffectExecutionOptions,
  BegunEffectExecution,
  RecordEffectReceiptOptions,
} from "./service/effects.js";

// Migrations
export { runMigrations } from "./migrations/compat.js";
export type { MigrationResult, MigrationOptions } from "./migrations/compat.js";

// Service: events
export { recordEvent, listEvents, getEvent, setEventListener } from "./service/events.js";
export { diagnoseStore, type DoctorIssue, type DoctorReport } from "./doctor.js";
export type { ListEventsOptions, RecordEventOptions } from "./service/events.js";

export {
  IDEMPOTENCY_REQUEST_DIGEST_VERSION,
  LEGACY_IDEMPOTENCY_DIGEST_VERSION,
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  MAX_IDEMPOTENCY_RETENTION_MS,
  idempotencyCallerScope,
  listIdempotencyRecords,
  pruneExpiredIdempotency,
} from "./service/idempotency.js";
export type {
  IdempotencyContext,
  IdempotencyOutcome,
  ListIdempotencyOptions,
  PruneIdempotencyOptions,
} from "./service/idempotency.js";

// ADR-003 explicit operation/snapshot replication.
export * from "./service/replication.js";

export {
  ensureDeliverySink,
  disableDeliverySink,
  getDeliverySink,
  listDeliveryOutbox,
  leaseNextDelivery,
  completeDelivery,
  failDelivery,
  repairDelivery,
} from "./service/delivery.js";
export type {
  DeliveryClockOptions,
  EnsureDeliverySinkInput,
  ListDeliveryOutboxOptions,
  LeaseNextDeliveryOptions,
  LeasedDelivery,
  OwnedDeliveryOptions,
  FailDeliveryOptions,
  DeliveryRepairAction,
} from "./service/delivery.js";

// Universal extension registry (administrative trusted-code surface).
export {
  canonicalJson,
  sha256Digest,
  prepareExtensionManifest,
  installExtension,
  ensureBundledReferenceExtension,
  ensureBundledReferenceExtensionAvailable,
  listExtensionReleases,
  getExtensionTypeRegistration,
  getExtensionEvaluatorRegistration,
} from "./service/extensions.js";
export type {
  InstallExtensionOptions,
  InstalledExtension,
} from "./service/extensions.js";

// Service: areas
export {
  createArea,
  getArea,
  getAreaBySlug,
  listAreas,
  updateArea,
  softDeleteArea,
  restoreArea,
} from "./service/areas.js";
export type { ServiceContext, ListAreasOptions } from "./service/areas.js";

// Service: goals
export {
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  softDeleteGoal,
  restoreGoal,
  GoalStatus,
} from "./service/goals.js";
export type { ListGoalsOptions } from "./service/goals.js";

// Service: projects
export {
  createProject,
  getProject,
  listProjects,
  updateProject,
  softDeleteProject,
  restoreProject,
  ProjectStatus,
} from "./service/projects.js";
export type { ListProjectsOptions } from "./service/projects.js";

// Service: tasks
export {
  getTask,
  getTaskDepth,
  getTaskTree,
  subtreeHeight,
  softDeleteTask,
  listTasks,
} from "./service/tasks.js";
export type {
  StatusChangeOptions,
  ListTasksOptions,
  SoftDeleteOptions,
  TaskServiceContext,
} from "./service/tasks.js";
export {
  createTask,
  updateTask,
  startTask,
  blockTask,
  unblockTask,
  cancelTask,
  reopenTask,
  restoreTask,
} from "./service/life-tasks.js";
export { completeTask } from "./service/recurring-tasks.js";

// Agentic execution primitives: durable commitment ≠ execution attempt.
export {
  acquireTaskClaim,
  releaseTaskClaim,
  getTaskClaim,
  getActiveTaskClaim,
  listTaskClaims,
  activeTaskClaimMap,
  startTaskAttempt,
  getTaskAttempt,
  listTaskAttempts,
  transitionTaskAttempt,
  addTaskEvidence,
  getTaskEvidence,
  listTaskEvidence,
  ATTEMPT_STATUSES,
  AGENTIC_CONFIG,
} from "./service/agentic.js";
export type {
  AcquireClaimOptions,
  ReleaseClaimOptions,
  ListClaimsOptions,
  StartAttemptOptions,
  ListAttemptsOptions,
  TransitionAttemptOptions,
  AddEvidenceOptions,
  ListEvidenceOptions,
} from "./service/agentic.js";

// Typed external waits: durable expectation state, not runtime scheduling.
export {
  createWaitCondition,
  getWaitCondition,
  listWaitConditions,
  cancelWaitCondition,
} from "./service/waits.js";
export type {
  CreateWaitConditionOptions,
  ListWaitConditionsOptions,
  CancelWaitConditionOptions,
} from "./service/waits.js";

// Immutable normalized facts from external watcher/connector deliveries.
export {
  ingestObservation,
  getObservation,
  getObservationByDelivery,
  listObservations,
} from "./service/observations.js";
export type {
  IngestObservationOptions,
  ListObservationsOptions,
} from "./service/observations.js";

// Pure typed matcher decisions and their immutable task-scoped reconciliation.
export {
  reconcileWaitObservation,
  getReconciliation,
  getReconciliationByEvaluation,
  listReconciliations,
  listCandidateObservations,
} from "./service/reconciliation.js";
export type {
  ReconcileOptions,
  ListReconciliationsOptions,
} from "./service/reconciliation.js";
export {
  MATCHER_REGISTRY,
  evaluateWaitObservation,
  conditionRouteKey,
  observationRouteKeys,
} from "./service/matchers.js";
export type { MatchDecision } from "./service/matchers.js";

// Deadline evaluation is invoked by runtimes/cron; it never performs an
// external side effect and only materializes ledger tasks.
export {
  evaluateWaitConditionDeadline,
  sweepWaitConditionDeadlines,
} from "./service/life-deadlines.js";
export type {
  DeadlineEvaluationOutcome,
  DeadlineEvaluationResult,
  EvaluateDeadlineOptions,
  SweepDeadlineOptions,
  DeadlineSweepResult,
} from "./service/deadlines.js";

// Service: recurrence (SPEC §6.4-H — cadence-enum + anchor; materialize next instance)
export { nextOccurrence, materializeNextInstance } from "./service/recurrence.js";
export type { MaterializedInstance } from "./service/recurrence.js";

// Service: dependencies (SPEC §4.5 — first-class peer task_dependency)
export {
  dependTask,
  undependTask,
  listDependencies,
  unresolvedBlockerCount,
  unresolvedBlockerMap,
  justUnblocked,
} from "./service/dependencies.js";
export type {
  ListDependenciesOptions,
  UndependOptions,
  JustUnblockedOptions,
} from "./service/dependencies.js";

// Service: progress + ETA
export {
  getProjectProgress,
  getTaskProgress,
  PROGRESS_CONFIG,
} from "./service/progress.js";
export type { Progress, Eta, StatusCounts, ProgressOptions } from "./service/progress.js";

// Prioritizer
export { pickNext, scoreTask, PRIORITIZER_CONFIG } from "./prioritizer.js";
export type { ScoreInputs, ScoreBreakdown, PickNextOptions, NextResult } from "./prioritizer.js";

// Projection
export { renderProjection } from "./projection/markdown.js";
export type { RenderOptions } from "./projection/markdown.js";

// Schema re-exports for convenience (callers usually need types + ids)
export * from "@tasq/schema";

// Bundled v1 aliases live outside the kernel schema but remain available to
// existing service consumers during the compatibility window.
export * from "@tasq-internal/reference-extension";
