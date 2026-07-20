import { describe, expect, test } from "bun:test";
import {
  EFFECT_REQUEST_CANONICALIZATION,
  EFFECT_REQUEST_DIGEST_ALGORITHM,
  EFFECT_REQUEST_PROTOCOL,
  EFFECT_RECEIPT_COVERAGE,
  EFFECT_RECEIPT_PROTOCOL,
  EffectReceipt,
  EffectReceiptReport,
  canonicalizeEffectJson,
  deriveEffectDispatchKey,
  prepareEffectRequest,
  prepareEffectReceiptReport,
  type EffectRequestEnvelope,
} from "../src/effects.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const EFFECT_ID = "01900000-0000-7000-8000-000000000001";
const SECOND_EFFECT_ID = "01900000-0000-7000-8000-000000000002";

function request(overrides: Partial<EffectRequestEnvelope> = {}): EffectRequestEnvelope {
  return {
    protocol: EFFECT_REQUEST_PROTOCOL,
    canonicalization: EFFECT_REQUEST_CANONICALIZATION,
    digestAlgorithm: EFFECT_REQUEST_DIGEST_ALGORITHM,
    workspaceId: "workspace:test",
    effectTypeUri: "https://schemas.tasq.dev/effects/money-transfer",
    effectSchemaVersion: 1,
    connector: {
      operationUri: "https://schemas.tasq.dev/connectors/mercury/transfer",
      operationVersion: 1,
      contractDigest: `sha256:${A}`,
      instanceRef: "connector:mercury:primary",
      bindingDigest: `sha256:${B}`,
    },
    parameters: {
      amountMinor: 5_800,
      currency: "EUR",
      recipientRef: "recipient:alice",
    },
    secretBindings: [],
    ...overrides,
  };
}

describe("effect request identity", () => {
  test("freezes a language-neutral canonical request and domain-separated digest", () => {
    const prepared = prepareEffectRequest(request());
    expect(prepared.canonicalRequest).toBe(
      `{"canonicalization":"tasq.jcs-safe-integer.v1","connector":{"bindingDigest":"sha256:${B}","contractDigest":"sha256:${A}","instanceRef":"connector:mercury:primary","operationUri":"https://schemas.tasq.dev/connectors/mercury/transfer","operationVersion":1},"digestAlgorithm":"sha-256","effectSchemaVersion":1,"effectTypeUri":"https://schemas.tasq.dev/effects/money-transfer","parameters":{"amountMinor":5800,"currency":"EUR","recipientRef":"recipient:alice"},"protocol":"tasq.effect-request.v1","secretBindings":[],"workspaceId":"workspace:test"}`,
    );
    expect(prepared.requestDigest).toBe(
      "sha256:170041327837b3ec17abfb2af60267265e6dd8c373bc824cc41beb5b3b3ac01d",
    );
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.request.parameters)).toBe(true);
  });

  test("normalizes object and secret-binding order without normalizing meaning", () => {
    const first = prepareEffectRequest(request({
      secretBindings: [
        { name: "signing-key", ref: "secret:key", version: "v3" },
        { name: "attachment", ref: "secret:attachment", version: "v1", contentDigest: `sha256:${A}` },
      ],
    }));
    const second = prepareEffectRequest({
      ...request(),
      parameters: {
        recipientRef: "recipient:alice",
        currency: "EUR",
        amountMinor: 5_800,
      },
      secretBindings: [
        { contentDigest: `sha256:${A}`, version: "v1", ref: "secret:attachment", name: "attachment" },
        { version: "v3", name: "signing-key", ref: "secret:key" },
      ],
    });
    expect(first.canonicalRequest).toBe(second.canonicalRequest);
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.request.secretBindings.map(({ name }) => name)).toEqual(["attachment", "signing-key"]);
  });

  test("meaningful request mutations always change the digest", () => {
    const original = prepareEffectRequest(request()).requestDigest;
    const mutations = [
      request({ parameters: { ...request().parameters, amountMinor: 580_000 } }),
      request({ parameters: { ...request().parameters, recipientRef: "recipient:mallory" } }),
      request({ effectSchemaVersion: 2 }),
      request({ connector: { ...request().connector, operationVersion: 2 } }),
      request({ connector: { ...request().connector, instanceRef: "connector:mercury:other" } }),
      request({ secretBindings: [{ name: "signing-key", ref: "secret:key", version: "v4" }] }),
      request({ workspaceId: "workspace:other" }),
    ];
    for (const mutation of mutations) {
      expect(prepareEffectRequest(mutation).requestDigest).not.toBe(original);
    }
  });

  test("separates content identity from intentional occurrence and dispatch identity", () => {
    const prepared = prepareEffectRequest(request());
    expect(deriveEffectDispatchKey(EFFECT_ID, prepared)).toBe(
      "tqfx1_zY2wH3bu2yKS7TIeQa1R5p-YRJATpaIIpkTnB5GUnWo",
    );
    expect(deriveEffectDispatchKey(EFFECT_ID, prepared)).toBe(deriveEffectDispatchKey(EFFECT_ID, prepared));
    expect(deriveEffectDispatchKey(SECOND_EFFECT_ID, prepared)).not.toBe(
      deriveEffectDispatchKey(EFFECT_ID, prepared),
    );
  });

  test("rejects ambiguous or non-portable JSON values", () => {
    for (const invalid of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, Number.MAX_SAFE_INTEGER + 1, undefined, 1n]) {
      expect(() => canonicalizeEffectJson(invalid)).toThrow();
    }
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalizeEffectJson(sparse)).toThrow(/sparse/);
    expect(() => canonicalizeEffectJson(new Date(0))).toThrow(/plain JSON/);
    expect(() => canonicalizeEffectJson("\ud800")).toThrow(/surrogate/);
    expect(() => canonicalizeEffectJson({ value: undefined })).toThrow(/undefined/);
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const object = JSON.parse(`{"${key}":true}`);
      expect(() => canonicalizeEffectJson(object)).toThrow(/reserved object key/);
    }
  });

  test("rejects unsafe envelopes, duplicate bindings and raw secret fields", () => {
    expect(() => prepareEffectRequest(request({
      secretBindings: [
        { name: "token", ref: "secret:a", version: "1" },
        { name: "token", ref: "secret:b", version: "2" },
      ],
    }))).toThrow(/Duplicate/);
    expect(() => prepareEffectRequest(request({
      parameters: { amount: 1.5 },
    }))).toThrow(/safe integer/);
    expect(() => prepareEffectRequest({
      ...request(),
      secretBindings: [{ name: "token", ref: "secret:a", version: "1", value: "raw-secret" }],
    } as EffectRequestEnvelope)).toThrow();
    expect(() => prepareEffectRequest({ ...request(), surprise: true } as EffectRequestEnvelope)).toThrow();
  });

  test("enforces canonical size and depth limits", () => {
    expect(() => canonicalizeEffectJson("x".repeat(65_536))).toThrow(/canonical bytes/);
    let deep: unknown = null;
    for (let index = 0; index < 34; index += 1) deep = [deep];
    expect(() => canonicalizeEffectJson(deep)).toThrow(/depth/);
  });
});

