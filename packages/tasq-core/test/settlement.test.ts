import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettlementClassificationV1, type AgreementTermsInputV1, type SettlementPolicyV1 } from "@tasq-run/schema";
import {
  createLocalTasq,
  createMutableClock,
  installExtension,
  openDb,
  runKernelMigrations,
} from "../src/kernel.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const EFFECT_TYPE = "https://schemas.example.test/effects/transfer";

async function store(name: string) {
  const root = await mkdtemp(join(tmpdir(), `tasq-settlement-${name}-`));
  roots.push(root);
  return { root, url: `file:${join(root, "db.sqlite")}` };
}

function agreementTerms(buyer: string, worker: string): AgreementTermsInputV1 {
  const parties = [
    { principalId: buyer, roleUri: "https://schemas.example.test/roles/buyer/v1" },
    { principalId: worker, roleUri: "https://schemas.example.test/roles/worker/v1" },
  ].sort((left, right) => left.principalId < right.principalId ? -1 : 1);
  const resolutionPolicy = (id: string) => ({
    criteria: [{ id, statement: `${id} is satisfied` }],
    policyKind: "deterministic" as const,
    policyUri: "https://schemas.example.test/policies/outcome/v1",
    policyVersion: 1,
    implementationDigest: digest("a"),
    notBefore: null,
    challengeWindowMs: 0,
    allowSelfValidation: false,
    eligibleValidatorPrincipalIds: [],
    adjudicatorPrincipalIds: [],
    metadata: {},
  });
  return {
    contractVersion: "tasq.agreement-terms.v1",
    title: "Verified field work",
    purposeUri: "https://schemas.example.test/purposes/field-work/v1",
    parties,
    obligations: [{
      id: "buyer-settle",
      obligorPrincipalId: buyer,
      beneficiaryPrincipalId: worker,
      commitment: {
        title: "Settle accepted work", description: null,
        successCriteria: "Settlement is evidenced", notBefore: null, dueAt: null,
        priority: null, metadata: {},
      },
      resolutionPolicy: resolutionPolicy("settled"),
    }, {
      id: "worker-perform",
      obligorPrincipalId: worker,
      beneficiaryPrincipalId: buyer,
      commitment: {
        title: "Perform field work", description: null,
        successCriteria: "Outcome evidence is accepted", notBefore: null, dueAt: null,
        priority: null, metadata: {},
      },
      resolutionPolicy: resolutionPolicy("performed"),
    }],
    terms: { currency: "EUR", amountMinor: 12_500, showUpMinor: 2_500 },
  };
}

function request(workspaceId: string, amountMinor: number) {
  return {
    protocol: "tasq.effect-request.v1" as const,
    canonicalization: "tasq.jcs-safe-integer.v1" as const,
    digestAlgorithm: "sha-256" as const,
    workspaceId,
    effectTypeUri: EFFECT_TYPE,
    effectSchemaVersion: 1,
    connector: {
      operationUri: "https://schemas.example.test/connectors/payments/transfer",
      operationVersion: 1,
      contractDigest: digest("b"),
      instanceRef: "payments:test",
      bindingDigest: digest("c"),
    },
    parameters: { amountMinor, currency: "EUR", recipientRef: "worker:test" },
    secretBindings: [],
  };
}

function policy(input: {
  workspaceId: string; buyer: string; worker: string; classification?: "full" | "partial" | "show_up" | "cancellation" | "rework" | "credit" | "indeterminate";
  amountMinor?: number; effect?: boolean; effectTypeUri?: string;
}): SettlementPolicyV1 {
  const effectRequest = request(input.workspaceId, input.amountMinor ?? 12_500);
  if (input.effectTypeUri) effectRequest.effectTypeUri = input.effectTypeUri;
  return {
    contractVersion: "tasq.settlement-policy.v1",
    policyUri: "https://schemas.example.test/policies/field-settlement/v1",
    policyVersion: 1,
    implementationDigest: digest("d"),
    rules: [{
      id: "succeeded",
      when: {
        taskStatuses: [], anyAttemptStatuses: ["succeeded"], validationOutcomes: [],
        validationReasonCodes: [], anyEffectStatuses: [],
      },
      classification: input.classification ?? "full",
      entitlements: [{
        id: "worker-entitlement",
        obligorPrincipalId: input.buyer,
        beneficiaryPrincipalId: input.worker,
        task: {
          title: "Pay worker entitlement", description: null,
          successCriteria: "Payment receipt is attached", dueAt: null, metadata: {},
        },
        effect: input.effect === false ? null : { request: effectRequest, compensationOfEffectId: null },
      }],
    }],
  };
}

