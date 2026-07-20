import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalizeEffectJson, type EffectJsonObject } from "@tasq/schema";
import { PROVIDER_RECEIPT_COVERAGE } from "./constants.js";

const PORTABLE_REF = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export interface ProviderWorkItemSnapshot {
  accountRef: string;
  projectRef: string;
  itemRef: string;
  version: string;
  state: "open" | "closed";
  title: string;
  updatedAt: number;
  recordRef: string;
}

export interface ProviderCommentReceiptPayload extends EffectJsonObject {
  accountRef: string;
  projectRef: string;
  itemRef: string;
  dispatchIdempotencyKey: string;
  requestDigest: string;
  providerOperationId: string;
  outcome: "committed" | "failed";
  occurredAt: number;
  receiptId: string;
  rawRef: string;
  coverage: (typeof PROVIDER_RECEIPT_COVERAGE)[number][];
}

export interface ProviderReceiptProof extends EffectJsonObject {
  algorithm: "hmac-sha256";
  keyId: string;
  signature: string;
}

export interface ProviderCommentReceipt {
  payload: ProviderCommentReceiptPayload;
  proof: ProviderReceiptProof;
}

export interface CreateProviderCommentInput {
  projectRef: string;
  itemRef: string;
  dispatchIdempotencyKey: string;
  requestDigest: string;
  bodyBase64: string;
  bodyDigest: string;
}

export interface WorkItemProviderClient {
  readWorkItem(input: { projectRef: string; itemRef: string }): Promise<ProviderWorkItemSnapshot>;
  createComment(input: CreateProviderCommentInput): Promise<ProviderCommentReceipt>;
  lookupComment(dispatchIdempotencyKey: string): Promise<ProviderCommentReceipt | null>;
}

export interface ProviderReceiptVerifier {
  readonly algorithm: string;
  readonly keyId: string;
  verify(payload: ProviderCommentReceiptPayload, proof: ProviderReceiptProof): boolean;
}

export interface ProviderReceiptAuthenticator extends ProviderReceiptVerifier {
  sign(payload: ProviderCommentReceiptPayload): ProviderReceiptProof;
}

export class ProviderOutcomeUnknownError extends Error {
  readonly dispatchIdempotencyKey: string;

  constructor(dispatchIdempotencyKey: string, message = "Provider outcome is unknown") {
    super(message);
    this.name = "ProviderOutcomeUnknownError";
    this.dispatchIdempotencyKey = dispatchIdempotencyKey;
  }
}

export function createHmacProviderReceiptAuthenticator(
  keyId: string,
  secret: string | Uint8Array,
): ProviderReceiptAuthenticator {
  if (!keyId.trim()) throw new Error("Provider receipt keyId must not be blank");
  const key = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (key.byteLength < 32) throw new Error("Provider receipt HMAC key must contain at least 32 bytes");
  const signature = (payload: ProviderCommentReceiptPayload): string => createHmac("sha256", key)
    .update(canonicalizeEffectJson(payload), "utf8")
    .digest("base64url");
  const authenticator: ProviderReceiptAuthenticator = {
    algorithm: "hmac-sha256",
    keyId,
    sign(payload: ProviderCommentReceiptPayload) {
      return {
        algorithm: "hmac-sha256" as const,
        keyId,
        signature: signature(payload),
      };
    },
    verify(payload: ProviderCommentReceiptPayload, proof: ProviderReceiptProof) {
      if (proof.algorithm !== "hmac-sha256" || proof.keyId !== keyId) return false;
      const expected = Buffer.from(signature(payload), "utf8");
      const actual = Buffer.from(proof.signature, "utf8");
      return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
    },
  };
  return Object.freeze(authenticator);
}

export interface FetchWorkItemProviderOptions {
  baseUrl: string;
  accountRef: string;
  credentialRef: string;
  resolveCredential(reference: string): Promise<string> | string;
  fetch?: typeof globalThis.fetch;
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
    throw new Error(`${label} must be a portable provider reference`);
  }
  return value;
}

function unixMs(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return Number(value);
}

