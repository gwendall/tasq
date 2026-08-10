import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptAssignment,
  acquireTaskClaim,
  authorizeEffect,
  createCommitment,
  createLocalTasq,
  createPrincipal,
  getEffect,
  installExtension,
  listDeliveryOutbox,
  listEffects,
  openDb,
  proposeAssignment,
  proposeEffect,
  recordEffectApproval,
  releaseTaskClaim,
  runKernelMigrations,
  startTaskAttempt,
} from "@tasq-run/core";
import {
  createHmacEffectPermitAuthenticator,
  enforceEffectDispatch,
  type EffectConnectorPolicy,
  type VerifiedEffectReceipt,
} from "@tasq-run/extension-sdk";
import {
  EffectReceiptReport,
  canonicalizeEffectJson,
  createMutableClock,
  type EffectDispatchPermit,
  type EffectReceiptReport as EffectReceiptReportT,
  type AgreementTermsV1,
  type SettlementPolicyV1,
} from "@tasq-run/schema";
import {
  ReferenceDelegatedRunner,
  buildReviewInbox,
  type DelegatedEffectConnector,
  type DelegatedEffectConnectorResult,
  type EffectDispatchBoundary,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function store(name: string, now = 10_000) {
  const root = mkdtempSync(join(tmpdir(), `tasq-runner-${name}-`));
  roots.push(root);
  const handle = await openDb({ url: `file:${join(root, "db.sqlite")}`, wal: false });
  await runKernelMigrations(handle.client, { now });
  return { ...handle, url: `file:${join(root, "db.sqlite")}` };
}

const EFFECT_TYPE_URI = "https://example.test/effects/power-cycle";
const INSTANCE_REF = "connector:facility:one";
const BINDING_DIGEST = `sha256:${"b".repeat(64)}` as const;
const CONTRACT_DIGEST = `sha256:${"a".repeat(64)}` as const;
const RECEIPT_DIGEST = `sha256:${"d".repeat(64)}` as const;
const permitAuth = createHmacEffectPermitAuthenticator("runner-test-key", "p".repeat(32));

function request(workspaceId: string) {
  return {
    protocol: "tasq.effect-request.v1" as const,
    canonicalization: "tasq.jcs-safe-integer.v1" as const,
    digestAlgorithm: "sha-256" as const,
    workspaceId,
    effectTypeUri: EFFECT_TYPE_URI,
    effectSchemaVersion: 1,
    connector: {
      operationUri: "https://example.test/connectors/facility/power-cycle",
      operationVersion: 1,
      contractDigest: CONTRACT_DIGEST,
      instanceRef: INSTANCE_REF,
      bindingDigest: BINDING_DIGEST,
    },
    parameters: { targetRef: "rack:device:42" },
    secretBindings: [],
  };
}

function policy(): EffectConnectorPolicy {
  return {
    effectTypeUri: EFFECT_TYPE_URI,
    effectSchemaVersion: 1,
    operationUri: "https://example.test/connectors/facility/power-cycle",
    operationVersion: 1,
    contractDigest: CONTRACT_DIGEST,
    instanceRef: INSTANCE_REF,
    bindingDigest: BINDING_DIGEST,
    parseParameters(value) {
      const parsed = value as Record<string, unknown>;
      if (Object.keys(parsed).length !== 1 || parsed.targetRef !== "rack:device:42") {
        throw new Error("wrong target");
      }
      return parsed as { targetRef: string };
    },
    evaluateAuthority({ scope, verificationLevel }) {
      const allowed = verificationLevel !== "self_asserted" && scope.targetRef === "rack:device:42";
      return {
        allowed,
        reasonCode: allowed ? "exact_target" : "target_denied",
        explanation: allowed ? "The exact target is authorized." : "The target is outside authority.",
      };
    },
  };
}

class InstrumentedConnector implements DelegatedEffectConnector {
  readonly policy = policy();
  dispatches = 0;
  lookups = 0;
  loseResponse = false;
  committed = false;
  onBeforeIo: (() => Promise<void>) | null = null;

  #report(permit: EffectDispatchPermit, outcome: "committed" | "indeterminate", resolvesReceiptId: string | null) {
    return EffectReceiptReport.parse({
      protocol: "tasq.effect-receipt.v1",
      workspaceId: permit.payload.workspaceId,
      effectId: permit.payload.effectId,
      requestDigest: permit.payload.requestDigest,
      dispatchIdempotencyKey: permit.payload.dispatchIdempotencyKey,
      approvalId: permit.payload.approval.id,
      claimId: permit.payload.claim.id,
      fence: permit.payload.claim.fence,
      connectorInstanceRef: permit.payload.request.connector.instanceRef,
      connectorBindingDigest: permit.payload.request.connector.bindingDigest,
      externalReceiptId: `${outcome}:receipt:${permit.payload.effectId}`,
      providerOperationId: outcome === "committed" ? `operation:${permit.payload.effectId}` : null,
      outcome,
      occurredAt: permit.payload.issuedAt + 1,
      rawRef: `urn:test-receipt:${outcome}:${permit.payload.effectId}`,
      rawDigest: RECEIPT_DIGEST,
      payload: { providerStatus: outcome },
      resolvesReceiptId,
    });
  }

  async dispatch(input: unknown, boundary: EffectDispatchBoundary): Promise<DelegatedEffectConnectorResult> {
    if (this.onBeforeIo) await this.onBeforeIo();
    await boundary.assertLiveAuthority();
    const { permit } = enforceEffectDispatch(input, this.policy, {
      now: (input as EffectDispatchPermit).payload.issuedAt,
      verifier: permitAuth,
    });
    this.dispatches += 1;
    this.committed = true;
    const outcome = this.loseResponse ? "indeterminate" : "committed";
    this.loseResponse = false;
    return {
      outcome,
      dispatchIdempotencyKey: permit.payload.dispatchIdempotencyKey,
      providerOperationId: outcome === "committed" ? `operation:${permit.payload.effectId}` : null,
      report: this.#report(permit, outcome, null),
    };
  }

  async lookup(input: unknown, options: { resolvesReceiptId?: string | null } = {}): Promise<DelegatedEffectConnectorResult> {
    const permit = input as EffectDispatchPermit;
    this.lookups += 1;
    const outcome = this.committed ? "committed" : "indeterminate";
    return {
      outcome,
      dispatchIdempotencyKey: permit.payload.dispatchIdempotencyKey,
      providerOperationId: outcome === "committed" ? `operation:${permit.payload.effectId}` : null,
      report: this.#report(permit, outcome, options.resolvesReceiptId ?? null),
    };
  }

  verifyReceipt(report: unknown): VerifiedEffectReceipt {
    const parsed = EffectReceiptReport.parse(report);
    return parsed.outcome === "indeterminate" ? {
      level: "self_asserted",
      method: "test-transport-unknown",
      coverage: [],
      details: { exactReport: canonicalizeEffectJson(parsed) },
    } : {
      level: "cryptographic",
      method: "test-provider-signature",
      coverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
      details: { exactReport: canonicalizeEffectJson(parsed) },
    };
  }
}