async function fixture(name: string) {
  const { url } = await store(name);
  const workspaceId = `field/${name}`;
  const clock = createMutableClock(2_900_000_000_000);
  const bootstrap = await openDb({ url, wal: false });
  await runKernelMigrations(bootstrap.client, { clock });
  await installExtension(bootstrap.db, {
    extensionUri: "https://schemas.example.test/extensions/payments",
    version: "1.0.0",
    types: [{
      recordKind: "effect", typeUri: EFFECT_TYPE, schemaVersion: 1,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: true,
      },
    }],
    evaluators: [],
  }, { tenantId: workspaceId, actor: "admin", clock });
  await bootstrap.close();
  const buyer = await createLocalTasq({ url, workspaceId, actor: "buyer", clock, wal: false });
  const worker = await createLocalTasq({ url, workspaceId, actor: "worker", clock, wal: false });
  const offer = await buyer.agreements.offer({
    terms: agreementTerms(buyer.principalId, worker.principalId), expiresAt: clock.now() + 60_000,
  });
  await buyer.agreements.accept(offer.id, offer.termsDigest);
  const accepted = await worker.agreements.accept(offer.id, offer.termsDigest);
  const source = accepted.activation!.compilations.find(({ obligationId }) => obligationId === "worker-perform")!;
  const attempt = await worker.attempts.start(source.commitmentId, { runtime: "field-runner" });
  const succeeded = await worker.attempts.transition(attempt.id, "succeeded", { expectedRevision: attempt.revision });
  return { url, workspaceId, clock, buyer, worker, offer, source, attempt: succeeded };
}

