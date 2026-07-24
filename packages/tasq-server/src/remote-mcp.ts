import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ResourceRef,
  VerifiedIdentity,
  digestAuthorityValue,
  type VerifiedIdentity as VerifiedIdentityValue,
} from "@tasq-internal/authority";
import { z } from "zod";
import {
  CredentialVerificationError,
  createHostedHttpHandler,
  type HostedHttpOptions,
  type HostedMutationOperation,
} from "./http.js";

export const HOSTED_MCP_CONTRACT_VERSION = "tasq.hosted-mcp.v1" as const;
export const HOSTED_MCP_IMPLEMENTATION_DIGEST = digestAuthorityValue({
  contractVersion: HOSTED_MCP_CONTRACT_VERSION,
  transport: "stateless_streamable_http_json_response",
  route: "workspace_scoped_mcp",
  authentication: "exact_request_then_raw_credential_discarded",
  authority: "projected_tq803_tq804_handler_and_live_adr004_guard",
  reads: ["commitment.get", "commitment.list", "event.list"],
  eventCursorQuery: "after_exclusive_sequence",
  mutations: "one_collision_checked_tool_per_host_registered_operation",
  idempotency: "mandatory_tq804_subject_actor_action_scoped_key",
  sessions: "none_event_cursor_is_durable_resume",
  clock: "one_injected_snapshot_per_mcp_http_request",
});

const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const Opaque = z.string().min(1).max(500)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const CredentialHeader = z.string().min(1).max(32_768);
const Cursor = z.string().min(1).max(2_000);
const IdempotencyKey = z.string().min(1).max(500)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));

function canonicalHttps(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("hosted MCP resource must be canonical HTTPS without credentials, query or fragment");
  }
  if (url.href !== value) throw new Error("hosted MCP resource URL must be canonical");
  return value;
}

function metadataPath(resource: URL): string {
  const suffix = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  return `/.well-known/oauth-protected-resource${suffix}`;
}

function decodeWorkspaceSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("\\") || !WorkspaceId.safeParse(decoded).success ? null : decoded;
  } catch {
    return null;
  }
}

function mcpRoute(url: URL, resource: URL): string | null {
  const prefix = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  const routePrefix = `${prefix}/v1/workspaces/`;
  if (!url.pathname.startsWith(routePrefix)) return null;
  const parts = url.pathname.slice(routePrefix.length).split("/");
  if (parts.length !== 2 || parts[1] !== "mcp" || !parts[0]) return null;
  return decodeWorkspaceSegment(parts[0]);
}

function jsonResponse(body: unknown, status: number, now: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      date: new Date(now).toUTCString(),
      ...headers,
    },
  });
}

function problem(
  status: number,
  code: string,
  requestId: string,
  now: number,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({
    contractVersion: "tasq.hosted-mcp-problem.v1",
    status: "error",
    code,
    requestId,
    evaluatedAt: now,
  }, status, now, headers);
}

