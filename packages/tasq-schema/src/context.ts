/** Language-neutral DTOs for bounded, reason-traced agent context. */

import { z } from "zod";
import { TaskStatus, UuidV7 } from "./types.js";

export const CONTEXT_PACKET_CONTRACT_VERSION = "tasq.context-packet.v1" as const;
export const CONTEXT_PACKET_TOKEN_ESTIMATOR_URI =
  "https://schemas.tasq.dev/token-estimators/utf8-byte-upper-bound/v1" as const;

const UnixMs = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

/**
 * A portable model tokenizer does not exist. Tasq therefore treats every UTF-8
 * byte as one possible token. This is intentionally conservative, deterministic
 * in every language and a hard upper bound for byte-fallback tokenizers.
 */
export const ContextPacketRequest = z.object({
  maxRecords: z.number().int().min(1).max(500).default(20),
  maxTokens: z.number().int().min(1_024).max(1_000_000).default(8_192),
  includeDeferred: z.boolean().default(false),
  actor: z.string().trim().min(1).max(500).nullable().default(null),
}).strict();
export type ContextPacketRequest = z.infer<typeof ContextPacketRequest>;

export const ContextPacketReason = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(120),
  detail: z.string().min(1).max(500),
}).strict();
export type ContextPacketReason = z.infer<typeof ContextPacketReason>;

export const ContextPacketItem = z.object({
  recordType: z.literal("commitment"),
  commitment: z.object({
    id: UuidV7,
    workspaceId: z.string().min(1).max(500),
    title: z.string().min(1).max(500),
    description: z.string().nullable(),
    successCriteria: z.string().nullable(),
    completionPolicy: z.enum(["assertion", "evidence"]),
    status: TaskStatus,
    priority: z.number().int().min(1).max(5).nullable(),
    notBefore: UnixMs.nullable(),
    dueAt: UnixMs.nullable(),
    startedAt: UnixMs.nullable(),
    revision: z.number().int().positive(),
    updatedAt: UnixMs,
  }).strict(),
  coordination: z.object({
    activeClaim: z.object({
      id: UuidV7,
      actorAlias: z.string().min(1),
      principalId: z.string().min(1).nullable(),
      fence: z.number().int().positive(),
      revision: z.number().int().positive(),
      expiresAt: UnixMs,
      ownedByRequestingActor: z.boolean(),
    }).strict().nullable(),
    activeAttemptCount: Count,
    activeAssignmentCount: Count,
    activeRelationCount: Count,
    unresolvedEffectCount: Count,
  }).strict(),
  rank: z.object({
    statusTier: z.number().int().min(1).max(3),
    deadlineTier: z.number().int().min(0).max(3),
    explicitPriority: z.number().int().min(0).max(5),
    updatedAt: UnixMs,
  }).strict(),
  reasonTrace: z.array(ContextPacketReason).min(1).max(12),
  truncatedFields: z.array(z.object({
    field: z.enum(["description", "successCriteria"]),
    originalUtf8Bytes: z.number().int().positive(),
    projectedUtf8Bytes: Count,
  }).strict()).max(2),
  inspect: z.object({
    operation: z.literal("inspectCommitment"),
    commitmentId: UuidV7,
  }).strict(),
}).strict();
export type ContextPacketItem = z.infer<typeof ContextPacketItem>;

export const ContextPacket = z.object({
  contractVersion: z.literal(CONTEXT_PACKET_CONTRACT_VERSION),
  generatedAt: UnixMs,
  workspaceId: z.string().min(1).max(500),
  requestingActor: z.string().min(1).max(500).nullable(),
  scope: z.object({
    statuses: z.tuple([
      z.literal("in_progress"),
      z.literal("blocked"),
      z.literal("open"),
    ]),
    deferred: z.enum(["exclude_future_not_before", "include"]),
  }).strict(),
  ordering: z.tuple([
    z.literal("status_tier_desc"),
    z.literal("deadline_tier_desc"),
    z.literal("explicit_priority_desc"),
    z.literal("due_at_asc_nulls_last"),
    z.literal("updated_at_desc"),
    z.literal("commitment_id_asc"),
  ]),
  budget: z.object({
    maxRecords: z.number().int().min(1).max(500),
    maxTokens: z.number().int().min(1_024).max(1_000_000),
    usedRecords: Count,
    usedTokens: Count,
    measuredUtf8Bytes: Count,
    tokenEstimator: z.literal(CONTEXT_PACKET_TOKEN_ESTIMATOR_URI),
    encoding: z.literal("canonical-json-utf8"),
    hardLimitSatisfied: z.literal(true),
  }).strict(),
  selection: z.object({
    eligibleRecords: Count,
    evaluatedRecords: Count,
    selectedRecords: Count,
    candidateScanLimit: z.number().int().positive(),
    omitted: z.object({
      recordBudget: Count,
      tokenBudget: Count,
      candidateScanLimit: Count,
    }).strict(),
  }).strict(),
  items: z.array(ContextPacketItem).max(500),
  resumeCursor: z.object({
    afterEventSequence: Count,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.items.length !== value.selection.selectedRecords ||
      value.items.length !== value.budget.usedRecords) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selection", "selectedRecords"],
      message: "selectedRecords, usedRecords and items.length must agree",
    });
  }
  if (value.budget.usedTokens !== value.budget.measuredUtf8Bytes ||
      value.budget.usedTokens > value.budget.maxTokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget", "usedTokens"],
      message: "portable token estimate must equal measured bytes and remain within maxTokens",
    });
  }
});
export type ContextPacket = z.infer<typeof ContextPacket>;
