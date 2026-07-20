/** Provider-neutral connector declaration, failure semantics and black-box test kit. */

import {
  EFFECT_RECEIPT_COVERAGE,
  canonicalizeEffectJson,
  type EffectJsonObject,
  type EffectReceiptCoverage,
} from "@tasq/schema";
import type { VerifiedEffectReceipt } from "./effects.js";

export const CONNECTOR_CONFORMANCE_PROTOCOL = "tasq.connector-conformance.v1" as const;

export const CONNECTOR_FAILURE_CLASSES = [
  "invalid_request",
  "unauthorized",
  "stale_fence",
  "integrity_error",
  "misconfigured",
  "throttled_before_send",
  "transient_before_send",
  "transport_unknown",
  "provider_pending",
  "provider_rejected",
  "provider_failed",
] as const;
export type ConnectorFailureClass = typeof CONNECTOR_FAILURE_CLASSES[number];

export type ConnectorFailureDisposition =
  | "reject_without_provider_attempt"
  | "retry_same_dispatch_identity"
  | "indeterminate_lookup_only"
  | "terminal_failed";

const FAILURE_DISPOSITIONS: Readonly<Record<ConnectorFailureClass, ConnectorFailureDisposition>> = {
  invalid_request: "reject_without_provider_attempt",
  unauthorized: "reject_without_provider_attempt",
  stale_fence: "reject_without_provider_attempt",
  integrity_error: "reject_without_provider_attempt",
  misconfigured: "reject_without_provider_attempt",
  throttled_before_send: "retry_same_dispatch_identity",
  transient_before_send: "retry_same_dispatch_identity",
  transport_unknown: "indeterminate_lookup_only",
  provider_pending: "indeterminate_lookup_only",
  provider_rejected: "terminal_failed",
  provider_failed: "terminal_failed",
};

export function classifyConnectorFailure(value: ConnectorFailureClass): ConnectorFailureDisposition {
  const result = FAILURE_DISPOSITIONS[value];
  if (!result) throw new Error(`Unknown connector failure class: ${String(value)}`);
  return result;
}

export const CONNECTOR_FAILURE_PROTOCOL = "tasq.connector-failure.v1" as const;

/** A transport-neutral failure envelope whose recovery action is derived, never chosen by a connector. */
export interface ConnectorFailure {
  protocol: typeof CONNECTOR_FAILURE_PROTOCOL;
  failureClass: ConnectorFailureClass;
  disposition: ConnectorFailureDisposition;
  message: string;
  providerAttempted: boolean;
  dispatchIdempotencyKey: string | null;
  providerOperationId: string | null;
  retryAfterMs: number | null;
}

export function defineConnectorFailure(input: Omit<ConnectorFailure, "protocol" | "disposition">): Readonly<ConnectorFailure> {
  exactKeys(input, [
    "failureClass", "message", "providerAttempted", "dispatchIdempotencyKey",
    "providerOperationId", "retryAfterMs",
  ], "connector failure");
  if (!CONNECTOR_FAILURE_CLASSES.includes(input.failureClass)) throw new Error("Unknown connector failure class");
  nonBlank(input.message, "connector failure message");
  if (typeof input.providerAttempted !== "boolean") throw new Error("providerAttempted must be boolean");
  if (input.dispatchIdempotencyKey != null) nonBlank(input.dispatchIdempotencyKey, "dispatchIdempotencyKey");
  if (input.providerOperationId != null) nonBlank(input.providerOperationId, "providerOperationId");
  if (input.retryAfterMs != null && (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0)) {
    throw new Error("retryAfterMs must be null or a non-negative millisecond duration");
  }
  const disposition = classifyConnectorFailure(input.failureClass);
  if (disposition === "reject_without_provider_attempt") {
    if (input.providerAttempted || input.dispatchIdempotencyKey != null || input.providerOperationId != null) {
      throw new Error("Pre-dispatch rejection cannot claim a provider attempt or provider identity");
    }
  } else if (disposition === "retry_same_dispatch_identity") {
    if (input.providerAttempted || input.dispatchIdempotencyKey == null || input.providerOperationId != null) {
      throw new Error("Safe retry requires no provider attempt and the existing dispatch identity");
    }
  } else {
    if (!input.providerAttempted || input.dispatchIdempotencyKey == null) {
      throw new Error("Provider outcome failures require an attempted dispatch and its identity");
    }
    if (input.retryAfterMs != null) throw new Error("Provider outcome failures cannot advertise a blind retry delay");
  }
  return Object.freeze({
    protocol: CONNECTOR_FAILURE_PROTOCOL,
    ...input,
    disposition,
  });
}