function safeProviderUrl(value: unknown, origin: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a URL`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error(`${label} must stay on the configured HTTPS provider origin`);
  }
  return parsed.href;
}

function parseSnapshot(input: unknown, accountRef: string, origin: string): ProviderWorkItemSnapshot {
  const value = exactObject(input, [
    "accountRef", "projectRef", "itemRef", "version", "state", "title", "updatedAt", "recordRef",
  ], "provider work item");
  if (value.accountRef !== accountRef) throw new Error("Provider work item account binding mismatch");
  const state = value.state;
  if (state !== "open" && state !== "closed") throw new Error("Provider work item state is unsupported");
  if (typeof value.title !== "string" || value.title.length > 8_192) {
    throw new Error("Provider work item title is invalid or too large");
  }
  return {
    accountRef,
    projectRef: portableRef(value.projectRef, "projectRef"),
    itemRef: portableRef(value.itemRef, "itemRef"),
    version: portableRef(value.version, "version"),
    state,
    title: value.title,
    updatedAt: unixMs(value.updatedAt, "updatedAt"),
    recordRef: safeProviderUrl(value.recordRef, origin, "recordRef"),
  };
}

function parseReceipt(input: unknown, accountRef: string, origin: string): ProviderCommentReceipt {
  const outer = exactObject(input, ["payload", "proof"], "provider comment receipt");
  const payload = exactObject(outer.payload, [
    "accountRef", "projectRef", "itemRef", "dispatchIdempotencyKey", "requestDigest",
    "providerOperationId", "outcome", "occurredAt", "receiptId", "rawRef", "coverage",
  ], "provider receipt payload");
  if (payload.accountRef !== accountRef) throw new Error("Provider receipt account binding mismatch");
  if (payload.outcome !== "committed" && payload.outcome !== "failed") {
    throw new Error("Provider receipt outcome is not terminal");
  }
  if (!Array.isArray(payload.coverage) || payload.coverage.some((value) => typeof value !== "string")) {
    throw new Error("Provider receipt coverage is invalid");
  }
  const proof = exactObject(outer.proof, ["algorithm", "keyId", "signature"], "provider receipt proof");
  if (proof.algorithm !== "hmac-sha256" || typeof proof.keyId !== "string" ||
    typeof proof.signature !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(proof.signature)) {
    throw new Error("Provider receipt proof is invalid");
  }
  const result: ProviderCommentReceipt = {
    payload: {
      accountRef,
      projectRef: portableRef(payload.projectRef, "projectRef"),
      itemRef: portableRef(payload.itemRef, "itemRef"),
      dispatchIdempotencyKey: portableRef(payload.dispatchIdempotencyKey, "dispatchIdempotencyKey"),
      requestDigest: typeof payload.requestDigest === "string" ? payload.requestDigest : "",
      providerOperationId: portableRef(payload.providerOperationId, "providerOperationId"),
      outcome: payload.outcome,
      occurredAt: unixMs(payload.occurredAt, "occurredAt"),
      receiptId: portableRef(payload.receiptId, "receiptId"),
      rawRef: safeProviderUrl(payload.rawRef, origin, "rawRef"),
      coverage: payload.coverage as ProviderCommentReceiptPayload["coverage"],
    },
    proof: {
      algorithm: "hmac-sha256",
      keyId: proof.keyId,
      signature: proof.signature,
    },
  };
  canonicalizeEffectJson(result);
  return result;
}

/**
 * Concrete HTTPS provider client. It owns credential resolution, pins every
 * request to one origin and uses manual redirect handling so credentials are
 * never forwarded to a redirect target.
 */
export function createFetchWorkItemProviderClient(
  options: FetchWorkItemProviderOptions,
): WorkItemProviderClient {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("Work-item provider baseUrl must be HTTPS without embedded credentials");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("A fetch implementation is required");
  portableRef(options.accountRef, "accountRef");
  if (!options.credentialRef.trim()) throw new Error("credentialRef must not be blank");

  const request = async (path: string, init: RequestInit, allowNotFound = false): Promise<unknown | null> => {
    const target = new URL(path, base);
    if (target.origin !== base.origin) throw new Error("Provider request escaped the configured origin");
    const credential = await options.resolveCredential(options.credentialRef);
    if (!credential.trim()) throw new Error("Resolved provider credential must not be blank");
    let response: Response;
    try {
      response = await fetcher(target, {
        ...init,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential}`,
          ...init.headers,
        },
      });
    } catch (error) {
      if (init.method === "POST") {
        const key = new Headers(init.headers).get("Idempotency-Key") ?? "unknown-dispatch";
        throw new ProviderOutcomeUnknownError(key, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    const dispatchKey = new Headers(init.headers).get("Idempotency-Key") ?? "unknown-dispatch";
    const rejectResponse = (message: string): never => {
      if (init.method === "POST") throw new ProviderOutcomeUnknownError(dispatchKey, message);
      throw new Error(message);
    };
    if (response.status >= 300 && response.status < 400) {
      rejectResponse("Provider redirects are refused; credentials were not forwarded");
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) rejectResponse(`Provider request failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) rejectResponse("Provider response exceeds size limit");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      rejectResponse("Provider response exceeds size limit");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return rejectResponse("Provider response is not valid JSON");
    }
  };

  const client: WorkItemProviderClient = {
    async readWorkItem(input: { projectRef: string; itemRef: string }) {
      const projectRef = portableRef(input.projectRef, "projectRef");
      const itemRef = portableRef(input.itemRef, "itemRef");
      const value = await request(
        `/v1/projects/${encodeURIComponent(projectRef)}/items/${encodeURIComponent(itemRef)}`,
        { method: "GET", cache: "no-store" },
      );
      return parseSnapshot(value, options.accountRef, base.origin);
    },
    async createComment(input: CreateProviderCommentInput) {
      const projectRef = portableRef(input.projectRef, "projectRef");
      const itemRef = portableRef(input.itemRef, "itemRef");
      const value = await request(
        `/v1/projects/${encodeURIComponent(projectRef)}/items/${encodeURIComponent(itemRef)}/comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.dispatchIdempotencyKey,
          },
          body: JSON.stringify({
            requestDigest: input.requestDigest,
            bodyBase64: input.bodyBase64,
            bodyDigest: input.bodyDigest,
          }),
        },
      );
      try {
        return parseReceipt(value, options.accountRef, base.origin);
      } catch (error) {
        throw new ProviderOutcomeUnknownError(
          input.dispatchIdempotencyKey,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    async lookupComment(dispatchIdempotencyKey: string) {
      const key = portableRef(dispatchIdempotencyKey, "dispatchIdempotencyKey");
      const value = await request(
        `/v1/comment-operations/${encodeURIComponent(key)}`,
        { method: "GET", cache: "no-store" },
        true,
      );
      return value == null ? null : parseReceipt(value, options.accountRef, base.origin);
    },
  };
  return Object.freeze(client);
}
