import { z } from "zod";

export const REMOTE_CLIENT_CONTRACT_VERSION = "tasq.remote-client.v1" as const;

const Opaque = z.string().min(1).max(2_000);
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PortableResource = z.object({
  kind: z.enum(["workspace", "commitment", "resource", "effect", "replica"]),
  id: z.string().min(1).max(500),
}).strict();

export const RemoteCommitment = z.object({
  id: z.string().min(1).max(500),
  workspaceId: WorkspaceId,
  title: z.string().min(1).max(10_000),
  status: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  createdAt: UnixMs,
  updatedAt: UnixMs,
}).strict();
export type RemoteCommitment = z.infer<typeof RemoteCommitment>;

export const RemoteEventMetadata = z.object({
  id: z.string().min(1).max(500),
  sequence: z.number().int().positive(),
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(500),
  eventType: z.string().min(1).max(200),
  actorPrincipalId: z.string().min(1).max(500).nullable(),
  createdAt: UnixMs,
}).strict();
export type RemoteEventMetadata = z.infer<typeof RemoteEventMetadata>;

const CommitmentPage = z.object({
  contractVersion: z.literal("tasq.hosted-commitment-page.v1"),
  requestId: Opaque,
  decisionId: Opaque,
  evaluatedAt: UnixMs,
  items: z.array(RemoteCommitment).max(100),
  nextCursor: z.string().min(1).max(2_000).nullable(),
}).strict();

const CommitmentResponse = z.object({
  contractVersion: z.literal("tasq.hosted-commitment.v1"),
  requestId: Opaque,
  decisionId: Opaque,
  evaluatedAt: UnixMs,
  item: RemoteCommitment,
}).strict();

const EventPage = z.object({
  contractVersion: z.literal("tasq.hosted-event-metadata-page.v1"),
  requestId: Opaque,
  decisionId: Opaque,
  evaluatedAt: UnixMs,
  items: z.array(RemoteEventMetadata).max(100),
  nextSequence: z.number().int().positive().nullable(),
}).strict();

const ContractIdentity = z.object({
  uri: z.string().min(1).max(500),
  version: z.number().int().positive(),
  implementationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

export const RemoteOperation = z.object({
  id: z.string().min(1).max(100),
  actionUri: z.string().min(1).max(500),
  summary: z.string().min(1).max(500),
  inputContract: ContractIdentity,
  outputContract: ContractIdentity,
  requiresExpectedRevision: z.boolean(),
  action: ContractIdentity,
  resourceKinds: z.array(z.string().min(1)).min(1),
  senderConstraint: z.string().min(1),
  eligibility: z.string().min(1),
}).strict();
export type RemoteOperation = z.infer<typeof RemoteOperation>;

const OperationCatalog = z.object({
  contractVersion: z.literal("tasq.hosted-operation-catalog.v1"),
  operations: z.array(RemoteOperation).max(64),
}).strict();

const MutationOutcome = z.object({
  contractVersion: z.literal("tasq.hosted-mutation-outcome.v1"),
  workspaceId: WorkspaceId,
  operationId: z.string().min(1).max(100),
  requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  idempotencyKeyDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  resultType: z.string().min(1).max(2_000),
  resultId: z.string().min(1).max(2_000),
  resultRevision: z.number().int().positive().nullable(),
  eventSequence: z.number().int().positive().nullable(),
  replayed: z.boolean(),
  result: z.unknown(),
}).strict();
export type RemoteMutationOutcome = z.infer<typeof MutationOutcome>;

const MutationResponse = z.object({
  contractVersion: z.literal("tasq.hosted-mutation-response.v1"),
  requestId: Opaque,
  decisionId: Opaque,
  evaluatedAt: UnixMs,
  authorityRevision: z.number().int().nonnegative(),
  outcome: MutationOutcome,
}).strict();

const Problem = z.object({
  contractVersion: z.literal("tasq.hosted-problem.v1"),
  code: z.string().min(1),
  requestId: z.string().min(1),
  decisionId: z.string().min(1).nullable().optional(),
  oldestSequence: z.number().int().nonnegative().optional(),
}).passthrough();

export class TasqRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    readonly retryable: boolean,
    readonly oldestSequence: number | null = null,
  ) {
    super(`${code} (${status})`);
    this.name = "TasqRemoteError";
  }
}

