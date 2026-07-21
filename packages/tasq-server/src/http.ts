import { randomUUID } from "node:crypto";
import type { Clock } from "@tasq/schema";
import {
  ACTION_URIS,
  ResourceRef,
  VerifiedIdentity,
  digestAuthorityValue,
  getRegisteredAction,
  type AuthorizationDecision,
  type VerifiedIdentity as VerifiedIdentityValue,
} from "@tasq-internal/authority";
import { z } from "zod";
import type { IsolatedWorkspaceRouter } from "./router.js";
import { AuthorityStoreError } from "./store.js";

export const HOSTED_READ_HTTP_CONTRACT_VERSION = "tasq.hosted-read-http.v1" as const;
export const HOSTED_READ_HTTP_IMPLEMENTATION_DIGEST = digestAuthorityValue({
  contractVersion: HOSTED_READ_HTTP_CONTRACT_VERSION,
  discovery: "rfc9728",
  methods: ["GET"],
  routes: ["commitment", "commitments", "event_metadata"],
  scopes: [ACTION_URIS["commitment.read"], ACTION_URIS["workspace.read"]].sort(),
  bounds: { identifierMaximum: 500, pageDefault: 50, pageMaximum: 100 },
  input: "unique_bounded_query_and_credential_envelope_before_guard",
  output: "route_bound_identity_workspace_page_limit_and_exclusive_cursor",
  bearerMethods: ["header"],
  workspacePath: "single_percent_encoded_segment",
  authorization: "live_tq802_guard_after_verification",
  clock: "one_injected_snapshot_per_request",
});
export const HOSTED_MUTATION_HTTP_CONTRACT_VERSION = "tasq.hosted-mutation-http.v1" as const;
export const HOSTED_MUTATION_HTTP_IMPLEMENTATION_DIGEST = digestAuthorityValue({
  contractVersion: HOSTED_MUTATION_HTTP_CONTRACT_VERSION,
  method: "POST",
  route: "workspace_scoped_registered_operation",
  discovery: "public_state_free_operation_catalog",
  authorization: "begin_immediate_live_guard_held_through_durable_workspace_callback",
  concurrency: "host_declared_revision_requirement_and_competing_authority_writer_typed_retry",
  idempotency: "required_subject_actor_action_scoped_key_plus_semantic_request_digest",
  uncertainty: "committed_domain_without_bound_outcome_requires_exact_retry",
  bounds: { bodyBytes: 262_144, portableDepth: 32, portableNodes: 10_000 },
  clock: "one_injected_snapshot_per_request",
});

const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Opaque = z.string().min(1).max(500).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const Cursor = z.string().min(1).max(2_000);
const CredentialHeader = z.string().min(1).max(32_768);

