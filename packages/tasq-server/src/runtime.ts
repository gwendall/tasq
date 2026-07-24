import type { Clock } from "@tasq-run/schema";
import {
  CredentialVerificationError,
  type CredentialVerifier,
} from "./http.js";
import { createHostedHttpHandler } from "./http.js";
import { createHostedMcpHandler } from "./remote-mcp.js";
import {
  createRemoteEnrollmentAuthority,
  createRemoteEnrollmentHandler,
} from "./enrollment.js";
import { createJwtCredentialVerifier } from "./jwt.js";
import { IsolatedWorkspaceRouter } from "./router.js";
import { openAuthorityStore, type AuthorityStore } from "./store.js";
import { openSigningCredentialAuthority } from "./signing-credentials.js";
import {
  HOSTED_CORE_OPERATIONS,
  createHostedCoreWorkspace,
  type HostedCoreWorkspace,
} from "./workspace.js";
import { createHostedConsoleHandler } from "./hosted-console.js";
import { configuredScopeActions, type TasqServerConfig } from "./config.js";

export const TASQ_SERVER_RUNTIME_VERSION = "0.1.0";
export const TASQ_SERVER_RUNTIME_CONTRACT_VERSION = "tasq.server-runtime.v1" as const;

export interface TasqServerRuntime {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  authority: AuthorityStore;
  enrollment: ReturnType<typeof createRemoteEnrollmentAuthority>;
}

function json(body: unknown, status = 200, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}

function requestAtPublicOrigin(request: Request, publicUrl: string): Request {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, publicUrl);
  return new Request(target, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function supportWorkspace(pathname: string): string | null {
  const match = /^\/v1\/workspaces\/([^/]+)\/support-bundle$/.exec(pathname);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]!);
    return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function compositeVerifier(
  opaque: CredentialVerifier,
  jwt: CredentialVerifier[],
): CredentialVerifier {
  return {
    async verify(input, clock) {
      if (input.authorization.startsWith("Bearer tasq_access_")) return opaque.verify(input, clock);
      if (/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.authorization)) {
        for (const verifier of jwt) {
          try {
            return await verifier.verify(input, clock);
          } catch (error) {
            if (!(error instanceof CredentialVerificationError) || error.code !== "invalid_token") throw error;
          }
        }
      }
      throw new CredentialVerificationError("invalid_token");
    },
  };
}

