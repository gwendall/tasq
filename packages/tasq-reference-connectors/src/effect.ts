import {
  CONNECTOR_CONFORMANCE_PROTOCOL,
  canonicalEffectPermitPayload,
  defineConnectorConformanceProfile,
  enforceEffectDispatch,
  type ConnectorConformanceProfile,
  type EffectConnectorPolicy,
  type EffectPermitVerifier,
  type EffectReceiptVerifier,
  type VerifiedEffectReceipt,
} from "@tasq-run/extension-sdk";
import {
  EffectDispatchPermit as EffectDispatchPermitSchema,
  EffectReceiptReport as EffectReceiptReportSchema,
  canonicalizeEffectJson,
  clockNow,
  deriveEffectDispatchKey,
  prepareEffectRequest,
  type Clock,
  type EffectDispatchPermit,
  type EffectJsonObject,
  type EffectReceiptReport,
} from "@tasq-run/schema";
import {
  PROVIDER_RECEIPT_COVERAGE,
  REFERENCE_CONNECTOR_VERSION,
  WORK_ITEM_COMMENT_CONTRACT_DIGEST,
  WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
  WORK_ITEM_COMMENT_OPERATION_URI,
  WORK_ITEM_EFFECT_CONNECTOR_URI,
  WORK_ITEM_OPERATION_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  sha256,
} from "./constants.js";
import {
  ProviderOutcomeUnknownError,
  type ProviderCommentReceipt,
  type ProviderCommentReceiptPayload,
  type ProviderReceiptVerifier,
  type WorkItemProviderClient,
} from "./provider.js";

const PORTABLE_REF = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_CONTENT_REF_LENGTH = 2_048;

export interface WorkItemCommentParameters extends EffectJsonObject {
  providerAccountRef: string;
  projectRef: string;
  itemRef: string;
  bodyRef: string;
  bodyDigest: string;
  bodyBytes: number;
}

export interface ReferenceWorkItemEffectConnectorOptions {
  instanceRef: string;
  bindingDigest: string;
  providerIssuerUri: string;
  providerAccountRef: string;
  providerAudience: string;
  providerIdempotencyRetentionMs: number;
  maxBodyBytes: number;
  client: WorkItemProviderClient;
  receiptVerifier: ProviderReceiptVerifier;
  permitVerifier: EffectPermitVerifier;
  clock: Clock;
  resolveBody(reference: string): Promise<string | Uint8Array> | string | Uint8Array;
}

export interface ReferenceEffectConnectorResult {
  outcome: "committed" | "failed" | "indeterminate";
  dispatchIdempotencyKey: string;
  providerOperationId: string | null;
  report: EffectReceiptReport;
}

export interface ReferenceWorkItemEffectConnector {
  readonly profile: Readonly<ConnectorConformanceProfile>;
  readonly policy: EffectConnectorPolicy;
  dispatch(permit: unknown): Promise<ReferenceEffectConnectorResult>;
  lookup(
    permit: unknown,
    options?: { resolvesReceiptId?: string | null },
  ): Promise<ReferenceEffectConnectorResult>;
  verifyReceipt(report: unknown): VerifiedEffectReceipt;
}

function exactObject(input: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
  return value;
}

function portableRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !PORTABLE_REF.test(value)) {
    throw new Error(`${label} must be a portable reference`);
  }
  return value;
}

function contentRef(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONTENT_REF_LENGTH) {
    throw new Error("bodyRef must be a bounded absolute URI");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("bodyRef must be a bounded absolute URI");
  }
  if (parsed.username || parsed.password) throw new Error("bodyRef must not contain credentials");
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function byteCount(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new Error(`bodyBytes must be a non-negative safe integer at most ${max}`);
  }
  return Number(value);
}