export interface ConnectorEffectOperationProfile {
  effectTypeUri: string;
  effectSchemaVersion: number;
  operationUri: string;
  operationVersion: number;
  contractDigest: string;
  impact: "write";
  providerIdempotency: {
    mode: "provider_key" | "resource_identity" | "none";
    retentionMs: number | null;
    parameterConflict: "reject";
  };
  autonomousRetry: boolean;
  uncertainty: {
    timeoutOutcome: "indeterminate";
    blindRetry: false;
    lookup: "by_dispatch_identity" | "by_provider_operation" | "manual_only";
  };
  receipts: {
    terminalVerification: "authenticated_context" | "cryptographic";
    requiredCoverage: readonly EffectReceiptCoverage[];
    secretMinimized: true;
    digestBoundRawReference: true;
  };
}

export interface ConnectorConformanceProfile {
  protocol: typeof CONNECTOR_CONFORMANCE_PROTOCOL;
  connectorUri: string;
  connectorVersion: string;
  instanceRef: string;
  bindingDigest: string;
  provider: {
    issuerUri: string;
    accountRef: string;
    audience: string;
  };
  clock: "injected";
  credentials: "secret_refs_only";
  redirects: "forbid_credential_forwarding";
  observations: null | {
    deliveryIdentity: "source_external_event_id";
    exactReplay: "return_original";
    conflictingReplay: "reject";
    sourceTime: "provenance_only";
    secretMinimized: true;
    digestBoundRawReference: true;
  };
  effects: readonly ConnectorEffectOperationProfile[];
}

function nonBlank(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
}

function httpsUri(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URI`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be an absolute HTTPS URI without embedded credentials`);
  }
}

