/**
 * Minimal universal-kernel entrypoint.
 *
 * It deliberately exports no area/goal/project, cadence, recurrence,
 * prioritizer, `_life` projection or bundled reference-domain surface.
 */

import type { Client } from "@libsql/client";
import { runMigrations, type MigrationOptions } from "./migrations/index.js";
import type { TasqDb as KernelDb } from "./db.js";
import {
  releaseTaskClaim as releaseTaskClaimCompat,
  transitionTaskAttempt as transitionTaskAttemptCompat,
  type ReleaseClaimOptions,
  type TransitionAttemptOptions,
} from "./service/agentic.js";
import type { AttemptStatus } from "@tasq-run/schema";
import {
  getTasqDiscovery as getTasqDiscoveryWithProfile,
  type GetTasqDiscoveryOptions,
} from "./discovery.js";

export {
  openDb,
  defaultDbUrl,
  committedMutationCount,
  verifyDatabaseFile,
} from "./db.js";
export type {
  TasqDb,
  TasqDbOrTx,
  OpenedDb,
  OpenDbOptions,
  DatabaseVerification,
} from "./db.js";

export { buildInspectorIndex } from "./inspector-index.js";
export type { BuildInspectorIndexOptions } from "./inspector-index.js";

export {
  buildConsoleOverview,
  buildConsolePage,
  buildConsoleHealth,
  buildConsoleSupportBundle,
} from "./console-read-models.js";
export type { ConsoleReadOptions, ConsolePageOptions, ConsoleSupportBundleOptions } from "./console-read-models.js";

export {
  buildConsoleEventBatch,
  ConsoleLiveCursorError,
} from "./console-live.js";
export type { ConsoleEventBatchOptions } from "./console-live.js";

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
  createResolutionContract,
  getResolutionContract,
  listResolutionContracts,
  attestEvidenceTrust,
  revokeEvidenceTrust,
  getEvidenceTrustRecord,
  listEvidenceTrustRecords,
  proposeCompletion,
  getCompletionProposal,
  listCompletionProposals,
  challengeCompletion,
  getCompletionChallenge,
  listCompletionChallenges,
  evaluateCompletionDeterministically,
  attestCompletion,
  settleOptimisticCompletion,
  adjudicateCompletion,
  getValidationDecision,
  listValidationDecisions,
  getCompletionResolutionChain,
} from "./service/resolution.js";
export type {
  ResolutionContext,
  EvidenceTrustAuthority,
  AttestEvidenceTrustOptions,
  RevokeEvidenceTrustOptions,
  DeterministicValidationOptions,
} from "./service/resolution.js";

// Trusted administrative surface for provider-neutral extension manifests.
// Bundled domain extensions remain outside the minimal kernel entrypoint.
export {
  canonicalJson,
  sha256Digest,
  prepareExtensionManifest,
  installExtension,
  listExtensionReleases,
  getExtensionTypeRegistration,
  getExtensionEvaluatorRegistration,
} from "./service/extensions.js";
export type {
  InstallExtensionOptions,
  InstalledExtension,
} from "./service/extensions.js";

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

export { listEvents, getEvent } from "./service/events.js";
export type { ListEventsOptions } from "./service/events.js";

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

// ADR-003 is profile-neutral; compatibility-profile records are deliberately
// outside its current projection and therefore never advertised as synced.
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

export {
  acquireTaskClaim,
  getTaskClaim,
  getActiveTaskClaim,
  listTaskClaims,
  startTaskAttempt,
  getTaskAttempt,
  listTaskAttempts,
  addTaskEvidence,
  getTaskEvidence,
  listTaskEvidence,
} from "./service/agentic.js";

/** Strict kernel transition: mutable claim lifecycles require a CAS revision. */
export function releaseTaskClaim(
  db: KernelDb,
  taskId: string,
  options: Omit<ReleaseClaimOptions, "expectedRevision"> & { expectedRevision: number },
) {
  return releaseTaskClaimCompat(db, taskId, options);
}

/** Strict kernel transition: mutable attempt lifecycles require a CAS revision. */
export function transitionTaskAttempt(
  db: KernelDb,
  id: string,
  to: AttemptStatus,
  options: Omit<TransitionAttemptOptions, "expectedRevision"> & { expectedRevision: number },
) {
  return transitionTaskAttemptCompat(db, id, to, options);
}
export type {
  Commitment,
  KernelContext,
  CreateCommitmentInput,
  UpdateCommitmentInput,
  ListCommitmentsOptions,
  CommitmentTransitionOptions,
} from "./commitments.js";

export { createLocalTasq } from "./local-client.js";
export type {
  AddLocalEvidenceInput,
  CreateLocalTasqOptions,
  EventCursorPage,
  LocalCommitmentTransitionOptions,
  LocalEvidenceOptions,
  LocalMutationOptions,
  LocalTasqClient,
} from "./local-client.js";

export {
  PORTABLE_EXPORT_CONTRACT_VERSION,
  PORTABLE_EXPORT_OMISSIONS,
  exportPortableStore,
  importPortableStore,
  validatePortableExport,
} from "./portable.js";
export type {
  PortableExportDocument,
  PortableExportOptions,
  PortableExportResult,
  PortableImportResult,
  PortableTable,
} from "./portable.js";

export * from "./service/resources.js";

export {
  INSPECTION_CONTRACT_VERSION,
  inspectCommitment,
  renderCommitmentInspection,
} from "./inspection.js";
export type { InspectCommitmentOptions, CommitmentInspection } from "./inspection.js";

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
  getDiscoverySchema,
  negotiateOnboarding,
} from "./discovery.js";
export type { GetDiscoverySchemaOptions } from "./discovery.js";

/** Strict entrypoint cannot advertise compatibility-only condition/fact operations. */
export function getTasqDiscovery(
  db: KernelDb,
  options: Omit<GetTasqDiscoveryOptions, "capabilityProfile">,
) {
  return getTasqDiscoveryWithProfile(db, { ...options, capabilityProfile: "kernel" });
}

export {
  createMutableClock,
  systemClock,
  uuidv7,
  timestampFromUuidv7,
} from "@tasq-run/schema";
export type { Clock, MutableClock } from "@tasq-run/schema";

export type KernelMigrationOptions = MigrationOptions;

/** Run the compatible schema without installing any bundled domain extension. */
export function runKernelMigrations(
  client: Client,
  options: KernelMigrationOptions = {},
) {
  return runMigrations(client, options);
}
