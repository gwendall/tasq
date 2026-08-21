import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { systemClock } from "@tasq-run/schema";
import { z } from "zod";
import {
  CloudControlPlane,
  cloudMaintenanceMode,
  cloudRuntimeDatabase,
  cloudSessionCookie,
  createCloudBff,
  type CloudProvisioner,
} from "./index.js";
import { oidcTemporalClaimsAccepted } from "./oidc-claims.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function bytes(name: string): Uint8Array {
  const value = Buffer.from(required(name), "base64url");
  if (value.byteLength < 32) throw new Error(`${name} must contain at least 32 bytes`);
  return value;
}

function sha(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new Error("invalid provider path segment");
  return value;
}

const dataDir = process.env.TASQ_CLOUD_DATA_DIR ?? "/data";
const maintenance = cloudMaintenanceMode(process.env.TASQ_CLOUD_MAINTENANCE);
const database = cloudRuntimeDatabase({
  mode: process.env.TASQ_CLOUD_DATABASE_MODE,
  localUrl: `file:${join(dataDir, "control.sqlite")}`,
  remoteUrl: process.env.TASQ_CLOUD_DATABASE_URL,
  remoteAuthToken: process.env.TASQ_CLOUD_DATABASE_AUTH_TOKEN,
});
const artifactDir = join(dataDir, "artifacts");
const publicOrigin = required("TASQ_CLOUD_PUBLIC_ORIGIN");
const oidcIssuer = required("TASQ_CLOUD_OIDC_ISSUER");
const oidcClientId = required("TASQ_CLOUD_OIDC_CLIENT_ID");
const oidcClientSecret = required("TASQ_CLOUD_OIDC_CLIENT_SECRET");
const adminToken = required("TASQ_CLOUD_ADMIN_TOKEN");
const serverOrigin = required("TASQ_CLOUD_SERVER_ORIGIN");
const serverInternalOrigin = process.env.TASQ_CLOUD_SERVER_INTERNAL_ORIGIN?.trim();
const serverImageDigest = required("TASQ_CLOUD_SERVER_IMAGE_DIGEST");
const downstreamBearer = required("TASQ_CLOUD_DOWNSTREAM_BEARER");
const port = Number(process.env.PORT ?? "8787");
const stateKey = bytes("TASQ_CLOUD_STATE_KEY");
const runtimeClock = systemClock;

await mkdir(artifactDir, { recursive: true });

async function artifact(kind: string, id: string, content: unknown) {
  const name = `${safeSegment(kind)}-${safeSegment(id)}.json`;
  const path = join(artifactDir, name);
  const body = `${JSON.stringify(content, null, 2)}\n`;
  await writeFile(path, body, { mode: 0o600 });
  return {
    artifactRef: `fly-volume://tasq-control-data/artifacts/${name}`,
    artifactDigest: sha(body),
  };
}

const provisioner: CloudProvisioner = {
  async provision(input) {
    return {
      deploymentRef: `fly:tasq-api@${serverImageDigest}`,
      serverOrigin,
      secretRefs: [
        "fly-secret://tasq-api/TASQ_SERVER_ENROLLMENT_PEPPER",
        "fly-secret://tasq-control/TASQ_CLOUD_DOWNSTREAM_BEARER",
      ],
    };
  },
  async export(input) {
    return {
      ...await artifact("export", input.exportId, {
        contractVersion: "tasq.cloud-provider-export.v1",
        ...input,
        deploymentRef: `fly:tasq-api@${serverImageDigest}`,
      }),
      expiresAt: runtimeClock.now() + 24 * 60 * 60 * 1_000,
    };
  },
  async rotateCredentials(input) {
    return {
      secretRefs: [
        `fly-secret://tasq-control/TASQ_CLOUD_ROTATION_${safeSegment(input.rotationId)}`,
      ],
    };
  },
  async backup(input) {
    return artifact("backup", input.backupId, {
      contractVersion: "tasq.cloud-provider-backup-reference.v1",
      ...input,
      note: "Control-plane reference only; workspace bytes require the separate provider drill.",
    });
  },
  async restore(input) {
    const path = join(artifactDir, `backup-${safeSegment(input.backupId)}.json`);
    await readFile(path, "utf8");
    return {
      deploymentRef: `fly:tasq-api@${serverImageDigest}`,
      serverOrigin,
      secretRefs: ["fly-secret://tasq-control/TASQ_CLOUD_DOWNSTREAM_BEARER"],
    };
  },
  async delete(input) {
    await artifact("delete-receipt", `${input.tenantId}-${input.workspaceId}`, {
      contractVersion: "tasq.cloud-provider-delete-receipt.v1",
      ...input,
      deletedAt: new Date(runtimeClock.now()).toISOString(),
    });
  },
};