function parseParameters(input: unknown, options: ReferenceWorkItemEffectConnectorOptions): WorkItemCommentParameters {
  const value = exactObject(input, [
    "providerAccountRef", "projectRef", "itemRef", "bodyRef", "bodyDigest", "bodyBytes",
  ], "work-item comment parameters");
  return {
    providerAccountRef: portableRef(value.providerAccountRef, "providerAccountRef"),
    projectRef: portableRef(value.projectRef, "projectRef"),
    itemRef: portableRef(value.itemRef, "itemRef"),
    bodyRef: contentRef(value.bodyRef),
    bodyDigest: digest(value.bodyDigest, "bodyDigest"),
    bodyBytes: byteCount(value.bodyBytes, options.maxBodyBytes),
  };
}

function exactCoverage(value: readonly string[]): boolean {
  return value.length === PROVIDER_RECEIPT_COVERAGE.length &&
    new Set(value).size === value.length &&
    PROVIDER_RECEIPT_COVERAGE.every((entry) => value.includes(entry));
}

function policyFor(options: ReferenceWorkItemEffectConnectorOptions): EffectConnectorPolicy {
  const policy: EffectConnectorPolicy = {
    effectTypeUri: WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
    effectSchemaVersion: WORK_ITEM_SCHEMA_VERSION,
    operationUri: WORK_ITEM_COMMENT_OPERATION_URI,
    operationVersion: WORK_ITEM_OPERATION_VERSION,
    contractDigest: WORK_ITEM_COMMENT_CONTRACT_DIGEST,
    instanceRef: options.instanceRef,
    bindingDigest: options.bindingDigest,
    parseParameters: (input: unknown) => parseParameters(input, options),
    evaluateAuthority(input: Parameters<EffectConnectorPolicy["evaluateAuthority"]>[0]) {
      const scope = input.scope;
      const limits = input.limits;
      const parameters = input.parameters as WorkItemCommentParameters;
      const allowed = input.verificationLevel !== "self_asserted" &&
        scope.providerAccountRef === parameters.providerAccountRef &&
        scope.projectRef === parameters.projectRef &&
        scope.itemRef === parameters.itemRef &&
        scope.bodyDigest === parameters.bodyDigest &&
        Number(limits.maxBodyBytes) >= parameters.bodyBytes &&
        parameters.providerAccountRef === options.providerAccountRef;
      return {
        allowed,
        reasonCode: allowed ? "exact_work_item_comment" : "outside_work_item_comment_authority",
        explanation: allowed
          ? "The exact account, item, content digest and byte bound are authorized."
          : "The requested comment differs from the approved account, item, digest or size bound.",
      };
    },
  };
  return Object.freeze(policy);
}

function profileFor(options: ReferenceWorkItemEffectConnectorOptions): Readonly<ConnectorConformanceProfile> {
  return defineConnectorConformanceProfile({
    protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
    connectorUri: WORK_ITEM_EFFECT_CONNECTOR_URI,
    connectorVersion: REFERENCE_CONNECTOR_VERSION,
    instanceRef: options.instanceRef,
    bindingDigest: options.bindingDigest,
    provider: {
      issuerUri: options.providerIssuerUri,
      accountRef: options.providerAccountRef,
      audience: options.providerAudience,
    },
    clock: "injected",
    credentials: "secret_refs_only",
    redirects: "forbid_credential_forwarding",
    observations: null,
    effects: [{
      effectTypeUri: WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
      effectSchemaVersion: WORK_ITEM_SCHEMA_VERSION,
      operationUri: WORK_ITEM_COMMENT_OPERATION_URI,
      operationVersion: WORK_ITEM_OPERATION_VERSION,
      contractDigest: WORK_ITEM_COMMENT_CONTRACT_DIGEST,
      impact: "write",
      providerIdempotency: {
        mode: "provider_key",
        retentionMs: options.providerIdempotencyRetentionMs,
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
        requiredCoverage: PROVIDER_RECEIPT_COVERAGE,
        secretMinimized: true,
        digestBoundRawReference: true,
      },
    }],
  });
}