describe("TQ-628 settlement and recourse", () => {
  test("freezes the complete provider-neutral outcome vocabulary", () => {
    expect(SettlementClassificationV1.options).toEqual([
      "full", "partial", "show_up", "cancellation", "rework", "credit", "indeterminate",
    ]);
  });

  test("derives a full entitlement from every exact attempt and proposes, but never authorizes, its effect", async () => {
    const value = await fixture("full");
    try {
      const settlement = await value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id,
        obligationId: "worker-perform",
        attemptIds: [value.attempt.id],
        validationDecisionId: null,
        supersedesDecisionId: null,
        policy: policy({ workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId }),
      }, { idempotencyKey: "full-settlement" });
      expect(settlement).toMatchObject({
        decision: { decisionKind: "settlement", classification: "full", matchedRuleId: "succeeded" },
        assurance: { completionRewritten: false, effectAuthorityGranted: false, escrowOrRecordRoleAsserted: false },
      });
      expect(settlement.materializations).toHaveLength(1);
      const materialization = settlement.materializations[0]!;
      expect((await value.buyer.effects.get(materialization.effectId!))?.status).toBe("proposed");
      expect((await value.buyer.commitments.get(value.source.commitmentId))?.status).toBe("open");
      expect(await value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id,
        obligationId: "worker-perform",
        attemptIds: [value.attempt.id],
        validationDecisionId: null,
        supersedesDecisionId: null,
        policy: settlement.decision.policy,
      }, { idempotencyKey: "full-settlement" })).toEqual(settlement);
    } finally {
      await value.worker.close();
      await value.buyer.close();
    }
  });

  test("supersedes only pre-dispatch materializations and retains both immutable decisions", async () => {
    const value = await fixture("supersede");
    try {
      const first = await value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id, obligationId: "worker-perform",
        attemptIds: [value.attempt.id], validationDecisionId: null, supersedesDecisionId: null,
        policy: policy({ workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId }),
      });
      const second = await value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id, obligationId: "worker-perform",
        attemptIds: [value.attempt.id], validationDecisionId: null,
        supersedesDecisionId: first.decision.id,
        policy: policy({
          workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId,
          classification: "partial", amountMinor: 6_250,
        }),
      });
      expect(second.decision).toMatchObject({ classification: "partial", supersedesDecisionId: first.decision.id });
      expect((await value.buyer.effects.get(first.materializations[0]!.effectId!))?.status).toBe("cancelled");
      expect((await value.buyer.commitments.get(first.materializations[0]!.commitmentId))?.status).toBe("cancelled");
      expect((await value.buyer.settlement.get(first.decision.id))?.supersededByDecisionId).toBe(second.decision.id);
      expect(await value.buyer.settlement.list()).toHaveLength(2);
    } finally {
      await value.worker.close();
      await value.buyer.close();
    }
  });

  test("elects one root decision when two idempotency identities race the same obligation", async () => {
    const value = await fixture("root-race");
    try {
      const exact = {
        agreementOfferId: value.offer.id,
        obligationId: "worker-perform" as const,
        attemptIds: [value.attempt.id],
        validationDecisionId: null,
        supersedesDecisionId: null,
        policy: policy({
          workspaceId: value.workspaceId,
          buyer: value.buyer.principalId,
          worker: value.worker.principalId,
          effect: false,
        }),
      };
      const outcomes = await Promise.allSettled([
        value.buyer.settlement.evaluate(exact, { idempotencyKey: "root-race-a" }),
        value.buyer.settlement.evaluate(exact, { idempotencyKey: "root-race-b" }),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(await value.buyer.settlement.list()).toHaveLength(1);
      const decisions = await value.buyer.settlement.list();
      expect((await value.buyer.settlement.get(decisions[0]!.id))?.materializations).toHaveLength(1);
    } finally {
      await value.worker.close();
      await value.buyer.close();
    }
  });

  test("materializes recourse from the complete prior effect set without rewriting the original decision", async () => {
    const value = await fixture("recourse");
    try {
      const original = await value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id, obligationId: "worker-perform",
        attemptIds: [value.attempt.id], validationDecisionId: null, supersedesDecisionId: null,
        policy: policy({ workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId }),
      });
      const effectId = original.materializations[0]!.effectId!;
      const recoursePolicy = policy({
        workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId,
        classification: "rework", effect: false,
      });
      recoursePolicy.rules[0]!.when.anyEffectStatuses = ["proposed"];
      const recourse = await value.buyer.recourse.evaluate({
        agreementOfferId: value.offer.id,
        obligationId: "worker-perform",
        attemptIds: [value.attempt.id],
        validationDecisionId: null,
        effectIds: [effectId],
        priorSettlementDecisionId: original.decision.id,
        supersedesDecisionId: null,
        policy: recoursePolicy,
      });
      expect(recourse).toMatchObject({
        decision: { decisionKind: "recourse", classification: "rework" },
        materializations: [{ effectId: null }],
      });
      expect((await value.buyer.settlement.get(original.decision.id))?.supersededByDecisionId).toBeNull();
      expect((await value.buyer.commitments.get(value.source.commitmentId))?.status).toBe("open");
    } finally {
      await value.worker.close();
      await value.buyer.close();
    }
  });

  test("rolls back decision and entitlement when effect materialization fails late", async () => {
    const value = await fixture("rollback");
    try {
      await expect(value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id, obligationId: "worker-perform",
        attemptIds: [value.attempt.id], validationDecisionId: null, supersedesDecisionId: null,
        policy: policy({
          workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId,
          effectTypeUri: "https://schemas.example.test/effects/unregistered",
        }),
      })).rejects.toThrow("Unsupported effect type");
      expect(await value.buyer.settlement.list()).toEqual([]);
      expect((await value.buyer.commitments.list()).filter(({ metadata }) => metadata.settlementDecisionId)).toEqual([]);
    } finally {
      await value.worker.close();
      await value.buyer.close();
    }
  });

  test("makes decisions and materializations append-only at the database boundary", async () => {
    const value = await fixture("immutable");
    try {
      const result = await value.buyer.settlement.evaluate({
        agreementOfferId: value.offer.id, obligationId: "worker-perform",
        attemptIds: [value.attempt.id], validationDecisionId: null, supersedesDecisionId: null,
        policy: policy({
          workspaceId: value.workspaceId, buyer: value.buyer.principalId, worker: value.worker.principalId,
          effect: false,
        }),
      });
      const raw = createClient({ url: value.url });
      await expect(raw.execute({
        sql: "UPDATE settlement_decision SET classification = 'credit' WHERE id = ?", args: [result.decision.id],
      })).rejects.toThrow("settlement decisions are immutable");
      await expect(raw.execute("DELETE FROM settlement_materialization"))
        .rejects.toThrow("settlement materializations are append-only");
      raw.close();
    } finally {
      await value.worker.close();
      await value.buyer.close();
    }
  });
});