export interface RemoteTasqOptions {
  endpoint: string;
  workspaceId: string;
  accessToken: string | (() => string | Promise<string>);
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestIdFactory?: () => string;
  dpopProof?: (input: { method: "GET" | "POST"; url: string; accessToken: string }) => string | Promise<string>;
}

export interface ExecuteRemoteOperationInput {
  resource: z.infer<typeof PortableResource>;
  expectedRevision?: number | null;
  input: unknown;
  idempotencyKey: string;
  requestId?: string;
}

export interface StreamRemoteEventsInput {
  afterSequence: number;
  limit?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function canonicalEndpoint(value: string): URL {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("endpoint must be canonical HTTPS (HTTP is allowed only for loopback)");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function encodeWorkspace(workspaceId: string): string {
  return encodeURIComponent(WorkspaceId.parse(workspaceId));
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TasqRemoteError(response.status, "invalid_server_response", null, response.status >= 500);
  }
}

function retryable(status: number, code: string): boolean {
  return status >= 500 || code === "authority_busy" || code === "mutation_outcome_unknown";
}

export function createRemoteTasq(options: RemoteTasqOptions) {
  const endpoint = canonicalEndpoint(options.endpoint);
  const workspaceId = WorkspaceId.parse(options.workspaceId);
  const workspacePath = `v1/workspaces/${encodeWorkspace(workspaceId)}`;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("remote client requires a Fetch implementation");
  const requestIdFactory = options.requestIdFactory ?? (() => globalThis.crypto.randomUUID());

  async function token(): Promise<string> {
    const value = typeof options.accessToken === "function" ? await options.accessToken() : options.accessToken;
    return z.string().min(1).max(32_000).parse(value);
  }

  async function request(path: string, init: RequestInit & { method: "GET" | "POST" }): Promise<unknown> {
    const url = new URL(path, endpoint).href;
    const accessToken = await token();
    const authorization = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization);
    headers.set("x-tasq-request-id", headers.get("x-tasq-request-id") ?? requestIdFactory());
    if (options.dpopProof) headers.set("dpop", await options.dpopProof({ method: init.method, url, accessToken }));
    let response: Response;
    try {
      response = await fetcher(url, { ...init, headers });
    } catch {
      throw new TasqRemoteError(0, "network_error", headers.get("x-tasq-request-id"), true);
    }
    const body = await readBody(response);
    if (!response.ok) {
      const parsed = Problem.safeParse(body);
      throw new TasqRemoteError(
        response.status,
        parsed.success ? parsed.data.code : "invalid_server_response",
        parsed.success ? parsed.data.requestId : headers.get("x-tasq-request-id"),
        retryable(response.status, parsed.success ? parsed.data.code : ""),
        parsed.success ? parsed.data.oldestSequence ?? null : null,
      );
    }
    return body;
  }