function verifyPermitForLookup(
  input: unknown,
  policy: EffectConnectorPolicy,
  verifier: EffectPermitVerifier,
): EffectDispatchPermit {
  const permit = EffectDispatchPermitSchema.parse(input);
  if (!verifier.verify({
    algorithm: permit.authentication.algorithm,
    keyId: permit.authentication.keyId,
    canonicalPayload: canonicalEffectPermitPayload(permit.payload),
    signature: permit.authentication.signature,
  })) throw new Error("Effect dispatch permit authentication failed");
  const prepared = prepareEffectRequest(permit.payload.request);
  if (prepared.canonicalRequest !== permit.payload.canonicalRequest ||
    prepared.requestDigest !== permit.payload.requestDigest ||
    deriveEffectDispatchKey(permit.payload.effectId, prepared) !== permit.payload.dispatchIdempotencyKey) {
    throw new Error("Effect dispatch permit request identity mismatch");
  }
  const request = permit.payload.request;
  if (request.effectTypeUri !== policy.effectTypeUri ||
    request.effectSchemaVersion !== policy.effectSchemaVersion ||
    request.connector.operationUri !== policy.operationUri ||
    request.connector.operationVersion !== policy.operationVersion ||
    request.connector.contractDigest !== policy.contractDigest ||
    request.connector.instanceRef !== policy.instanceRef ||
    request.connector.bindingDigest !== policy.bindingDigest) {
    throw new Error("Effect request does not match the loaded connector policy binding");
  }
  policy.parseParameters(request.parameters);
  return permit;
}

function assertProviderReceipt(
  receipt: ProviderCommentReceipt,
  permit: EffectDispatchPermit,
  options: ReferenceWorkItemEffectConnectorOptions,
): ProviderCommentReceiptPayload {
  const payload = receipt.payload;
  const parameters = parseParameters(permit.payload.request.parameters, options);
  if (payload.accountRef !== options.providerAccountRef ||
    payload.projectRef !== parameters.projectRef || payload.itemRef !== parameters.itemRef ||
    payload.dispatchIdempotencyKey !== permit.payload.dispatchIdempotencyKey ||
    payload.requestDigest !== permit.payload.requestDigest) {
    throw new Error("Provider receipt does not match the exact request and account binding");
  }
  if (!exactCoverage(payload.coverage)) throw new Error("Provider receipt coverage is incomplete");
  if (!Number.isSafeInteger(payload.occurredAt) || payload.occurredAt < 0) {
    throw new Error("Provider receipt time must be a non-negative unix-ms integer");
  }
  const rawRef = new URL(payload.rawRef);
  if (rawRef.protocol !== "https:" || rawRef.origin !== new URL(options.providerIssuerUri).origin ||
    rawRef.username || rawRef.password) {
    throw new Error("Provider receipt raw reference escaped the pinned provider origin");
  }
  if (!options.receiptVerifier.verify(payload, receipt.proof)) {
    throw new Error("Provider receipt authentication failed");
  }
  return payload;
}

function terminalReport(
  permit: EffectDispatchPermit,
  receipt: ProviderCommentReceipt,
  resolvesReceiptId: string | null,
): EffectReceiptReport {
  const payload = receipt.payload;
  return EffectReceiptReportSchema.parse({
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
    externalReceiptId: payload.receiptId,
    providerOperationId: payload.providerOperationId,
    outcome: payload.outcome,
    occurredAt: payload.occurredAt,
    rawRef: payload.rawRef,
    rawDigest: sha256(canonicalizeEffectJson(receipt)),
    payload: {
      connectorContract: "tasq.reference-work-item-comment.v1",
      providerReceipt: {
        payload: receipt.payload,
        proof: receipt.proof,
      },
    },
    resolvesReceiptId,
  });
}