function sha256(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function exactReceiptCoverage(value: readonly EffectReceiptCoverage[]): boolean {
  return value.length === EFFECT_RECEIPT_COVERAGE.length &&
    new Set(value).size === value.length &&
    EFFECT_RECEIPT_COVERAGE.every((required) => value.includes(required));
}

/** Validate and freeze the security capabilities a connector is willing to claim. */
export function defineConnectorConformanceProfile(
  input: ConnectorConformanceProfile,
): Readonly<ConnectorConformanceProfile> {
  exactKeys(input, [
    "protocol", "connectorUri", "connectorVersion", "instanceRef", "bindingDigest",
    "provider", "clock", "credentials", "redirects", "observations", "effects",
  ], "connector profile");
  if (input.protocol !== CONNECTOR_CONFORMANCE_PROTOCOL) throw new Error("Unsupported connector conformance protocol");
  httpsUri(input.connectorUri, "connectorUri");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(input.connectorVersion)) {
    throw new Error("connectorVersion must be SemVer");
  }
  nonBlank(input.instanceRef, "instanceRef");
  sha256(input.bindingDigest, "bindingDigest");
  exactKeys(input.provider, ["issuerUri", "accountRef", "audience"], "provider profile");
  httpsUri(input.provider.issuerUri, "provider.issuerUri");
  nonBlank(input.provider.accountRef, "provider.accountRef");
  nonBlank(input.provider.audience, "provider.audience");
  if (input.clock !== "injected") throw new Error("Connectors must use an injected clock");
  if (input.credentials !== "secret_refs_only") throw new Error("Connectors may receive secret references only");
  if (input.redirects !== "forbid_credential_forwarding") {
    throw new Error("Connectors must forbid credential forwarding across redirects");
  }
  if (input.observations) {
    exactKeys(input.observations, [
      "deliveryIdentity", "exactReplay", "conflictingReplay", "sourceTime",
      "secretMinimized", "digestBoundRawReference",
    ], "observation profile");
    if (input.observations.deliveryIdentity !== "source_external_event_id" ||
      input.observations.exactReplay !== "return_original" ||
      input.observations.conflictingReplay !== "reject" ||
      input.observations.sourceTime !== "provenance_only" ||
      input.observations.secretMinimized !== true ||
      input.observations.digestBoundRawReference !== true) {
      throw new Error("Observation conformance claims must use the canonical replay and provenance contract");
    }
  }
  if (!Array.isArray(input.effects)) throw new Error("effects must be an array");
  if (!input.observations && input.effects.length === 0) {
    throw new Error("A connector profile must declare observations or at least one effect operation");
  }
  const operationIds = new Set<string>();
  for (const operation of input.effects) {
    exactKeys(operation, [
      "effectTypeUri", "effectSchemaVersion", "operationUri", "operationVersion",
      "contractDigest", "impact", "providerIdempotency", "autonomousRetry",
      "uncertainty", "receipts",
    ], "effect operation profile");
    httpsUri(operation.effectTypeUri, "effectTypeUri");
    httpsUri(operation.operationUri, "operationUri");
    positiveInteger(operation.effectSchemaVersion, "effectSchemaVersion");
    positiveInteger(operation.operationVersion, "operationVersion");
    sha256(operation.contractDigest, "contractDigest");
    if (operation.impact !== "write") throw new Error("Effect operations must declare write impact");
    if (typeof operation.autonomousRetry !== "boolean") throw new Error("autonomousRetry must be boolean");
    const identity = `${operation.operationUri}@${operation.operationVersion}`;
    if (operationIds.has(identity)) throw new Error(`Duplicate connector effect operation: ${identity}`);
    operationIds.add(identity);
    exactKeys(operation.providerIdempotency, ["mode", "retentionMs", "parameterConflict"], "provider idempotency profile");
    if (!["provider_key", "resource_identity", "none"].includes(operation.providerIdempotency.mode) ||
      operation.providerIdempotency.parameterConflict !== "reject") {
      throw new Error("Provider idempotency keys must reject parameter conflicts");
    }
    if (operation.providerIdempotency.mode === "provider_key") {
      positiveInteger(operation.providerIdempotency.retentionMs ?? 0, "provider idempotency retentionMs");
    } else if (operation.providerIdempotency.retentionMs != null) {
      throw new Error("retentionMs is only valid for provider-key idempotency");
    }
    if (operation.providerIdempotency.mode === "none" && operation.autonomousRetry) {
      throw new Error("A connector without provider idempotency cannot retry autonomously");
    }
    exactKeys(operation.uncertainty, ["timeoutOutcome", "blindRetry", "lookup"], "uncertainty profile");
    if (operation.uncertainty.timeoutOutcome !== "indeterminate" || operation.uncertainty.blindRetry !== false ||
      !["by_dispatch_identity", "by_provider_operation", "manual_only"].includes(operation.uncertainty.lookup)) {
      throw new Error("Timeout uncertainty must become indeterminate and forbid blind retry");
    }
    if (operation.uncertainty.lookup === "manual_only" && operation.autonomousRetry) {
      throw new Error("Manual-only uncertainty recovery cannot advertise autonomous retry");
    }
    exactKeys(operation.receipts, [
      "terminalVerification", "requiredCoverage", "secretMinimized", "digestBoundRawReference",
    ], "receipt profile");
    if (!["authenticated_context", "cryptographic"].includes(operation.receipts.terminalVerification) ||
      !exactReceiptCoverage(operation.receipts.requiredCoverage)) {
      throw new Error("Terminal receipts must cover provider account, operation, request identity and outcome exactly once");
    }
    if (operation.receipts.secretMinimized !== true || operation.receipts.digestBoundRawReference !== true) {
      throw new Error("Receipts must be secret-minimized and bind their raw reference by digest");
    }
  }
  return Object.freeze({
    ...input,
    provider: Object.freeze({ ...input.provider }),
    observations: input.observations ? Object.freeze({ ...input.observations }) : null,
    effects: Object.freeze(input.effects.map((operation) => Object.freeze({
      ...operation,
      providerIdempotency: Object.freeze({ ...operation.providerIdempotency }),
      uncertainty: Object.freeze({ ...operation.uncertainty }),
      receipts: Object.freeze({ ...operation.receipts, requiredCoverage: Object.freeze([...operation.receipts.requiredCoverage]) }),
    }))),
  });
}

export interface NormalizedConnectorObservation {
  source: string;
  externalEventId: string;
  typeUri: string;
  schemaVersion: number;
  payload: EffectJsonObject;
  occurredAt: number;
  verificationLevel: "authenticated_source" | "cryptographic";
  verificationMethod: string;
  rawRef: string;
  digest: string;
  metadata: EffectJsonObject;
}

export interface ObservationConnectorConformanceProbe {
  exactDelivery(): Promise<NormalizedConnectorObservation> | NormalizedConnectorObservation;
  replayExactDelivery(): Promise<NormalizedConnectorObservation> | NormalizedConnectorObservation;
  conflictingDelivery(): Promise<NormalizedConnectorObservation> | NormalizedConnectorObservation;
}