function toolResult(value: unknown) {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(value: unknown) {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { contractVersion: "tasq.hosted-mcp-tool-problem.v1", code: "operation_failed" };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function operationToolName(operation: HostedMutationOperation): string {
  return `tasq_operation_${operation.id.replace(/[._-]/g, "_")}`;
}

function validateOperationToolNames(operations: HostedMutationOperation[]): void {
  const names = operations.map(operationToolName);
  if (new Set(names).size !== names.length) {
    throw new Error("hosted MCP operation IDs normalize to colliding tool names");
  }
}

function withResponseHeaders(response: Response, now: number): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("date", new Date(now).toUTCString());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withoutCredentialHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("dpop");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function createRequestInvoker(
  options: HostedHttpOptions,
  identity: VerifiedIdentityValue,
  now: number,
): (request: Request) => Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>> {
  const handler = createHostedHttpHandler({
    ...options,
    clock: { now: () => now },
    verifier: {
      async verify() {
        return identity;
      },
    },
  });
  return async (request) => {
    try {
      const response = await handler(request);
      const body = await response.json().catch(() => ({
        contractVersion: "tasq.hosted-mcp-tool-problem.v1",
        status: "error",
        code: "invalid_server_response",
      }));
      return response.ok ? toolResult(body) : toolError(body);
    } catch {
      return toolError({
        contractVersion: "tasq.hosted-mcp-tool-problem.v1",
        status: "error",
        code: "server_unavailable",
      });
    }
  };
}

function createRequestServer(
  options: HostedHttpOptions,
  workspaceId: string,
  identity: VerifiedIdentityValue,
  now: number,
): McpServer {
  const resource = new URL(options.protectedResource);
  const prefix = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  const encodedWorkspace = encodeURIComponent(workspaceId);
  const invoke = createRequestInvoker(options, identity, now);
  const authenticatedHeaders = {
    authorization: "Bearer host-verified-mcp-identity",
  };
  const server = new McpServer({
    name: "tasq-server",
    version: "0.1.0",
  }, {
    instructions: [
      "This remote MCP connection is bound to one authenticated Tasq workspace.",
      "Tool presence is not authority; every call passes a fresh live Server authorization decision.",
      "A successful attempt or external protocol task never completes a commitment implicitly.",
    ].join(" "),
  });

  server.registerTool("tasq_commitment_list", {
    description: "List bounded commitments in the authenticated workspace.",
    inputSchema: {
      cursor: Cursor.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, ({ cursor, limit }) => invoke(new Request(new URL(
    `${prefix}/v1/workspaces/${encodedWorkspace}/commitments${cursor || limit
      ? `?${new URLSearchParams({
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }).toString()}`
      : ""}`,
    resource.origin,
  ), { headers: authenticatedHeaders })));

  server.registerTool("tasq_commitment_get", {
    description: "Get one commitment from the authenticated workspace.",
    inputSchema: { commitmentId: Opaque },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, ({ commitmentId }) => invoke(new Request(new URL(
    `${prefix}/v1/workspaces/${encodedWorkspace}/commitments/${encodeURIComponent(commitmentId)}`,
    resource.origin,
  ), { headers: authenticatedHeaders })));

  server.registerTool("tasq_event_list", {
    description: "Read payload-free event metadata after an exclusive sequence cursor.",
    inputSchema: {
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, ({ afterSequence, limit }) => invoke(new Request(new URL(
    `${prefix}/v1/workspaces/${encodedWorkspace}/events?${new URLSearchParams({
      after: String(afterSequence ?? 0),
      ...(limit ? { limit: String(limit) } : {}),
    }).toString()}`,
    resource.origin,
  ), { headers: authenticatedHeaders })));

  server.registerTool("tasq_operation_list", {
    description: "List the state-free registered mutation operations. Tool visibility does not grant authority.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, () => invoke(new Request(new URL(`${prefix}/v1/operations`, resource.origin))));

  for (const operation of options.mutationOperations) {
    server.registerTool(operationToolName(operation), {
      description: `${operation.summary} Every call requires a live Server decision.`,
      inputSchema: {
        resource: ResourceRef,
        expectedRevision: z.number().int().positive().nullable().optional(),
        input: z.unknown(),
        idempotencyKey: IdempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, ({ resource: target, expectedRevision, input, idempotencyKey }) => invoke(new Request(new URL(
      `${prefix}/v1/workspaces/${encodedWorkspace}/operations/${encodeURIComponent(operation.id)}`,
      resource.origin,
    ), {
      method: "POST",
      headers: {
        ...authenticatedHeaders,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        contractVersion: "tasq.hosted-mutation-request.v1",
        resource: target,
        expectedRevision: expectedRevision ?? null,
        input,
      }),
    })));
  }

  return server;
}

/**
 * Create a stateless, host-integrated remote MCP adapter. This is not a
 * listener: TQ-807 owns concrete network deployment and lifecycle.
 */
export function createHostedMcpHandler(options: HostedHttpOptions): (request: Request) => Promise<Response> {
  const resourceValue = canonicalHttps(options.protectedResource);
  const resource = new URL(resourceValue);
  const metadataUrl = new URL(metadataPath(resource), resource.origin).href;
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  validateOperationToolNames(options.mutationOperations);

  return async (request) => {
    const now = UnixMs.parse(options.clock.now());
    const suppliedRequestId = request.headers.get("x-tasq-request-id");
    const parsedRequestId = suppliedRequestId === null ? null : Opaque.safeParse(suppliedRequestId);
    const requestId = parsedRequestId?.success ? parsedRequestId.data : Opaque.parse(requestIdFactory());
    if (parsedRequestId && !parsedRequestId.success) {
      return problem(400, "invalid_request_id", requestId, now);
    }
    const url = new URL(request.url);
    if (url.origin !== resource.origin) return problem(400, "invalid_resource_origin", requestId, now);
    const workspaceId = mcpRoute(url, resource);
    if (!workspaceId) return problem(404, "not_found", requestId, now);
    if (url.search !== "") return problem(400, "invalid_query", requestId, now);
    if (request.method !== "POST") {
      return problem(405, "method_not_allowed", requestId, now, { allow: "POST" });
    }

    const authorization = request.headers.get("authorization");
    if (!authorization) {
      return problem(401, "authentication_required", requestId, now, {
        "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      });
    }
    const dpopProof = request.headers.get("dpop");
    if (!CredentialHeader.safeParse(authorization).success
      || (dpopProof !== null && !CredentialHeader.safeParse(dpopProof).success)) {
      return problem(400, "invalid_credential_envelope", requestId, now);
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

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createRequestServer(options, workspaceId, identity, now);
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(withoutCredentialHeaders(request), {
        authInfo: {
          token: "<redacted>",
          clientId: identity.clientId ?? "tasq-remote-client",
          scopes: identity.actionUpperBound.map((action) => action.uri),
          expiresAt: Math.floor(identity.expiresAt / 1_000),
          resource: new URL(resourceValue),
          extra: {
            contractVersion: HOSTED_MCP_CONTRACT_VERSION,
            subjectPrincipalBindingRequired: true,
          },
        },
      });
      return withResponseHeaders(response, now);
    } catch {
      return problem(400, "invalid_mcp_request", requestId, now);
    }
  };
}
