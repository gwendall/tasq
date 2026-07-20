import { describe, expect, test } from "bun:test";
import {
  deriveEffectDispatchKey,
  prepareEffectRequest,
  type EffectDispatchPermit,
  type EffectDispatchPermitPayload,
} from "@tasq/schema";
import {
  CONNECTOR_CONFORMANCE_PROTOCOL,
  CONNECTOR_FAILURE_PROTOCOL,
  assertConnectorConformance,
  canonicalEffectPermitPayload,
  classifyConnectorFailure,
  createHmacEffectPermitAuthenticator,
  defineConnectorConformanceProfile,
  defineConnectorFailure,
  enforceEffectDispatch,
  runConnectorConformance,
  type ConnectorConformanceProfile,
  type EffectConnectorConformanceProbe,
  type EffectConnectorPolicy,
  type NormalizedConnectorObservation,
} from "../src/index.js";

const authenticator = createHmacEffectPermitAuthenticator("conformance-key", "z".repeat(32));
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const operationUri = "https://connector.example/operations/transfer";

function profile(): ConnectorConformanceProfile {
  return {
    protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
    connectorUri: "https://connector.example/payments",
    connectorVersion: "1.0.0",
    instanceRef: "connector:payments:test",
    bindingDigest: `sha256:${B}`,
    provider: {
      issuerUri: "https://provider.example",
      accountRef: "provider-account:test",
      audience: "https://api.provider.example",
    },
    clock: "injected",
    credentials: "secret_refs_only",
    redirects: "forbid_credential_forwarding",
    observations: {
      deliveryIdentity: "source_external_event_id",
      exactReplay: "return_original",
      conflictingReplay: "reject",
      sourceTime: "provenance_only",
      secretMinimized: true,
      digestBoundRawReference: true,
    },
    effects: [{
      effectTypeUri: "https://connector.example/effects/transfer",
      effectSchemaVersion: 1,
      operationUri,
      operationVersion: 1,
      contractDigest: `sha256:${A}`,
      impact: "write",
      providerIdempotency: {
        mode: "provider_key",
        retentionMs: 86_400_000,
        parameterConflict: "reject",
      },
      autonomousRetry: true,
      uncertainty: {
        timeoutOutcome: "indeterminate",
        blindRetry: false,
        lookup: "by_dispatch_identity",
      },
      receipts: {
        terminalVerification: "cryptographic",
        requiredCoverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
        secretMinimized: true,
        digestBoundRawReference: true,
      },
    }],
  };
}

function request(effectId: string) {
  const prepared = prepareEffectRequest({
    protocol: "tasq.effect-request.v1",
    canonicalization: "tasq.jcs-safe-integer.v1",
    digestAlgorithm: "sha-256",
    workspaceId: "workspace:test",
    effectTypeUri: "https://connector.example/effects/transfer",
    effectSchemaVersion: 1,
    connector: {
      operationUri,
      operationVersion: 1,
      contractDigest: `sha256:${A}`,
      instanceRef: "connector:payments:test",
      bindingDigest: `sha256:${B}`,
    },
    parameters: { amountMinor: 5_800, currency: "EUR", recipient: "alice" },
    secretBindings: [],
  });
  const payload: EffectDispatchPermitPayload = {
    contractVersion: "tasq.effect-dispatch-permit.v1",
    issuedAt: 10_000,
    workspaceId: "workspace:test",
    effectId,
    effectRevision: 3,
    effectStatus: "executing",
    taskId: "01900000-0000-7000-8000-000000000010",
    attemptId: "01900000-0000-7000-8000-000000000011",
    request: prepared.request,
    canonicalRequest: prepared.canonicalRequest,
    requestDigest: prepared.requestDigest,
    dispatchIdempotencyKey: deriveEffectDispatchKey(effectId, prepared),
    approval: {
      id: "01900000-0000-7000-8000-000000000012",
      requestDigest: prepared.requestDigest,
      approverPrincipalId: "principal:approver",
      decision: "approved",
      scope: { accountRef: "provider-account:test" },
      limits: { maxAmountMinor: 5_800 },
      validFrom: 9_000,
      expiresAt: 20_000,
      verificationLevel: "cryptographic",
      verificationMethod: "test-signature",
      verification: { keyId: "approver-key:1" },
      decidedAt: 9_000,
    },
    claim: {
      id: "01900000-0000-7000-8000-000000000013",
      fence: 4,
      principalId: "principal:worker",
      expiresAt: 15_000,
    },
    executionStartedAt: 10_000,
  };
  return {
    payload,
    authentication: {
      algorithm: authenticator.algorithm,
      keyId: authenticator.keyId,
      signature: authenticator.sign(canonicalEffectPermitPayload(payload)),
    },
  } satisfies EffectDispatchPermit;
}

