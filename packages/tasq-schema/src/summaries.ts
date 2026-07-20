/** Source-bound semantic compaction for terminal commitments. */

import { z } from "zod";
import { UuidV7 } from "./types.js";

export const COMMITMENT_SUMMARY_CONTRACT_VERSION = "tasq.commitment-summary.v1" as const;
export const COMMITMENT_SUMMARY_SOURCE_CONTRACT_VERSION =
  "tasq.commitment-summary-source.v1" as const;
export const COMMITMENT_SUMMARY_PAGE_CONTRACT_VERSION =
  "tasq.commitment-summary-page.v1" as const;

const UnixMs = z.number().int().nonnegative();
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IdList = z.array(z.string().min(1).max(500)).max(20_000);

export const CommitmentSummarySourceRefs = z.object({
  inspect: z.object({
    operation: z.literal("inspectCommitment"),
    commitmentId: UuidV7,
  }).strict(),
  audit: z.object({
    entityType: z.literal("task"),
    entityId: UuidV7,
    throughSequence: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
  }).strict(),
  evidenceIds: IdList,
  artifactIds: IdList,
  completionRecordIds: IdList,
  effectReceiptIds: IdList,
  externalRefIds: IdList,
  /** Added by TQ-503; absent only on summaries created before migration 0024. */
  externalContextLinkIds: IdList.optional(),
}).strict().superRefine((value, context) => {
  for (const field of [
    "evidenceIds", "artifactIds", "completionRecordIds", "effectReceiptIds", "externalRefIds",
    "externalContextLinkIds",
  ] as const) {
    const references = value[field];
    if (references !== undefined && new Set(references).size !== references.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must not contain duplicate references`,
      });
    }
  }
});
export type CommitmentSummarySourceRefs = z.infer<typeof CommitmentSummarySourceRefs>;

export const CommitmentSummarySource = z.object({
  contractVersion: z.literal(COMMITMENT_SUMMARY_SOURCE_CONTRACT_VERSION),
  commitmentRevision: z.number().int().positive(),
  terminalStatus: z.enum(["done", "cancelled"]),
  rawEventSequence: z.number().int().nonnegative(),
  digest: Digest,
  refs: CommitmentSummarySourceRefs,
}).strict();
export type CommitmentSummarySource = z.infer<typeof CommitmentSummarySource>;

export const CommitmentSummaryState = z.enum(["current", "stale", "superseded"]);
export type CommitmentSummaryState = z.infer<typeof CommitmentSummaryState>;

export const CommitmentSummary = z.object({
  contractVersion: z.literal(COMMITMENT_SUMMARY_CONTRACT_VERSION),
  id: UuidV7,
  workspaceId: z.string().trim().min(1).max(500),
  commitmentId: UuidV7,
  supersedesSummaryId: UuidV7.nullable(),
  summary: z.string().trim().min(1).max(8_000),
  summaryDigest: Digest,
  source: CommitmentSummarySource,
  actorAlias: z.string().trim().min(1).max(500),
  principalId: z.string().min(1).max(500),
  createdAt: UnixMs,
  state: CommitmentSummaryState,
  staleReasons: z.array(z.enum([
    "commitment_not_terminal",
    "commitment_revision_changed",
    "raw_audit_advanced",
  ])).max(3),
}).strict().superRefine((value, context) => {
  if (value.source.refs.inspect.commitmentId !== value.commitmentId ||
      value.source.refs.audit.entityId !== value.commitmentId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source", "refs"],
      message: "source references must address the summarized commitment",
    });
  }
  if (value.source.refs.audit.throughSequence !== value.source.rawEventSequence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source", "refs", "audit", "throughSequence"],
      message: "audit cursor and source rawEventSequence must agree",
    });
  }
  if ((value.state === "current" && value.staleReasons.length !== 0) ||
      (value.state === "stale" && value.staleReasons.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["staleReasons"],
      message: "current summaries have no stale reasons and stale summaries require one",
    });
  }
});
export type CommitmentSummary = z.infer<typeof CommitmentSummary>;

export const CommitmentSummaryPage = z.object({
  contractVersion: z.literal(COMMITMENT_SUMMARY_PAGE_CONTRACT_VERSION),
  items: z.array(CommitmentSummary).max(10_000),
  selection: z.object({
    mode: z.literal("current_only"),
    excludes: z.tuple([z.literal("stale"), z.literal("superseded")]),
    emptyDoesNotProveNoHistory: z.literal(true),
    historyRecipeId: z.literal("summary.list"),
  }).strict().optional(),
}).strict();
export type CommitmentSummaryPage = z.infer<typeof CommitmentSummaryPage>;

export const AppendCommitmentSummaryInput = z.object({
  id: UuidV7.optional(),
  workspaceId: z.string().trim().min(1).max(500),
  commitmentId: UuidV7,
  summary: z.string().trim().min(1).max(8_000),
  expectedPreviousSummaryId: UuidV7.nullable(),
}).strict().superRefine((value, context) => {
  if (value.id !== undefined && value.id === value.expectedPreviousSummaryId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedPreviousSummaryId"],
      message: "a summary cannot supersede itself",
    });
  }
});
export type AppendCommitmentSummaryInput = z.infer<typeof AppendCommitmentSummaryInput>;
