/** Commitment-safe mappings from remote protocol tasks to Tasq execution records. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Artifact,
  Clock,
  ExternalRef,
  TaskAttempt,
} from "@tasq-run/schema";
import {
  appendArtifact,
  appendExternalRef,
  listArtifacts,
  startTaskAttempt,
  transitionTaskAttempt,
  type TasqDb,
} from "@tasq-run/core";

export const MCP_TASKS_PROTOCOL_VERSION = "2025-11-25" as const;
export const A2A_PROTOCOL_VERSION = "1.0" as const;
export const PROTOCOL_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const INLINE_PROTOCOL_ARTIFACT_MAX_BYTES = 1_200;

export const ProtocolAdapterManifest = z.object({
  contractVersion: z.literal("tasq.protocol-adapter.v1"),
  adapterUri: z.string().url(),
  mappings: z.array(z.object({
    protocolUri: z.string().url(),
    protocolVersion: z.string().min(1),
    remoteResource: z.literal("task"),
    tasqRecords: z.array(z.enum(["attempt", "external_ref", "artifact"])).min(1),
  }).strict()).min(1),
  completionAuthority: z.literal("none"),
  requiresInjectedClock: z.literal(true),
}).strict();
export type ProtocolAdapterManifest = z.infer<typeof ProtocolAdapterManifest>;

export const TASQ_PROTOCOL_ADAPTER_MANIFEST: ProtocolAdapterManifest = Object.freeze(ProtocolAdapterManifest.parse({
  contractVersion: "tasq.protocol-adapter.v1",
  adapterUri: "https://schemas.tasq.dev/adapters/protocol-tasks",
  mappings: [
    {
      protocolUri: "https://modelcontextprotocol.io/extensions/tasks",
      protocolVersion: MCP_TASKS_PROTOCOL_VERSION,
      remoteResource: "task",
      tasqRecords: ["attempt", "external_ref", "artifact"],
    },
    {
      protocolUri: "https://a2a-protocol.org/specification",
      protocolVersion: A2A_PROTOCOL_VERSION,
      remoteResource: "task",
      tasqRecords: ["attempt", "external_ref", "artifact"],
    },
  ],
  completionAuthority: "none",
  requiresInjectedClock: true,
}));

const BoundedId = z.string().min(1).max(1_000);
const BoundedMessage = z.string().min(1).max(2_000);
const AbsoluteUri = z.string().min(3).max(2_000).regex(/^[a-z][a-z0-9+.-]*:/i);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonValue).max(10_000), z.record(JsonValue),
]));

export const McpTaskStatus = z.enum([
  "working", "input_required", "completed", "failed", "cancelled",
]);
export type McpTaskStatus = z.infer<typeof McpTaskStatus>;

export const McpTaskSnapshot = z.object({
  taskId: BoundedId,
  status: McpTaskStatus,
  statusMessage: BoundedMessage.optional(),
  createdAt: z.string().min(1).max(100),
  lastUpdatedAt: z.string().min(1).max(100),
  ttl: z.number().int().nonnegative().optional(),
  pollInterval: z.number().int().nonnegative().optional(),
  result: JsonValue.optional(),
}).strip();
export type McpTaskSnapshot = z.infer<typeof McpTaskSnapshot>;

export const A2ATaskState = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);
export type A2ATaskState = z.infer<typeof A2ATaskState>;

const A2APart = z.object({
  text: z.string().max(PROTOCOL_SNAPSHOT_MAX_BYTES).optional(),
  raw: z.string().max(PROTOCOL_SNAPSHOT_MAX_BYTES).optional(),
  url: z.string().max(2_000).optional(),
  data: JsonValue.optional(),
  metadata: z.record(JsonValue).optional(),
  filename: z.string().max(500).optional(),
  mediaType: z.string().max(200).optional(),
}).strip().refine((part) => [part.text, part.raw, part.url, part.data]
  .filter((value) => value !== undefined).length === 1, {
  message: "A2A Part requires exactly one content field",
});

const A2AMessage = z.object({
  messageId: BoundedId,
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(A2APart).min(1).max(256),
}).strip();

export const A2AArtifactSnapshot = z.object({
  artifactId: BoundedId,
  name: z.string().min(1).max(500).optional(),
  description: z.string().max(2_000).optional(),
  parts: z.array(A2APart).min(1).max(256),
  metadata: z.record(JsonValue).optional(),
  extensions: z.array(AbsoluteUri).max(256).optional(),
}).strip();
export type A2AArtifactSnapshot = z.infer<typeof A2AArtifactSnapshot>;

export const A2ATaskSnapshot = z.object({
  id: BoundedId,
  contextId: BoundedId.optional(),
  status: z.object({
    state: A2ATaskState,
    message: A2AMessage.optional(),
    timestamp: z.string().min(1).max(100).optional(),
  }).strip(),
  artifacts: z.array(A2AArtifactSnapshot).max(256).optional(),
  metadata: z.record(JsonValue).optional(),
}).strip();
export type A2ATaskSnapshot = z.infer<typeof A2ATaskSnapshot>;

export interface ExternalizedContent {
  uri: string;
  digest: string;
}

export interface ProtocolAdapterContext {
  remoteSystem: string;
  actor: string;
  principalId?: string;
  tenantId?: string;
  claimId?: string | null;
  clock: Clock;
}

export interface SyncMcpTaskOptions extends ProtocolAdapterContext {
  resultContent?: ExternalizedContent;
}

export interface SyncA2ATaskOptions extends ProtocolAdapterContext {
  artifactContent?: Readonly<Record<string, ExternalizedContent>>;
}

export interface ProtocolSyncResult {
  attempt: TaskAttempt;
  taskRef: ExternalRef;
  artifacts: Artifact[];
  artifactRefs: ExternalRef[];
}

interface PreparedArtifact {
  externalId: string;
  name: string;
  typeUri: string;
  digest: string;
  uri: string;
  metadata: Record<string, unknown>;
}

const MCP_STATUS_MAP = Object.freeze({
  working: "running",
  input_required: "input_required",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const);

const A2A_STATUS_MAP = Object.freeze({
  TASK_STATE_SUBMITTED: "running",
  TASK_STATE_WORKING: "running",
  TASK_STATE_COMPLETED: "succeeded",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "cancelled",
  TASK_STATE_INPUT_REQUIRED: "input_required",
  TASK_STATE_REJECTED: "failed",
  TASK_STATE_AUTH_REQUIRED: "input_required",
} as const);

export function mapMcpTaskStatus(status: McpTaskStatus): TaskAttempt["status"] {
  return MCP_STATUS_MAP[McpTaskStatus.parse(status)];
}

export function mapA2ATaskState(state: A2ATaskState): TaskAttempt["status"] {
  return A2A_STATUS_MAP[A2ATaskState.parse(state)];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Protocol snapshot requires plain JSON objects");
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new Error(`Protocol snapshot contains unsupported ${typeof value}`);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedCanonical(input: unknown): string {
  const canonical = canonicalJson(input);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > PROTOCOL_SNAPSHOT_MAX_BYTES) {
    throw new Error(`Protocol snapshot exceeds ${PROTOCOL_SNAPSHOT_MAX_BYTES} bytes`);
  }
  return canonical;
}

/** Digest helper for connectors externalizing the exact validated JSON snapshot. */
export function protocolContentDigest(input: unknown): string {
  return digest(boundedCanonical(input));
}