async function authorizedFixture(name: string) {
  const workspaceId = `runner/${name}`;
  const clock = createMutableClock(20_000);
  const handle = await store(name, 10_000);
  await installExtension(handle.db, {
    extensionUri: "https://example.test/extensions/facility",
    version: "1.0.0",
    types: [{
      recordKind: "effect",
      typeUri: EFFECT_TYPE_URI,
      schemaVersion: 1,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: { targetRef: { type: "string" } },
        required: ["targetRef"],
      },
    }],
    evaluators: [],
  }, { tenantId: workspaceId, actor: "admin", clock });
  const worker = await createPrincipal(handle.db, {
    tenantId: workspaceId, displayName: "Runner worker", kind: "runtime", localAlias: "runner-worker",
  }, { tenantId: workspaceId, actor: "admin", clock });
  const approver = await createPrincipal(handle.db, {
    tenantId: workspaceId, displayName: "Approver", kind: "human", localAlias: "approver",
  }, { tenantId: workspaceId, actor: "admin", clock });
  const commitment = await createCommitment(handle.db, {
    title: "Power cycle one exact device",
    successCriteria: "Authenticated provider receipt",
  }, { workspaceId, actor: "runner-worker", principalId: worker.id, clock });
  const claim = await acquireTaskClaim(handle.db, commitment.id, {
    tenantId: workspaceId, principalId: worker.id, actor: "runner-worker",
    leaseMs: 60_000, clock,
  });
  const attempt = await startTaskAttempt(handle.db, commitment.id, {
    tenantId: workspaceId, principalId: worker.id, actor: "runner-worker",
    claimId: claim.id, runtime: "reference-delegated-runner", clock,
  });
  const proposed = await proposeEffect(handle.db, {
    tenantId: workspaceId, taskId: commitment.id, attemptId: attempt.id, request: request(workspaceId),
  }, { tenantId: workspaceId, principalId: worker.id, actor: "runner-worker", clock });
  const approval = await recordEffectApproval(handle.db, {
    tenantId: workspaceId, effectId: proposed.id, decision: "approved",
    scope: { targetRef: "rack:device:42" }, limits: {}, expiresAt: 70_000,
  }, {
    tenantId: workspaceId, principalId: approver.id, actor: "approver", clock,
    authorityVerification: { level: "authenticated_context", method: "test-session" },
  });
  const authorized = await authorizeEffect(handle.db, proposed.id, approval.id, {
    tenantId: workspaceId, principalId: worker.id, actor: "runner-worker",
    expectedRevision: proposed.revision, clock,
  });
  return { ...handle, workspaceId, clock, worker, commitment, claim, attempt, authorized };
}

