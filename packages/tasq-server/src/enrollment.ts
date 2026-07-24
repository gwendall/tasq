import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Clock } from "@tasq-run/schema";
import {
  VerifiedIdentity,
  digestAuthorityValue,
  type ActionIdentity,
  type VerifiedIdentity as VerifiedIdentityValue,
} from "@tasq-internal/authority";
import { z } from "zod";
import {
  CredentialVerificationError,
  type CredentialVerifier,
} from "./http.js";
import {
  AuthorityStoreError,
  EnrollmentStoreError,
  type AuthorityMutationContext,
  type AuthorityMutationResult,
  type AuthorityStore,
  type EnrollmentRecord,
} from "./store.js";

export const REMOTE_ENROLLMENT_CONTRACT_VERSION = "tasq.remote-enrollment.v1" as const;

const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const Id = z.string().min(1).max(500).refine((value) => value === value.trim());
const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Secret = z.string().min(32).max(2_000);

function secretDigest(pepper: Uint8Array, secret: string): string {
  return `sha256:${createHmac("sha256", pepper).update(secret, "utf8").digest("hex")}`;
}

function canonicalIssuer(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.href !== value) {
    throw new Error("enrollment issuer must be one canonical HTTPS URL");
  }
  return value;
}

function canonicalAudience(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.href !== value) {
    throw new Error("credential audience must be one canonical HTTPS URL");
  }
  return value;
}

export interface RemoteEnrollmentAuthorityOptions {
  store: AuthorityStore;
  clock: Clock;
  pepper: Uint8Array;
  issuer: string;
  audience: string;
  randomSecret?: () => string;
  randomId?: () => string;
}

export interface CreateRemoteEnrollmentInput {
  workspaceId: string;
  principalId: string;
  subject: string;
  clientKind: "human_device" | "workload_agent";
  actionUpperBound: ActionIdentity[];
  enrollmentExpiresAt: number;
  accessExpiresAt: number;
  context: AuthorityMutationContext;
}

export interface CreatedRemoteEnrollment {
  contractVersion: typeof REMOTE_ENROLLMENT_CONTRACT_VERSION;
  enrollmentId: string;
  workspaceId: string;
  enrollmentToken: string;
  enrollmentExpiresAt: number;
  accessExpiresAt: number;
  mutation: AuthorityMutationResult;
}

export interface RedeemedRemoteEnrollment {
  contractVersion: typeof REMOTE_ENROLLMENT_CONTRACT_VERSION;
  credentialId: string;
  workspaceId: string;
  principalId: string;
  clientKind: "human_device" | "workload_agent";
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
  actionUpperBound: ActionIdentity[];
}

export function createRemoteEnrollmentAuthority(options: RemoteEnrollmentAuthorityOptions) {
  if (options.pepper.byteLength < 32) throw new Error("enrollment credential pepper must contain at least 32 bytes");
  const issuer = canonicalIssuer(options.issuer);
  const audience = canonicalAudience(options.audience);
  const randomSecretFactory = options.randomSecret ?? (() => randomBytes(32).toString("base64url"));
  const randomIdFactory = options.randomId ?? randomUUID;

  async function create(input: CreateRemoteEnrollmentInput): Promise<CreatedRemoteEnrollment> {
    const now = UnixMs.parse(options.clock.now());
    const enrollmentId = Id.parse(`enrollment-${randomIdFactory()}`);
    const secret = Secret.parse(randomSecretFactory());
    const enrollmentToken = `tasq_enroll_${enrollmentId}.${secret}`;
    const enrollment: Omit<EnrollmentRecord, "consumedAt" | "revokedAt"> = {
      id: enrollmentId,
      workspaceId: WorkspaceId.parse(input.workspaceId),
      principalId: Id.parse(input.principalId),
      issuer,
      subject: Id.parse(input.subject),
      clientKind: input.clientKind,
      tokenDigest: secretDigest(options.pepper, enrollmentToken),
      actionUpperBound: input.actionUpperBound,
      createdAt: now,
      expiresAt: UnixMs.parse(input.enrollmentExpiresAt),
      accessExpiresAt: UnixMs.parse(input.accessExpiresAt),
    };
    const mutation = await options.store.createEnrollment({ enrollment, context: input.context });
    return {
      contractVersion: REMOTE_ENROLLMENT_CONTRACT_VERSION,
      enrollmentId,
      workspaceId: enrollment.workspaceId,
      enrollmentToken,
      enrollmentExpiresAt: enrollment.expiresAt,
      accessExpiresAt: enrollment.accessExpiresAt,
      mutation,
    };
  }

  async function redeem(input: { workspaceId: string; enrollmentToken: string }): Promise<RedeemedRemoteEnrollment> {
    const accessSecret = Secret.parse(randomSecretFactory());
    const credentialId = Id.parse(`credential-${randomIdFactory()}`);
    const accessToken = `tasq_access_${credentialId}.${accessSecret}`;
    const request = {
      workspaceId: WorkspaceId.parse(input.workspaceId),
      enrollmentTokenDigest: secretDigest(options.pepper, Secret.parse(input.enrollmentToken)),
      credentialId,
      credentialTokenDigest: secretDigest(options.pepper, accessToken),
      auditEventId: Id.parse(`redeem-${randomIdFactory()}`),
    };
    let credential: Awaited<ReturnType<AuthorityStore["redeemEnrollment"]>> | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        credential = await options.store.redeemEnrollment(request);
        break;
      } catch (error) {
        if (!(error instanceof AuthorityStoreError) || error.code !== "authority_busy" || attempt === 7) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 2 ** attempt));
      }
    }
    if (!credential) throw new AuthorityStoreError("authority_busy", "enrollment redemption retry budget exhausted");
    return {
      contractVersion: REMOTE_ENROLLMENT_CONTRACT_VERSION,
      credentialId: credential.id,
      workspaceId: credential.workspaceId,
      principalId: credential.principalId,
      clientKind: credential.clientKind,
      accessToken,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      actionUpperBound: credential.actionUpperBound,
    };
  }

  const verifier: CredentialVerifier = {
    async verify(input, requestClock): Promise<VerifiedIdentityValue> {
      const match = /^Bearer (tasq_access_.+)$/.exec(input.authorization);
      if (!match) throw new CredentialVerificationError("invalid_token");
      if (input.expectedAudience !== audience) throw new CredentialVerificationError("invalid_token");
      const now = UnixMs.parse(requestClock.now());
      const token = Secret.parse(match[1]);
      const credential = await options.store.findAccessCredential(secretDigest(options.pepper, token));
      if (!credential || credential.status !== "active" || now >= credential.expiresAt) {
        throw new CredentialVerificationError("invalid_token");
      }
      return VerifiedIdentity.parse({
        contractVersion: "tasq.verified-identity.v1",
        issuer,
        subject: credential.subject,
        audience: [audience],
        authenticationMethod: "oauth_introspection",
        authenticatedAt: credential.issuedAt,
        notBefore: credential.issuedAt,
        expiresAt: credential.expiresAt,
        clientId: credential.id,
        actor: null,
        credentialBinding: { kind: "none" },
        tokenIdDigest: credential.tokenDigest,
        issuerConfigurationDigest: digestAuthorityValue({
          contractVersion: REMOTE_ENROLLMENT_CONTRACT_VERSION,
          issuer,
          audience,
          method: "opaque_introspection",
        }),
        credentialKeyDigest: digestAuthorityValue({
          contractVersion: REMOTE_ENROLLMENT_CONTRACT_VERSION,
          pepperClass: "host_secret_hmac_sha256",
        }),
        actionUpperBound: credential.actionUpperBound,
      });
    },
  };

  return Object.freeze({ create, redeem, verifier, issuer, audience });
}

