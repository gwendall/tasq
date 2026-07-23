import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CONFORMANCE_PROTOCOL,
  assertConnectorConformance,
  canonicalEffectPermitPayload,
  createHmacEffectPermitAuthenticator,
  runConnectorConformance,
  type EffectConnectorConformanceProbe,
} from "@tasq-run/extension-sdk";
import {
  EffectReceiptReport,
  canonicalizeEffectJson,
  createMutableClock,
  deriveEffectDispatchKey,
  prepareEffectRequest,
  type EffectDispatchPermit,
  type EffectDispatchPermitPayload,
  type EffectReceiptReport as EffectReceiptReportT,
} from "@tasq-run/schema";
import {
  PROVIDER_RECEIPT_COVERAGE,
  ProviderOutcomeUnknownError,
  WORK_ITEM_COMMENT_CONTRACT_DIGEST,
  WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
  WORK_ITEM_COMMENT_OPERATION_URI,
  bindVerifiedEffectReceipt,
  createFetchWorkItemProviderClient,
  createHmacProviderReceiptAuthenticator,
  createReferenceWorkItemEffectConnector,
  createReferenceWorkItemReadConnector,
  sha256,
  type ProviderCommentReceipt,
  type ProviderCommentReceiptPayload,
  type ProviderWorkItemSnapshot,
  type WorkItemProviderClient,
} from "../src/index.js";

const A = "a".repeat(64);
const BINDING_DIGEST = `sha256:${"b".repeat(64)}`;
const INSTANCE_REF = "connector:reference-work-items:test-account";
const ACCOUNT_REF = "test-account";
const PROJECT_REF = "robotics";
const ITEM_REF = "issue-42";
const BODY = "Calibration completed; evidence attached.";
const BODY_BYTES = new TextEncoder().encode(BODY);
const BODY_DIGEST = sha256(BODY_BYTES);
const PERMIT_AUTH = createHmacEffectPermitAuthenticator("permit-key:1", "p".repeat(32));
const RECEIPT_AUTH = createHmacProviderReceiptAuthenticator("provider-key:1", "r".repeat(32));

function receiptFor(
  permit: EffectDispatchPermit,
  overrides: Partial<ProviderCommentReceiptPayload> = {},
): ProviderCommentReceipt {
  const payload: ProviderCommentReceiptPayload = {
    accountRef: ACCOUNT_REF,
    projectRef: PROJECT_REF,
    itemRef: ITEM_REF,
    dispatchIdempotencyKey: permit.payload.dispatchIdempotencyKey,
    requestDigest: permit.payload.requestDigest,
    providerOperationId: `comment:${permit.payload.effectId}`,
    outcome: "committed",
    occurredAt: 11_000,
    receiptId: `receipt:${permit.payload.effectId}`,
    rawRef: `https://provider.example/receipts/${permit.payload.effectId}`,
    coverage: [...PROVIDER_RECEIPT_COVERAGE],
    ...overrides,
  };
  return { payload, proof: RECEIPT_AUTH.sign(payload) };
}

function reportFor(
  permit: EffectDispatchPermit,
  receipt: ProviderCommentReceipt,
): EffectReceiptReportT {
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
    externalReceiptId: receipt.payload.receiptId,
    providerOperationId: receipt.payload.providerOperationId,
    outcome: receipt.payload.outcome,
    occurredAt: receipt.payload.occurredAt,
    rawRef: receipt.payload.rawRef,
    rawDigest: sha256(canonicalizeEffectJson(receipt)),
    payload: {
      connectorContract: "tasq.reference-work-item-comment.v1",
      providerReceipt: { payload: receipt.payload, proof: receipt.proof },
    },
    resolvesReceiptId: null,
  });
}

function permit(effectId: string): EffectDispatchPermit {
  const prepared = prepareEffectRequest({
    protocol: "tasq.effect-request.v1",
    canonicalization: "tasq.jcs-safe-integer.v1",
    digestAlgorithm: "sha-256",
    workspaceId: "workspace:test",
    effectTypeUri: WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
    effectSchemaVersion: 1,
    connector: {
      operationUri: WORK_ITEM_COMMENT_OPERATION_URI,
      operationVersion: 1,
      contractDigest: WORK_ITEM_COMMENT_CONTRACT_DIGEST,
      instanceRef: INSTANCE_REF,
      bindingDigest: BINDING_DIGEST,
    },
    parameters: {
      providerAccountRef: ACCOUNT_REF,
      projectRef: PROJECT_REF,
      itemRef: ITEM_REF,
      bodyRef: "urn:artifact:comment-body:1",
      bodyDigest: BODY_DIGEST,
      bodyBytes: BODY_BYTES.byteLength,
    },
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
      scope: {
        providerAccountRef: ACCOUNT_REF,
        projectRef: PROJECT_REF,
        itemRef: ITEM_REF,
        bodyDigest: BODY_DIGEST,
      },
      limits: { maxBodyBytes: 1_024 },
      validFrom: 9_000,
      expiresAt: 20_000,
      verificationLevel: "cryptographic",
      verificationMethod: "test-approval-signature",
      verification: { keyId: "approver-key:1" },
      decidedAt: 9_000,
    },
    claim: {
      id: "01900000-0000-7000-8000-000000000013",
      fence: 7,
      principalId: "principal:worker",
      expiresAt: 15_000,
    },
    executionStartedAt: 10_000,
  };
  return {
    payload,
    authentication: {
      algorithm: PERMIT_AUTH.algorithm,
      keyId: PERMIT_AUTH.keyId,
      signature: PERMIT_AUTH.sign(canonicalEffectPermitPayload(payload)),
    },
  };
}