function runner(input: Awaited<ReturnType<typeof authorizedFixture>>, connector: InstrumentedConnector) {
  return new ReferenceDelegatedRunner({
    db: input.db,
    workspaceId: input.workspaceId,
    principalId: input.worker.id,
    runnerId: "reference-runner",
    configurationDigest: `sha256:${"c".repeat(64)}`,
    clock: input.clock,
    permitIssuer: permitAuth,
    connectors: [connector],
  });
}

function noEffectSettlementPolicy(input: {
  buyer: string;
  worker: string;
  classification: "full" | "rework";
}): SettlementPolicyV1 {
  return {
    contractVersion: "tasq.settlement-policy.v1",
    policyUri: "https://example.test/policies/runner-settlement/v1",
    policyVersion: 1,
    implementationDigest: `sha256:${"9".repeat(64)}`,
    rules: [{
      id: "attempt-succeeded",
      when: {
        taskStatuses: [], anyAttemptStatuses: ["succeeded"], validationOutcomes: [],
        validationReasonCodes: [], anyEffectStatuses: [],
      },
      classification: input.classification,
      entitlements: [{
        id: "follow-up",
        obligorPrincipalId: input.buyer,
        beneficiaryPrincipalId: input.worker,
        task: {
          title: input.classification === "full" ? "Acknowledge settlement" : "Perform recourse",
          description: null, successCriteria: "Follow-up is evidenced", dueAt: null, metadata: {},
        },
        effect: null,
      }],
    }],
  };
}