const RedeemRequest = z.object({
  contractVersion: z.literal(REMOTE_ENROLLMENT_CONTRACT_VERSION),
  enrollmentToken: Secret,
}).strict();

async function readBoundedEnrollmentBody(request: Request): Promise<string> {
  const maximum = 8_192;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) {
    throw new Error("enrollment body exceeds bound");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new Error("enrollment body exceeds bound");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export function createRemoteEnrollmentHandler(input: {
  endpoint: string;
  authority: Pick<ReturnType<typeof createRemoteEnrollmentAuthority>, "redeem">;
  clock: Clock;
  requestIdFactory?: () => string;
}): (request: Request) => Promise<Response> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.href !== input.endpoint) {
    throw new Error("remote enrollment endpoint must be one canonical HTTPS URL");
  }
  const prefix = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
  const routePrefix = `${prefix}/v1/workspaces/`;
  const requestIdFactory = input.requestIdFactory ?? randomUUID;
  return async (request) => {
    const now = UnixMs.parse(input.clock.now());
    const suppliedRequestId = request.headers.get("x-tasq-request-id");
    const parsedRequestId = suppliedRequestId === null ? null : Id.safeParse(suppliedRequestId);
    const requestId = parsedRequestId?.success ? parsedRequestId.data : Id.parse(requestIdFactory());
    const url = new URL(request.url);
    const remainder = url.pathname.startsWith(routePrefix)
      ? url.pathname.slice(routePrefix.length).split("/")
      : [];
    let workspaceId: string | null = null;
    try {
      workspaceId = remainder.length === 3 && remainder[1] === "enrollments" && remainder[2] === "redeem"
        ? decodeURIComponent(remainder[0]!)
        : null;
    } catch {
      workspaceId = null;
    }
    const response = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        date: new Date(now).toUTCString(),
      },
    });
    if (parsedRequestId && !parsedRequestId.success) {
      return response({
        contractVersion: "tasq.hosted-problem.v1",
        code: "invalid_request_id",
        requestId,
      }, 400);
    }
    if (url.origin !== endpoint.origin || !workspaceId || !WorkspaceId.safeParse(workspaceId).success) {
      return response({ contractVersion: "tasq.hosted-problem.v1", code: "not_found", requestId }, 404);
    }
    if (request.method !== "POST") {
      return response({ contractVersion: "tasq.hosted-problem.v1", code: "method_not_allowed", requestId }, 405);
    }
    if (url.search || request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      return response({ contractVersion: "tasq.hosted-problem.v1", code: "invalid_enrollment_request", requestId }, 400);
    }
    let parsed: z.infer<typeof RedeemRequest>;
    try {
      const raw = await readBoundedEnrollmentBody(request);
      parsed = RedeemRequest.parse(JSON.parse(raw));
    } catch {
      return response({ contractVersion: "tasq.hosted-problem.v1", code: "invalid_enrollment_request", requestId }, 400);
    }
    try {
      const result = await input.authority.redeem({ workspaceId, enrollmentToken: parsed.enrollmentToken });
      return response({ ...result, requestId }, 201);
    } catch (error) {
      if (error instanceof EnrollmentStoreError) {
        const status = error.code === "expired" ? 410 : error.code === "not_found" ? 404 : 409;
        return response({
          contractVersion: "tasq.hosted-problem.v1",
          code: `enrollment_${error.code}`,
          requestId,
        }, status);
      }
      return response({
        contractVersion: "tasq.hosted-problem.v1",
        code: "enrollment_unavailable",
        requestId,
      }, 503);
    }
  };
}