class InstrumentedProvider implements WorkItemProviderClient {
  snapshot: ProviderWorkItemSnapshot = {
    accountRef: ACCOUNT_REF,
    projectRef: PROJECT_REF,
    itemRef: ITEM_REF,
    version: "v1",
    state: "open",
    title: "Private customer title",
    updatedAt: 9_500,
    recordRef: "https://provider.example/projects/robotics/items/issue-42",
  };
  readonly operations = new Map<string, ProviderCommentReceipt>();
  loseNextResponse = false;

  async readWorkItem(): Promise<ProviderWorkItemSnapshot> {
    return structuredClone(this.snapshot);
  }

  async createComment(input: Parameters<WorkItemProviderClient["createComment"]>[0]): Promise<ProviderCommentReceipt> {
    const prior = this.operations.get(input.dispatchIdempotencyKey);
    if (prior) return structuredClone(prior);
    const fakePermit = permitsByDispatch.get(input.dispatchIdempotencyKey);
    if (!fakePermit) throw new Error("Unknown test dispatch identity");
    const receipt = receiptFor(fakePermit);
    this.operations.set(input.dispatchIdempotencyKey, receipt);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new ProviderOutcomeUnknownError(input.dispatchIdempotencyKey, "response lost after commit");
    }
    return structuredClone(receipt);
  }

  async lookupComment(dispatchIdempotencyKey: string): Promise<ProviderCommentReceipt | null> {
    const value = this.operations.get(dispatchIdempotencyKey);
    return value ? structuredClone(value) : null;
  }
}

const permitsByDispatch = new Map<string, EffectDispatchPermit>();

function effectHarness(provider = new InstrumentedProvider()) {
  const clock = createMutableClock(11_000);
  const connector = createReferenceWorkItemEffectConnector({
    instanceRef: INSTANCE_REF,
    bindingDigest: BINDING_DIGEST,
    providerIssuerUri: "https://provider.example",
    providerAccountRef: ACCOUNT_REF,
    providerAudience: "work-items:test-account",
    providerIdempotencyRetentionMs: 86_400_000,
    maxBodyBytes: 1_024,
    client: provider,
    receiptVerifier: RECEIPT_AUTH,
    permitVerifier: PERMIT_AUTH,
    clock,
    resolveBody: () => BODY_BYTES,
  });
  return { connector, provider, clock };
}

function effectProbe(
  connector: ReturnType<typeof createReferenceWorkItemEffectConnector>,
  provider: InstrumentedProvider,
  clock: ReturnType<typeof createMutableClock>,
): EffectConnectorConformanceProbe {
  const valid = permit("01900000-0000-7000-8000-000000000001");
  const uncertain = permit("01900000-0000-7000-8000-000000000002");
  permitsByDispatch.set(valid.payload.dispatchIdempotencyKey, valid);
  permitsByDispatch.set(uncertain.payload.dispatchIdempotencyKey, uncertain);
  const mutated = structuredClone(valid);
  mutated.payload.request.parameters.bodyDigest = `sha256:${A}`;
  const validReport = reportFor(valid, receiptFor(valid));
  const forged = structuredClone(validReport);
  const forgedReceipt = (forged.payload.providerReceipt as Record<string, unknown>);
  (forgedReceipt.proof as Record<string, unknown>).signature = "x".repeat(43);

  const wrongReceipt = receiptFor(valid, { accountRef: "other-account" });
  const wrongAccount = reportFor(valid, wrongReceipt);
  const partialReceipt = receiptFor(valid, { coverage: ["outcome"] });
  const insufficient = reportFor(valid, partialReceipt);

  return {
    operationUri: WORK_ITEM_COMMENT_OPERATION_URI,
    operationVersion: 1,
    validInput: valid,
    mutatedInput: mutated,
    uncertainInput: uncertain,
    claimExpiresAt: valid.payload.claim.expiresAt,
    providerOperationCount: () => provider.operations.size,
    async dispatch(input, options) {
      clock.set(options.now);
      if (options.loseResponseAfterProviderCommit) provider.loseNextResponse = true;
      return connector.dispatch(input);
    },
    lookup: (_dispatchIdempotencyKey, options) => {
      clock.set(options.now);
      return connector.lookup(uncertain);
    },
    verifyReceipt: (report) => connector.verifyReceipt(report),
    forgedReceipt: forged,
    wrongAccountReceipt: wrongAccount,
    insufficientCoverageReceipt: insufficient,
  };
}