const controlPlane = await CloudControlPlane.open({
  database,
  clock: runtimeClock,
  identityPepper: bytes("TASQ_CLOUD_IDENTITY_PEPPER"),
  sessionPepper: bytes("TASQ_CLOUD_SESSION_PEPPER"),
  authorize: async (input) => ({
    decisionId: `runtime:${randomUUID()}`,
    actorPrincipalId: "service:tasq-control-runtime",
    decision: "allow",
    evaluatedAt: runtimeClock.now(),
  }),
  provisioner,
});

const bff = createCloudBff({
  publicOrigin,
  controlPlane,
  resolveServerCredential: async () => downstreamBearer,
  fetch: serverInternalOrigin
    ? (input, init) => {
      const external = new URL(input instanceof Request ? input.url : input);
      const internal = new URL(external.pathname + external.search, serverInternalOrigin);
      const headers = new Headers(init?.headers);
      headers.set("host", internal.host);
      headers.delete("fly-forwarded-host");
      headers.delete("x-forwarded-host");
      return fetch(internal, { ...init, headers });
    }
    : fetch,
});

function cookie(request: Request, name: string): string | null {
  const value = request.headers.get("cookie");
  if (!value) return null;
  for (const item of value.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function stateDigest(state: string): string {
  return sha(Buffer.concat([stateKey, Buffer.from(state)]));
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function admin(request: Request, url: URL): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${adminToken}`) return new Response("unauthorized", { status: 401 });
  if (request.method === "POST" && url.pathname === "/admin/bootstrap") {
    const tenant = await controlPlane.createTenant({
      id: "tasq-beta",
      slug: "tasq-beta",
      plan: "private-beta",
      maxWorkspaces: 5,
      retentionDays: 30,
      operationId: "bootstrap-tasq-beta-v1",
    });
    let workspace = await controlPlane.getWorkspace("tasq-beta", "main");
    if (!workspace) {
      workspace = await controlPlane.provisionWorkspace({
        tenantId: "tasq-beta",
        workspaceId: "main",
        region: "cdg",
        operationId: "bootstrap-tasq-beta-main-v1",
      });
    } else if (workspace.deploymentRef !== `fly:tasq-api@${serverImageDigest}`) {
      const { createClient } = await import("@libsql/client");
      const client = createClient(database);
      try {
        await client.execute({
          sql: `UPDATE cloud_workspace SET status='failed',last_error_code='deployment_digest_reconciliation',updated_at=?
                WHERE tenant_id='tasq-beta' AND id='main'`,
          args: [runtimeClock.now()],
        });
      } finally {
        client.close();
      }
      workspace = await controlPlane.reconcileWorkspace({ tenantId: "tasq-beta", workspaceId: "main" });
    }
    return responseJson({ tenant, workspace });
  }
  if (request.method === "GET" && url.pathname === "/admin/audit") {
    return responseJson(await controlPlane.listAudit("tasq-beta"));
  }
  if (request.method === "POST" && url.pathname === "/admin/drill/identity") {
    const suffix = randomUUID();
    const humanId = `human:drill:${suffix}`;
    const deviceId = `browser:drill:${suffix}`;
    const subject = `subject:drill:${suffix}`;
    await controlPlane.registerPrincipal({
      tenantId: "tasq-beta",
      principalId: humanId,
      kind: "human",
      issuer: oidcIssuer,
      subject,
      operationId: `drill-human-${suffix}`,
    });
    await controlPlane.enrollDevice({
      tenantId: "tasq-beta",
      principalId: humanId,
      deviceId,
      label: `drill-${suffix}`,
    });
    const beforeRecovery = await controlPlane.issueHumanSession({
      tenantId: "tasq-beta",
      issuer: oidcIssuer,
      subject,
      deviceId,
    });
    if (!await controlPlane.authenticateSession(beforeRecovery.token)) throw new Error("identity drill session unavailable");
    const recovered = await controlPlane.recoverHuman({
      tenantId: "tasq-beta",
      principalId: humanId,
      verifiedRecoveryProofId: `proof:${suffix}`,
    });
    const recoveryInvalidatedSession = await controlPlane.authenticateSession(beforeRecovery.token) === null;
    const beforeDeviceRevocation = await controlPlane.issueHumanSession({
      tenantId: "tasq-beta",
      issuer: oidcIssuer,
      subject,
      deviceId,
    });
    const revokedDevice = await controlPlane.revokeDevice({
      tenantId: "tasq-beta",
      deviceId,
      expectedRevision: 1,
    });
    const deviceInvalidatedSession = await controlPlane.authenticateSession(beforeDeviceRevocation.token) === null;
    const workloadPrincipalId = `workload:drill:${suffix}`;
    const workloadId = `workload-instance:drill:${suffix}`;
    await controlPlane.registerPrincipal({
      tenantId: "tasq-beta",
      principalId: workloadPrincipalId,
      kind: "workload",
      issuer: oidcIssuer,
      subject: `workload-subject:${suffix}`,
      operationId: `drill-workload-${suffix}`,
    });
    const enrolledWorkload = await controlPlane.enrollWorkload({
      tenantId: "tasq-beta",
      principalId: workloadPrincipalId,
      workloadId,
      credentialRef: `fly-secret://tasq-control/TASQ_DRILL_${suffix}`,
    });
    const revokedWorkload = await controlPlane.revokeWorkload({
      tenantId: "tasq-beta",
      workloadId,
      expectedRevision: enrolledWorkload.revision,
    });
    return responseJson({
      contractVersion: "tasq.cloud-identity-drill.v1",
      status: recoveryInvalidatedSession && deviceInvalidatedSession ? "passed" : "failed",
      humanId,
      recoveryRevision: recovered.recoveryRevision,
      recoveryInvalidatedSession,
      revokedDevice,
      deviceInvalidatedSession,
      revokedWorkload,
    });
  }
  if (request.method === "POST" && url.pathname === "/admin/drill/operations") {
    const suffix = randomUUID();
    const backupId = `backup-drill-${suffix}`;
    const backup = await controlPlane.createBackup({
      tenantId: "tasq-beta",
      workspaceId: "main",
      backupId,
      lifetimeMs: 24 * 60 * 60 * 1_000,
    });
    const restored = await controlPlane.restoreBackup({
      tenantId: "tasq-beta",
      workspaceId: "main",
      backupId,
    });
    const exported = await controlPlane.requestExport({ tenantId: "tasq-beta", workspaceId: "main" });
    const rotation = await controlPlane.rotateWorkspaceCredentials({
      tenantId: "tasq-beta",
      workspaceId: "main",
      rotationId: `rotation-drill-${suffix}`,
    });
    const supportPrincipalId = `support:drill:${suffix}`;
    await controlPlane.registerPrincipal({
      tenantId: "tasq-beta",
      principalId: supportPrincipalId,
      kind: "support",
      issuer: oidcIssuer,
      subject: `support-subject:${suffix}`,
      operationId: `drill-support-${suffix}`,
    });
    const support = await controlPlane.grantSupportAccess({
      tenantId: "tasq-beta",
      supportPrincipalId,
      scope: "metadata",
      reason: "automated on-call support access drill",
      ticketRef: `incident-${suffix}`,
      lifetimeMs: 60_000,
    });
    const supportActive = await controlPlane.hasSupportAccess({
      id: support.id,
      tenantId: "tasq-beta",
      supportPrincipalId,
      scope: "metadata",
    });
    await controlPlane.revokeSupportAccess({ id: support.id, tenantId: "tasq-beta", expectedStatus: "active" });
    const supportRevoked = !await controlPlane.hasSupportAccess({
      id: support.id,
      tenantId: "tasq-beta",
      supportPrincipalId,
      scope: "metadata",
    });
    return responseJson({
      contractVersion: "tasq.cloud-operations-drill.v1",
      status: backup.status === "ready" && restored.status === "ready" && exported.status === "ready" &&
          rotation.status === "ready" && supportActive && supportRevoked ? "passed" : "failed",
      backup,
      restored,
      exported,
      rotation,
      support: { id: support.id, activeBeforeRevocation: supportActive, revoked: supportRevoked },
    });
  }
  return new Response("not found", { status: 404 });
}

