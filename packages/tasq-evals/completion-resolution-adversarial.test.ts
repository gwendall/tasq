import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  exportPortableStore,
  getCompletionResolutionChain,
  importPortableStore,
  openDb,
  proposeCompletion,
  runKernelMigrations,
  settleOptimisticCompletion,
} from "@tasq-run/core";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("TQ-612 adversarial completion resolution", () => {
  it("rejects self-validation, preserves a dispute and requires named adjudication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-resolution-eval-"));
    dirs.push(dir);
    const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    await runKernelMigrations(opened.client, { now: 1_000 });
    try {
      const worker = await createPrincipal(opened.db, {
        tenantId: "research/lab",
        kind: "agent", displayName: "Worker", localAlias: "worker",
      }, { now: 2_000 });
      const adjudicator = await createPrincipal(opened.db, {
        tenantId: "research/lab",
        kind: "human", displayName: "Adjudicator", localAlias: "adjudicator",
      }, { now: 2_100 });
      const commitment = await createCommitment(opened.db, {
        title: "Resolve a disputed research result",
        successCriteria: "The named result is reproduced",
        completionPolicy: "evidence",
        validationRequired: true,
      }, {
        workspaceId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 3_000,
      });
      const evidence = await addTaskEvidence(opened.db, {
        taskId: commitment.id,
        kind: "experiment.result",
        summary: "Fixture reports a reproduced result",
        observedAt: 4_000,
      }, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 4_000,
        idempotencyKey: "eval-evidence",
      });
      const trust = await attestEvidenceTrust(opened.db, {
        taskId: commitment.id,
        evidenceId: evidence.id,
        authenticity: "unverified",
        authorityUri: "urn:tasq:authority:local-attribution",
        authorityVersion: 1,
        authorityDigest: `sha256:${"1".repeat(64)}`,
        reason: "Attribution is known; source authenticity is not claimed",
        verifiedAt: 4_000,
      }, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 4_100,
        idempotencyKey: "eval-trust",
      });
      const contract = await createResolutionContract(opened.db, {
        taskId: commitment.id,
        criteria: [{
          id: "reproduced",
          statement: "The named result is reproduced",
          acceptedEvidenceKinds: ["experiment.result"],
          minimumAuthenticity: "unverified",
        }],
        policyKind: "optimistic",
        policyUri: "urn:tasq:eval:optimistic",
        policyVersion: 1,
        implementationDigest: `sha256:${"2".repeat(64)}`,
        challengeWindowMs: 2_000,
        adjudicatorPrincipalIds: [adjudicator.id],
      }, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 4_200,
        idempotencyKey: "eval-contract",
      });
      const proposal = await proposeCompletion(opened.db, {
        taskId: commitment.id,
        resolutionContractId: contract.id,
        criterionEvidence: [{ criterionId: "reproduced", evidenceIds: [evidence.id] }],
      }, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 5_000,
        idempotencyKey: "eval-proposal",
      });

      const early = await settleOptimisticCompletion(opened.db, proposal.id, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 6_000,
        idempotencyKey: "eval-settle-early",
      });
      expect(early.outcome).toBe("too_early");
      const challenge = await challengeCompletion(opened.db, {
        proposalId: proposal.id,
        reasonCode: "replication-questioned",
        explanation: "The reproduction environment is disputed",
        counterEvidenceIds: [],
      }, {
        tenantId: "research/lab",
        actor: "adjudicator",
        principalId: adjudicator.id,
        now: 6_500,
        idempotencyKey: "eval-challenge",
      });
      const challenged = await settleOptimisticCompletion(opened.db, proposal.id, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 7_000,
        idempotencyKey: "eval-settle-final",
      });
      expect(challenged.outcome).toBe("challenged");
      await expect(adjudicateCompletion(opened.db, {
        proposalId: proposal.id,
        outcome: "accepted",
        reasonCode: "worker-self-adjudication",
        explanation: "The proposer cannot resolve their own dispute",
        supersedesDecisionId: challenged.id,
      }, {
        tenantId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        now: 7_100,
        idempotencyKey: "eval-self-adjudication",
      })).rejects.toThrow(/eligible adjudicator|self-validation/);
      const accepted = await adjudicateCompletion(opened.db, {
        proposalId: proposal.id,
        outcome: "accepted",
        reasonCode: "dispute-resolved",
        explanation: "The named adjudicator reviewed the dispute and evidence",
        supersedesDecisionId: challenged.id,
      }, {
        tenantId: "research/lab",
        actor: "adjudicator",
        principalId: adjudicator.id,
        now: 7_200,
        idempotencyKey: "eval-adjudication",
      });
      const done = await completeCommitment(opened.db, commitment.id, {
        workspaceId: "research/lab",
        actor: "worker",
        principalId: worker.id,
        expectedRevision: commitment.revision,
        validationDecisionId: accepted.id,
        now: 7_300,
      });
      expect(done.status).toBe("done");
      expect(await getCompletionResolutionChain(opened.db, contract.id, "research/lab"))
        .toMatchObject({
          challenges: [{ id: challenge.id }],
          decisions: [
            { id: early.id, outcome: "too_early" },
            { id: challenged.id, outcome: "challenged" },
            { id: accepted.id, outcome: "accepted" },
          ],
          trustRecords: [{ id: trust.id }],
        });
      const exported = await exportPortableStore(opened.client, "research/lab", { now: 7_400 });
      const importedPath = join(dir, "imported.sqlite");
      await importPortableStore(exported.document, importedPath, exported.sha256, 7_500);
      const imported = await openDb({ url: `file:${importedPath}`, wal: false });
      try {
        expect(await getCompletionResolutionChain(imported.db, contract.id, "research/lab"))
          .toMatchObject({
            challenges: [{ id: challenge.id }],
            decisions: [{ id: early.id }, { id: challenged.id }, { id: accepted.id }],
          });
      } finally {
        await imported.close();
      }
    } finally {
      await opened.close();
    }
  });
});