describe("TQ-629 reference delegated-action runner", () => {
  test("releases an event cursor only after handling and resumes the same delivery after restart", async () => {
    const handle = await store("outbox");
    const workspaceId = "runner/outbox";
    const clock = createMutableClock(20_000);
    const principal = await createPrincipal(handle.db, {
      tenantId: workspaceId, displayName: "Event runner", kind: "runtime", localAlias: "event-runner",
    }, { tenantId: workspaceId, actor: "admin", clock });
    const seen: string[] = [];
    let fail = true;
    const build = () => new ReferenceDelegatedRunner({
      db: handle.db, workspaceId, principalId: principal.id, runnerId: "event-runner",
      configurationDigest: `sha256:${"e".repeat(64)}`, clock, permitIssuer: permitAuth,
      connectors: [],
      eventHandler: async ({ event, idempotencyKey }) => {
        seen.push(`${event.id}:${idempotencyKey}`);
        if (fail) throw new Error("simulated process crash");
      },
    });
    const first = build();
    await first.start();
    await createCommitment(handle.db, { title: "Wake runner" }, {
      workspaceId, actor: "event-runner", principalId: principal.id, clock,
    });
    expect(await first.processNextEvent()).toBe("retry");
    const pending = await listDeliveryOutbox(handle.db, { tenantId: workspaceId, sinkId: "event-runner" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");

    fail = false;
    clock.advance(1_001);
    const restarted = build();
    await restarted.start();
    expect(await restarted.processNextEvent()).toBe("delivered");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect((await listDeliveryOutbox(handle.db, {
      tenantId: workspaceId, sinkId: "event-runner", status: "delivered",
    }))).toHaveLength(1);
    await handle.close();
  });

  test("records unknown outcome once and performs provider lookup, never blind redispatch, after restart", async () => {
    const fixture = await authorizedFixture("lookup");
    const connector = new InstrumentedConnector();
    connector.loseResponse = true;
    const first = runner(fixture, connector);
    const unknown = await first.runEffect(fixture.authorized.id, {
      claimId: fixture.claim.id, fence: fixture.claim.fence,
    });
    expect(unknown).toMatchObject({ action: "dispatched", effect: { status: "indeterminate" } });
    expect(connector.dispatches).toBe(1);

    const restarted = runner(fixture, connector);
    const recovered = await restarted.runEffect(fixture.authorized.id);
    expect(recovered).toMatchObject({ action: "looked_up", effect: { status: "committed" } });
    expect(connector.dispatches).toBe(1);
    expect(connector.lookups).toBe(1);
    expect(await listEffects(fixture.db, {
      tenantId: fixture.workspaceId, taskId: fixture.commitment.id,
    })).toHaveLength(1);
    await fixture.close();
  });

  test("stops at the last live-fence read when authority is revoked before connector I/O", async () => {
    const fixture = await authorizedFixture("fence");
    const connector = new InstrumentedConnector();
    const instance = runner(fixture, connector);
    connector.onBeforeIo = () => releaseTaskClaim(fixture.db, fixture.commitment.id, {
      tenantId: fixture.workspaceId, principalId: fixture.worker.id, actor: "runner-worker",
      expectedRevision: fixture.claim.revision, clock: fixture.clock,
    }).then(() => {});
    await expect(instance.runEffect(fixture.authorized.id, {
      claimId: fixture.claim.id, fence: fixture.claim.fence,
    })).rejects.toThrow(/live claim fence/);
    expect(connector.dispatches).toBe(0);
    expect((await getEffect(fixture.db, fixture.authorized.id, fixture.workspaceId))?.status).toBe("executing");
    await fixture.close();
  });

  test("materializes one settlement and one recourse root across runner replay", async () => {
    const handle = await store("recourse");
    const workspaceId = "runner/recourse";
    const clock = createMutableClock(40_000);
    const buyer = await createLocalTasq({
      url: handle.url, workspaceId, actor: "buyer", clock, wal: false,
    });
    const worker = await createLocalTasq({
      url: handle.url, workspaceId, actor: "worker", clock, wal: false,
    });
    try {
      const terms: AgreementTermsV1 = {
        contractVersion: "tasq.agreement-terms.v1",
        title: "Runner recourse proof",
        purposeUri: "https://example.test/purposes/runner-recourse/v1",
        parties: [
          { principalId: buyer.principalId, roleUri: "https://example.test/roles/buyer" },
          { principalId: worker.principalId, roleUri: "https://example.test/roles/worker" },
        ].sort((left, right) => left.principalId.localeCompare(right.principalId)),
        obligations: [
          {
            id: "perform",
            obligorPrincipalId: worker.principalId,
            beneficiaryPrincipalId: buyer.principalId,
            commitment: {
              title: "Perform delegated action", description: null,
              successCriteria: "Attempt result is recorded", notBefore: null, dueAt: null,
              priority: null, metadata: {},
            },
            resolutionPolicy: {
              criteria: [{
                id: "performed", statement: "Action was performed", minimumEvidenceCount: 1,
                acceptedEvidenceKinds: [], acceptedSources: [], minimumAuthenticity: "unverified",
                maxAgeMs: null, minimumRetentionMs: 0, evaluatorInput: {},
              }],
              policyKind: "deterministic", policyUri: "https://example.test/policies/outcome/v1",
              policyVersion: 1, implementationDigest: `sha256:${"8".repeat(64)}`,
              notBefore: null, challengeWindowMs: 0, allowSelfValidation: false,
              eligibleValidatorPrincipalIds: [], adjudicatorPrincipalIds: [], metadata: {},
            },
          },
          {
            id: "settle",
            obligorPrincipalId: buyer.principalId,
            beneficiaryPrincipalId: worker.principalId,
            commitment: {
              title: "Acknowledge settlement", description: null,
              successCriteria: "Settlement is recorded", notBefore: null, dueAt: null,
              priority: null, metadata: {},
            },
            resolutionPolicy: {
              criteria: [{
                id: "settled", statement: "Settlement was recorded", minimumEvidenceCount: 1,
                acceptedEvidenceKinds: [], acceptedSources: [], minimumAuthenticity: "unverified",
                maxAgeMs: null, minimumRetentionMs: 0, evaluatorInput: {},
              }],
              policyKind: "deterministic", policyUri: "https://example.test/policies/outcome/v1",
              policyVersion: 1, implementationDigest: `sha256:${"8".repeat(64)}`,
              notBefore: null, challengeWindowMs: 0, allowSelfValidation: false,
              eligibleValidatorPrincipalIds: [], adjudicatorPrincipalIds: [], metadata: {},
            },
          },
        ],
        terms: {},
      };
      const offer = await buyer.agreements.offer({ terms, expiresAt: clock.now() + 60_000 });
      await buyer.agreements.accept(offer.id, offer.termsDigest);
      const accepted = await worker.agreements.accept(offer.id, offer.termsDigest);
      const source = accepted.activation!.compilations.find(({ obligationId }) => obligationId === "perform")!;
      const started = await worker.attempts.start(source.commitmentId, { runtime: "field-runner" });
      const succeeded = await worker.attempts.transition(started.id, "succeeded", {
        expectedRevision: started.revision,
      });
      const reference = new ReferenceDelegatedRunner({
        db: handle.db, workspaceId, principalId: buyer.principalId,
        runnerId: "settlement-runner", configurationDigest: `sha256:${"7".repeat(64)}`,
        clock, permitIssuer: permitAuth, connectors: [],
      });
      const settlementInput = {
        agreementOfferId: offer.id, obligationId: "perform", attemptIds: [succeeded.id],
        validationDecisionId: null, effectIds: [], priorSettlementDecisionId: null,
        supersedesDecisionId: null,
        policy: noEffectSettlementPolicy({
          buyer: buyer.principalId, worker: worker.principalId, classification: "full",
        }),
      };
      const first = await reference.materializeSettlementOrRecourse(settlementInput);
      expect(await reference.materializeSettlementOrRecourse(settlementInput)).toEqual(first);
      expect(first.materializations).toHaveLength(1);

      const recourseInput = {
        ...settlementInput,
        priorSettlementDecisionId: first.decision.id,
        policy: noEffectSettlementPolicy({
          buyer: buyer.principalId, worker: worker.principalId, classification: "rework",
        }),
      };
      const recourse = await reference.materializeSettlementOrRecourse(recourseInput);
      expect(await reference.materializeSettlementOrRecourse(recourseInput)).toEqual(recourse);
      expect(recourse.decision.decisionKind).toBe("recourse");
      expect(recourse.materializations).toHaveLength(1);
      expect(await buyer.settlement.list()).toHaveLength(2);
    } finally {
      await worker.close();
      await buyer.close();
      await handle.close();
    }
  });

  test("rebuilds bounded assignment, eligibility and custody attention without shadow state", async () => {
    const handle = await store("inbox");
    const workspaceId = "runner/inbox";
    const clock = createMutableClock(30_000);
    const assigner = await createPrincipal(handle.db, {
      tenantId: workspaceId, displayName: "Assigner", kind: "agent", localAlias: "assigner",
    }, { tenantId: workspaceId, actor: "admin", clock });
    const assignee = await createPrincipal(handle.db, {
      tenantId: workspaceId, displayName: "Assignee", kind: "human", localAlias: "assignee",
    }, { tenantId: workspaceId, actor: "admin", clock });
    const commitment = await createCommitment(handle.db, { title: "Inspect site" }, {
      workspaceId, actor: "assigner", principalId: assigner.id, clock,
    });
    const assignment = await proposeAssignment(handle.db, {
      tenantId: workspaceId, taskId: commitment.id,
      assignerPrincipalId: assigner.id,
      assigneePrincipalId: assignee.id, role: "owner",
    }, { tenantId: workspaceId, principalId: assigner.id, actor: "assigner", clock });
    const custody = {
      id: "custody:candidate:one", kind: "custody" as const, severity: "critical" as const,
      recordType: "custody_handoff", recordId: "candidate:one", commitmentId: commitment.id,
      reasonCode: "custody_conflict", explanation: "Experimental custody conflict.", observedAt: clock.now(),
    };
    const before = await buildReviewInbox(handle.db, {
      workspaceId, clock, limit: 10, scanLimit: 10,
      projectCustodyAttention: async () => [custody],
    });
    expect(before.items.map(({ kind }) => kind)).toEqual(["custody", "assignment_acceptance"]);

    await acceptAssignment(handle.db, assignment.id, {
      tenantId: workspaceId, principalId: assignee.id, actor: "assignee",
      expectedRevision: assignment.revision, clock,
    });
    const after = await buildReviewInbox(handle.db, {
      workspaceId, clock, limit: 10, scanLimit: 10,
      evaluateEligibility: async () => ({
        contractVersion: "tasq.attestation-eligibility-decision.v1",
        workspaceId,
        subject: { typeUri: "https://example.test/subjects/principal", id: assignee.id, digest: null },
        authorityTime: clock.now(), outcome: "ineligible",
        basisAttestationIds: [], unsatisfiedRequirementIndexes: [0],
        assurance: {
          issuerAuthentication: "not_asserted_by_eligibility", claimTruth: "not_asserted",
          authority: "not_granted", availability: "not_asserted",
        },
      }),
      projectCustodyAttention: async () => [],
    });
    expect(after.items.map(({ kind }) => kind)).toEqual(["eligibility"]);
    expect(after.assurance).toEqual({
      derivedOnly: true, persistedShadowState: false, authorityGranted: false,
    });
    await handle.close();
  });
});