const connectorPolicy: EffectConnectorPolicy = {
  effectTypeUri: "https://connector.example/effects/transfer",
  effectSchemaVersion: 1,
  operationUri,
  operationVersion: 1,
  contractDigest: `sha256:${A}`,
  instanceRef: "connector:payments:test",
  bindingDigest: `sha256:${B}`,
  parseParameters(input) {
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join() !== "amountMinor,currency,recipient" ||
      !Number.isSafeInteger(value.amountMinor) || value.currency !== "EUR" || typeof value.recipient !== "string") {
      throw new Error("invalid transfer parameters");
    }
    return value as { amountMinor: number; currency: string; recipient: string };
  },
  evaluateAuthority(input) {
    const allowed = input.scope.accountRef === "provider-account:test" &&
      Number(input.parameters.amountMinor) <= Number(input.limits.maxAmountMinor);
    return { allowed, reasonCode: allowed ? "allowed" : "denied", explanation: allowed ? "Exact transfer." : "Outside authority." };
  },
};

function observation(status = "settled"): NormalizedConnectorObservation {
  return {
    source: "payments:test",
    externalEventId: "delivery:1",
    typeUri: "https://connector.example/observations/transaction",
    schemaVersion: 1,
    payload: { transactionId: "txn:1", status },
    occurredAt: 9_500,
    verificationLevel: "cryptographic",
    verificationMethod: "provider-signature",
    rawRef: "urn:provider-delivery:1",
    digest: `sha256:${status === "settled" ? A : C}`,
    metadata: { accountRef: "provider-account:test" },
  };
}

function effectProbe(): EffectConnectorConformanceProbe {
  const valid = request("01900000-0000-7000-8000-000000000001");
  const uncertain = request("01900000-0000-7000-8000-000000000002");
  const mutated = structuredClone(valid);
  mutated.payload.request.parameters.amountMinor = 580_000;
  const operations = new Map<string, { id: string; requestDigest: string }>();
  const reportFor = (key: string, operationId: string, overrides: Record<string, unknown> = {}) => ({
    dispatchIdempotencyKey: key,
    providerOperationId: operationId,
    accountRef: "provider-account:test",
    outcome: "committed",
    signature: "valid",
    coverage: "complete",
    ...overrides,
  });
  return {
    operationUri,
    operationVersion: 1,
    validInput: valid,
    mutatedInput: mutated,
    uncertainInput: uncertain,
    claimExpiresAt: valid.payload.claim.expiresAt,
    providerOperationCount: () => operations.size,
    async dispatch(input, options) {
      const accepted = enforceEffectDispatch(input, connectorPolicy, { now: options.now, verifier: authenticator });
      const key = accepted.permit.payload.dispatchIdempotencyKey;
      const prior = operations.get(key);
      const operation = prior ?? { id: `provider-operation:${operations.size + 1}`, requestDigest: accepted.permit.payload.requestDigest };
      if (!prior) operations.set(key, operation);
      if (options.loseResponseAfterProviderCommit) {
        return {
          outcome: "indeterminate",
          dispatchIdempotencyKey: key,
          providerOperationId: null,
          report: { dispatchIdempotencyKey: key, outcome: "indeterminate" },
        };
      }
      return {
        outcome: "committed",
        dispatchIdempotencyKey: key,
        providerOperationId: operation.id,
        report: reportFor(key, operation.id),
      };
    },
    async lookup(key) {
      const operation = operations.get(key);
      if (!operation) throw new Error("provider operation not found");
      return {
        outcome: "committed",
        dispatchIdempotencyKey: key,
        providerOperationId: operation.id,
        report: reportFor(key, operation.id),
      };
    },
    verifyReceipt(input) {
      const value = input as Record<string, unknown>;
      if (value.signature !== "valid" || value.accountRef !== "provider-account:test" || value.coverage !== "complete") {
        throw new Error("receipt verification failed");
      }
      return {
        level: "cryptographic",
        method: "provider-signature",
        coverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
        details: { accountRef: "provider-account:test" },
      };
    },
    forgedReceipt: reportFor("forged", "forged", { signature: "forged" }),
    wrongAccountReceipt: reportFor("wrong-account", "wrong-account", { accountRef: "other-account" }),
    insufficientCoverageReceipt: reportFor("partial", "partial", { coverage: "outcome-only" }),
  };
}

