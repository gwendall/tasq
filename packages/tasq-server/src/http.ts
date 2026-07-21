import { randomUUID } from "node:crypto";
import type { Clock } from "@tasq/schema";
import {
  ACTION_URIS,
  VerifiedIdentity,
  digestAuthorityValue,
  getRegisteredAction,
  type VerifiedIdentity as VerifiedIdentityValue,
} from "@tasq-internal/authority";
import { z } from "zod";
import type { IsolatedWorkspaceRouter } from "./router.js";

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
  method: "GET";
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

export function createHostedReadHandler(options: HostedReadHttpOptions): (request: Request) => Promise<Response> {
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
    scopes_supported: [ACTION_URIS["commitment.read"], ACTION_URIS["workspace.read"]].sort(),
    ...(options.resourceDocumentation ? { resource_documentation: canonicalHttps(options.resourceDocumentation, true) } : {}),
    ...(options.dpopSigningAlgorithms?.length
      ? { dpop_signing_alg_values_supported: [...new Set(options.dpopSigningAlgorithms)].sort() }
      : {}),
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
