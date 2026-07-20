import { describe, expect, it } from "bun:test";
import {
  AppendCommitmentSummaryInput,
  CommitmentSummary,
  CommitmentSummaryPage,
} from "../src/index.js";

const commitmentId = "01910000-0000-7000-8000-000000000001";
const summaryId = "01910000-0000-7000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`;

function validSummary() {
  return {
    contractVersion: "tasq.commitment-summary.v1",
    id: summaryId,
    workspaceId: "robotics/lab",
    commitmentId,
    supersedesSummaryId: null,
    summary: "Calibration completed.",
    summaryDigest: digest,
    source: {
      contractVersion: "tasq.commitment-summary-source.v1",
      commitmentRevision: 2,
      terminalStatus: "done",
      rawEventSequence: 42,
      digest,
      refs: {
        inspect: { operation: "inspectCommitment", commitmentId },
        audit: { entityType: "task", entityId: commitmentId, throughSequence: 42, eventCount: 2 },
        evidenceIds: [],
        artifactIds: [],
        completionRecordIds: [],
        effectReceiptIds: [],
        externalRefIds: [],
      },
    },
    actorAlias: "agent:reviewer",
    principalId: "urn:tasq:local-principal:reviewer",
    createdAt: 1_000,
    state: "current",
    staleReasons: [],
  } as const;
}

describe("commitment summary contracts", () => {
  it("freezes a self-consistent source-bound terminal projection", () => {
    expect(CommitmentSummary.parse(validSummary())).toEqual(validSummary());
    expect(CommitmentSummaryPage.parse({
      contractVersion: "tasq.commitment-summary-page.v1",
      items: [validSummary()],
      selection: {
        mode: "current_only",
        excludes: ["stale", "superseded"],
        emptyDoesNotProveNoHistory: true,
        historyRecipeId: "summary.list",
      },
    }).items).toHaveLength(1);
  });

  it("rejects mismatched source coordinates, cursors, state and duplicate references", () => {
    expect(CommitmentSummary.safeParse({
      ...validSummary(),
      source: {
        ...validSummary().source,
        refs: {
          ...validSummary().source.refs,
          audit: { ...validSummary().source.refs.audit, throughSequence: 41 },
          evidenceIds: [summaryId, summaryId],
        },
      },
      state: "stale",
      staleReasons: [],
    }).success).toBe(false);
  });

  it("requires explicit first/correction CAS identity and forbids self-supersession", () => {
    expect(AppendCommitmentSummaryInput.parse({
      workspaceId: "robotics/lab",
      commitmentId,
      summary: "First",
      expectedPreviousSummaryId: null,
    })).toMatchObject({ expectedPreviousSummaryId: null });
    expect(AppendCommitmentSummaryInput.safeParse({
      id: summaryId,
      workspaceId: "robotics/lab",
      commitmentId,
      summary: "Cycle",
      expectedPreviousSummaryId: summaryId,
    }).success).toBe(false);
  });
});
