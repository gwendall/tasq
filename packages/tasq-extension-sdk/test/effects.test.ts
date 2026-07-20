import { describe, expect, test } from "bun:test";
import {
  createMutableClock,
  deriveEffectDispatchKey,
  prepareEffectRequest,
  type EffectDispatchPermit,
  type EffectDispatchPermitPayload,
} from "@tasq/schema";
import {
  canonicalEffectPermitPayload,
  createHmacEffectPermitAuthenticator,
  enforceEffectDispatch,
  type EffectConnectorPolicy,
} from "../src/index.js";

const effectId = "018f0000-0000-7000-8000-000000000001";
const taskId = "018f0000-0000-7000-8000-000000000002";
const attemptId = "018f0000-0000-7000-8000-000000000003";
const approvalId = "018f0000-0000-7000-8000-000000000004";
const claimId = "018f0000-0000-7000-8000-000000000005";
const authenticator = createHmacEffectPermitAuthenticator("test-key", "x".repeat(32));

function request(amountMinor = 5_800) {
  return {
    protocol: "tasq.effect-request.v1" as const,
    canonicalization: "tasq.jcs-safe-integer.v1" as const,
    digestAlgorithm: "sha-256" as const,
    workspaceId: "workspace-1",
    effectTypeUri: "https://acme.example/effects/transfer",
    effectSchemaVersion: 1,
    connector: {
      operationUri: "https://acme.example/connectors/transfer",
      operationVersion: 1,
      contractDigest: `sha256:${"a".repeat(64)}`,
      instanceRef: "connector:payments:primary",
      bindingDigest: `sha256:${"b".repeat(64)}`,
    },
    parameters: { amountMinor, currency: "EUR", recipientRef: "recipient:alice" },
    secretBindings: [],
  };
}

function policy(maxAmountMinor = 5_800): EffectConnectorPolicy {
  return {
    effectTypeUri: "https://acme.example/effects/transfer",
    effectSchemaVersion: 1,
    operationUri: "https://acme.example/connectors/transfer",
    operationVersion: 1,
    contractDigest: `sha256:${"a".repeat(64)}`,
    instanceRef: "connector:payments:primary",
    bindingDigest: `sha256:${"b".repeat(64)}`,
    parseParameters(input) {
      const value = input as Record<string, unknown>;
      if (!Number.isSafeInteger(value.amountMinor) || typeof value.currency !== "string" ||
        typeof value.recipientRef !== "string" || Object.keys(value).length !== 3) {
        throw new Error("invalid transfer parameters");
      }
      return value as { amountMinor: number; currency: string; recipientRef: string };
    },
    evaluateAuthority(input) {
      const approvedLimit = Number(input.limits.maxAmountMinor ?? 0);
      const amount = Number(input.parameters.amountMinor);
      const allowed = amount <= approvedLimit && amount <= maxAmountMinor &&
        input.scope.connectorInstanceRef === "connector:payments:primary" &&
        input.verificationLevel !== "self_asserted";
      return {
        allowed,
        reasonCode: allowed ? "within_exact_transfer_authority" : "outside_transfer_authority",
        explanation: allowed ? "Transfer matches scope and limits." : "Transfer exceeds or mismatches authority.",
      };
    },
  };
}

function permit(): EffectDispatchPermit {
  const prepared = prepareEffectRequest(request());
  const payload: EffectDispatchPermitPayload = {
    contractVersion: "tasq.effect-dispatch-permit.v1",
    issuedAt: 12_000,
    workspaceId: "workspace-1",
    effectId,
    effectRevision: 3,
    effectStatus: "executing",
    taskId,
    attemptId,
    request: prepared.request,
    canonicalRequest: prepared.canonicalRequest,
    requestDigest: prepared.requestDigest,
    dispatchIdempotencyKey: deriveEffectDispatchKey(effectId, prepared),
    approval: {
      id: approvalId,
      requestDigest: prepared.requestDigest,
      approverPrincipalId: "principal:human:alice",
      decision: "approved",
      scope: { connectorInstanceRef: "connector:payments:primary" },
      limits: { maxAmountMinor: 5_800 },
      validFrom: 11_000,
      expiresAt: 13_000,
      verificationLevel: "authenticated_context",
      verificationMethod: "test-session",
      verification: { sessionRef: "session:1" },
      decidedAt: 11_000,
    },
    claim: {
      id: claimId,
      fence: 7,
      principalId: "principal:agent:worker",
      expiresAt: 12_500,
    },
    executionStartedAt: 12_000,
  };
  return {
    payload,
    authentication: {
      algorithm: authenticator.algorithm,
      keyId: authenticator.keyId,
      signature: authenticator.sign(canonicalEffectPermitPayload(payload)),
    },
  };
}

describe("connector-side effect enforcement", () => {
  test("accepts one exact permit with an injected boundary clock", () => {
    const clock = createMutableClock(12_100);
    const result = enforceEffectDispatch(permit(), policy(), { clock, verifier: authenticator });
    expect(result.permit.payload.effectId).toBe(effectId);
    expect(result.parameters).toEqual({ amountMinor: 5_800, currency: "EUR", recipientRef: "recipient:alice" });
  });

  test("fails closed on missing time, expiry and policy denial", () => {
    expect(() => enforceEffectDispatch(permit(), policy(), { verifier: authenticator })).toThrow(/dispatch now/);
    expect(() => enforceEffectDispatch(permit(), policy(), { now: 12_500, verifier: authenticator })).toThrow(/claim fence expired/);
    expect(() => enforceEffectDispatch(permit(), policy(5_799), { now: 12_100, verifier: authenticator })).toThrow(/outside_transfer_authority/);
  });

  test("rejects request, connector and parser drift at the final boundary", () => {
    const changed = structuredClone(permit());
    changed.payload.request.parameters.amountMinor = 580_000;
    expect(() => enforceEffectDispatch(changed, policy(), { now: 12_100, verifier: authenticator })).toThrow(/authentication failed/);

    const expanded = structuredClone(permit());
    expanded.payload.approval.limits.maxAmountMinor = 580_000;
    expect(() => enforceEffectDispatch(expanded, policy(580_000), {
      now: 12_100,
      verifier: authenticator,
    })).toThrow(/authentication failed/);

    expect(() => enforceEffectDispatch(permit(), {
      ...policy(),
      bindingDigest: `sha256:${"c".repeat(64)}`,
    }, { now: 12_100, verifier: authenticator })).toThrow(/policy binding/);

    expect(() => enforceEffectDispatch(permit(), {
      ...policy(),
      parseParameters: (input) => ({ ...(input as Record<string, unknown>), injected: true }),
    }, { now: 12_100, verifier: authenticator })).toThrow(/changed the approved parameters/);
  });
});
