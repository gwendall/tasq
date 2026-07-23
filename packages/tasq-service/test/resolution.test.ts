import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCompletionEvaluator } from "@tasq-run/extension-sdk";
import {
  addTaskEvidence,
  adjudicateCompletion,
  attestCompletion,
  attestEvidenceTrust,
  challengeCompletion,
  completeCommitment,
  createCommitment,
  createPrincipal,
  createResolutionContract,
  evaluateCompletionDeterministically,
  getCompletionResolutionChain,
  listCompletionRecords,
  openDb,
  proposeCompletion,
  revokeEvidenceTrust,
  runKernelMigrations,
  settleOptimisticCompletion,
  updateCommitment,
} from "../src/kernel.js";
import { diagnoseStore } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-resolution-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(handle.client, { now: 1_000 });
  return handle;
}

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;

async function fixture(policy: "attestation" | "deterministic" | "optimistic" | "adjudicated") {
  const handle = await freshDb();
  const worker = await createPrincipal(handle.db, {
    kind: "agent",
    displayName: "Worker",
    localAlias: "worker",
  }, { now: 2_000 });
  const validator = await createPrincipal(handle.db, {
    kind: "human",
    displayName: "Validator",
    localAlias: "validator",
  }, { now: 2_100 });
  const adjudicator = await createPrincipal(handle.db, {
    kind: "human",
    displayName: "Adjudicator",
    localAlias: "adjudicator",
  }, { now: 2_200 });
  const commitment = await createCommitment(handle.db, {
    title: "Deploy exact release",
    successCriteria: "The named release is healthy",
    completionPolicy: "evidence",
    validationRequired: true,
  }, {
    workspaceId: "gwendall",
    actor: "worker",
    principalId: worker.id,
    now: 3_000,
  });
  const evidence = await addTaskEvidence(handle.db, {
    taskId: commitment.id,
    kind: "deployment.health",
    summary: "Health endpoint returned the exact release",
    digest: digest("a"),
    source: "deploy:production",
    observedAt: 4_000,
  }, {
    tenantId: "gwendall",
    actor: "worker",
    principalId: worker.id,
    now: 4_000,
    idempotencyKey: `evidence-${policy}`,
  });
  const trust = await attestEvidenceTrust(handle.db, {
    taskId: commitment.id,
    evidenceId: evidence.id,
    authenticity: "unverified",
    authorityUri: "urn:tasq:authority:local-attribution",
    authorityVersion: 1,
    authorityDigest: digest("b"),
    reason: "Locally attributed evidence",
    verifiedAt: 4_000,
    retentionUntil: 100_000,
  }, {
    tenantId: "gwendall",
    actor: "worker",
    principalId: worker.id,
    now: 4_100,
    idempotencyKey: `trust-${policy}`,
  });
  const contract = await createResolutionContract(handle.db, {
    taskId: commitment.id,
    criteria: [{
      id: "healthy-release",
      statement: "The named release is healthy",
      acceptedEvidenceKinds: ["deployment.health"],
      acceptedSources: ["deploy:production"],
      minimumAuthenticity: "unverified",
      maxAgeMs: 50_000,
      minimumRetentionMs: 10_000,
    }],
    policyKind: policy,
    policyUri: `urn:tasq:test-policy:${policy}`,
    policyVersion: 1,
    implementationDigest: digest(
      policy === "attestation" ? "a"
        : policy === "deterministic" ? "d"
          : policy === "optimistic" ? "c"
            : "e",
    ),
    challengeWindowMs: policy === "optimistic" ? 5_000 : 0,
    eligibleValidatorPrincipalIds: policy === "attestation" ? [worker.id, validator.id] : [],
    adjudicatorPrincipalIds:
      policy === "adjudicated" || policy === "optimistic" ? [adjudicator.id] : [],
  }, {
    tenantId: "gwendall",
    actor: "worker",
    principalId: worker.id,
    now: 4_200,
    idempotencyKey: `contract-${policy}`,
  });
  const proposal = await proposeCompletion(handle.db, {
    taskId: commitment.id,
    resolutionContractId: contract.id,
    criterionEvidence: [{ criterionId: "healthy-release", evidenceIds: [evidence.id] }],
    summary: "Ready for independent resolution",
  }, {
    tenantId: "gwendall",
    actor: "worker",
    principalId: worker.id,
    now: 5_000,
    idempotencyKey: `proposal-${policy}`,
  });
  return { handle, worker, validator, adjudicator, commitment, evidence, trust, contract, proposal };
}