export interface EffectConnectorProbeResult {
  outcome: "committed" | "failed" | "indeterminate";
  dispatchIdempotencyKey: string;
  providerOperationId: string | null;
  report: unknown;
}

export interface EffectConnectorConformanceProbe {
  operationUri: string;
  operationVersion: number;
  validInput: unknown;
  mutatedInput: unknown;
  uncertainInput: unknown;
  claimExpiresAt: number;
  providerOperationCount(): number;
  dispatch(input: unknown, options: {
    now: number;
    loseResponseAfterProviderCommit?: boolean;
  }): Promise<EffectConnectorProbeResult>;
  lookup?(dispatchIdempotencyKey: string, options: { now: number }): Promise<EffectConnectorProbeResult>;
  verifyReceipt(report: unknown, options: { now: number }): Promise<VerifiedEffectReceipt> | VerifiedEffectReceipt;
  forgedReceipt: unknown;
  wrongAccountReceipt: unknown;
  insufficientCoverageReceipt: unknown;
}

export interface ConnectorConformanceProbe {
  observation?: ObservationConnectorConformanceProbe;
  effects?: readonly EffectConnectorConformanceProbe[];
}

export interface ConnectorConformanceCheck {
  id: string;
  passed: boolean;
  message: string;
}

export interface ConnectorConformanceReport {
  protocol: typeof CONNECTOR_CONFORMANCE_PROTOCOL;
  connectorUri: string;
  passed: boolean;
  checks: readonly ConnectorConformanceCheck[];
}

function observationIdentity(value: NormalizedConnectorObservation): string {
  return `${value.source}\0${value.externalEventId}`;
}

function containsSecret(value: unknown, key = ""): boolean {
  const normalizedKey = key.replace(/[-_\s]/g, "").toLowerCase();
  if ([
    "authorization", "cookie", "password", "passwd", "token", "accesstoken",
    "refreshtoken", "sessiontoken", "idtoken", "secret", "clientsecret",
    "apikey", "privatekey",
  ].includes(normalizedKey)) return true;
  if (typeof value === "string" && /^(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*$/i.test(value)) return true;
  if (Array.isArray(value)) return value.some((child) => containsSecret(child));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, child]) => containsSecret(child, childKey));
  }
  return false;
}

function validObservation(value: NormalizedConnectorObservation): boolean {
  try {
    exactKeys(value, [
      "source", "externalEventId", "typeUri", "schemaVersion", "payload", "occurredAt",
      "verificationLevel", "verificationMethod", "rawRef", "digest", "metadata",
    ], "normalized observation");
    nonBlank(value.source, "source");
    nonBlank(value.externalEventId, "externalEventId");
    httpsUri(value.typeUri, "typeUri");
    positiveInteger(value.schemaVersion, "schemaVersion");
    if (!Number.isSafeInteger(value.occurredAt) || value.occurredAt < 0) return false;
    if (!["authenticated_source", "cryptographic"].includes(value.verificationLevel)) return false;
    nonBlank(value.verificationMethod, "verificationMethod");
    nonBlank(value.rawRef, "rawRef");
    sha256(value.digest, "digest");
    canonicalizeEffectJson(value.payload);
    canonicalizeEffectJson(value.metadata);
    return !containsSecret(value);
  } catch {
    return false;
  }
}