export const HostedCommitmentRead = z.object({
  id: Opaque,
  workspaceId: WorkspaceId,
  title: z.string().min(1).max(10_000),
  status: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict();
export type HostedCommitmentRead = z.infer<typeof HostedCommitmentRead>;

function parseWorkspaceCommitment(value: unknown, workspaceId: string): HostedCommitmentRead {
  const parsed = HostedCommitmentRead.parse(value);
  if (parsed.workspaceId !== workspaceId) throw new Error("hosted commitment workspace mismatch");
  return parsed;
}

function parseExactCommitment(value: unknown, workspaceId: string, commitmentId: string): HostedCommitmentRead {
  const parsed = parseWorkspaceCommitment(value, workspaceId);
  if (parsed.id !== commitmentId) throw new Error("hosted commitment identity mismatch");
  return parsed;
}

export const HostedEventMetadata = z.object({
  id: Opaque,
  sequence: z.number().int().positive(),
  entityType: z.string().min(1).max(100),
  entityId: Opaque,
  eventType: z.string().min(1).max(200),
  actorPrincipalId: Opaque.nullable(),
  createdAt: UnixMs,
}).strict();
export type HostedEventMetadata = z.infer<typeof HostedEventMetadata>;

export interface HostedReadWorkspace {
  workspaceId: string;
  getCommitment(id: string): Promise<HostedCommitmentRead | null>;
  listCommitments(input: { cursor: string | null; limit: number }): Promise<{
    items: HostedCommitmentRead[];
    nextCursor: string | null;
  }>;
  listEventMetadata(input: { afterSequence: number; limit: number }): Promise<{
    items: HostedEventMetadata[];
    nextSequence: number | null;
  }>;
}

export interface CredentialVerificationInput {
  authorization: string;
  dpopProof: string | null;
  method: "GET" | "POST";
  requestUrl: string;
  expectedAudience: string;
}

export interface CredentialVerifier {
  verify(input: CredentialVerificationInput, clock: Clock): Promise<VerifiedIdentityValue>;
}

export class CredentialVerificationError extends Error {
  constructor(readonly code: "missing_token" | "invalid_token" | "temporarily_unavailable") {
    super(code);
    this.name = "CredentialVerificationError";
  }
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
  scopes_supported: string[];
  resource_documentation?: string;
  dpop_signing_alg_values_supported?: string[];
  tasq_operation_catalog?: string;
}

export interface HostedReadHttpOptions {
  protectedResource: string;
  authorizationServers: string[];
  resourceDocumentation?: string;
  dpopSigningAlgorithms?: string[];
  clock: Clock;
  verifier: CredentialVerifier;
  router: IsolatedWorkspaceRouter<HostedReadWorkspace>;
  requestIdFactory?: () => string;
}

type Route =
  | { kind: "metadata" }
  | { kind: "commitments"; workspaceId: string }
  | { kind: "commitment"; workspaceId: string; commitmentId: string }
  | { kind: "events"; workspaceId: string }
  | { kind: "missing" };

type ReadRoute = Exclude<Route, { kind: "metadata" | "missing" }>;
type ParsedQuery =
  | { kind: "commitment" }
  | { kind: "commitments"; cursor: string | null; limit: number }
  | { kind: "events"; afterSequence: number; limit: number };

function canonicalHttps(value: string, allowPath: boolean): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("hosted resource URLs must be canonical HTTPS URLs without credentials, query or fragment");
  }
  if (!allowPath && url.pathname !== "/") throw new Error("authorization server issuer must not contain a path");
  if (url.href !== value) throw new Error("hosted resource URLs must be canonical");
  return value;
}

function metadataPath(resource: URL): string {
  const suffix = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  return `/.well-known/oauth-protected-resource${suffix}`;
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") || decoded.includes("\\") ? null : Opaque.safeParse(decoded).success ? decoded : null;
  } catch {
    return null;
  }
}

function decodeWorkspaceSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("\\") || !WorkspaceId.safeParse(decoded).success ? null : decoded;
  } catch {
    return null;
  }
}

function route(url: URL, protectedResource: URL): Route {
  if (url.pathname === metadataPath(protectedResource)) return { kind: "metadata" };
  const prefix = protectedResource.pathname === "/" ? "" : protectedResource.pathname.replace(/\/$/, "");
  if (!url.pathname.startsWith(`${prefix}/v1/workspaces/`)) return { kind: "missing" };
  const remainder = url.pathname.slice(`${prefix}/v1/workspaces/`.length);
  const parts = remainder.split("/");
  // Split the raw path before decoding so an encoded slash remains part of one
  // opaque workspace identifier while a literal slash remains a route boundary.
  const workspaceId = parts[0] ? decodeWorkspaceSegment(parts[0]) : null;
  if (!workspaceId) return { kind: "missing" };
  if (parts.length === 2 && parts[1] === "commitments") return { kind: "commitments", workspaceId };
  if (parts.length === 3 && parts[1] === "commitments") {
    const commitmentId = decodeSegment(parts[2]!);
    return commitmentId ? { kind: "commitment", workspaceId, commitmentId } : { kind: "missing" };
  }
  if (parts.length === 2 && parts[1] === "events") return { kind: "events", workspaceId };
  return { kind: "missing" };
}