describe("connector conformance contract", () => {
  test("freezes safe capability claims and failure dispositions", () => {
    expect(defineConnectorConformanceProfile(profile())).toMatchObject({
      protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
      clock: "injected",
      credentials: "secret_refs_only",
    });
    expect(classifyConnectorFailure("stale_fence")).toBe("reject_without_provider_attempt");
    expect(classifyConnectorFailure("transient_before_send")).toBe("retry_same_dispatch_identity");
    expect(classifyConnectorFailure("transport_unknown")).toBe("indeterminate_lookup_only");
    expect(classifyConnectorFailure("provider_failed")).toBe("terminal_failed");
    expect(defineConnectorFailure({
      failureClass: "transient_before_send",
      message: "Provider was unavailable before request transmission.",
      providerAttempted: false,
      dispatchIdempotencyKey: "dispatch:1",
      providerOperationId: null,
      retryAfterMs: 1_000,
    })).toEqual({
      protocol: CONNECTOR_FAILURE_PROTOCOL,
      failureClass: "transient_before_send",
      disposition: "retry_same_dispatch_identity",
      message: "Provider was unavailable before request transmission.",
      providerAttempted: false,
      dispatchIdempotencyKey: "dispatch:1",
      providerOperationId: null,
      retryAfterMs: 1_000,
    });
    expect(() => defineConnectorFailure({
      failureClass: "transport_unknown",
      message: "Response lost.",
      providerAttempted: false,
      dispatchIdempotencyKey: "dispatch:1",
      providerOperationId: null,
      retryAfterMs: null,
    })).toThrow(/attempted dispatch/);

    const unsafeRetry = profile();
    unsafeRetry.effects[0]!.providerIdempotency.mode = "none";
    unsafeRetry.effects[0]!.providerIdempotency.retentionMs = null;
    expect(() => defineConnectorConformanceProfile(unsafeRetry)).toThrow(/cannot retry autonomously/);
    const partialReceipt = profile();
    partialReceipt.effects[0]!.receipts.requiredCoverage = ["outcome"];
    expect(() => defineConnectorConformanceProfile(partialReceipt)).toThrow(/cover provider account/);
    const empty = profile();
    empty.observations = null;
    empty.effects = [];
    expect(() => defineConnectorConformanceProfile(empty)).toThrow(/must declare observations/);
  });

  test("passes a read/write connector through the reusable black-box suite", async () => {
    const report = await runConnectorConformance(profile(), {
      observation: {
        exactDelivery: () => observation(),
        replayExactDelivery: () => observation(),
        conflictingDelivery: () => observation("reversed"),
      },
      effects: [effectProbe()],
    }, { now: 11_000 });
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(17);
    expect(report.checks.every((value) => value.passed)).toBe(true);
    expect(() => assertConnectorConformance(report)).not.toThrow();
  });

  test("accepts an honest no-retry operation with manual uncertainty recovery", async () => {
    const manualProfile = profile();
    manualProfile.effects[0]!.providerIdempotency = {
      mode: "none",
      retentionMs: null,
      parameterConflict: "reject",
    };
    manualProfile.effects[0]!.autonomousRetry = false;
    manualProfile.effects[0]!.uncertainty.lookup = "manual_only";
    const manualProbe = effectProbe();
    manualProbe.lookup = undefined;
    const report = await runConnectorConformance(manualProfile, {
      observation: {
        exactDelivery: () => observation(),
        replayExactDelivery: () => observation(),
        conflictingDelivery: () => observation("reversed"),
      },
      effects: [manualProbe],
    }, { now: 11_000 });
    expect(report.passed).toBe(true);
    expect(report.checks.map((value) => value.id)).toEqual(expect.arrayContaining([
      `effect.${operationUri}@1.retry_disabled`,
      `effect.${operationUri}@1.manual_recovery`,
    ]));
  });

  test("reports behavioral failures instead of accepting connector self-claims", async () => {
    const unsafe = effectProbe();
    unsafe.mutatedInput = unsafe.validInput;
    const report = await runConnectorConformance(profile(), {
      observation: {
        exactDelivery: () => observation(),
        replayExactDelivery: () => ({ ...observation(), payload: { transactionId: "txn:1", status: "changed" } }),
        conflictingDelivery: () => observation(),
      },
      effects: [unsafe],
    }, { now: 11_000 });
    expect(report.passed).toBe(false);
    expect(report.checks.filter((value) => !value.passed).map((value) => value.id)).toEqual(expect.arrayContaining([
      "observation.exact_replay",
      "observation.conflict_content",
      `effect.${operationUri}@1.mutation_rejected`,
    ]));
    expect(() => assertConnectorConformance(report)).toThrow(/Connector conformance failed/);
  });

  test("turns probe exceptions and weak receipt verification into failed checks", async () => {
    const weak = effectProbe();
    weak.verifyReceipt = () => ({
      level: "authenticated_context",
      method: "session",
      coverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
      details: {},
    });
    const report = await runConnectorConformance(profile(), {
      observation: {
        exactDelivery: () => { throw new Error("provider offline"); },
        replayExactDelivery: () => observation(),
        conflictingDelivery: () => observation("reversed"),
      },
      effects: [weak],
    }, { now: 11_000 });
    expect(report.passed).toBe(false);
    expect(report.checks.filter((value) => !value.passed).map((value) => value.id)).toEqual(expect.arrayContaining([
      "observation.probe_execution",
      `effect.${operationUri}@1.terminal_receipt`,
    ]));

    const leaking = effectProbe();
    leaking.verifyReceipt = () => ({
      level: "cryptographic",
      method: "provider-signature",
      coverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
      details: { token: "raw-provider-credential" },
    });
    const leakingReport = await runConnectorConformance(profile(), {
      observation: {
        exactDelivery: () => observation(),
        replayExactDelivery: () => observation(),
        conflictingDelivery: () => observation("reversed"),
      },
      effects: [leaking],
    }, { now: 11_000 });
    expect(leakingReport.checks.find((value) => value.id === `effect.${operationUri}@1.terminal_receipt`)?.passed).toBe(false);
  });
});