const idTokenPayload = z.object({
  iss: z.string().url(),
  aud: z.string().min(1),
  sub: z.string().min(1).max(500),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  auth_time: z.number().int().positive(),
  nonce: z.string().min(1).max(500).optional(),
}).strict();

async function verifyIdToken(token: string): Promise<z.infer<typeof idTokenPayload>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid id token structure");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as {
    alg?: string;
    kid?: string;
    typ?: string;
  };
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || !header.kid) {
    throw new Error("unsupported id token header");
  }
  const discoveryResponse = await fetch(new URL(".well-known/openid-configuration", oidcIssuer));
  if (!discoveryResponse.ok) throw new Error("oidc discovery failed");
  const discovery = await discoveryResponse.json() as { issuer?: string; jwks_uri?: string };
  if (discovery.issuer !== oidcIssuer || !discovery.jwks_uri) throw new Error("oidc discovery binding mismatch");
  const jwksResponse = await fetch(discovery.jwks_uri);
  if (!jwksResponse.ok) throw new Error("oidc jwks failed");
  const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
  const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid && candidate.alg === "EdDSA");
  if (!jwk) throw new Error("id token signing key not found");
  const signatureValid = verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk as Record<string, string>, format: "jwk" }),
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!signatureValid) throw new Error("id token signature invalid");
  return idTokenPayload.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
}