describe("effect receipt identity", () => {
  const report = {
    protocol: EFFECT_RECEIPT_PROTOCOL,
    workspaceId: "workspace:test",
    effectId: EFFECT_ID,
    requestDigest: `sha256:${A}`,
    dispatchIdempotencyKey: "tqfx1_zY2wH3bu2yKS7TIeQa1R5p-YRJATpaIIpkTnB5GUnWo",
    approvalId: "01900000-0000-7000-8000-000000000003",
    claimId: "01900000-0000-7000-8000-000000000004",
    fence: 3,
    connectorInstanceRef: "connector:mercury:primary",
    connectorBindingDigest: `sha256:${B}`,
    externalReceiptId: "receipt:provider:42",
    providerOperationId: "operation:provider:42",
    outcome: "committed" as const,
    occurredAt: 1_000,
    rawRef: "urn:provider-receipt:42",
    rawDigest: `sha256:${A}`,
    payload: { providerStatus: "posted" },
    resolvesReceiptId: null,
  };

  test("canonicalizes and domain-separates immutable connector reports", () => {
    const prepared = prepareEffectReceiptReport(report);
    expect(prepared.report).toEqual(report);
    expect(prepared.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(prepared.report.payload)).toBe(true);
    expect(prepareEffectReceiptReport({ ...report, payload: { providerStatus: "rejected" } }).receiptDigest)
      .not.toBe(prepared.receiptDigest);
  });

  test("keeps uncertainty honest and terminal verification complete", () => {
    expect(() => EffectReceiptReport.parse({
      ...report,
      outcome: "indeterminate",
      providerOperationId: "operation:claimed-too-early",
    })).toThrow(/must be absent/);

    const prepared = prepareEffectReceiptReport(report);
    const receipt = {
      id: "01900000-0000-7000-8000-000000000005",
      tenantId: report.workspaceId,
      effectId: report.effectId,
      taskId: "01900000-0000-7000-8000-000000000006",
      attemptId: "01900000-0000-7000-8000-000000000007",
      approvalId: report.approvalId,
      evidenceId: "01900000-0000-7000-8000-000000000008",
      report,
      canonicalReport: prepared.canonicalReport,
      receiptDigest: prepared.receiptDigest,
      verificationLevel: "cryptographic" as const,
      verificationMethod: "provider-signature",
      coverage: [...EFFECT_RECEIPT_COVERAGE],
      verification: { keyId: "provider-key:1" },
      recordedByPrincipalId: "principal:connector",
      recordedAt: 1_100,
    };
    expect(EffectReceipt.parse(receipt)).toMatchObject({ effectId: report.effectId });
    expect(() => EffectReceipt.parse({ ...receipt, verificationLevel: "self_asserted" }))
      .toThrow(/independent verification/);
    expect(() => EffectReceipt.parse({ ...receipt, coverage: ["outcome"] }))
      .toThrow(/missing provider_account/);
  });
});