/** Digest the exact A2A artifact representation accepted and persisted by this adapter. */
export function a2aArtifactContentDigest(input: unknown): string {
  return protocolContentDigest(A2AArtifactSnapshot.parse(input));
}

function unixMs(iso: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new Error(`${field} must be an ISO 8601 timestamp with timezone`);
  }
  const value = Date.parse(iso);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a valid non-negative ISO timestamp`);
  return value;
}

function context(input: ProtocolAdapterContext) {
  const remoteSystem = AbsoluteUri.parse(input.remoteSystem);
  const actor = z.string().min(1).max(500).parse(input.actor);
  const observedAt = input.clock.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("Injected clock returned invalid unix-ms");
  return {
    remoteSystem,
    actor,
    principalId: input.principalId,
    tenantId: input.tenantId ?? "gwendall",
    claimId: input.claimId ?? null,
    clock: input.clock,
    observedAt,
  };
}

function identityKey(protocol: string, remoteSystem: string, remoteId: string): string {
  return digest(canonicalJson({ protocol, remoteSystem, remoteId })).slice("sha256:".length);
}

function protocolVersion(protocol: string): string {
  return protocol.slice(protocol.lastIndexOf(":") + 1);
}

function dataUri(canonical: string): string {
  return `data:application/json;base64,${Buffer.from(canonical, "utf8").toString("base64")}`;
}

function prepareArtifact(
  payload: unknown,
  external: ExternalizedContent | undefined,
  details: Omit<PreparedArtifact, "digest" | "uri">,
): PreparedArtifact {
  const canonical = boundedCanonical(payload);
  const contentDigest = digest(canonical);
  let uri: string;
  if (external) {
    uri = AbsoluteUri.parse(external.uri);
    if (external.digest !== contentDigest) {
      throw new Error(`Externalized content digest mismatch for ${details.externalId}`);
    }
  } else {
    if (Buffer.byteLength(canonical, "utf8") > INLINE_PROTOCOL_ARTIFACT_MAX_BYTES) {
      throw new Error(`Protocol artifact ${details.externalId} requires externalized content`);
    }
    uri = dataUri(canonical);
    if (uri.length > 2_000) throw new Error(`Protocol artifact ${details.externalId} data URI exceeds storage limit`);
  }
  return { ...details, digest: contentDigest, uri };
}

function a2aStatusMessage(snapshot: A2ATaskSnapshot): string | null {
  const text = snapshot.status.message?.parts
    .flatMap((part) => part.text === undefined ? [] : [part.text]).join("\n").trim();
  return text ? text.slice(0, 2_000) : null;
}

async function ensureAttempt(
  db: TasqDb,
  commitmentId: string,
  protocol: string,
  externalId: string,
  contextId: string | null,
  createdAt: number,
  ctx: ReturnType<typeof context>,
): Promise<{ attempt: TaskAttempt; key: string }> {
  const key = identityKey(protocol, ctx.remoteSystem, externalId);
  const attempt = await startTaskAttempt(db, commitmentId, {
    actor: ctx.actor,
    principalId: ctx.principalId,
    tenantId: ctx.tenantId,
    claimId: ctx.claimId,
    runtime: protocol,
    externalId,
    contextId,
    metadata: { protocol, remoteSystem: ctx.remoteSystem },
    idempotencyKey: `protocol-attempt:${key}`,
    occurredAt: createdAt,
    clock: ctx.clock,
  });
  return { attempt, key };
}

async function ensureTaskRef(
  db: TasqDb,
  attempt: TaskAttempt,
  protocol: string,
  externalId: string,
  contextId: string | null,
  key: string,
  ctx: ReturnType<typeof context>,
): Promise<ExternalRef> {
  return appendExternalRef(db, {
    tenantId: ctx.tenantId,
    recordType: "attempt",
    recordId: attempt.id,
    system: ctx.remoteSystem,
    resourceType: `${protocol}/task`,
    externalId,
    version: protocolVersion(protocol),
    metadata: contextId ? { contextId } : {},
  }, {
    actor: ctx.actor,
    principalId: ctx.principalId,
    idempotencyKey: `protocol-task-ref:${key}`,
    clock: ctx.clock,
    now: ctx.observedAt,
  });
}

async function appendPreparedArtifacts(
  db: TasqDb,
  commitmentId: string,
  attempt: TaskAttempt,
  protocol: string,
  taskKey: string,
  prepared: PreparedArtifact[],
  ctx: ReturnType<typeof context>,
): Promise<{ artifacts: Artifact[]; refs: ExternalRef[] }> {
  const artifacts: Artifact[] = [];
  const refs: ExternalRef[] = [];
  for (const item of prepared) {
    const artifactKey = digest(canonicalJson({ taskKey, externalId: item.externalId, digest: item.digest }))
      .slice("sha256:".length);
    const artifact = await appendArtifact(db, {
      tenantId: ctx.tenantId,
      taskId: commitmentId,
      attemptId: attempt.id,
      typeUri: item.typeUri,
      schemaVersion: 1,
      name: item.name,
      mediaType: "application/json",
      uri: item.uri,
      digest: item.digest,
      metadata: { ...item.metadata, remoteArtifactId: item.externalId },
    }, {
      actor: ctx.actor,
      principalId: ctx.principalId,
      idempotencyKey: `protocol-artifact:${artifactKey}`,
      clock: ctx.clock,
      now: ctx.observedAt,
    });
    const ref = await appendExternalRef(db, {
      tenantId: ctx.tenantId,
      recordType: "artifact",
      recordId: artifact.id,
      system: ctx.remoteSystem,
      resourceType: `${protocol}/artifact-snapshot`,
      externalId: `sha256:${artifactKey}`,
      version: protocolVersion(protocol),
      digest: item.digest,
      metadata: { remoteArtifactId: item.externalId },
    }, {
      actor: ctx.actor,
      principalId: ctx.principalId,
      idempotencyKey: `protocol-artifact-ref:${artifactKey}`,
      clock: ctx.clock,
      now: ctx.observedAt,
    });
    artifacts.push(artifact);
    refs.push(ref);
  }
  return { artifacts, refs };
}

async function assertTerminalArtifactSnapshots(
  db: TasqDb,
  attempt: TaskAttempt,
  prepared: PreparedArtifact[],
): Promise<void> {
  if (!["succeeded", "failed", "cancelled"].includes(attempt.status)) return;
  const existing = await listArtifacts(db, { tenantId: attempt.tenantId, attemptId: attempt.id });
  for (const item of prepared) {
    const prior = existing.find((artifact) => artifact.metadata.remoteArtifactId === item.externalId);
    if (prior && prior.digest !== item.digest) {
      throw new Error(`Protocol artifact ${item.externalId} contradicts immutable terminal snapshot`);
    }
  }
}

async function applyStatus(
  db: TasqDb,
  attempt: TaskAttempt,
  status: TaskAttempt["status"],
  occurredAt: number,
  message: string | null,
  ctx: ReturnType<typeof context>,
): Promise<TaskAttempt> {
  if (occurredAt < attempt.updatedAt) {
    throw new Error(`Out-of-order protocol snapshot: ${occurredAt} precedes attempt revision time ${attempt.updatedAt}`);
  }
  if (attempt.status === status && occurredAt === attempt.updatedAt) return attempt;
  return transitionTaskAttempt(db, attempt.id, status, {
    actor: ctx.actor,
    principalId: ctx.principalId,
    tenantId: ctx.tenantId,
    expectedRevision: attempt.revision,
    message,
    occurredAt,
    clock: ctx.clock,
  });
}

function assertStatusSnapshot(
  attempt: TaskAttempt,
  status: TaskAttempt["status"],
  occurredAt: number,
): void {
  if (occurredAt < attempt.updatedAt) {
    throw new Error(`Out-of-order protocol snapshot: ${occurredAt} precedes attempt revision time ${attempt.updatedAt}`);
  }
  if (["succeeded", "failed", "cancelled"].includes(attempt.status) && attempt.status !== status) {
    throw new Error(`Protocol snapshot contradicts terminal attempt ${attempt.id} (${attempt.status})`);
  }
}

/** Import one MCP Tasks snapshot without granting it commitment authority. */
export async function syncMcpTask(
  db: TasqDb,
  commitmentId: string,
  input: unknown,
  options: SyncMcpTaskOptions,
): Promise<ProtocolSyncResult> {
  boundedCanonical(input);
  const snapshot = McpTaskSnapshot.parse(input);
  const ctx = context(options);
  const createdAt = unixMs(snapshot.createdAt, "createdAt");
  const updatedAt = unixMs(snapshot.lastUpdatedAt, "lastUpdatedAt");
  if (updatedAt < createdAt) throw new Error("MCP lastUpdatedAt precedes createdAt");
  const prepared = snapshot.result !== undefined
    ? [prepareArtifact(snapshot.result, options.resultContent, {
      externalId: `${snapshot.taskId}:result`,
      name: `MCP result ${snapshot.taskId}`,
      typeUri: "https://schemas.tasq.dev/protocols/mcp/2025-11-25/result",
      metadata: { protocol: `mcp:${MCP_TASKS_PROTOCOL_VERSION}`, remoteTaskId: snapshot.taskId },
    })]
    : [];
  const ensured = await ensureAttempt(
    db, commitmentId, `mcp:${MCP_TASKS_PROTOCOL_VERSION}`, snapshot.taskId, null, createdAt, ctx,
  );
  const mappedStatus = mapMcpTaskStatus(snapshot.status);
  assertStatusSnapshot(ensured.attempt, mappedStatus, updatedAt);
  await assertTerminalArtifactSnapshots(db, ensured.attempt, prepared);
  const taskRef = await ensureTaskRef(
    db, ensured.attempt, `mcp:${MCP_TASKS_PROTOCOL_VERSION}`, snapshot.taskId, null, ensured.key, ctx,
  );
  const appended = await appendPreparedArtifacts(
    db, commitmentId, ensured.attempt, `mcp:${MCP_TASKS_PROTOCOL_VERSION}`, ensured.key, prepared, ctx,
  );
  const attempt = await applyStatus(
    db, ensured.attempt, mappedStatus, updatedAt,
    snapshot.statusMessage ?? null, ctx,
  );
  return { attempt, taskRef, artifacts: appended.artifacts, artifactRefs: appended.refs };
}

/** Import one A2A 1.0 Task snapshot and its immutable artifact snapshots. */
export async function syncA2ATask(
  db: TasqDb,
  commitmentId: string,
  input: unknown,
  options: SyncA2ATaskOptions,
): Promise<ProtocolSyncResult> {
  boundedCanonical(input);
  const snapshot = A2ATaskSnapshot.parse(input);
  const ctx = context(options);
  const occurredAt = snapshot.status.timestamp
    ? unixMs(snapshot.status.timestamp, "status.timestamp")
    : ctx.observedAt;
  const prepared = (snapshot.artifacts ?? []).map((artifact) => prepareArtifact(
    artifact,
    options.artifactContent?.[artifact.artifactId],
    {
      externalId: artifact.artifactId,
      name: artifact.name ?? `A2A artifact ${artifact.artifactId}`,
      typeUri: "https://schemas.tasq.dev/protocols/a2a/1.0/artifact",
      metadata: {
        protocol: `a2a:${A2A_PROTOCOL_VERSION}`,
        remoteTaskId: snapshot.id,
        remoteArtifactId: artifact.artifactId,
        partCount: artifact.parts.length,
        extensions: artifact.extensions ?? [],
      },
    },
  ));
  const ensured = await ensureAttempt(
    db, commitmentId, `a2a:${A2A_PROTOCOL_VERSION}`, snapshot.id,
    snapshot.contextId ?? null, occurredAt, ctx,
  );
  const mappedStatus = mapA2ATaskState(snapshot.status.state);
  assertStatusSnapshot(ensured.attempt, mappedStatus, occurredAt);
  await assertTerminalArtifactSnapshots(db, ensured.attempt, prepared);
  const taskRef = await ensureTaskRef(
    db, ensured.attempt, `a2a:${A2A_PROTOCOL_VERSION}`, snapshot.id,
    snapshot.contextId ?? null, ensured.key, ctx,
  );
  const appended = await appendPreparedArtifacts(
    db, commitmentId, ensured.attempt, `a2a:${A2A_PROTOCOL_VERSION}`, ensured.key, prepared, ctx,
  );
  const attempt = await applyStatus(
    db, ensured.attempt, mappedStatus, occurredAt,
    a2aStatusMessage(snapshot), ctx,
  );
  return { attempt, taskRef, artifacts: appended.artifacts, artifactRefs: appended.refs };
}