async function oidcCallback(request: Request, url: URL): Promise<Response> {
  const requestNow = runtimeClock.now();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = cookie(request, "__Host-tasq_oidc_state");
  if (!code || !state || !storedState) {
    return new Response("invalid oidc callback", { status: 400 });
  }
  const [expectedState, expectedDigest, expectedNonce, expectedNonceDigest] = storedState.split(".");
  const actual = Buffer.from(stateDigest(state));
  const expected = Buffer.from(expectedDigest ?? "");
  if (expectedState !== state || actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return new Response("invalid oidc state", { status: 400 });
  }
  const tokenResponse = await fetch(new URL("token", oidcIssuer), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: oidcClientId,
      client_secret: oidcClientSecret,
      redirect_uri: new URL("oidc/callback", publicOrigin).href,
    }),
  });
  if (!tokenResponse.ok) return new Response("oidc token exchange failed", { status: 502 });
  const tokens = await tokenResponse.json() as { id_token?: string };
  if (!tokens.id_token) return new Response("oidc id token absent", { status: 502 });
  const payload = await verifyIdToken(tokens.id_token);
  const actualNonceDigest = payload.nonce ? Buffer.from(stateDigest(payload.nonce)) : Buffer.alloc(0);
  const storedNonceDigest = Buffer.from(expectedNonceDigest ?? "");
  if (
    payload.iss !== oidcIssuer ||
    payload.aud !== oidcClientId ||
    !oidcTemporalClaimsAccepted(payload, requestNow) ||
    payload.nonce !== expectedNonce ||
    actualNonceDigest.byteLength !== storedNonceDigest.byteLength ||
    !timingSafeEqual(actualNonceDigest, storedNonceDigest)
  ) {
    return new Response("oidc claims rejected", { status: 403 });
  }
  await controlPlane.registerPrincipal({
    tenantId: "tasq-beta",
    principalId: "human:beta-operator",
    kind: "human",
    issuer: oidcIssuer,
    subject: payload.sub,
    operationId: "oidc-beta-operator-v1",
  }).catch((error) => {
    if (!String(error).includes("UNIQUE constraint")) throw error;
  });
  await controlPlane.enrollDevice({
    tenantId: "tasq-beta",
    principalId: "human:beta-operator",
    deviceId: "browser:certification",
    label: "Certification browser",
  }).catch((error) => {
    if (!String(error).includes("UNIQUE constraint")) throw error;
  });
  const session = await controlPlane.issueHumanSession({
    tenantId: "tasq-beta",
    issuer: oidcIssuer,
    subject: payload.sub,
    deviceId: "browser:certification",
  });
  return new Response(null, {
    status: 303,
    headers: {
      location: "/console",
      "set-cookie": cloudSessionCookie(session.token, session.expiresAt, requestNow),
      "x-tasq-csrf": session.csrfToken,
    },
  });
}