describe("ADR-005 independently validated completion", () => {
  it("separates proposal, independent attestation, decision and final completion", async () => {
    const f = await fixture("attestation");
    try {
      await expect(attestCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        outcome: "accepted",
        reasonCode: "looks-good",
        explanation: "Worker tried to validate their own proposal",
      }, {
        tenantId: "gwendall",
        actor: "worker",
        principalId: f.worker.id,
        now: 6_000,
        idempotencyKey: "self-validation",
      })).rejects.toThrow(/forbids self-validation/);

      const accepted = await attestCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        outcome: "accepted",
        reasonCode: "independently-confirmed",
        explanation: "A distinct eligible principal confirmed the evidence",
      }, {
        tenantId: "gwendall",
        actor: "validator",
        principalId: f.validator.id,
        now: 6_100,
        idempotencyKey: "independent-validation",
      });
      const retry = await attestCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        outcome: "accepted",
        reasonCode: "independently-confirmed",
        explanation: "A distinct eligible principal confirmed the evidence",
      }, {
        tenantId: "gwendall",
        actor: "validator",
        principalId: f.validator.id,
        now: 6_200,
        idempotencyKey: "independent-validation",
      });
      expect(retry.id).toBe(accepted.id);

      await expect(completeCommitment(f.handle.db, f.commitment.id, {
        workspaceId: "gwendall",
        actor: "worker",
        principalId: f.worker.id,
        expectedRevision: f.commitment.revision,
        evidenceIds: [f.evidence.id],
        now: 6_300,
      })).rejects.toThrow(/accepted validation decision/);

      const done = await completeCommitment(f.handle.db, f.commitment.id, {
        workspaceId: "gwendall",
        actor: "worker",
        principalId: f.worker.id,
        expectedRevision: f.commitment.revision,
        validationDecisionId: accepted.id,
        now: 6_400,
      });
      expect(done).toMatchObject({ status: "done", validationRequired: true });
      const lostResponseRetry = await attestCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        outcome: "accepted",
        reasonCode: "independently-confirmed",
        explanation: "A distinct eligible principal confirmed the evidence",
      }, {
        tenantId: "gwendall",
        actor: "validator",
        principalId: f.validator.id,
        now: 6_500,
        idempotencyKey: "independent-validation",
      });
      expect(lostResponseRetry.id).toBe(accepted.id);
      expect(await listCompletionRecords(f.handle.db, f.commitment.id)).toMatchObject([{
        resolutionContractId: f.contract.id,
        validationDecisionId: accepted.id,
        decidedByPrincipalId: f.validator.id,
        evidenceIds: [f.evidence.id],
      }]);
      expect(await getCompletionResolutionChain(f.handle.db, f.contract.id)).toMatchObject({
        proposals: [{ id: f.proposal.id }],
        decisions: [{ id: accepted.id, outcome: "accepted" }],
        trustRecords: [{ id: f.trust.id, action: "attest" }],
      });
      expect((await diagnoseStore(f.handle.db, f.handle.client)).issues).toEqual([]);

      await f.handle.client.execute("DROP TRIGGER validation_decision_immutable_update");
      await f.handle.client.execute({
        sql: "UPDATE validation_decision SET trust_record_ids = ? WHERE id = ?",
        args: [JSON.stringify(["missing-trust-record"]), accepted.id],
      });
      expect((await diagnoseStore(f.handle.db, f.handle.client)).issues).toContainEqual(
        expect.objectContaining({
          code: "validation_decision_evidence_mismatch",
          entityId: accepted.id,
        }),
      );
    } finally {
      await f.handle.close();
    }
  });

  it("fails closed on criterion drift, trust revocation and evaluator identity drift", async () => {
    const f = await fixture("deterministic");
    try {
      await revokeEvidenceTrust(f.handle.db, f.trust.id, {
        tenantId: "gwendall",
        actor: "worker",
        principalId: f.worker.id,
        reason: "Source provenance was withdrawn",
        now: 5_500,
        idempotencyKey: "revoke-trust",
      });
      const evaluator = defineCompletionEvaluator({
        policyUri: f.contract.policyUri,
        policyVersion: f.contract.policyVersion,
        implementationDigest: f.contract.implementationDigest,
        evaluate: () => ({
          outcome: "accepted",
          reasonCode: "predicate-matched",
          explanation: "The deterministic predicate matched",
        }),
      });
      const indeterminate = await evaluateCompletionDeterministically(
        f.handle.db,
        f.proposal.id,
        {
          tenantId: "gwendall",
          actor: "validator-runtime",
          evaluator,
          now: 6_000,
          idempotencyKey: "deterministic-after-revoke",
        },
      );
      expect(indeterminate).toMatchObject({
        outcome: "indeterminate",
        reasonCode: "evidence_trust_revoked",
      });

      await expect(evaluateCompletionDeterministically(f.handle.db, f.proposal.id, {
        tenantId: "gwendall",
        actor: "validator-runtime",
        evaluator: defineCompletionEvaluator({
          ...evaluator,
          implementationDigest: digest("f"),
        }),
        now: 6_100,
        idempotencyKey: "wrong-evaluator",
      })).rejects.toThrow(/identity does not match/);

      const updated = await updateCommitment(f.handle.db, f.commitment.id, {
        successCriteria: "A different release criterion",
      }, {
        workspaceId: "gwendall",
        actor: "worker",
        principalId: f.worker.id,
        expectedRevision: f.commitment.revision,
        now: 6_200,
      });
      expect(updated.revision).toBe(2);
      await expect(evaluateCompletionDeterministically(f.handle.db, f.proposal.id, {
        tenantId: "gwendall",
        actor: "validator-runtime",
        evaluator,
        now: 6_300,
        idempotencyKey: "stale-contract",
      })).rejects.toThrow(/Success criteria changed/);
    } finally {
      await f.handle.close();
    }
  });

  it("keeps optimistic challenges visible and requires named adjudication", async () => {
    const f = await fixture("optimistic");
    try {
      const tooEarly = await settleOptimisticCompletion(f.handle.db, f.proposal.id, {
        tenantId: "gwendall",
        actor: "system",
        now: 7_000,
        idempotencyKey: "settle-too-early",
      });
      expect(tooEarly).toMatchObject({ outcome: "too_early", reasonCode: "challenge_window_open" });

      await challengeCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        reasonCode: "release-mismatch",
        explanation: "The health response names another release",
      }, {
        tenantId: "gwendall",
        actor: "validator",
        principalId: f.validator.id,
        now: 8_000,
        idempotencyKey: "challenge",
      });
      await expect(challengeCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        reasonCode: "late",
        explanation: "This challenge arrived after the deadline",
      }, {
        tenantId: "gwendall",
        actor: "validator",
        principalId: f.validator.id,
        now: 10_000,
        idempotencyKey: "late-challenge",
      })).rejects.toThrow(/deadline passed/);

      const challenged = await settleOptimisticCompletion(f.handle.db, f.proposal.id, {
        tenantId: "gwendall",
        actor: "system",
        now: 10_000,
        idempotencyKey: "settle-challenged",
      });
      expect(challenged.outcome).toBe("challenged");

      const accepted = await adjudicateCompletion(f.handle.db, {
        proposalId: f.proposal.id,
        outcome: "accepted",
        reasonCode: "counter-evidence-resolved",
        explanation: "The named adjudicator resolved the discrepancy",
        supersedesDecisionId: challenged.id,
      }, {
        tenantId: "gwendall",
        actor: "adjudicator",
        principalId: f.adjudicator.id,
        now: 10_100,
        idempotencyKey: "adjudicate",
      });
      expect(accepted).toMatchObject({
        outcome: "accepted",
        supersedesDecisionId: challenged.id,
      });
    } finally {
      await f.handle.close();
    }
  });
});