async function rejected(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

function check(checks: ConnectorConformanceCheck[], id: string, passed: boolean, message: string): void {
  checks.push({ id, passed, message });
}

function terminalReceiptVerification(
  value: VerifiedEffectReceipt,
  promised: ConnectorEffectOperationProfile["receipts"]["terminalVerification"],
): boolean {
  try {
    exactKeys(value, ["level", "method", "coverage", "details"], "verified receipt");
    const strongEnough = promised === "cryptographic"
      ? value.level === "cryptographic"
      : value.level === "authenticated_context" || value.level === "cryptographic";
    canonicalizeEffectJson(value.details);
    return strongEnough && value.method.trim().length > 0 && exactReceiptCoverage(value.coverage) && !containsSecret(value);
  } catch {
    return false;
  }
}

function canonicalOrNull(value: unknown): string | null {
  try {
    return canonicalizeEffectJson(value);
  } catch {
    return null;
  }
}

async function attempt<T>(operation: () => Promise<T> | T): Promise<{ value: T | null; error: unknown | null }> {
  try {
    return { value: await operation(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/**
 * Exercise a connector through observable behavior only. The caller supplies
 * an injected time snapshot and an instrumented provider probe; no network,
 * database or device clock is owned by this test kit.
 */
export async function runConnectorConformance(
  profileInput: ConnectorConformanceProfile,
  probe: ConnectorConformanceProbe,
  options: { now: number },
): Promise<ConnectorConformanceReport> {
  if (!Number.isSafeInteger(options.now) || options.now < 0) throw new Error("Conformance now must be injected unix-ms");
  const checks: ConnectorConformanceCheck[] = [];
  let profile: Readonly<ConnectorConformanceProfile> | null = null;
  try {
    profile = defineConnectorConformanceProfile(profileInput);
    check(checks, "profile.valid", true, "Connector security profile is internally consistent.");
  } catch (error) {
    check(checks, "profile.valid", false, error instanceof Error ? error.message : String(error));
  }
  if (!profile) return { protocol: CONNECTOR_CONFORMANCE_PROTOCOL, connectorUri: profileInput.connectorUri, passed: false, checks };

  if (profile.observations) {
    if (!probe.observation) {
      check(checks, "observation.probe", false, "Observation capability has no conformance probe.");
    } else {
      const exactAttempt = await attempt(() => probe.observation!.exactDelivery());
      const replayAttempt = await attempt(() => probe.observation!.replayExactDelivery());
      const conflictAttempt = await attempt(() => probe.observation!.conflictingDelivery());
      if (!exactAttempt.value || !replayAttempt.value || !conflictAttempt.value) {
        check(checks, "observation.probe_execution", false, "Observation probe threw instead of returning the three required fixtures.");
      } else {
      const exact = exactAttempt.value;
      const replay = replayAttempt.value;
      const conflict = conflictAttempt.value;
      const exactCanonical = canonicalOrNull(exact);
      const replayCanonical = canonicalOrNull(replay);
      const conflictCanonical = canonicalOrNull(conflict);
      check(checks, "observation.valid", validObservation(exact), "Observation is bounded, canonical, authenticated and secret-minimized.");
      check(checks, "observation.exact_replay", exactCanonical != null && exactCanonical === replayCanonical, "Exact delivery replay is byte-equivalent after normalization.");
      check(checks, "observation.conflict_identity", observationIdentity(conflict) === observationIdentity(exact), "Conflicting delivery preserves the provider natural identity.");
      check(checks, "observation.conflict_content", conflictCanonical != null && exactCanonical != null && conflictCanonical !== exactCanonical && conflict.digest !== exact.digest, "Conflicting delivery changes canonical content and digest so the ledger can reject it.");
      check(checks, "observation.conflict_secret_minimized", validObservation(conflict), "Conflicting test delivery remains safe to inspect.");
      }
    }
  } else if (probe.observation) {
    check(checks, "observation.undeclared", false, "Probe exposes observations that the connector profile does not declare.");
  }

  const declared = new Map(profile.effects.map((operation) => [
    `${operation.operationUri}@${operation.operationVersion}`,
    operation,
  ]));
  const effectProbes = probe.effects ?? [];
  const effectProbeIdentities = effectProbes.map((candidate) => `${candidate.operationUri}@${candidate.operationVersion}`);
  if (new Set(effectProbeIdentities).size !== effectProbeIdentities.length) {
    check(checks, "effect.probes_unique", false, "Each declared effect operation must have exactly one probe.");
  }
  for (const operation of profile.effects) {
    const identity = `${operation.operationUri}@${operation.operationVersion}`;
    if (!effectProbes.some((candidate) => `${candidate.operationUri}@${candidate.operationVersion}` === identity)) {
      check(checks, `effect.${identity}.probe`, false, "Declared effect operation has no conformance probe.");
    }
  }
  for (const effectProbe of effectProbes) {
    const identity = `${effectProbe.operationUri}@${effectProbe.operationVersion}`;
    if (!declared.has(identity)) {
      check(checks, `effect.${identity}.undeclared`, false, "Probe exercises an undeclared effect operation.");
      continue;
    }
    const prefix = `effect.${identity}`;
    const initialCount = effectProbe.providerOperationCount();
    const operation = declared.get(identity)!;
    const firstAttempt = await attempt(() => effectProbe.dispatch(effectProbe.validInput, { now: options.now }));
    const afterFirst = effectProbe.providerOperationCount();
    check(checks, `${prefix}.dispatch_once`, afterFirst === initialCount + 1, "First exact dispatch creates one provider operation.");
    const first = firstAttempt.value;
    check(checks, `${prefix}.dispatch_terminal`, first?.outcome === "committed" && first.providerOperationId != null && first.dispatchIdempotencyKey.length > 0, "Valid dispatch commits and returns a provider identity.");
    if (!first) continue;
    if (operation.providerIdempotency.mode !== "none") {
      const replayAttempt = await attempt(() => effectProbe.dispatch(effectProbe.validInput, { now: options.now }));
      const replay = replayAttempt.value;
      check(checks, `${prefix}.exact_retry`, replay != null && effectProbe.providerOperationCount() === afterFirst && replay.providerOperationId === first.providerOperationId && replay.dispatchIdempotencyKey === first.dispatchIdempotencyKey, "Exact retry returns the original provider operation.");
    } else {
      check(checks, `${prefix}.retry_disabled`, operation.autonomousRetry === false, "Operation without provider idempotency forbids autonomous retry.");
    }
    const mutationRejected = await rejected(() => effectProbe.dispatch(effectProbe.mutatedInput, { now: options.now }));
    check(checks, `${prefix}.mutation_rejected`, mutationRejected && effectProbe.providerOperationCount() === afterFirst, "Semantic mutation is rejected before provider I/O.");
    const staleRejected = await rejected(() => effectProbe.dispatch(effectProbe.validInput, { now: effectProbe.claimExpiresAt }));
    check(checks, `${prefix}.stale_fence_rejected`, staleRejected && effectProbe.providerOperationCount() === afterFirst, "Expired claim fence is rejected before provider I/O.");

    let verified: VerifiedEffectReceipt | null = null;
    try {
      verified = await effectProbe.verifyReceipt(first.report, { now: options.now });
    } catch {
      verified = null;
    }
    check(checks, `${prefix}.terminal_receipt`, verified != null && terminalReceiptVerification(verified, operation.receipts.terminalVerification), "Terminal receipt has the promised independent verification, exact coverage and no secrets.");
    for (const [name, hostile] of [
      ["forged_receipt", effectProbe.forgedReceipt],
      ["wrong_account_receipt", effectProbe.wrongAccountReceipt],
      ["insufficient_coverage_receipt", effectProbe.insufficientCoverageReceipt],
    ] as const) {
      check(checks, `${prefix}.${name}`, await rejected(() => Promise.resolve(effectProbe.verifyReceipt(hostile, { now: options.now }))), `${name.replace(/_/g, " ")} is rejected.`);
    }

    const uncertainAttempt = await attempt(() => effectProbe.dispatch(effectProbe.uncertainInput, {
      now: options.now,
      loseResponseAfterProviderCommit: true,
    }));
    const uncertain = uncertainAttempt.value;
    const afterUncertain = effectProbe.providerOperationCount();
    check(checks, `${prefix}.timeout_indeterminate`, uncertain?.outcome === "indeterminate" && uncertain.providerOperationId === null && afterUncertain === afterFirst + 1, "Lost response becomes indeterminate after exactly one provider operation.");
    if (!uncertain) continue;
    if (operation.uncertainty.lookup === "manual_only") {
      check(checks, `${prefix}.manual_recovery`, effectProbe.lookup == null && operation.autonomousRetry === false, "Manual-only uncertainty exposes no autonomous lookup or retry.");
      continue;
    }
    if (!effectProbe.lookup) {
      check(checks, `${prefix}.lookup_recovers`, false, "Declared uncertainty lookup has no probe implementation.");
      continue;
    }
    const recoveredAttempt = await attempt(() => effectProbe.lookup!(uncertain.dispatchIdempotencyKey, { now: options.now }));
    const recovered = recoveredAttempt.value;
    check(checks, `${prefix}.lookup_recovers`, recovered?.outcome === "committed" && recovered.providerOperationId != null && recovered.dispatchIdempotencyKey === uncertain.dispatchIdempotencyKey && effectProbe.providerOperationCount() === afterUncertain, "Lookup resolves the same dispatch identity without redispatch.");
  }

  const passed = checks.length > 0 && checks.every((value) => value.passed);
  return Object.freeze({
    protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
    connectorUri: profile.connectorUri,
    passed,
    checks: Object.freeze(checks.map((value) => Object.freeze(value))),
  });
}

export function assertConnectorConformance(report: ConnectorConformanceReport): void {
  const failures = report.checks.filter((value) => !value.passed);
  if (failures.length > 0) {
    throw new Error(`Connector conformance failed: ${failures.map((value) => `${value.id}: ${value.message}`).join("; ")}`);
  }
}