function indeterminateReport(permit: EffectDispatchPermit, now: number): EffectReceiptReport {
  const raw = {
    connectorContract: "tasq.reference-work-item-comment.v1",
    providerAccountRef: permit.payload.request.parameters.providerAccountRef,
    projectRef: permit.payload.request.parameters.projectRef,
    itemRef: permit.payload.request.parameters.itemRef,
    status: "outcome_unknown",
  };
  return EffectReceiptReportSchema.parse({
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
    externalReceiptId: `unknown:${permit.payload.dispatchIdempotencyKey}`,
    providerOperationId: null,
    outcome: "indeterminate",
    occurredAt: now,
    rawRef: `urn:tasq:reference-connector:unknown:${permit.payload.dispatchIdempotencyKey}`,
    rawDigest: sha256(canonicalizeEffectJson(raw)),
    payload: raw,
    resolvesReceiptId: null,
  });
}

function parseEmbeddedProviderReceipt(report: EffectReceiptReport): ProviderCommentReceipt {
  const outer = exactObject(report.payload, ["connectorContract", "providerReceipt"], "receipt payload");
  if (outer.connectorContract !== "tasq.reference-work-item-comment.v1") {
    throw new Error("Receipt connector contract is unsupported");
  }
  const embedded = exactObject(outer.providerReceipt, ["payload", "proof"], "embedded provider receipt");
  const payload = exactObject(embedded.payload, [
    "accountRef", "projectRef", "itemRef", "dispatchIdempotencyKey", "requestDigest",
    "providerOperationId", "outcome", "occurredAt", "receiptId", "rawRef", "coverage",
  ], "embedded provider receipt payload") as unknown as ProviderCommentReceiptPayload;
  const proof = exactObject(embedded.proof, ["algorithm", "keyId", "signature"], "embedded provider receipt proof") as unknown as ProviderCommentReceipt["proof"];
  return { payload, proof };
}