  return Object.freeze({
    contractVersion: REMOTE_CLIENT_CONTRACT_VERSION,
    endpoint: endpoint.href,
    workspaceId,

    async listCommitments(input: { cursor?: string | null; limit?: number } = {}) {
      const query = new URLSearchParams();
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size ? `?${query}` : "";
      return CommitmentPage.parse(await request(`${workspacePath}/commitments${suffix}`, { method: "GET" }));
    },

    async getCommitment(id: string) {
      return CommitmentResponse.parse(await request(
        `${workspacePath}/commitments/${encodeURIComponent(z.string().min(1).max(500).parse(id))}`,
        { method: "GET" },
      ));
    },

    async listEvents(input: { afterSequence?: number; limit?: number } = {}) {
      const query = new URLSearchParams();
      query.set("after", String(z.number().int().nonnegative().parse(input.afterSequence ?? 0)));
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      return EventPage.parse(await request(`${workspacePath}/events?${query}`, { method: "GET" }));
    },

    async *streamEvents(input: StreamRemoteEventsInput): AsyncGenerator<RemoteEventMetadata, number, void> {
      let cursor = z.number().int().nonnegative().parse(input.afterSequence);
      const limit = z.number().int().min(1).max(100).parse(input.limit ?? 100);
      const delay = z.number().int().min(0).max(60_000).parse(input.pollIntervalMs ?? 1_000);
      while (!input.signal?.aborted) {
        const page = await this.listEvents({ afterSequence: cursor, limit });
        for (const event of page.items) {
          cursor = event.sequence;
          yield event;
        }
        if (page.items.length === 0) {
          if (delay === 0) return cursor;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            input.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        }
      }
      return cursor;
    },

    async listOperations() {
      return OperationCatalog.parse(await request("v1/operations", { method: "GET" }));
    },

    async executeOperation(operationId: string, input: ExecuteRemoteOperationInput) {
      const operation = z.string().min(1).max(100).regex(/^[a-z][a-z0-9._-]*$/).parse(operationId);
      const idempotencyKey = z.string().min(1).max(500).parse(input.idempotencyKey);
      const requestId = z.string().min(1).max(500).parse(input.requestId ?? requestIdFactory());
      const body = {
        contractVersion: "tasq.hosted-mutation-request.v1",
        resource: PortableResource.parse(input.resource),
        expectedRevision: input.expectedRevision ?? null,
        input: input.input,
      };
      const response = MutationResponse.parse(await request(`${workspacePath}/operations/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-tasq-request-id": requestId,
        },
        body: JSON.stringify(body),
      }));
      return response.outcome;
    },
  });
}

export type RemoteTasq = ReturnType<typeof createRemoteTasq>;

const EnrollmentResponse = z.object({
  contractVersion: z.literal("tasq.remote-enrollment.v1"),
  requestId: Opaque,
  credentialId: Opaque,
  workspaceId: WorkspaceId,
  principalId: Opaque,
  clientKind: z.enum(["human_device", "workload_agent"]),
  accessToken: z.string().min(32).max(2_000),
  issuedAt: UnixMs,
  expiresAt: UnixMs,
  actionUpperBound: z.array(ContractIdentity).min(1),
}).strict();
export type RemoteEnrollmentResponse = z.infer<typeof EnrollmentResponse>;

export async function redeemRemoteEnrollment(input: {
  endpoint: string;
  workspaceId: string;
  enrollmentToken: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestId?: string;
}): Promise<RemoteEnrollmentResponse> {
  const endpoint = canonicalEndpoint(input.endpoint);
  const workspaceId = WorkspaceId.parse(input.workspaceId);
  const requestId = z.string().min(1).max(500).parse(input.requestId ?? globalThis.crypto.randomUUID());
  const fetcher = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(new URL(
      `v1/workspaces/${encodeWorkspace(workspaceId)}/enrollments/redeem`,
      endpoint,
    ), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tasq-request-id": requestId,
      },
      body: JSON.stringify({
        contractVersion: "tasq.remote-enrollment.v1",
        enrollmentToken: z.string().min(32).max(2_000).parse(input.enrollmentToken),
      }),
    });
  } catch {
    throw new TasqRemoteError(0, "network_error", requestId, true);
  }
  const body = await readBody(response);
  if (!response.ok) {
    const parsed = Problem.safeParse(body);
    throw new TasqRemoteError(
      response.status,
      parsed.success ? parsed.data.code : "invalid_server_response",
      parsed.success ? parsed.data.requestId : requestId,
      retryable(response.status, parsed.success ? parsed.data.code : ""),
    );
  }
  const parsed = EnrollmentResponse.parse(body);
  if (parsed.workspaceId !== workspaceId) {
    throw new TasqRemoteError(response.status, "workspace_binding_mismatch", parsed.requestId, false);
  }
  return parsed;
}