function consolePage(authenticated: boolean): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tasq Cloud</title><style>body{font:16px system-ui;margin:4rem auto;max-width:48rem;padding:0 1rem;color:#171717}a{color:#155eef}code{background:#f4f4f5;padding:.15rem .35rem;border-radius:.25rem}</style></head><body><h1>Tasq Cloud private beta</h1><p>${authenticated ? "Authenticated control-plane session active." : "Sign in through the isolated OIDC certification provider."}</p><p><a href="${authenticated ? "/logout" : "/login"}">${authenticated ? "Log out" : "Sign in"}</a></p><p>Workspace API: <code>/api/tenants/tasq-beta/workspaces/main/…</code></p></body></html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return responseJson({ status: "ok", maintenance });
    }
    if (maintenance) {
      return responseJson({
        contractVersion: "tasq.cloud-maintenance.v1",
        code: "database_migration_in_progress",
      }, 503);
    }
    if (url.pathname === "/readyz") {
      const workspace = await controlPlane.getWorkspace("tasq-beta", "main").catch(() => null);
      return responseJson({ status: workspace?.status === "ready" ? "ready" : "initializing", workspace }, workspace ? 200 : 503);
    }
    if (url.pathname.startsWith("/admin/")) return admin(request, url);
    if (url.pathname === "/login") {
      const state = randomBytes(24).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      const target = new URL("authorize", oidcIssuer);
      target.search = new URLSearchParams({
        response_type: "code",
        client_id: oidcClientId,
        redirect_uri: new URL("oidc/callback", publicOrigin).href,
        scope: "openid profile",
        state,
        nonce,
      }).toString();
      return new Response(null, {
        status: 303,
        headers: {
          location: target.href,
          "set-cookie": `__Host-tasq_oidc_state=${state}.${stateDigest(state)}.${nonce}.${stateDigest(nonce)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`,
        },
      });
    }
    if (url.pathname === "/oidc/callback") return oidcCallback(request, url);
    if (url.pathname === "/logout") {
      const target = new URL("logout", oidcIssuer);
      target.searchParams.set("post_logout_redirect_uri", publicOrigin);
      return new Response(null, {
        status: 303,
        headers: {
          location: target.href,
          "set-cookie": "__Host-tasq_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
        },
      });
    }
    if (url.pathname === "/" || url.pathname === "/console") {
      const token = cookie(request, "__Host-tasq_session");
      const authenticated = token ? Boolean(await controlPlane.authenticateSession(token)) : false;
      return consolePage(authenticated);
    }
    if (url.pathname.startsWith("/api/")) {
      const publicUrl = new URL(publicOrigin);
      const forwardedProto = request.headers.get("fly-forwarded-proto") ??
        request.headers.get("x-forwarded-proto");
      if (request.headers.get("host") !== publicUrl.host || forwardedProto !== "https") {
        return new Response("not found", { status: 404 });
      }
      return bff(new Request(new URL(url.pathname + url.search, publicUrl), request));
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(JSON.stringify({
  contractVersion: "tasq.cloud-runtime.v1",
  origin: publicOrigin,
  port: server.port,
  serverImageDigest,
  remoteEffects: false,
}));
