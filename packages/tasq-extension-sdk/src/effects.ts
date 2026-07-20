/** Pure connector-side enforcement for one exact authorized effect dispatch. */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  EffectDispatchPermit,
  canonicalizeEffectJson,
  deriveEffectDispatchKey,
  prepareEffectRequest,
  type Clock,
  type EffectApproval,
  type EffectDispatchPermit as EffectDispatchPermitT,
  type EffectDispatchPermitPayload,
  type EffectJsonObject,
  type EffectRequestEnvelope,
  type EffectReceiptCoverage,
  type EffectReceiptReport,
} from "@tasq/schema";

export interface VerifiedEffectReceipt {
  level: "self_asserted" | "authenticated_context" | "cryptographic";
  method: string;
  coverage: readonly EffectReceiptCoverage[];
  details: EffectJsonObject;
}

export interface EffectReceiptVerifier {
  /** Pure verification over already-collected connector/provider material. */
  verify(input: { report: EffectReceiptReport; now: number }): VerifiedEffectReceipt;
}

export interface EffectPermitIssuer {
  algorithm: string;
  keyId: string;
  sign(canonicalPayload: string): string;
}

export interface EffectPermitVerifier {
  verify(input: {
    algorithm: string;
    keyId: string;
    canonicalPayload: string;
    signature: string;
  }): boolean;
}

export type EffectPermitAuthenticator = EffectPermitIssuer & EffectPermitVerifier;

export function canonicalEffectPermitPayload(payload: EffectDispatchPermitPayload): string {
  return canonicalizeEffectJson(payload);
}

/** Convenience authenticator for a local composition root; the key is never persisted. */
export function createHmacEffectPermitAuthenticator(
  keyId: string,
  secret: string | Uint8Array,
): EffectPermitAuthenticator {
  if (!keyId.trim()) throw new Error("Effect permit keyId must not be empty");
  const key = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (key.byteLength < 32) throw new Error("Effect permit HMAC secret must contain at least 32 bytes");
  const sign = (canonicalPayload: string) => createHmac("sha256", key)
    .update(canonicalPayload, "utf8").digest("base64url");
  return Object.freeze({
    algorithm: "hmac-sha256",
    keyId,
    sign,
    verify(input: Parameters<EffectPermitVerifier["verify"]>[0]) {
      if (input.algorithm !== "hmac-sha256" || input.keyId !== keyId) return false;
      const expected = Buffer.from(sign(input.canonicalPayload), "utf8");
      const actual = Buffer.from(input.signature, "utf8");
      return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
    },
  });
}

export interface EffectAuthorityDecision {
  allowed: boolean;
  reasonCode: string;
  explanation: string;
}

export interface EffectConnectorPolicy {
  effectTypeUri: string;
  effectSchemaVersion: number;
  operationUri: string;
  operationVersion: number;
  contractDigest: string;
  instanceRef: string;
  bindingDigest: string;
  parseParameters(input: unknown): EffectJsonObject;
  evaluateAuthority(input: {
    parameters: EffectJsonObject;
    secretBindings: EffectRequestEnvelope["secretBindings"];
    scope: EffectJsonObject;
    limits: EffectJsonObject;
    approverPrincipalId: string;
    verificationLevel: EffectApproval["verificationLevel"];
    verification: EffectJsonObject;
    now: number;
  }): EffectAuthorityDecision;
}

export interface EffectAuthorityInput {
  request: EffectRequestEnvelope;
  requestDigest: string;
  approval: Pick<EffectApproval,
    "requestDigest" | "approverPrincipalId" | "decision" | "scope" | "limits" |
    "validFrom" | "expiresAt" | "verificationLevel" | "verification">;
  now: number;
}

function assertUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function assertPolicyBinding(request: EffectRequestEnvelope, policy: EffectConnectorPolicy): void {
  const matches = request.effectTypeUri === policy.effectTypeUri &&
    request.effectSchemaVersion === policy.effectSchemaVersion &&
    request.connector.operationUri === policy.operationUri &&
    request.connector.operationVersion === policy.operationVersion &&
    request.connector.contractDigest === policy.contractDigest &&
    request.connector.instanceRef === policy.instanceRef &&
    request.connector.bindingDigest === policy.bindingDigest;
  if (!matches) throw new Error("Effect request does not match the loaded connector policy binding");
}

/**
 * Synchronous and side-effect-free by contract so the ledger can run it inside
 * the same transaction that enters `executing`.
 */
export function assertEffectAuthority(
  input: EffectAuthorityInput,
  policy: EffectConnectorPolicy,
): EffectJsonObject {
  const now = assertUnixMs(input.now, "authority now");
  if (input.approval.decision !== "approved" || input.approval.requestDigest !== input.requestDigest) {
    throw new Error("Effect authority is not an exact approved request");
  }
  if (input.approval.validFrom != null && now < input.approval.validFrom) {
    throw new Error("Effect authority is not valid yet");
  }
  if (input.approval.expiresAt != null && now >= input.approval.expiresAt) {
    throw new Error("Effect authority has expired");
  }
  assertPolicyBinding(input.request, policy);
  const parsed = policy.parseParameters(input.request.parameters);
  const exactInput = canonicalizeEffectJson(input.request.parameters);
  if (canonicalizeEffectJson(parsed) !== exactInput) {
    throw new Error("Connector parser changed the approved parameters");
  }
  const decision = policy.evaluateAuthority({
    parameters: parsed,
    secretBindings: input.request.secretBindings,
    scope: input.approval.scope,
    limits: input.approval.limits,
    approverPrincipalId: input.approval.approverPrincipalId,
    verificationLevel: input.approval.verificationLevel,
    verification: input.approval.verification,
    now,
  });
  if (!decision.reasonCode.trim() || !decision.explanation.trim()) {
    throw new Error("Connector authority decision requires a reason code and explanation");
  }
  if (!decision.allowed) {
    throw new Error(`Connector authority denied (${decision.reasonCode}): ${decision.explanation}`);
  }
  return parsed;
}

export interface EnforceEffectDispatchOptions {
  now?: number;
  clock?: Clock;
  verifier: EffectPermitVerifier;
}

/** Final fail-closed check at the connector boundary immediately before I/O. */
export function enforceEffectDispatch(
  input: unknown,
  policy: EffectConnectorPolicy,
  options: EnforceEffectDispatchOptions,
): Readonly<{
  permit: EffectDispatchPermitT;
  parameters: EffectJsonObject;
}> {
  const now = assertUnixMs(
    options.now ?? options.clock?.now() ?? Number.NaN,
    "connector dispatch now",
  );
  const permit = EffectDispatchPermit.parse(input);
  const payload = permit.payload;
  if (!options.verifier.verify({
    algorithm: permit.authentication.algorithm,
    keyId: permit.authentication.keyId,
    canonicalPayload: canonicalEffectPermitPayload(payload),
    signature: permit.authentication.signature,
  })) throw new Error("Effect dispatch permit authentication failed");
  if (now < payload.issuedAt) throw new Error("Connector clock precedes dispatch authorization");
  if (now >= payload.claim.expiresAt) throw new Error("Effect claim fence expired before dispatch");
  const prepared = prepareEffectRequest(payload.request);
  if (prepared.canonicalRequest !== payload.canonicalRequest || prepared.requestDigest !== payload.requestDigest) {
    throw new Error("Effect dispatch permit request identity mismatch");
  }
  if (deriveEffectDispatchKey(payload.effectId, prepared) !== payload.dispatchIdempotencyKey) {
    throw new Error("Effect dispatch permit idempotency identity mismatch");
  }
  const parameters = assertEffectAuthority({
    request: payload.request,
    requestDigest: payload.requestDigest,
    approval: payload.approval,
    now,
  }, policy);
  return Object.freeze({ permit, parameters: Object.freeze(parameters) });
}