export async function createTasqServerRuntime(input: {
  config: TasqServerConfig;
  enrollmentPepper: Uint8Array;
  clock: Clock;
}): Promise<TasqServerRuntime> {
  const startedAt = input.clock.now();
  const authority = await openAuthorityStore({
    url: input.config.authorityDatabaseUrl,
    clock: input.clock,
  });
  const signingCredentials = await openSigningCredentialAuthority({
    url: input.config.authorityDatabaseUrl,
    clock: input.clock,
  });
  const workspaces = new Map<string, Promise<HostedCoreWorkspace>>();
  const opened = new Set<HostedCoreWorkspace>();
  const bindings = input.config.workspaces.map((configured) => ({
    workspaceId: configured.id,
    storageBindingId: configured.storageBindingId,
    open: async () => {
      let pending = workspaces.get(configured.id);
      if (!pending) {
        pending = createHostedCoreWorkspace({
          workspaceId: configured.id,
          databaseUrl: configured.databaseUrl,
          receiptDatabaseUrl: configured.receiptDatabaseUrl,
          clock: input.clock,
          signedStatements: {
            audience: input.config.publicUrl,
            // The authority store is the trust root in the deployable Server
            // composition: only public credentials enrolled through its
            // guarded lifecycle are returned. The digest still makes that
            // root explicit and portable at acceptance.
            acceptedTrustRootDigests: input.config.signing.acceptedTrustRootDigests,
            resolveCredential: async (id) => {
              const credential = await signingCredentials.get(id);
              return credential &&
                input.config.signing.acceptedTrustRootDigests.includes(
                  credential.trustRootDigest,
                )
                ? credential
                : null;
            },
          },
        }).then((workspace) => {
          opened.add(workspace);
          return workspace;
        });
        workspaces.set(configured.id, pending);
      }
      return pending;
    },
  }));
  const router = new IsolatedWorkspaceRouter(authority, bindings);
  const enrollment = createRemoteEnrollmentAuthority({
    store: authority,
    clock: input.clock,
    pepper: input.enrollmentPepper,
    issuer: input.config.enrollment.issuer,
    audience: input.config.publicUrl,
  });
  const jwtConfigurations = [input.config.jwt, ...input.config.additionalJwtIssuers];
  const jwt = jwtConfigurations.map((configuration) => createJwtCredentialVerifier({
    ...configuration,
    scopeActions: configuredScopeActions(configuration.scopeActions),
    keys: configuration.keys.map(({ kid, jwk }) => ({ kid, jwk })),
  }));
  const verifier = compositeVerifier(enrollment.verifier, jwt);
  const handlerOptions = {
    protectedResource: input.config.publicUrl,
    authorizationServers: [...new Set([
      ...jwtConfigurations.map(({ issuer }) => issuer),
      input.config.enrollment.issuer,
    ])].sort(),
    resourceDocumentation: input.config.support.documentationUrl,
    clock: input.clock,
    verifier,
    router,
    mutationOperations: [...HOSTED_CORE_OPERATIONS],
  };
  const rest = createHostedHttpHandler(handlerOptions);
  const mcp = createHostedMcpHandler(handlerOptions);
  const redeem = createRemoteEnrollmentHandler({
    endpoint: input.config.publicUrl,
    authority: enrollment,
    clock: input.clock,
  });
  const consoleHandler = createHostedConsoleHandler({
    publicUrl: input.config.publicUrl,
    restHandler: rest,
  });
  // Readiness means every configured binding has completed Core and receipt
  // migrations; requests never discover an unopenable workspace after /readyz.
  try {
    await Promise.all(bindings.map(({ open }) => open()));
  } catch (error) {
    await Promise.all([...opened].map((workspace) => workspace.close()));
    signingCredentials.close();
    await authority.close();
    throw error;
  }
  let requests = 0;
  let failures = 0;

  return {
    authority,
    enrollment,
    async fetch(raw) {
      requests += 1;
      const request = requestAtPublicOrigin(raw, input.config.publicUrl);
      const url = new URL(request.url);
      try {
        if (url.pathname === "/healthz" && request.method === "GET") {
          return json({ status: "ok" });
        }
        if (url.pathname === "/readyz" && request.method === "GET") {
          return json({ status: "ready", workspaces: input.config.workspaces.length });
        }
        if (url.pathname === "/version" && request.method === "GET") {
          return json({
            contractVersion: TASQ_SERVER_RUNTIME_CONTRACT_VERSION,
            version: TASQ_SERVER_RUNTIME_VERSION,
            api: "v1",
            effectsEnabled: false,
            connectorsBundled: false,
          }, 200, "public, max-age=300");
        }
        if (url.pathname === "/support" && request.method === "GET") {
          return json({
            contractVersion: "tasq.server-support.v1",
            documentationUrl: input.config.support.documentationUrl ?? null,
            contact: input.config.support.contact ?? null,
            publicUrl: input.config.publicUrl,
            authorityDatabase: "configured",
            workspaceCount: input.config.workspaces.length,
          });
        }
        if (url.pathname === "/metrics" && request.method === "GET") {
          const now = input.clock.now();
          return new Response([
            "# TYPE tasq_server_up gauge",
            "tasq_server_up 1",
            "# TYPE tasq_server_requests_total counter",
            `tasq_server_requests_total ${requests}`,
            "# TYPE tasq_server_failures_total counter",
            `tasq_server_failures_total ${failures}`,
            "# TYPE tasq_server_uptime_milliseconds gauge",
            `tasq_server_uptime_milliseconds ${Math.max(0, now - startedAt)}`,
            "",
          ].join("\n"), {
            headers: {
              "content-type": "text/plain; version=0.0.4; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }
        const supportWorkspaceId = supportWorkspace(url.pathname);
        if (supportWorkspaceId && request.method === "GET") {
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            return json({
              contractVersion: "tasq.hosted-problem.v1",
              code: "authentication_required",
              requestId: request.headers.get("x-tasq-request-id") ?? "support-bundle",
              decisionId: null,
            }, 401);
          }
          const probe = await rest(new Request(new URL(
            `/v1/workspaces/${encodeURIComponent(supportWorkspaceId)}/commitments?limit=1`,
            input.config.publicUrl,
          ), {
            headers: {
              authorization,
              "x-tasq-request-id": request.headers.get("x-tasq-request-id") ?? "support-bundle-probe",
            },
          }));
          if (!probe.ok) return probe;
          return new Response(JSON.stringify({
            contractVersion: "tasq.server-support-bundle.v1",
            generatedAt: input.clock.now(),
            serverVersion: TASQ_SERVER_RUNTIME_VERSION,
            workspaceId: supportWorkspaceId,
            publicUrl: input.config.publicUrl,
            health: "ready",
            effectsEnabled: false,
            connectorsBundled: false,
            redacted: [
              "authorization_headers",
              "cookies",
              "enrollment_and_access_tokens",
              "jwt_claims",
              "database_urls",
              "commitment_content",
              "event_payloads",
              "principal_subjects",
            ],
          }), {
            headers: {
              "content-type": "application/json",
              "content-disposition": `attachment; filename="tasq-server-support-${encodeURIComponent(supportWorkspaceId)}.json"`,
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }
        const consoleResponse = await consoleHandler(request);
        if (consoleResponse) return consoleResponse;
        if (/\/v1\/workspaces\/[^/]+\/enrollments\/redeem$/.test(url.pathname)) return redeem(request);
        if (/\/v1\/workspaces\/[^/]+\/mcp$/.test(url.pathname)) return mcp(request);
        return rest(request);
      } catch {
        failures += 1;
        return json({
          contractVersion: "tasq.hosted-problem.v1",
          code: "server_unavailable",
        }, 503);
      }
    },
    async close() {
      await Promise.all([...opened].map((workspace) => workspace.close()));
      signingCredentials.close();
      await authority.close();
    },
  };
}