export function createReferenceWorkItemEffectConnector(
  options: ReferenceWorkItemEffectConnectorOptions,
): ReferenceWorkItemEffectConnector {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  const policy = policyFor(options);
  const profile = profileFor(options);

  const verifyReceipt = (input: unknown): VerifiedEffectReceipt => {
    const report = EffectReceiptReportSchema.parse(input);
    if (report.connectorInstanceRef !== options.instanceRef ||
      report.connectorBindingDigest !== options.bindingDigest) {
      throw new Error("Receipt connector binding mismatch");
    }
    if (report.outcome === "indeterminate") {
      return {
        level: "self_asserted",
        method: "connector-transport-outcome-unknown",
        coverage: ["request_identity", "outcome"],
        details: { lookupRequired: true },
      };
    }
    const receipt = parseEmbeddedProviderReceipt(report);
    const payload = receipt.payload;
    if (payload.accountRef !== options.providerAccountRef ||
      payload.dispatchIdempotencyKey !== report.dispatchIdempotencyKey ||
      payload.requestDigest !== report.requestDigest ||
      payload.providerOperationId !== report.providerOperationId ||
      payload.outcome !== report.outcome || payload.occurredAt !== report.occurredAt ||
      payload.receiptId !== report.externalReceiptId || payload.rawRef !== report.rawRef ||
      report.rawDigest !== sha256(canonicalizeEffectJson(receipt)) ||
      !exactCoverage(payload.coverage)) {
      throw new Error("Receipt report does not preserve the authenticated provider result");
    }
    if (!options.receiptVerifier.verify(payload, receipt.proof)) {
      throw new Error("Provider receipt authentication failed");
    }
    return {
      level: "cryptographic",
      method: `${options.receiptVerifier.algorithm}:${options.receiptVerifier.keyId}`,
      coverage: PROVIDER_RECEIPT_COVERAGE,
      details: {
        providerAccountRef: options.providerAccountRef,
        receiptKeyId: options.receiptVerifier.keyId,
      },
    };
  };

  const connector: ReferenceWorkItemEffectConnector = {
    profile,
    policy,
    async dispatch(input: unknown): Promise<ReferenceEffectConnectorResult> {
      const now = clockNow(options.clock);
      const accepted = enforceEffectDispatch(input, policy, {
        now,
        verifier: options.permitVerifier,
      });
      const parameters = accepted.parameters as WorkItemCommentParameters;
      const resolved = await options.resolveBody(parameters.bodyRef);
      const bytes = typeof resolved === "string" ? new TextEncoder().encode(resolved) : new Uint8Array(resolved);
      if (bytes.byteLength !== parameters.bodyBytes || sha256(bytes) !== parameters.bodyDigest) {
        throw new Error("Resolved comment body does not match the approved byte length and digest");
      }
      try {
        const receipt = await options.client.createComment({
          projectRef: parameters.projectRef,
          itemRef: parameters.itemRef,
          dispatchIdempotencyKey: accepted.permit.payload.dispatchIdempotencyKey,
          requestDigest: accepted.permit.payload.requestDigest,
          bodyBase64: Buffer.from(bytes).toString("base64"),
          bodyDigest: parameters.bodyDigest,
        });
        const payload = assertProviderReceipt(receipt, accepted.permit, options);
        const report = terminalReport(accepted.permit, receipt, null);
        return {
          outcome: payload.outcome,
          dispatchIdempotencyKey: payload.dispatchIdempotencyKey,
          providerOperationId: payload.providerOperationId,
          report,
        };
      } catch (error) {
        if (!(error instanceof ProviderOutcomeUnknownError) ||
          error.dispatchIdempotencyKey !== accepted.permit.payload.dispatchIdempotencyKey) throw error;
        return {
          outcome: "indeterminate",
          dispatchIdempotencyKey: accepted.permit.payload.dispatchIdempotencyKey,
          providerOperationId: null,
          report: indeterminateReport(accepted.permit, now),
        };
      }
    },
    async lookup(
      input: unknown,
      lookupOptions: { resolvesReceiptId?: string | null } = {},
    ): Promise<ReferenceEffectConnectorResult> {
      const now = clockNow(options.clock);
      const permit = verifyPermitForLookup(input, policy, options.permitVerifier);
      const receipt = await options.client.lookupComment(permit.payload.dispatchIdempotencyKey);
      if (!receipt) {
        return {
          outcome: "indeterminate",
          dispatchIdempotencyKey: permit.payload.dispatchIdempotencyKey,
          providerOperationId: null,
          report: indeterminateReport(permit, now),
        };
      }
      const payload = assertProviderReceipt(receipt, permit, options);
      const report = terminalReport(permit, receipt, lookupOptions.resolvesReceiptId ?? null);
      return {
        outcome: payload.outcome,
        dispatchIdempotencyKey: payload.dispatchIdempotencyKey,
        providerOperationId: payload.providerOperationId,
        report,
      };
    },
    verifyReceipt,
  };
  return Object.freeze(connector);
}

/** Turn a previously verified connector receipt into the pure service callback. */
export function bindVerifiedEffectReceipt(
  reportInput: unknown,
  verifiedInput: VerifiedEffectReceipt,
): EffectReceiptVerifier {
  const report = EffectReceiptReportSchema.parse(reportInput);
  const canonical = canonicalizeEffectJson(report);
  const verified = Object.freeze({
    ...verifiedInput,
    coverage: Object.freeze([...verifiedInput.coverage]),
    details: Object.freeze({ ...verifiedInput.details }),
  });
  const verifier: EffectReceiptVerifier = {
    verify({ report: candidate }: Parameters<EffectReceiptVerifier["verify"]>[0]) {
      if (canonicalizeEffectJson(candidate) !== canonical) {
        throw new Error("Receipt differs from the connector-verified report");
      }
      return verified;
    },
  };
  return Object.freeze(verifier);
}
