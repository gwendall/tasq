import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalTasq,
  exportPortableStore,
  importPortableStore,
  openDb,
} from "@tasq-run/core";
import { createMutableClock } from "@tasq-run/schema";
import { ExperimentalCustodyStore } from "@tasq-internal/custody";
import {
  CERTIFIED_SCENARIO_DOMAINS,
  PHYSICAL_VERIFICATION_PROFILE,
  certifyDelegatedActionScenario,
  compileDelegatedActionOrder,
  type DelegatedActionScenarioTraceV1,
  type ScenarioFailureCode,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(name: string) {
  const value = mkdtempSync(join(tmpdir(), `tasq-profile-${name}-`));
  roots.push(value);
  return value;
}

const target = {
  contractVersion: "tasq.target-ref.v1" as const,
  namespace: "https://property.example.test/targets/",
  resourceType: "property_exterior",
  identifier: { form: "plain" as const, value: "property:75011:42" },
  version: "request-7",
  digest: null,
};

function trace(domain: DelegatedActionScenarioTraceV1["domain"]): DelegatedActionScenarioTraceV1 {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const denied = domain === "compromised_agent";
  return {
    contractVersion: "tasq.delegated-action-scenario-trace.v1",
    domain,
    targetDigests: { order: digest, authority: digest, agreement: digest, attempt: digest, evidence: digest },
    authority: denied ? "denied" : "allowed",
    access: "granted",
    attempt: denied ? "not_started" : "succeeded",
    outcome: denied ? "none" : "complete",
    completion: denied ? "blocked" : "done",
    executorPrincipalId: "executor",
    review: denied
      ? { required: true, reviewerPrincipalId: null, decision: "pending" }
      : { required: true, reviewerPrincipalId: "independent-reviewer", decision: "accepted" },
    connectorRoutesOpened: denied ? 0 : 1,
    externalEffect: ["remote_hands", "software_deployment", "procurement"].includes(domain),
    restart: { exactReplay: true, providerLookupBeforeRedispatch: true },
    portable: { coreVerified: true, custodyVerified: domain === "custody" ? true : null },
    custodySuccessorIds: domain === "custody" ? ["successor:one"] : [],
  };
}

describe("TQ-632 provider-neutral delegated-action certification", () => {
  test("binds the machine certificate to every executable domain and evidence path", () => {
    const repository = join(import.meta.dir, "../../..");
    const certificate = JSON.parse(readFileSync(
      join(repository, "docs/contracts/TQ-632_DELEGATED_ACTION_CERTIFICATION.json"), "utf8",
    )) as { status: string; domains: Array<{ id: string; result: string }>; executableEvidence: string[]; nonClaims: string[] };
    const matrix = JSON.parse(readFileSync(
      join(repository, "docs/concepts/PRODUCT_SURFACE_MATRIX.json"), "utf8",
    )) as { surfaces: Array<{ id: string; support: string; mutations: boolean }> };
    expect(certificate.status).toBe("source_certified_private_reference");
    expect(certificate.domains.map(({ id }) => id)).toEqual([...CERTIFIED_SCENARIO_DOMAINS]);
    expect(certificate.domains.every(({ result }) => result.startsWith("passed"))).toBeTrue();
    expect(certificate.executableEvidence.every((path) => existsSync(join(repository, path)))).toBeTrue();
    expect(certificate.nonClaims).toEqual(expect.arrayContaining([
      "no_provider_supply", "no_marketplace", "no_physical_truth_or_outcome_guarantee", "no_remote_effect_enablement",
    ]));
    expect(matrix.surfaces.find(({ id }) => id === "physical_verification_profile")).toEqual(expect.objectContaining({
      support: "reference_only", mutations: false,
    }));
  });

  test("compiles one bounded exterior-verification order without marketplace or provider claims", () => {
    const compiled = compileDelegatedActionOrder(PHYSICAL_VERIFICATION_PROFILE, {
      profileId: PHYSICAL_VERIFICATION_PROFILE.id,
      profileVersion: PHYSICAL_VERIFICATION_PROFILE.version,
      target,
      requesterPrincipalId: "requester",
      executorPrincipalId: "executor",
      notBefore: 1_000,
      dueAt: 61_000,
      externalPermissionRefs: {
        requester_site_authority: "authority:property-manager:7",
        applicable_photography_authority: "authority:exterior-only:7",
      },
      requestedFacts: ["entrance_condition", "posted_notice", "entrance_condition"],
    });
    expect(compiled.commitment).toMatchObject({ completionPolicy: "evidence", validationRequired: true });
    expect(compiled.resolution.independentReviewRequired).toBeTrue();
    expect(compiled.requestedFacts).toEqual(["entrance_condition", "posted_notice"]);
    expect(compiled.nonClaims).toEqual(expect.arrayContaining(["provider_supply", "marketplace", "physical_truth"]));
    expect(JSON.stringify(compiled)).not.toMatch(/taskrabbit|field.?nation|providerId|workerPool/i);
    expect(Object.isFrozen(compiled)).toBeTrue();
    expect(Object.isFrozen(compiled.target.target)).toBeTrue();
    expect(compileDelegatedActionOrder(PHYSICAL_VERIFICATION_PROFILE, {
      profileId: PHYSICAL_VERIFICATION_PROFILE.id,
      profileVersion: PHYSICAL_VERIFICATION_PROFILE.version,
      target,
      requesterPrincipalId: "requester",
      executorPrincipalId: "executor",
      notBefore: 1_000,
      dueAt: 61_000,
      externalPermissionRefs: {
        requester_site_authority: "authority:property-manager:7",
        applicable_photography_authority: "authority:exterior-only:7",
      },
      requestedFacts: ["posted_notice", "entrance_condition"],
    }).orderDigest).toBe(compiled.orderDigest);
    expect(() => compileDelegatedActionOrder(PHYSICAL_VERIFICATION_PROFILE, {
      profileId: PHYSICAL_VERIFICATION_PROFILE.id,
      profileVersion: PHYSICAL_VERIFICATION_PROFILE.version,
      target,
      requesterPrincipalId: "requester",
      executorPrincipalId: "executor",
      notBefore: 1_000,
      dueAt: 61_000,
      externalPermissionRefs: {
        requester_site_authority: "authority:property-manager:7",
        applicable_photography_authority: "authority:exterior-only:7",
        silently_ignored_power: "must-not-disappear",
      },
      requestedFacts: ["entrance_condition"],
    })).toThrow("permissions must match");
  });

  test("passes all six domains through one invariant set", () => {
    expect(CERTIFIED_SCENARIO_DOMAINS.map((domain) => certifyDelegatedActionScenario(trace(domain))))
      .toEqual(CERTIFIED_SCENARIO_DOMAINS.map((domain) => ({
        contractVersion: "tasq.delegated-action-scenario-certification.v1",
        domain,
        passed: true,
        failures: [],
      })));
  });

  test("fails closed on target drift, no access, partial outcome, timeout, revocation and concurrent handoff", () => {
    const digestB = `sha256:${"b".repeat(64)}` as const;
    const mutations: Array<[Partial<DelegatedActionScenarioTraceV1>, ScenarioFailureCode]> = [
      [{ targetDigests: { ...trace("physical_verification").targetDigests, evidence: digestB } }, "target_drift"],
      [{ access: "no_access" }, "no_access_completed"],
      [{ outcome: "partial" }, "partial_or_timeout_completed"],
      [{ attempt: "timed_out" }, "partial_or_timeout_completed"],
      [{ authority: "revoked" }, "denied_action_completed"],
      [{ review: { required: true, reviewerPrincipalId: "executor", decision: "accepted" } }, "independent_review_missing"],
      [{ restart: { exactReplay: false, providerLookupBeforeRedispatch: true } }, "restart_replay_unproven"],
    ];
    for (const [mutation, failure] of mutations) {
      const base = trace("physical_verification");
      const result = certifyDelegatedActionScenario({ ...base, ...mutation });
      expect(result.passed).toBeFalse();
      expect(result.failures).toContain(failure);
    }
    const custody = trace("custody");
    expect(certifyDelegatedActionScenario({ ...custody, custodySuccessorIds: ["one", "two"] }).failures)
      .toContain("concurrent_custody_successors");
    const compromised = trace("compromised_agent");
    expect(certifyDelegatedActionScenario({ ...compromised, connectorRoutesOpened: 1 }).failures)
      .toContain("denied_route_opened");
  });

  test("restarts, replays, independently reviews and imports one physical-verification result", async () => {
    const directory = root("portable-core");
    const url = `file:${join(directory, "source.sqlite")}`;
    const workspaceId = "verification/reference-profile";
    const clock = createMutableClock(3_000_000_000_000);
    let worker = await createLocalTasq({ url, workspaceId, actor: "executor", clock, wal: false });
    const reviewer = await createLocalTasq({ url, workspaceId, actor: "independent-reviewer", clock, wal: false });
    const commitment = await worker.commitments.create({
      title: "Verify one property exterior",
      successCriteria: "Fresh target-bound exterior observation is independently accepted",
      completionPolicy: "evidence",
      validationRequired: true,
    }, { idempotencyKey: "profile:commitment" });
    const contract = await worker.resolution.contracts.create({
      taskId: commitment.id,
      criteria: [{
        id: "fresh-exterior", statement: "Exterior observation is fresh", minimumEvidenceCount: 1,
        acceptedEvidenceKinds: ["captured_outcome"], acceptedSources: [], minimumAuthenticity: "unverified",
        maxAgeMs: null, minimumRetentionMs: 0, evaluatorInput: {},
      }],
      policyKind: "attestation",
      policyUri: "https://tasq.run/policies/physical-verification-review/v1",
      policyVersion: 1,
      implementationDigest: `sha256:${"c".repeat(64)}`,
      notBefore: null,
      challengeWindowMs: 0,
      allowSelfValidation: false,
      eligibleValidatorPrincipalIds: [reviewer.principalId],
      adjudicatorPrincipalIds: [],
      metadata: {},
    }, { idempotencyKey: "profile:contract" });
    const execution = await worker.journeys.claimAndStart({
      commitmentId: commitment.id,
      runtime: "physical-verification-reference",
      idempotencyKey: "profile:execution",
    });
    const submissionInput = {
      commitmentId: commitment.id,
      attemptId: execution.attempt.id,
      expectedAttemptRevision: execution.attempt.revision,
      resolutionContractId: contract.id,
      artifacts: [{
        typeUri: "https://tasq.run/artifacts/exterior-observation/v1", schemaVersion: 1,
        name: "exterior-observation.json", mediaType: "application/json",
        uri: "https://objects.example.test/exterior-observation.json",
        digest: `sha256:${"d".repeat(64)}` as const, inlineDataRef: null, metadata: { redacted: true },
      }],
      evidence: [{
        evidence: {
          kind: "captured_outcome", summary: "Fresh redacted exterior observation",
          uri: "https://objects.example.test/exterior-observation.json",
          digest: `sha256:${"d".repeat(64)}` as const,
          source: "physical-verification-reference", metadata: { targetDigest: `sha256:${"a".repeat(64)}` },
        },
        criterionIds: ["fresh-exterior"],
      }],
      summary: "Exterior evidence submitted for independent review",
      idempotencyKey: "profile:outcome",
    };
    const submitted = await worker.journeys.submitOutcome(submissionInput);
    await worker.close();

    worker = await createLocalTasq({ url, workspaceId, actor: "executor", clock, wal: false });
    const replayedExecution = await worker.journeys.claimAndStart({
      commitmentId: commitment.id,
      runtime: "physical-verification-reference",
      idempotencyKey: "profile:execution",
    });
    expect(replayedExecution.claim.id).toBe(execution.claim.id);
    expect(await worker.journeys.submitOutcome(submissionInput)).toEqual(submitted);
    const evidence = submitted.evidence[0]!;
    await worker.resolution.trust.attest({
      taskId: commitment.id,
      evidenceId: evidence.id,
      authenticity: "unverified",
      authorityUri: "https://tasq.run/authorities/reference-capture/v1",
      authorityVersion: 1,
      authorityDigest: `sha256:${"e".repeat(64)}`,
      reason: "Local source attribution only; no host authenticator is claimed",
      verifiedAt: clock.now(),
      validUntil: null,
      retentionUntil: null,
    }, { idempotencyKey: "profile:trust" });
    await expect(worker.resolution.decisions.attest({
      proposalId: submitted.proposal.id,
      outcome: "accepted",
      reasonCode: "self_review",
      explanation: "Executor cannot independently accept its own outcome",
      supersedesDecisionId: null,
    }, { idempotencyKey: "profile:self-review" })).rejects.toThrow();
    const decision = await reviewer.resolution.decisions.attest({
      proposalId: submitted.proposal.id,
      outcome: "accepted",
      reasonCode: "evidence_satisfies_contract",
      explanation: "Independent reviewer matched exact evidence to the frozen criterion",
      supersedesDecisionId: null,
    }, { idempotencyKey: "profile:independent-review" });
    const current = await worker.commitments.get(commitment.id);
    const done = await worker.commitments.complete(commitment.id, {
      expectedRevision: current!.revision,
      validationDecisionId: decision.id,
      idempotencyKey: "profile:complete",
    });
    expect(done.status).toBe("done");
    await reviewer.close();
    await worker.close();

    const source = await openDb({ url, wal: false });
    const exported = await exportPortableStore(source.client, workspaceId, { now: clock.now() });
    await source.close();
    const importedPath = join(directory, "imported.sqlite");
    await importPortableStore(exported.document, importedPath, exported.sha256, clock.now());
    const imported = await createLocalTasq({
      url: `file:${importedPath}`, workspaceId, actor: "portable-reader", clock, wal: false,
    });
    expect(await imported.commitments.get(commitment.id)).toMatchObject({ status: "done" });
    expect((await imported.resolution.decisions.list(submitted.proposal.id))[0]).toMatchObject({
      id: decision.id, decidedByPrincipalId: reviewer.principalId,
    });
    await imported.close();
  });

  test("imports the same exact custody successor lineage separately from Core portability", async () => {
    const directory = root("portable-custody");
    const clock = createMutableClock(10_000);
    const source = await ExperimentalCustodyStore.open({ url: `file:${join(directory, "source-custody.sqlite")}`, clock });
    const workspaceId = "verification/custody";
    const state = await source.establish({
      target, custodianPrincipalId: "executor", condition: { state: "camera_in_case" },
      evidenceRefs: ["evidence:initial"], effectiveAt: 9_000,
    }, { workspaceId, actorPrincipalId: "executor", idempotencyKey: "custody:establish" });
    const handoff = await source.offer({
      targetDigest: state.targetDigest, sourceStateId: state.id, toPrincipalId: "reviewer",
      condition: { state: "camera_in_case" }, evidenceRequirements: ["serial_photo"], expiresAt: 20_000,
    }, { workspaceId, actorPrincipalId: "executor", idempotencyKey: "custody:offer" });
    const accepted = await source.accept(handoff.id, {
      expectedRevision: 1, conditionDigest: handoff.conditionDigest,
      acceptanceEvidence: [{ requirement: "serial_photo", evidenceRef: "evidence:serial" }], effectiveAt: 10_000,
    }, { workspaceId, actorPrincipalId: "reviewer", idempotencyKey: "custody:accept" });
    const packet = await source.exportPortable(workspaceId, 11_000);
    source.close();
    const destination = await ExperimentalCustodyStore.open({ url: `file:${join(directory, "imported-custody.sqlite")}`, clock });
    await destination.importPortable(packet);
    expect((await destination.current(workspaceId, state.targetDigest))?.currentState.id).toBe(accepted.state.id);
    destination.close();
  });
});