describe("TQ-306 reference connectors", () => {
  test("read connector emits a replay-stable, secret-minimized observation and passes conformance", async () => {
    const provider = new InstrumentedProvider();
    const connector = createReferenceWorkItemReadConnector({
      instanceRef: "connector:reference-work-item-reader:test-account",
      bindingDigest: BINDING_DIGEST,
      providerIssuerUri: "https://provider.example",
      providerAccountRef: ACCOUNT_REF,
      providerAudience: "work-items:test-account",
      client: provider,
    });
    const input = { projectRef: PROJECT_REF, itemRef: ITEM_REF };
    const exact = await connector.observe(input);
    const replay = await connector.observe(input);
    provider.snapshot.state = "closed";
    const conflict = await connector.observe(input);

    expect(replay).toEqual(exact);
    expect(conflict.externalEventId).toBe(exact.externalEventId);
    expect(conflict.digest).not.toBe(exact.digest);
    expect(JSON.stringify(exact)).not.toContain(provider.snapshot.title);
    expect(exact.payload.titleDigest).toBe(sha256("Private customer title"));
    expect(connector.profile.protocol).toBe(CONNECTOR_CONFORMANCE_PROTOCOL);

    const report = await runConnectorConformance(connector.profile, {
      observation: {
        exactDelivery: () => exact,
        replayExactDelivery: () => replay,
        conflictingDelivery: () => conflict,
      },
    }, { now: 11_000 });
    expect(report.passed).toBe(true);
    expect(() => assertConnectorConformance(report)).not.toThrow();

    provider.snapshot.projectRef = "a:b";
    provider.snapshot.itemRef = "c";
    const firstAmbiguousTuple = await connector.observe({ projectRef: "a:b", itemRef: "c" });
    provider.snapshot.projectRef = "a";
    provider.snapshot.itemRef = "b:c";
    const secondAmbiguousTuple = await connector.observe({ projectRef: "a", itemRef: "b:c" });
    expect(firstAmbiguousTuple.externalEventId).not.toBe(secondAmbiguousTuple.externalEventId);
  });

  test("effect connector passes the full write, replay, fence, uncertainty and receipt gate", async () => {
    const { connector, provider, clock } = effectHarness();
    const report = await runConnectorConformance(connector.profile, {
      effects: [effectProbe(connector, provider, clock)],
    }, { now: 11_000 });

    expect(
      report.passed,
      JSON.stringify(report.checks.filter((check) => !check.passed), null, 2),
    ).toBe(true);
    expect(report.checks).toHaveLength(12);
    expect(provider.operations.size).toBe(2);
    expect(() => assertConnectorConformance(report)).not.toThrow();
  });

  test("resolved content and pure service receipt binding cannot be changed after verification", async () => {
    const provider = new InstrumentedProvider();
    const value = effectHarness(provider);
    const valid = permit("01900000-0000-7000-8000-000000000003");
    permitsByDispatch.set(valid.payload.dispatchIdempotencyKey, valid);
    const result = await value.connector.dispatch(valid);
    const verified = value.connector.verifyReceipt(result.report);
    const bound = bindVerifiedEffectReceipt(result.report, verified);
    expect(bound.verify({ report: result.report, now: 11_000 })).toEqual(verified);
    const changed = { ...result.report, externalReceiptId: "receipt:changed" };
    expect(() => bound.verify({ report: changed as EffectReceiptReportT, now: 11_000 }))
      .toThrow(/differs/);

    const badBodyConnector = createReferenceWorkItemEffectConnector({
      instanceRef: INSTANCE_REF,
      bindingDigest: BINDING_DIGEST,
      providerIssuerUri: "https://provider.example",
      providerAccountRef: ACCOUNT_REF,
      providerAudience: "work-items:test-account",
      providerIdempotencyRetentionMs: 86_400_000,
      maxBodyBytes: 1_024,
      client: provider,
      receiptVerifier: RECEIPT_AUTH,
      permitVerifier: PERMIT_AUTH,
      clock: createMutableClock(11_000),
      resolveBody: () => "mutated body",
    });
    const before = provider.operations.size;
    await expect(badBodyConnector.dispatch(permit("01900000-0000-7000-8000-000000000004")))
      .rejects.toThrow(/does not match/);
    expect(provider.operations.size).toBe(before);
  });

  test("fetch provider pins origin, resolves credentials late and refuses redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const snapshot = {
      accountRef: ACCOUNT_REF,
      projectRef: PROJECT_REF,
      itemRef: ITEM_REF,
      version: "v1",
      state: "open",
      title: "Bounded title",
      updatedAt: 9_500,
      recordRef: "https://provider.example/projects/robotics/items/issue-42",
    };
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createFetchWorkItemProviderClient({
      baseUrl: "https://provider.example/api/",
      accountRef: ACCOUNT_REF,
      credentialRef: "secret:provider:test-account",
      resolveCredential: (reference) => {
        expect(reference).toBe("secret:provider:test-account");
        return "raw-token-must-not-escape";
      },
      fetch: fetcher,
    });
    const result = await client.readWorkItem({ projectRef: PROJECT_REF, itemRef: ITEM_REF });
    expect(result).toEqual(snapshot);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://provider.example/v1/projects/robotics/items/issue-42");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer raw-token-must-not-escape");
    expect(JSON.stringify(result)).not.toContain("raw-token-must-not-escape");

    let redirectCalls = 0;
    const redirecting = createFetchWorkItemProviderClient({
      baseUrl: "https://provider.example",
      accountRef: ACCOUNT_REF,
      credentialRef: "secret:provider:test-account",
      resolveCredential: () => "raw-token-must-not-escape",
      fetch: (async () => {
        redirectCalls += 1;
        return new Response(null, { status: 302, headers: { location: "https://attacker.example" } });
      }) as typeof fetch,
    });
    await expect(redirecting.readWorkItem({ projectRef: PROJECT_REF, itemRef: ITEM_REF }))
      .rejects.toThrow(/redirects are refused/);
    expect(redirectCalls).toBe(1);
  });

  test("fetch effect sends one pinned idempotent request and degrades unproved HTTP outcomes to lookup-only", async () => {
    const valid = permit("01900000-0000-7000-8000-000000000005");
    const providerReceipt = receiptFor(valid);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchClient = createFetchWorkItemProviderClient({
      baseUrl: "https://provider.example",
      accountRef: ACCOUNT_REF,
      credentialRef: "secret:provider:test-account",
      resolveCredential: () => "raw-token-must-not-escape",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify(providerReceipt), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const connector = createReferenceWorkItemEffectConnector({
      instanceRef: INSTANCE_REF,
      bindingDigest: BINDING_DIGEST,
      providerIssuerUri: "https://provider.example",
      providerAccountRef: ACCOUNT_REF,
      providerAudience: "work-items:test-account",
      providerIdempotencyRetentionMs: 86_400_000,
      maxBodyBytes: 1_024,
      client: fetchClient,
      receiptVerifier: RECEIPT_AUTH,
      permitVerifier: PERMIT_AUTH,
      clock: createMutableClock(11_000),
      resolveBody: () => BODY_BYTES,
    });
    const result = await connector.dispatch(valid);
    expect(result.outcome).toBe("committed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://provider.example/v1/projects/robotics/items/issue-42/comments");
    expect(calls[0]!.init.redirect).toBe("manual");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("idempotency-key")).toBe(valid.payload.dispatchIdempotencyKey);
    expect(headers.get("authorization")).toBe("Bearer raw-token-must-not-escape");
    expect(JSON.stringify(result)).not.toContain("raw-token-must-not-escape");

    const uncertainPermit = permit("01900000-0000-7000-8000-000000000006");
    const uncertainClient = createFetchWorkItemProviderClient({
      baseUrl: "https://provider.example",
      accountRef: ACCOUNT_REF,
      credentialRef: "secret:provider:test-account",
      resolveCredential: () => "raw-token-must-not-escape",
      fetch: (async () => new Response("gateway failure", { status: 502 })) as typeof fetch,
    });
    const uncertainConnector = createReferenceWorkItemEffectConnector({
      instanceRef: INSTANCE_REF,
      bindingDigest: BINDING_DIGEST,
      providerIssuerUri: "https://provider.example",
      providerAccountRef: ACCOUNT_REF,
      providerAudience: "work-items:test-account",
      providerIdempotencyRetentionMs: 86_400_000,
      maxBodyBytes: 1_024,
      client: uncertainClient,
      receiptVerifier: RECEIPT_AUTH,
      permitVerifier: PERMIT_AUTH,
      clock: createMutableClock(11_000),
      resolveBody: () => BODY_BYTES,
    });
    const uncertain = await uncertainConnector.dispatch(uncertainPermit);
    expect(uncertain).toMatchObject({
      outcome: "indeterminate",
      dispatchIdempotencyKey: uncertainPermit.payload.dispatchIdempotencyKey,
      providerOperationId: null,
      report: { outcome: "indeterminate" },
    });
  });
});