function jsonResponse(body: unknown, status: number, now: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "cache-control": status === 200 ? "private, no-store" : "no-store",
      date: new Date(now).toUTCString(),
      ...extra,
    },
  });
}

function problem(
  status: number,
  code: string,
  requestId: string,
  now: number,
  extraHeaders: Record<string, string> = {},
  decisionId?: string,
): Response {
  return jsonResponse({
    contractVersion: "tasq.hosted-problem.v1",
    code,
    requestId,
    decisionId: decisionId ?? null,
  }, status, now, extraHeaders);
}

function parseBoundedInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseQuery(url: URL, matched: ReadRoute): ParsedQuery | null {
  if (matched.kind === "commitment") {
    return url.search === "" ? { kind: "commitment" } : null;
  }
  const allowed = matched.kind === "commitments" ? new Set(["cursor", "limit"]) : new Set(["after", "limit"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
  if ([...allowed].some((key) => url.searchParams.getAll(key).length > 1)) return null;
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 100);
  if (limit === null) return null;
  if (matched.kind === "commitments") {
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? null : Cursor.safeParse(rawCursor).success ? rawCursor : null;
    return rawCursor !== null && cursor === null ? null : { kind: "commitments", cursor, limit };
  }
  const afterSequence = parseBoundedInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  return afterSequence === null ? null : { kind: "events", afterSequence, limit };
}

function createHostedReadHandlerWithExtensions(
  options: HostedReadHttpOptions,
  extension: { scopeUris?: string[]; operationCatalogUrl?: string } = {},
): (request: Request) => Promise<Response> {
  const resourceValue = canonicalHttps(options.protectedResource, true);
  const resource = new URL(resourceValue);
  const authorizationServers = options.authorizationServers.map((value) => canonicalHttps(value, true));
  if (authorizationServers.length === 0 || new Set(authorizationServers).size !== authorizationServers.length) {
    throw new Error("hosted read handler requires unique authorization servers");
  }
  const metadataUrl = new URL(metadataPath(resource), resource.origin).href;
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const metadata: ProtectedResourceMetadata = {
    resource: resourceValue,
    authorization_servers: [...authorizationServers].sort(),
    bearer_methods_supported: ["header"],
    resource_name: "Tasq hosted read API",
    scopes_supported: [...new Set([
      ACTION_URIS["commitment.read"], ACTION_URIS["workspace.read"], ...(extension.scopeUris ?? []),
    ])].sort(),
    ...(options.resourceDocumentation ? { resource_documentation: canonicalHttps(options.resourceDocumentation, true) } : {}),
    ...(options.dpopSigningAlgorithms?.length
      ? { dpop_signing_alg_values_supported: [...new Set(options.dpopSigningAlgorithms)].sort() }
      : {}),
    ...(extension.operationCatalogUrl ? { tasq_operation_catalog: extension.operationCatalogUrl } : {}),
  };

  return async (request) => {
    const now = UnixMs.parse(options.clock.now());
    const suppliedRequestId = request.headers.get("x-tasq-request-id");
    const parsedRequestId = suppliedRequestId === null ? null : Opaque.safeParse(suppliedRequestId);
    const requestId = parsedRequestId?.success ? parsedRequestId.data : Opaque.parse(requestIdFactory());
    if (parsedRequestId && !parsedRequestId.success) return problem(400, "invalid_request_id", requestId, now);
    const url = new URL(request.url);
    if (url.origin !== resource.origin) return problem(400, "invalid_resource_origin", requestId, now);
    const matched = route(url, resource);
    if (matched.kind === "missing") return problem(404, "not_found", requestId, now);
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", requestId, now, { allow: "GET" });
    }
    if (matched.kind === "metadata") {
      if (url.search !== "") return problem(400, "invalid_query", requestId, now);
      return jsonResponse(metadata, 200, now, { "cache-control": "public, max-age=300" });
    }

    // Reject malformed input before credential verification, authority access,
    // or opening any tenant storage.
    const query = parseQuery(url, matched);
    if (!query) return problem(400, "invalid_query", requestId, now);

    const authorization = request.headers.get("authorization");
    const challenge = { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` };
    if (!authorization) return problem(401, "authentication_required", requestId, now, challenge);
    const dpopProof = request.headers.get("dpop");
    if (!CredentialHeader.safeParse(authorization).success || (dpopProof !== null && !CredentialHeader.safeParse(dpopProof).success)) {
      return problem(400, "invalid_credential_envelope", requestId, now);
    }
    let identity: VerifiedIdentityValue;
    try {
      identity = VerifiedIdentity.parse(await options.verifier.verify({
        authorization,
        dpopProof,
        method: "GET",
        requestUrl: url.href,
        expectedAudience: resourceValue,
      }, { now: () => now }));
    } catch (error) {
      if (error instanceof CredentialVerificationError && error.code === "temporarily_unavailable") {
        return problem(503, "authentication_unavailable", requestId, now);
      }
      return problem(401, "invalid_token", requestId, now, {
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
      });
    }
    const registered = getRegisteredAction(matched.kind === "commitment" ? ACTION_URIS["commitment.read"] : ACTION_URIS["workspace.read"]);
    if (!registered) throw new Error("read action registry is incomplete");
    const action = { uri: registered.uri, version: registered.version, implementationDigest: registered.implementationDigest };
    const resourceRef = matched.kind === "commitment"
      ? { kind: "commitment" as const, id: matched.commitmentId }
      : { kind: "workspace" as const, id: matched.workspaceId };
    let routed;
    try {
      routed = await options.router.authorizeAndOpenAt({
        requestId,
        workspaceId: matched.workspaceId,
        serviceAudience: resourceValue,
        action,
        resource: resourceRef,
        identity,
      }, now);
    } catch {
      return problem(503, "authority_unavailable", requestId, now);
    }
    if (routed.decision.decision !== "allow" || !routed.workspace) {
      return problem(403, "access_denied", requestId, now, {}, routed.decision.decisionId);
    }
    if (routed.workspace.workspaceId !== matched.workspaceId) {
      return problem(500, "workspace_binding_mismatch", requestId, now);
    }

    if (matched.kind === "commitment") {
      let item;
      try {
        item = await routed.workspace.getCommitment(matched.commitmentId);
      } catch {
        return problem(500, "read_failed", requestId, now, {}, routed.decision.decisionId);
      }
      if (!item) return problem(404, "not_found", requestId, now, {}, routed.decision.decisionId);
      try {
        return jsonResponse({
          contractVersion: "tasq.hosted-commitment.v1", requestId, decisionId: routed.decision.decisionId,
          evaluatedAt: now, item: parseExactCommitment(item, matched.workspaceId, matched.commitmentId),
        }, 200, now);
      } catch {
        return problem(500, "read_contract_violation", requestId, now, {}, routed.decision.decisionId);
      }
    }
    if (matched.kind === "commitments") {
      if (query.kind !== "commitments") throw new Error("route query mismatch");
      try {
        const page = await routed.workspace.listCommitments({ cursor: query.cursor, limit: query.limit });
        const items = z.array(z.unknown()).max(query.limit).parse(page.items)
          .map((item) => parseWorkspaceCommitment(item, matched.workspaceId));
        const nextCursor = page.nextCursor === null ? null : Cursor.parse(page.nextCursor);
        if (items.length === 0 && nextCursor !== null) throw new Error("empty commitment page cannot advance");
        return jsonResponse({
          contractVersion: "tasq.hosted-commitment-page.v1", requestId,
          decisionId: routed.decision.decisionId, evaluatedAt: now,
          items,
          nextCursor,
        }, 200, now);
      } catch {
        return problem(500, "read_contract_violation", requestId, now, {}, routed.decision.decisionId);
      }
    }
    if (query.kind !== "events") throw new Error("route query mismatch");
    try {
      const page = await routed.workspace.listEventMetadata({ afterSequence: query.afterSequence, limit: query.limit });
      const items = z.array(HostedEventMetadata).max(query.limit).parse(page.items);
      if (items.some((item, index) => item.sequence <= query.afterSequence
        || (index > 0 && item.sequence <= items[index - 1]!.sequence))) {
        throw new Error("event metadata is not an exclusive increasing page");
      }
      const nextSequence = page.nextSequence === null ? null : z.number().int().positive().parse(page.nextSequence);
      if ((items.length === 0 && nextSequence !== null)
        || (items.length > 0 && nextSequence !== items[items.length - 1]!.sequence)) {
        throw new Error("event metadata cursor does not bind the page tail");
      }
      return jsonResponse({
        contractVersion: "tasq.hosted-event-metadata-page.v1", requestId,
        decisionId: routed.decision.decisionId, evaluatedAt: now,
        items,
        nextSequence,
      }, 200, now);
    } catch {
      return problem(500, "read_contract_violation", requestId, now, {}, routed.decision.decisionId);
    }
  };
}

export function createHostedReadHandler(options: HostedReadHttpOptions): (request: Request) => Promise<Response> {
  return createHostedReadHandlerWithExtensions(options);
}

const OperationId = z.string().min(1).max(100).regex(/^[a-z][a-z0-9._-]*$/);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ContractIdentity = z.object({
  uri: z.string().min(1).max(500).refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.href === value && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }),
  version: z.number().int().positive(),
  implementationDigest: Digest,
}).strict();

export const HostedMutationOperation = z.object({
  id: OperationId,
  actionUri: z.string().min(1).max(500),
  summary: z.string().min(1).max(500),
  inputContract: ContractIdentity,
  outputContract: ContractIdentity,
  requiresExpectedRevision: z.boolean(),
}).strict();
export type HostedMutationOperation = z.infer<typeof HostedMutationOperation>;

const HostedMutationEnvelope = z.object({
  contractVersion: z.literal("tasq.hosted-mutation-request.v1"),
  resource: ResourceRef,
  expectedRevision: z.number().int().positive().nullable().default(null),
  input: z.unknown(),
}).strict();

const HostedMutationOutcomeSchema = z.object({
  contractVersion: z.literal("tasq.hosted-mutation-outcome.v1"),
  workspaceId: WorkspaceId,
  operationId: OperationId,
  requestDigest: Digest,
  idempotencyKeyDigest: Digest,
  resultType: Opaque,
  resultId: Opaque,
  resultRevision: z.number().int().positive().nullable(),
  eventSequence: z.number().int().positive().nullable(),
  replayed: z.boolean(),
  result: z.unknown(),
}).strict();
export type HostedMutationOutcome = z.infer<typeof HostedMutationOutcomeSchema>;

export interface HostedMutationCommand {
  contractVersion: "tasq.hosted-mutation-command.v1";
  operation: HostedMutationOperation;
  workspaceId: string;
  resource: z.infer<typeof ResourceRef>;
  expectedRevision: number | null;
  input: unknown;
  requestDigest: string;
  idempotencyKey: string;
  idempotencyKeyDigest: string;
  evaluatedAt: number;
  authorityRevision: number;
  decision: AuthorizationDecision;
}

export interface HostedMutationWorkspace extends HostedReadWorkspace {
  executeMutation(command: HostedMutationCommand): Promise<HostedMutationOutcome>;
}

export class HostedMutationError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "indeterminate" | "unavailable") {
    super(code);
    this.name = "HostedMutationError";
  }
}

export interface HostedHttpOptions extends Omit<HostedReadHttpOptions, "router"> {
  router: IsolatedWorkspaceRouter<HostedMutationWorkspace>;
  mutationOperations: HostedMutationOperation[];
}

type MutationRoute = { workspaceId: string; operationId: string } | null;
const MAX_MUTATION_BODY_BYTES = 256 * 1024;
const MAX_PORTABLE_NODES = 10_000;
const MAX_PORTABLE_DEPTH = 32;

function mutationRoute(url: URL, protectedResource: URL): MutationRoute {
  const prefix = protectedResource.pathname === "/" ? "" : protectedResource.pathname.replace(/\/$/, "");
  if (!url.pathname.startsWith(`${prefix}/v1/workspaces/`)) return null;
  const remainder = url.pathname.slice(`${prefix}/v1/workspaces/`.length);
  const parts = remainder.split("/");
  if (parts.length !== 3 || parts[1] !== "operations") return null;
  const workspaceId = parts[0] ? decodeWorkspaceSegment(parts[0]) : null;
  const operationId = parts[2] ? decodeSegment(parts[2]) : null;
  return workspaceId && operationId && OperationId.safeParse(operationId).success
    ? { workspaceId, operationId }
    : null;
}

function validatePortableValue(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_PORTABLE_NODES || current.depth > MAX_PORTABLE_DEPTH) {
      throw new HostedMutationError("invalid_input");
    }
    if (current.value === null || typeof current.value === "boolean" || typeof current.value === "string") continue;
    if (typeof current.value === "number") {
      if (!Number.isSafeInteger(current.value)) throw new HostedMutationError("invalid_input");
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) pending.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value === "object" && Object.getPrototypeOf(current.value) === Object.prototype) {
      for (const entry of Object.values(current.value)) pending.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    throw new HostedMutationError("invalid_input");
  }
}

async function readMutationEnvelope(request: Request): Promise<z.infer<typeof HostedMutationEnvelope>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HostedMutationError("invalid_input");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = parseBoundedInteger(declaredLength, 0, 0, MAX_MUTATION_BODY_BYTES);
    if (parsed === null) throw new HostedMutationError("invalid_input");
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let body = "";
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > MAX_MUTATION_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new HostedMutationError("invalid_input");
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    }
  } catch (error) {
    if (error instanceof HostedMutationError) throw error;
    throw new HostedMutationError("invalid_input");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new HostedMutationError("invalid_input");
  }
  const parsedEnvelope = HostedMutationEnvelope.safeParse(decoded);
  if (!parsedEnvelope.success) throw new HostedMutationError("invalid_input");
  const envelope = parsedEnvelope.data;
  validatePortableValue(envelope.input);
  return envelope;
}

function exactOutcome(
  value: unknown,
  expected: { workspaceId: string; operationId: string; requestDigest: string; idempotencyKeyDigest: string },
): HostedMutationOutcome {
  try {
    const parsed = HostedMutationOutcomeSchema.parse(value);
    if (parsed.workspaceId !== expected.workspaceId || parsed.operationId !== expected.operationId
      || parsed.requestDigest !== expected.requestDigest || parsed.idempotencyKeyDigest !== expected.idempotencyKeyDigest) {
      throw new Error("hosted mutation outcome binding mismatch");
    }
    validatePortableValue(parsed.result);
    if (new TextEncoder().encode(JSON.stringify(parsed.result)).byteLength > MAX_MUTATION_BODY_BYTES) {
      throw new Error("hosted mutation outcome exceeds the response bound");
    }
    return parsed;
  } catch {
    // The host may already have committed before returning a corrupt or lost
    // receipt. Never recast that boundary as a safe client error.
    throw new HostedMutationError("indeterminate");
  }
}

function mutationProblem(error: unknown, requestId: string, now: number): Response {
  if (error instanceof HostedMutationError) {
    if (error.code === "invalid_input") return problem(400, "invalid_mutation", requestId, now);
    if (error.code === "not_found") return problem(404, "not_found", requestId, now);
    if (error.code === "conflict") return problem(409, "mutation_conflict", requestId, now);
    if (error.code === "indeterminate") {
      return problem(503, "mutation_outcome_unknown", requestId, now, { "retry-after": "0" });
    }
    return problem(503, "workspace_unavailable", requestId, now);
  }
  if (error instanceof AuthorityStoreError
    && (error.code === "revision_conflict" || error.code === "idempotency_conflict")) {
    return problem(409, "authority_changed", requestId, now);
  }
  if (error instanceof AuthorityStoreError && error.code === "authority_busy") {
    return problem(503, "authority_busy", requestId, now, { "retry-after": "0" });
  }
  return problem(503, "authority_unavailable", requestId, now);
}

export function createHostedHttpHandler(options: HostedHttpOptions): (request: Request) => Promise<Response> {
  const resourceValue = canonicalHttps(options.protectedResource, true);
  const resource = new URL(resourceValue);
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const operations = options.mutationOperations.map((value) => HostedMutationOperation.parse(value));
  if (operations.length === 0 || operations.length > 64 || new Set(operations.map(({ id }) => id)).size !== operations.length) {
    throw new Error("hosted HTTP requires between one and 64 unique mutation operations");
  }
  const registered = new Map(operations.map((operation) => {
    const action = getRegisteredAction(operation.actionUri);
    if (!action || action.uri === ACTION_URIS["workspace.read"] || action.uri === ACTION_URIS["commitment.read"]
      || action.uri === ACTION_URIS["replication.pull"]) {
      throw new Error(`hosted mutation operation ${operation.id} does not map to a registered mutation action`);
    }
    return [operation.id, { operation: Object.freeze({ ...operation }), action }] as const;
  }));
  const prefix = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  const catalogUrl = new URL(`${prefix}/v1/operations`, resource.origin).href;
  const metadataUrl = new URL(metadataPath(resource), resource.origin).href;
  const readHandler = createHostedReadHandlerWithExtensions(options, {
    scopeUris: [...registered.values()].map(({ action }) => action.uri),
    operationCatalogUrl: catalogUrl,
  });
  const catalog = {
    contractVersion: "tasq.hosted-operation-catalog.v1",
    operations: [...registered.values()].map(({ operation, action }) => ({
      ...operation,
      action: { uri: action.uri, version: action.version, implementationDigest: action.implementationDigest },
      resourceKinds: action.resourceKinds,
      senderConstraint: action.senderConstraint,
      eligibility: action.eligibility,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.origin === resource.origin && url.pathname === new URL(catalogUrl).pathname) {
        const now = UnixMs.parse(options.clock.now());
        const generated = Opaque.parse(requestIdFactory());
        if (url.search !== "") return problem(400, "invalid_query", generated, now);
        return jsonResponse(catalog, 200, now, { "cache-control": "public, max-age=300" });
      }
      return readHandler(request);
    }

    const now = UnixMs.parse(options.clock.now());
    const suppliedRequestId = request.headers.get("x-tasq-request-id");
    const parsedRequestId = suppliedRequestId === null ? null : Opaque.safeParse(suppliedRequestId);
    const requestId = parsedRequestId?.success ? parsedRequestId.data : Opaque.parse(requestIdFactory());
    if (parsedRequestId && !parsedRequestId.success) return problem(400, "invalid_request_id", requestId, now);
    if (url.origin !== resource.origin) return problem(400, "invalid_resource_origin", requestId, now);
    const matched = mutationRoute(url, resource);
    if (!matched) return problem(404, "not_found", requestId, now);
    if (request.method !== "POST") return problem(405, "method_not_allowed", requestId, now, { allow: "POST" });
    if (url.search !== "") return problem(400, "invalid_query", requestId, now);
    const selected = registered.get(matched.operationId);
    if (!selected) return problem(404, "unknown_operation", requestId, now);

    const authorization = request.headers.get("authorization");
    const dpopProof = request.headers.get("dpop");
    if (!authorization) {
      return problem(401, "authentication_required", requestId, now, {
        "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      });
    }
    if (!CredentialHeader.safeParse(authorization).success || (dpopProof !== null && !CredentialHeader.safeParse(dpopProof).success)) {
      return problem(400, "invalid_credential_envelope", requestId, now);
    }
    const rawIdempotencyKey = request.headers.get("idempotency-key");
    const idempotencyKey = rawIdempotencyKey === null ? null : Opaque.safeParse(rawIdempotencyKey);
    if (!idempotencyKey?.success) return problem(400, "idempotency_key_required", requestId, now);

    let envelope: z.infer<typeof HostedMutationEnvelope>;
    try {
      envelope = await readMutationEnvelope(request);
    } catch (error) {
      return mutationProblem(error, requestId, now);
    }
    if (!selected.action.resourceKinds.includes(envelope.resource.kind)) {
      return problem(400, "invalid_resource_kind", requestId, now);
    }
    if (selected.operation.requiresExpectedRevision && envelope.expectedRevision === null) {
      return problem(400, "expected_revision_required", requestId, now);
    }
    if (envelope.resource.kind === "workspace" && envelope.resource.id !== matched.workspaceId) {
      return problem(400, "workspace_binding_mismatch", requestId, now);
    }

    let identity: VerifiedIdentityValue;
    try {
      identity = VerifiedIdentity.parse(await options.verifier.verify({
        authorization,
        dpopProof,
        method: "POST",
        requestUrl: url.href,
        expectedAudience: resourceValue,
      }, { now: () => now }));
    } catch (error) {
      if (error instanceof CredentialVerificationError && error.code === "temporarily_unavailable") {
        return problem(503, "authentication_unavailable", requestId, now);
      }
      return problem(401, "invalid_token", requestId, now, {
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
      });
    }
    const idempotencyKeyDigest = digestAuthorityValue({
      contractVersion: "tasq.hosted-idempotency-key.v1",
      workspaceId: matched.workspaceId,
      subject: { issuer: identity.issuer, subject: identity.subject },
      actor: identity.actor,
      action: {
        uri: selected.action.uri,
        version: selected.action.version,
        implementationDigest: selected.action.implementationDigest,
      },
      key: idempotencyKey.data,
    });
    const requestDigest = digestAuthorityValue({
      contractVersion: "tasq.hosted-mutation-request-digest.v1",
      workspaceId: matched.workspaceId,
      operation: selected.operation,
      action: {
        uri: selected.action.uri,
        version: selected.action.version,
        implementationDigest: selected.action.implementationDigest,
      },
      resource: envelope.resource,
      expectedRevision: envelope.expectedRevision,
      input: envelope.input,
    });

    try {
      const routed = await options.router.authorizeAndExecuteAt({
        requestId,
        workspaceId: matched.workspaceId,
        serviceAudience: resourceValue,
        action: {
          uri: selected.action.uri,
          version: selected.action.version,
          implementationDigest: selected.action.implementationDigest,
        },
        resource: envelope.resource,
        identity,
      }, now, async (workspace, authority) => {
        if (authority.authorityRevision === null) throw new Error("allowed mutation has no authority revision");
        const outcome = await workspace.executeMutation({
          contractVersion: "tasq.hosted-mutation-command.v1",
          operation: selected.operation,
          workspaceId: matched.workspaceId,
          resource: envelope.resource,
          expectedRevision: envelope.expectedRevision,
          input: envelope.input,
          requestDigest,
          idempotencyKey: idempotencyKey.data,
          idempotencyKeyDigest,
          evaluatedAt: now,
          authorityRevision: authority.authorityRevision,
          decision: authority.decision,
        });
        return exactOutcome(outcome, {
          workspaceId: matched.workspaceId,
          operationId: selected.operation.id,
          requestDigest,
          idempotencyKeyDigest,
        });
      });
      if (routed.decision.decision !== "allow" || routed.execution === null) {
        return problem(403, "access_denied", requestId, now, {}, routed.decision.decisionId);
      }
      return jsonResponse({
        contractVersion: "tasq.hosted-mutation-response.v1",
        requestId,
        decisionId: routed.decision.decisionId,
        evaluatedAt: now,
        authorityRevision: routed.authorityRevision,
        outcome: routed.execution,
      }, 200, now);
    } catch (error) {
      return mutationProblem(error, requestId, now);
    }
  };
}
