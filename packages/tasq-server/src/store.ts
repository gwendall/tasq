import { createClient, type Client, type Transaction } from "@libsql/client";
import type { Clock } from "@tasq-run/schema";
import {
  ActionIdentity,
  AuthorityEligibility,
  AuthorityPrincipal,
  AuthorizationDecision,
  AuthorizationGrant,
  AuthorizationRequest,
  Delegation,
  PermissionSetDefinition,
  SubjectBinding,
  digestAuthorityValue,
  evaluateAuthorization,
  getRegisteredAction,
  type AuthorityEligibility as AuthorityEligibilityValue,
  type AuthorityPrincipal as AuthorityPrincipalValue,
  type AuthorizationDecision as AuthorizationDecisionValue,
  type AuthorizationGrant as AuthorizationGrantValue,
  type Delegation as DelegationValue,
  type PermissionSetDefinition as PermissionSetDefinitionValue,
  type ResourceRef,
  type SubjectBinding as SubjectBindingValue,
  type VerifiedIdentity,
} from "@tasq-internal/authority";
import { z } from "zod";
import { migrateAuthorityStore } from "./migration.js";
import {
  MandateIntent,
  MandateView,
  compileMandate,
  mandateRecordIds,
  protectedMandateDecision,
  type MandateDecision,
  type MandateIntent as MandateIntentValue,
  type MandateView as MandateViewValue,
} from "./mandates.js";

const Id = z.string().min(1).max(500).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const AuditTargetId = z.string().min(1).max(1_000).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const EnrollmentRecordSchema = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  principalId: Id,
  issuer: z.string().url(),
  subject: Id,
  clientKind: z.enum(["human_device", "workload_agent"]),
  tokenDigest: Digest,
  actionUpperBound: z.array(ActionIdentity).min(1),
  createdAt: UnixMs,
  expiresAt: UnixMs,
  accessExpiresAt: UnixMs,
  consumedAt: UnixMs.nullable(),
  revokedAt: UnixMs.nullable(),
}).strict();
export type EnrollmentRecord = z.infer<typeof EnrollmentRecordSchema>;

const AccessCredentialRecordSchema = z.object({
  id: Id,
  enrollmentId: Id,
  workspaceId: WorkspaceId,
  principalId: Id,
  issuer: z.string().url(),
  subject: Id,
  clientKind: z.enum(["human_device", "workload_agent"]),
  tokenDigest: Digest,
  actionUpperBound: z.array(ActionIdentity).min(1),
  issuedAt: UnixMs,
  expiresAt: UnixMs,
  status: z.enum(["active", "revoked"]),
  revision: z.number().int().positive(),
  revokedAt: UnixMs.nullable(),
}).strict();
export type AccessCredentialRecord = z.infer<typeof AccessCredentialRecordSchema>;

export class EnrollmentStoreError extends Error {
  constructor(readonly code: "not_found" | "expired" | "consumed" | "revoked" | "invalid_binding") {
    super(code);
    this.name = "EnrollmentStoreError";
  }
}

export const AuthorityMutationContext = z.object({
  operationId: Id,
  actorPrincipalId: Id.nullable(),
  reason: z.string().min(1).max(1_000),
  expectedAuthorityRevision: z.number().int().nonnegative().nullable(),
}).strict();
export type AuthorityMutationContext = z.infer<typeof AuthorityMutationContext>;

const AuthorityMutationResultSchema = z.object({
  operationId: Id,
  workspaceId: WorkspaceId.nullable(),
  operation: Id,
  targetType: Id,
  targetId: AuditTargetId,
  authorityRevision: z.number().int().nonnegative().nullable(),
  occurredAt: UnixMs,
  replayed: z.boolean(),
}).strict();
export type AuthorityMutationResult = z.infer<typeof AuthorityMutationResultSchema>;

export interface WorkspaceAuthorizationInput {
  requestId: string;
  workspaceId: string;
  serviceAudience: string;
  action: ActionIdentity;
  resource: ResourceRef;
  identity: VerifiedIdentity;
}

export interface WorkspaceAuthorizationResult {
  decision: AuthorizationDecisionValue;
  authorityRevision: number | null;
  storageBindingId: string | null;
  replayed: boolean;
}

export interface AuthorizedExecutionResult<T> {
  authorization: WorkspaceAuthorizationResult;
  execution: T | null;
}

export class AuthorityStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "already_exists"
      | "revision_conflict"
      | "idempotency_conflict"
      | "authority_busy"
      | "workspace_disabled"
      | "authority_corrupt",
    message: string,
  ) {
    super(message);
    this.name = "AuthorityStoreError";
  }
}

function mapAuthorityStoreError(error: unknown): unknown {
  if (error instanceof AuthorityStoreError) return error;
  if (error instanceof z.ZodError) {
    return new AuthorityStoreError("authority_corrupt", "stored authority record violates its strict contract");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new AuthorityStoreError("already_exists", "authority identity already exists");
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new AuthorityStoreError("not_found", "referenced authority record does not exist");
  }
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return new AuthorityStoreError("authority_busy", "another authority writer currently owns the workspace gate");
  }
  return error;
}

function isAuthorityBusy(error: unknown): boolean {
  if (error instanceof AuthorityStoreError) return error.code === "authority_busy";
  if (typeof error === "object" && error !== null && "code" in error
    && String((error as { code: unknown }).code).startsWith("SQLITE_BUSY")) return true;
  return /SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : String(error));
}

async function initializeAuthorityClient(client: Client, url: string, appliedAt: number): Promise<void> {
  await client.execute("PRAGMA busy_timeout = 30000");
  if (url !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA synchronous = NORMAL");
  await migrateAuthorityStore(client, appliedAt);
}

async function beginAuthorityWrite(client: Client): Promise<Transaction> {
  try {
    return await client.transaction("write");
  } catch (error) {
    throw mapAuthorityStoreError(error);
  }
}

function requiredClockNow(clock: Clock): number {
  if (!clock || typeof clock.now !== "function") throw new Error("authority store requires an injected Clock");
  return UnixMs.parse(clock.now());
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AuthorityStoreError("authority_corrupt", `authority column ${key} is invalid`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new AuthorityStoreError("authority_corrupt", `authority column ${key} is invalid`);
  return value;
}

function nullableInteger(row: Record<string, unknown>, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function json<T>(row: Record<string, unknown>, key: string): T {
  try {
    return JSON.parse(text(row, key)) as T;
  } catch {
    throw new AuthorityStoreError("authority_corrupt", `authority column ${key} is not JSON`);
  }
}

function portableJson(value: unknown): string {
  return JSON.stringify(value);
}

function exactRegisteredActions(value: unknown): ActionIdentity[] {
  const parsed = z.array(ActionIdentity).min(1).max(32).parse(value);
  const sorted = [...parsed].sort((left, right) => left.uri.localeCompare(right.uri));
  if (new Set(sorted.map(({ uri }) => uri)).size !== sorted.length) {
    throw new EnrollmentStoreError("invalid_binding");
  }
  for (const action of sorted) {
    const registered = getRegisteredAction(action.uri);
    if (!registered || registered.version !== action.version
      || registered.implementationDigest !== action.implementationDigest) {
      throw new EnrollmentStoreError("invalid_binding");
    }
  }
  return sorted;
}

function enrollmentFromRow(row: Record<string, unknown>): EnrollmentRecord {
  return EnrollmentRecordSchema.parse({
    id: text(row, "id"),
    workspaceId: text(row, "workspace_id"),
    principalId: text(row, "principal_id"),
    issuer: text(row, "issuer"),
    subject: text(row, "subject"),
    clientKind: text(row, "client_kind"),
    tokenDigest: text(row, "token_digest"),
    actionUpperBound: json(row, "action_upper_bound_json"),
    createdAt: integer(row, "created_at"),
    expiresAt: integer(row, "expires_at"),
    accessExpiresAt: integer(row, "access_expires_at"),
    consumedAt: nullableInteger(row, "consumed_at"),
    revokedAt: nullableInteger(row, "revoked_at"),
  });
}

function credentialFromRow(row: Record<string, unknown>): AccessCredentialRecord {
  return AccessCredentialRecordSchema.parse({
    id: text(row, "id"),
    enrollmentId: text(row, "enrollment_id"),
    workspaceId: text(row, "workspace_id"),
    principalId: text(row, "principal_id"),
    issuer: text(row, "issuer"),
    subject: text(row, "subject"),
    clientKind: text(row, "client_kind"),
    tokenDigest: text(row, "token_digest"),
    actionUpperBound: json(row, "action_upper_bound_json"),
    issuedAt: integer(row, "issued_at"),
    expiresAt: integer(row, "expires_at"),
    status: text(row, "status"),
    revision: integer(row, "revision"),
    revokedAt: nullableInteger(row, "revoked_at"),
  });
}

async function rollback(transaction: Transaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // Preserve the operation's original failure.
  }
}

interface WorkspaceRow {
  workspaceId: string;
  storageBindingId: string;
  status: "enabled" | "disabled";
  authorityRevision: number;
}

function workspaceFromRow(row: Record<string, unknown>): WorkspaceRow {
  const status = text(row, "status");
  if (status !== "enabled" && status !== "disabled") {
    throw new AuthorityStoreError("authority_corrupt", "workspace status is invalid");
  }
  return {
    workspaceId: text(row, "workspace_id"),
    storageBindingId: text(row, "storage_binding_id"),
    status,
    authorityRevision: integer(row, "authority_revision"),
  };
}

export class AuthorityStore {
  constructor(
    private readonly client: Client,
    private readonly clock: Clock,
  ) {}

  async close(): Promise<void> {
    this.client.close();
  }

  async getWorkspaceAuthorityState(workspaceIdInput: string): Promise<{
    workspaceId: string;
    storageBindingId: string;
    status: "enabled" | "disabled";
    authorityRevision: number;
  } | null> {
    const workspaceId = WorkspaceId.parse(workspaceIdInput);
    const result = await this.client.execute({
      sql: "SELECT workspace_id, storage_binding_id, status, authority_revision FROM hosted_workspace WHERE workspace_id = ?",
      args: [workspaceId],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? workspaceFromRow(row) : null;
  }

  private async findIdempotent(
    transaction: Transaction,
    operationId: string,
    requestDigest: string,
  ): Promise<AuthorityMutationResult | null> {
    const found = await transaction.execute({
      sql: "SELECT request_digest, result_json FROM authority_idempotency WHERE operation_id = ?",
      args: [operationId],
    });
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (text(row, "request_digest") !== requestDigest) {
      throw new AuthorityStoreError("idempotency_conflict", `operation ${operationId} was reused with different input`);
    }
    const result = AuthorityMutationResultSchema.parse(json(row, "result_json"));
    return { ...result, replayed: true };
  }

  private async workspaceMutation(input: {
    workspaceId: string;
    operation: string;
    targetType: string;
    targetId: string;
    context: AuthorityMutationContext;
    request: unknown;
    apply: (transaction: Transaction, now: number) => Promise<void>;
  }): Promise<AuthorityMutationResult> {
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const context = AuthorityMutationContext.parse(input.context);
    if (context.expectedAuthorityRevision === null) {
      throw new AuthorityStoreError("revision_conflict", "workspace mutation requires expectedAuthorityRevision");
    }
    const now = requiredClockNow(this.clock);
    const requestDigest = digestAuthorityValue({
      operation: input.operation,
      workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      context,
      request: input.request,
    });
    const transaction = await beginAuthorityWrite(this.client);
    try {
      const replay = await this.findIdempotent(transaction, context.operationId, requestDigest);
      if (replay) {
        await transaction.commit();
        return replay;
      }
      const workspaceResult = await transaction.execute({
        sql: "SELECT workspace_id, storage_binding_id, status, authority_revision FROM hosted_workspace WHERE workspace_id = ?",
        args: [workspaceId],
      });
      const row = workspaceResult.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new AuthorityStoreError("not_found", `workspace ${workspaceId} does not exist`);
      const workspace = workspaceFromRow(row);
      if (workspace.status !== "enabled") throw new AuthorityStoreError("workspace_disabled", `workspace ${workspaceId} is disabled`);
      if (workspace.authorityRevision !== context.expectedAuthorityRevision) {
        throw new AuthorityStoreError("revision_conflict", `workspace authority revision is ${workspace.authorityRevision}`);
      }

      await input.apply(transaction, now);
      const nextRevision = workspace.authorityRevision + 1;
      const updated = await transaction.execute({
        sql: `UPDATE hosted_workspace SET authority_revision = ?, updated_at = ?
              WHERE workspace_id = ? AND authority_revision = ? AND status = 'enabled'`,
        args: [nextRevision, now, workspaceId, workspace.authorityRevision],
      });
      if (updated.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "workspace authority changed concurrently");

      const result = AuthorityMutationResultSchema.parse({
        operationId: context.operationId,
        workspaceId,
        operation: input.operation,
        targetType: input.targetType,
        targetId: input.targetId,
        authorityRevision: nextRevision,
        occurredAt: now,
        replayed: false,
      });
      await transaction.execute({
        sql: `INSERT INTO authority_audit(
                event_id, workspace_id, occurred_at, actor_principal_id, event_type,
                target_type, target_id, authority_revision, request_digest, reason, payload_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [context.operationId, workspaceId, now, context.actorPrincipalId, input.operation,
          input.targetType, input.targetId, nextRevision, requestDigest, context.reason,
          portableJson({ operationId: context.operationId, targetType: input.targetType, targetId: input.targetId })],
      });
      await transaction.execute({
        sql: `INSERT INTO authority_idempotency(operation_id, workspace_id, operation, request_digest, result_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [context.operationId, workspaceId, input.operation, requestDigest, portableJson(result), now],
      });
      await transaction.commit();
      return result;
    } catch (error) {
      await rollback(transaction);
      throw mapAuthorityStoreError(error);
    }
  }

  async provisionHostTenant(input: {
    id: string;
    context: Omit<AuthorityMutationContext, "expectedAuthorityRevision">;
  }): Promise<AuthorityMutationResult> {
    const id = Id.parse(input.id);
    const context = AuthorityMutationContext.parse({ ...input.context, expectedAuthorityRevision: null });
    const now = requiredClockNow(this.clock);
    const requestDigest = digestAuthorityValue({ operation: "host_tenant.provision", id, context });
    const transaction = await beginAuthorityWrite(this.client);
    try {
      const replay = await this.findIdempotent(transaction, context.operationId, requestDigest);
      if (replay) { await transaction.commit(); return replay; }
      await transaction.execute({
        sql: "INSERT INTO host_tenant(id, status, revision, created_at) VALUES (?, 'enabled', 1, ?)",
        args: [id, now],
      });
      const result = AuthorityMutationResultSchema.parse({
        operationId: context.operationId, workspaceId: null, operation: "host_tenant.provision",
        targetType: "host_tenant", targetId: id, authorityRevision: null, occurredAt: now, replayed: false,
      });
      await transaction.execute({
        sql: `INSERT INTO authority_audit(event_id, workspace_id, occurred_at, actor_principal_id, event_type,
                target_type, target_id, authority_revision, request_digest, reason, payload_json)
              VALUES (?, NULL, ?, ?, 'host_tenant.provision', 'host_tenant', ?, NULL, ?, ?, ?)`,
        args: [context.operationId, now, context.actorPrincipalId, id, requestDigest, context.reason,
          portableJson({ operationId: context.operationId, targetType: "host_tenant", targetId: id })],
      });
      await transaction.execute({
        sql: `INSERT INTO authority_idempotency(operation_id, workspace_id, operation, request_digest, result_json, created_at)
              VALUES (?, NULL, 'host_tenant.provision', ?, ?, ?)`,
        args: [context.operationId, requestDigest, portableJson(result), now],
      });
      await transaction.commit();
      return result;
    } catch (error) {
      await rollback(transaction);
      throw mapAuthorityStoreError(error);
    }
  }

  async provisionWorkspace(input: {
    workspaceId: string;
    hostTenantId: string;
    storageBindingId: string;
    context: Omit<AuthorityMutationContext, "expectedAuthorityRevision">;
  }): Promise<AuthorityMutationResult> {
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const hostTenantId = Id.parse(input.hostTenantId);
    const storageBindingId = Id.parse(input.storageBindingId);
    const context = AuthorityMutationContext.parse({ ...input.context, expectedAuthorityRevision: null });
    const now = requiredClockNow(this.clock);
    const requestDigest = digestAuthorityValue({
      operation: "workspace.provision", workspaceId, hostTenantId, storageBindingId, context,
    });
    const transaction = await beginAuthorityWrite(this.client);
    try {
      const replay = await this.findIdempotent(transaction, context.operationId, requestDigest);
      if (replay) { await transaction.commit(); return replay; }
      await transaction.execute({
        sql: `INSERT INTO hosted_workspace(
                workspace_id, host_tenant_id, storage_binding_id, status, authority_revision, created_at, updated_at
              ) VALUES (?, ?, ?, 'enabled', 0, ?, ?)`,
        args: [workspaceId, hostTenantId, storageBindingId, now, now],
      });
      const result = AuthorityMutationResultSchema.parse({
        operationId: context.operationId, workspaceId, operation: "workspace.provision",
        targetType: "workspace", targetId: workspaceId, authorityRevision: 0, occurredAt: now, replayed: false,
      });
      await transaction.execute({
        sql: `INSERT INTO authority_audit(event_id, workspace_id, occurred_at, actor_principal_id, event_type,
                target_type, target_id, authority_revision, request_digest, reason, payload_json)
              VALUES (?, ?, ?, ?, 'workspace.provision', 'workspace', ?, 0, ?, ?, ?)`,
        args: [context.operationId, workspaceId, now, context.actorPrincipalId, workspaceId, requestDigest, context.reason,
          portableJson({ operationId: context.operationId, targetType: "workspace", targetId: workspaceId })],
      });
      await transaction.execute({
        sql: `INSERT INTO authority_idempotency(operation_id, workspace_id, operation, request_digest, result_json, created_at)
              VALUES (?, ?, 'workspace.provision', ?, ?, ?)`,
        args: [context.operationId, workspaceId, requestDigest, portableJson(result), now],
      });
      await transaction.commit();
      return result;
    } catch (error) {
      await rollback(transaction);
      throw mapAuthorityStoreError(error);
    }
  }

  async registerPrincipal(input: {
    principal: AuthorityPrincipalValue;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const principal = AuthorityPrincipal.parse(input.principal);
    if (principal.revision !== 1 || principal.status !== "enabled") {
      throw new AuthorityStoreError("revision_conflict", "new principals must start enabled at revision 1");
    }
    return this.workspaceMutation({
      workspaceId: principal.workspaceId,
      operation: "principal.register",
      targetType: "principal",
      targetId: principal.id,
      context: input.context,
      request: principal,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO authority_principal(workspace_id, id, kind, status, revision)
                VALUES (?, ?, ?, ?, ?)`,
          args: [principal.workspaceId, principal.id, principal.kind, principal.status, principal.revision],
        });
      },
    });
  }

  async disablePrincipal(input: {
    workspaceId: string;
    principalId: string;
    expectedPrincipalRevision: number;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "principal.disable",
      targetType: "principal",
      targetId: Id.parse(input.principalId),
      context: input.context,
      request: { expectedPrincipalRevision: input.expectedPrincipalRevision },
      apply: async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE authority_principal SET status = 'disabled', revision = revision + 1
                WHERE workspace_id = ? AND id = ? AND status = 'enabled' AND revision = ?`,
          args: [input.workspaceId, input.principalId, input.expectedPrincipalRevision],
        });
        if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "principal revision changed");
      },
    });
  }

  async bindSubject(input: {
    binding: SubjectBindingValue;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const binding = SubjectBinding.parse(input.binding);
    if (binding.revision !== 1 || binding.status !== "enabled" || binding.disabledAt !== null) {
      throw new AuthorityStoreError("revision_conflict", "new bindings must start enabled at revision 1");
    }
    return this.workspaceMutation({
      workspaceId: binding.workspaceId,
      operation: "subject_binding.create",
      targetType: "subject_binding",
      targetId: binding.id,
      context: input.context,
      request: binding,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO subject_binding(
                  workspace_id, id, principal_id, issuer, subject, method, status,
                  revision, created_at, disabled_at, replaced_by_binding_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [binding.workspaceId, binding.id, binding.principalId, binding.issuer, binding.subject,
            binding.method, binding.status, binding.revision, binding.createdAt, binding.disabledAt,
            binding.replacedByBindingId],
        });
      },
    });
  }

  async disableBinding(input: {
    workspaceId: string;
    bindingId: string;
    expectedBindingRevision: number;
    replacedByBindingId?: string | null;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "subject_binding.disable",
      targetType: "subject_binding",
      targetId: Id.parse(input.bindingId),
      context: input.context,
      request: {
        expectedBindingRevision: input.expectedBindingRevision,
        replacedByBindingId: input.replacedByBindingId ?? null,
      },
      apply: async (transaction, now) => {
        const result = await transaction.execute({
          sql: `UPDATE subject_binding
                SET status = 'disabled', revision = revision + 1, disabled_at = ?, replaced_by_binding_id = ?
                WHERE workspace_id = ? AND id = ? AND status = 'enabled' AND revision = ?`,
          args: [now, input.replacedByBindingId ?? null, input.workspaceId, input.bindingId, input.expectedBindingRevision],
        });
        if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "binding revision changed");
      },
    });
  }

  async activatePermissionSet(input: {
    workspaceId: string;
    permissionSet: PermissionSetDefinitionValue;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const permissionSet = PermissionSetDefinition.parse(input.permissionSet);
    return this.workspaceMutation({
      workspaceId,
      operation: "permission_set.activate",
      targetType: "permission_set",
      targetId: `${permissionSet.uri}#${permissionSet.version}`,
      context: input.context,
      request: permissionSet,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO permission_set(
                  workspace_id, uri, version, implementation_digest, actions_json, status, revision
                ) VALUES (?, ?, ?, ?, ?, 'active', 1)`,
          args: [workspaceId, permissionSet.uri, permissionSet.version, permissionSet.implementationDigest,
            portableJson(permissionSet.actions)],
        });
      },
    });
  }

  async retirePermissionSet(input: {
    workspaceId: string;
    uri: string;
    version: number;
    expectedPermissionRevision: number;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const targetId = `${input.uri}#${input.version}`;
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "permission_set.retire",
      targetType: "permission_set",
      targetId,
      context: input.context,
      request: {
        uri: input.uri,
        version: input.version,
        expectedPermissionRevision: input.expectedPermissionRevision,
      },
      apply: async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE permission_set SET status = 'retired', revision = revision + 1
                WHERE workspace_id = ? AND uri = ? AND version = ? AND status = 'active' AND revision = ?`,
          args: [input.workspaceId, input.uri, input.version, input.expectedPermissionRevision],
        });
        if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "permission set revision changed");
      },
    });
  }

  async createGrant(input: {
    grant: AuthorizationGrantValue;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const grant = AuthorizationGrant.parse(input.grant);
    if (grant.revision !== 1 || grant.status !== "active") {
      throw new AuthorityStoreError("revision_conflict", "new grants must start active at revision 1");
    }
    return this.workspaceMutation({
      workspaceId: grant.workspaceId,
      operation: "grant.create",
      targetType: "grant",
      targetId: grant.id,
      context: input.context,
      request: grant,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO authorization_grant(
                  workspace_id, id, grantor_principal_id, grantee_principal_id,
                  permission_uri, permission_version, permission_digest, scope_json,
                  not_before, expires_at, status, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [grant.workspaceId, grant.id, grant.grantorPrincipalId, grant.granteePrincipalId,
            grant.permissionSet.uri, grant.permissionSet.version, grant.permissionSet.implementationDigest,
            portableJson(grant.scope), grant.notBefore, grant.expiresAt, grant.status, grant.revision],
        });
      },
    });
  }

  async revokeGrant(input: {
    workspaceId: string;
    grantId: string;
    expectedGrantRevision: number;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "grant.revoke",
      targetType: "grant",
      targetId: Id.parse(input.grantId),
      context: input.context,
      request: { expectedGrantRevision: input.expectedGrantRevision },
      apply: async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE authorization_grant SET status = 'revoked', revision = revision + 1
                WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?`,
          args: [input.workspaceId, input.grantId, input.expectedGrantRevision],
        });
        if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "grant revision changed");
      },
    });
  }

  async createDelegation(input: {
    delegation: DelegationValue;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const delegation = Delegation.parse(input.delegation);
    if (delegation.revision !== 1 || delegation.status !== "active") {
      throw new AuthorityStoreError("revision_conflict", "new delegations must start active at revision 1");
    }
    return this.workspaceMutation({
      workspaceId: delegation.workspaceId,
      operation: "delegation.create",
      targetType: "delegation",
      targetId: delegation.id,
      context: input.context,
      request: delegation,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO authority_delegation(
                  workspace_id, id, subject_principal_id, actor_principal_id, actions_json,
                  scope_json, not_before, expires_at, status, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [delegation.workspaceId, delegation.id, delegation.subjectPrincipalId,
            delegation.actorPrincipalId, portableJson(delegation.actions), portableJson(delegation.scope),
            delegation.notBefore, delegation.expiresAt, delegation.status, delegation.revision],
        });
      },
    });
  }

  async revokeDelegation(input: {
    workspaceId: string;
    delegationId: string;
    expectedDelegationRevision: number;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "delegation.revoke",
      targetType: "delegation",
      targetId: Id.parse(input.delegationId),
      context: input.context,
      request: { expectedDelegationRevision: input.expectedDelegationRevision },
      apply: async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE authority_delegation SET status = 'revoked', revision = revision + 1
                WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?`,
          args: [input.workspaceId, input.delegationId, input.expectedDelegationRevision],
        });
        if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "delegation revision changed");
      },
    });
  }

  async grantEligibility(input: {
    eligibility: AuthorityEligibilityValue;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const eligibility = AuthorityEligibility.parse(input.eligibility);
    if (eligibility.revision !== 1 || eligibility.status !== "active") {
      throw new AuthorityStoreError("revision_conflict", "new eligibility must start active at revision 1");
    }
    return this.workspaceMutation({
      workspaceId: eligibility.workspaceId,
      operation: "eligibility.grant",
      targetType: "eligibility",
      targetId: eligibility.id,
      context: input.context,
      request: eligibility,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO authority_eligibility(
                  workspace_id, id, principal_id, kind, status, not_before, expires_at, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [eligibility.workspaceId, eligibility.id, eligibility.principalId, eligibility.kind,
            eligibility.status, eligibility.notBefore, eligibility.expiresAt, eligibility.revision],
        });
      },
    });
  }

  async revokeEligibility(input: {
    workspaceId: string;
    eligibilityId: string;
    expectedEligibilityRevision: number;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "eligibility.revoke",
      targetType: "eligibility",
      targetId: Id.parse(input.eligibilityId),
      context: input.context,
      request: { expectedEligibilityRevision: input.expectedEligibilityRevision },
      apply: async (transaction) => {
        const result = await transaction.execute({
          sql: `UPDATE authority_eligibility SET status = 'revoked', revision = revision + 1
                WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?`,
          args: [input.workspaceId, input.eligibilityId, input.expectedEligibilityRevision],
        });
        if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "eligibility revision changed");
      },
    });
  }

  async createEnrollment(input: {
    enrollment: Omit<EnrollmentRecord, "consumedAt" | "revokedAt">;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    const enrollment = EnrollmentRecordSchema.parse({
      ...input.enrollment,
      actionUpperBound: exactRegisteredActions(input.enrollment.actionUpperBound),
      consumedAt: null,
      revokedAt: null,
    });
    if (enrollment.expiresAt <= enrollment.createdAt
      || enrollment.accessExpiresAt <= enrollment.createdAt) {
      throw new EnrollmentStoreError("expired");
    }
    return this.workspaceMutation({
      workspaceId: enrollment.workspaceId,
      operation: "enrollment.create",
      targetType: "enrollment",
      targetId: enrollment.id,
      context: input.context,
      request: {
        id: enrollment.id,
        principalId: enrollment.principalId,
        issuer: enrollment.issuer,
        subject: enrollment.subject,
        clientKind: enrollment.clientKind,
        tokenDigest: enrollment.tokenDigest,
        actionUpperBound: enrollment.actionUpperBound,
        createdAt: enrollment.createdAt,
        expiresAt: enrollment.expiresAt,
        accessExpiresAt: enrollment.accessExpiresAt,
      },
      apply: async (transaction) => {
        const binding = await transaction.execute({
          sql: `SELECT b.id FROM subject_binding b
                JOIN authority_principal p ON p.workspace_id = b.workspace_id AND p.id = b.principal_id
                WHERE b.workspace_id = ? AND b.principal_id = ? AND b.issuer = ? AND b.subject = ?
                  AND b.status = 'enabled' AND p.status = 'enabled'`,
          args: [enrollment.workspaceId, enrollment.principalId, enrollment.issuer, enrollment.subject],
        });
        if (binding.rows.length !== 1) throw new EnrollmentStoreError("invalid_binding");
        await transaction.execute({
          sql: `INSERT INTO hosted_enrollment(
                  id, workspace_id, principal_id, issuer, subject, client_kind, token_digest,
                  action_upper_bound_json, created_at, expires_at, access_expires_at, consumed_at, revoked_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          args: [
            enrollment.id, enrollment.workspaceId, enrollment.principalId, enrollment.issuer,
            enrollment.subject, enrollment.clientKind, enrollment.tokenDigest,
            portableJson(enrollment.actionUpperBound), enrollment.createdAt, enrollment.expiresAt,
            enrollment.accessExpiresAt,
          ],
        });
      },
    });
  }

  /**
   * Atomically consumes one bootstrap token and creates its opaque access
   * credential. Raw tokens never enter this store; callers provide only
   * peppered digests and return the credential secret once after commit.
   */
  async redeemEnrollment(input: {
    workspaceId: string;
    enrollmentTokenDigest: string;
    credentialId: string;
    credentialTokenDigest: string;
    auditEventId: string;
  }): Promise<AccessCredentialRecord> {
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const enrollmentTokenDigest = Digest.parse(input.enrollmentTokenDigest);
    const credentialId = Id.parse(input.credentialId);
    const credentialTokenDigest = Digest.parse(input.credentialTokenDigest);
    const auditEventId = Id.parse(input.auditEventId);
    const now = requiredClockNow(this.clock);
    const transaction = await beginAuthorityWrite(this.client);
    try {
      const found = await transaction.execute({
        sql: `SELECT e.* FROM hosted_enrollment e
              JOIN hosted_workspace w ON w.workspace_id = e.workspace_id AND w.status = 'enabled'
              JOIN authority_principal p ON p.workspace_id = e.workspace_id
                AND p.id = e.principal_id AND p.status = 'enabled'
              JOIN subject_binding b ON b.workspace_id = e.workspace_id
                AND b.principal_id = e.principal_id AND b.issuer = e.issuer
                AND b.subject = e.subject AND b.status = 'enabled'
              WHERE e.workspace_id = ? AND e.token_digest = ?`,
        args: [workspaceId, enrollmentTokenDigest],
      });
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new EnrollmentStoreError("not_found");
      const enrollment = enrollmentFromRow(row);
      if (enrollment.revokedAt !== null) throw new EnrollmentStoreError("revoked");
      if (enrollment.consumedAt !== null) throw new EnrollmentStoreError("consumed");
      if (now >= enrollment.expiresAt) throw new EnrollmentStoreError("expired");
      const credentialExpiresAt = enrollment.accessExpiresAt;
      if (credentialExpiresAt <= now) {
        throw new EnrollmentStoreError("expired");
      }
      const consumed = await transaction.execute({
        sql: `UPDATE hosted_enrollment SET consumed_at = ?
              WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
        args: [now, enrollment.id],
      });
      if (consumed.rowsAffected !== 1) throw new EnrollmentStoreError("consumed");
      await transaction.execute({
        sql: `INSERT INTO hosted_access_credential(
                id, enrollment_id, workspace_id, principal_id, issuer, subject, client_kind,
                token_digest, action_upper_bound_json, issued_at, expires_at, status, revision, revoked_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, NULL)`,
        args: [
          credentialId, enrollment.id, enrollment.workspaceId, enrollment.principalId,
          enrollment.issuer, enrollment.subject, enrollment.clientKind, credentialTokenDigest,
          portableJson(enrollment.actionUpperBound), now, credentialExpiresAt,
        ],
      });
      const credential = AccessCredentialRecordSchema.parse({
        id: credentialId,
        enrollmentId: enrollment.id,
        workspaceId: enrollment.workspaceId,
        principalId: enrollment.principalId,
        issuer: enrollment.issuer,
        subject: enrollment.subject,
        clientKind: enrollment.clientKind,
        tokenDigest: credentialTokenDigest,
        actionUpperBound: enrollment.actionUpperBound,
        issuedAt: now,
        expiresAt: credentialExpiresAt,
        status: "active",
        revision: 1,
        revokedAt: null,
      });
      await transaction.execute({
        sql: `INSERT INTO authority_audit(
                event_id, workspace_id, occurred_at, actor_principal_id, event_type,
                target_type, target_id, authority_revision, request_digest, reason, payload_json
              ) SELECT ?, workspace_id, ?, ?, 'enrollment.redeem',
                  'access_credential', ?, authority_revision, ?, 'one-use remote enrollment',
                  ? FROM hosted_workspace WHERE workspace_id = ?`,
        args: [
          auditEventId, now, credential.principalId, credentialId,
          digestAuthorityValue({
            enrollmentId: enrollment.id,
            credentialId,
            credentialTokenDigest,
            credentialExpiresAt,
          }),
          portableJson({
            enrollmentId: enrollment.id,
            credentialId,
            clientKind: enrollment.clientKind,
            expiresAt: credentialExpiresAt,
          }),
          workspaceId,
        ],
      });
      await transaction.commit();
      return credential;
    } catch (error) {
      await rollback(transaction);
      throw mapAuthorityStoreError(error);
    }
  }

  async revokeEnrollment(input: {
    workspaceId: string;
    enrollmentId: string;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "enrollment.revoke",
      targetType: "enrollment",
      targetId: Id.parse(input.enrollmentId),
      context: input.context,
      request: {},
      apply: async (transaction, now) => {
        const result = await transaction.execute({
          sql: `UPDATE hosted_enrollment SET revoked_at = ?
                WHERE workspace_id = ? AND id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
          args: [now, input.workspaceId, input.enrollmentId],
        });
        if (result.rowsAffected !== 1) throw new EnrollmentStoreError("consumed");
      },
    });
  }

  async revokeAccessCredential(input: {
    workspaceId: string;
    credentialId: string;
    expectedCredentialRevision: number;
    context: AuthorityMutationContext;
  }): Promise<AuthorityMutationResult> {
    return this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "access_credential.revoke",
      targetType: "access_credential",
      targetId: Id.parse(input.credentialId),
      context: input.context,
      request: { expectedCredentialRevision: input.expectedCredentialRevision },
      apply: async (transaction, now) => {
        const result = await transaction.execute({
          sql: `UPDATE hosted_access_credential
                SET status = 'revoked', revision = revision + 1, revoked_at = ?
                WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?`,
          args: [now, input.workspaceId, input.credentialId, input.expectedCredentialRevision],
        });
        if (result.rowsAffected !== 1) throw new EnrollmentStoreError("revoked");
      },
    });
  }

  async findAccessCredential(tokenDigest: string): Promise<AccessCredentialRecord | null> {
    const result = await this.client.execute({
      sql: "SELECT * FROM hosted_access_credential WHERE token_digest = ?",
      args: [Digest.parse(tokenDigest)],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? credentialFromRow(row) : null;
  }

  private principalFromRow(row: Record<string, unknown>): AuthorityPrincipalValue {
    return AuthorityPrincipal.parse({
      id: text(row, "principal_id"),
      workspaceId: text(row, "workspace_id"),
      kind: text(row, "principal_kind"),
      status: text(row, "principal_status"),
      revision: integer(row, "principal_revision"),
    });
  }

  private bindingFromRow(row: Record<string, unknown>): SubjectBindingValue {
    return SubjectBinding.parse({
      contractVersion: "tasq.subject-binding.v1",
      id: text(row, "binding_id"),
      workspaceId: text(row, "workspace_id"),
      principalId: text(row, "principal_id"),
      issuer: text(row, "issuer"),
      subject: text(row, "subject"),
      method: text(row, "method"),
      status: text(row, "binding_status"),
      revision: integer(row, "binding_revision"),
      createdAt: integer(row, "created_at"),
      disabledAt: nullableInteger(row, "disabled_at"),
      replacedByBindingId: nullableText(row, "replaced_by_binding_id"),
    });
  }

  private async loadBoundPrincipal(
    transaction: Transaction,
    workspaceId: string,
    issuer: string,
    subject: string,
  ): Promise<{ binding: SubjectBindingValue; principal: AuthorityPrincipalValue } | null> {
    const result = await transaction.execute({
      sql: `SELECT b.workspace_id, b.id AS binding_id, b.principal_id, b.issuer, b.subject, b.method,
              b.status AS binding_status, b.revision AS binding_revision, b.created_at, b.disabled_at,
              b.replaced_by_binding_id, p.kind AS principal_kind, p.status AS principal_status,
              p.revision AS principal_revision
            FROM subject_binding b
            JOIN authority_principal p ON p.workspace_id = b.workspace_id AND p.id = b.principal_id
            WHERE b.workspace_id = ? AND b.issuer = ? AND b.subject = ?`,
      args: [workspaceId, issuer, subject],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { binding: this.bindingFromRow(row), principal: this.principalFromRow(row) } : null;
  }

  private async loadPermissionSets(
    transaction: Transaction,
    workspaceId: string,
  ): Promise<PermissionSetDefinitionValue[]> {
    const result = await transaction.execute({
      sql: `SELECT uri, version, implementation_digest, actions_json
            FROM permission_set WHERE workspace_id = ? AND status = 'active'
            ORDER BY uri, version`,
      args: [workspaceId],
    });
    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return PermissionSetDefinition.parse({
        uri: text(row, "uri"),
        version: integer(row, "version"),
        implementationDigest: text(row, "implementation_digest"),
        actions: json(row, "actions_json"),
      });
    });
  }

  private async loadGrants(
    transaction: Transaction,
    workspaceId: string,
    principalId: string | null,
  ): Promise<AuthorizationGrantValue[]> {
    if (principalId === null) return [];
    const result = await transaction.execute({
      sql: `SELECT g.* FROM authorization_grant g
            JOIN permission_set p ON p.workspace_id = g.workspace_id
              AND p.uri = g.permission_uri AND p.version = g.permission_version
              AND p.implementation_digest = g.permission_digest AND p.status = 'active'
            WHERE g.workspace_id = ? AND g.grantee_principal_id = ? ORDER BY g.id`,
      args: [workspaceId, principalId],
    });
    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return AuthorizationGrant.parse({
        contractVersion: "tasq.authorization-grant.v1",
        id: text(row, "id"),
        workspaceId: text(row, "workspace_id"),
        grantorPrincipalId: text(row, "grantor_principal_id"),
        granteePrincipalId: text(row, "grantee_principal_id"),
        permissionSet: {
          uri: text(row, "permission_uri"),
          version: integer(row, "permission_version"),
          implementationDigest: text(row, "permission_digest"),
        },
        scope: json(row, "scope_json"),
        notBefore: nullableInteger(row, "not_before"),
        expiresAt: nullableInteger(row, "expires_at"),
        status: text(row, "status"),
        revision: integer(row, "revision"),
      });
    });
  }

  private async loadDelegation(
    transaction: Transaction,
    workspaceId: string,
    subjectPrincipalId: string | null,
    actorPrincipalId: string | null,
    action: ActionIdentity,
    resource: ResourceRef,
    now: number,
  ): Promise<DelegationValue | null> {
    if (!subjectPrincipalId || !actorPrincipalId) return null;
    const result = await transaction.execute({
      sql: `SELECT * FROM authority_delegation
            WHERE workspace_id = ? AND subject_principal_id = ? AND actor_principal_id = ? ORDER BY id`,
      args: [workspaceId, subjectPrincipalId, actorPrincipalId],
    });
    const parsed = result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return Delegation.parse({
        contractVersion: "tasq.delegation.v1",
        id: text(row, "id"),
        workspaceId: text(row, "workspace_id"),
        subjectPrincipalId: text(row, "subject_principal_id"),
        actorPrincipalId: text(row, "actor_principal_id"),
        actions: json(row, "actions_json"),
        scope: json(row, "scope_json"),
        notBefore: nullableInteger(row, "not_before"),
        expiresAt: nullableInteger(row, "expires_at"),
        status: text(row, "status"),
        revision: integer(row, "revision"),
      });
    });
    const exactAction = (entry: DelegationValue) => entry.actions.some((candidate) =>
      candidate.uri === action.uri && candidate.version === action.version &&
      candidate.implementationDigest === action.implementationDigest);
    const covers = (entry: DelegationValue) => entry.scope.kind === "workspace" || (
      entry.scope.resource.kind === resource.kind && entry.scope.resource.id === resource.id
    );
    const live = (entry: DelegationValue) => entry.status === "active" &&
      (entry.notBefore === null || entry.notBefore <= now) && (entry.expiresAt === null || now < entry.expiresAt);
    return parsed.find((entry) => exactAction(entry) && covers(entry) && live(entry))
      ?? parsed.find((entry) => exactAction(entry) && covers(entry))
      ?? null;
  }

  private async loadEligibilities(
    transaction: Transaction,
    workspaceId: string,
    principalId: string | null,
  ): Promise<AuthorityEligibilityValue[]> {
    if (principalId === null) return [];
    const result = await transaction.execute({
      sql: `SELECT * FROM authority_eligibility
            WHERE workspace_id = ? AND principal_id = ? ORDER BY id`,
      args: [workspaceId, principalId],
    });
    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return AuthorityEligibility.parse({
        contractVersion: "tasq.authority-eligibility.v1",
        id: text(row, "id"),
        workspaceId: text(row, "workspace_id"),
        principalId: text(row, "principal_id"),
        kind: text(row, "kind"),
        status: text(row, "status"),
        notBefore: nullableInteger(row, "not_before"),
        expiresAt: nullableInteger(row, "expires_at"),
        revision: integer(row, "revision"),
      });
    });
  }

  async authorize(input: WorkspaceAuthorizationInput): Promise<WorkspaceAuthorizationResult> {
    return this.authorizeAt(input, requiredClockNow(this.clock));
  }

  /**
   * Compile one readable mandate to the existing immutable permission set,
   * grant and optional delegation records in one authority revision. No
   * mandate table exists: inspectMandate projects those authoritative rows.
   */
  async issueMandate(input: {
    intent: MandateIntentValue;
    context: AuthorityMutationContext;
  }): Promise<{ mutation: AuthorityMutationResult; mandate: MandateViewValue }> {
    const compiled = compileMandate(input.intent);
    const { intent, permissionSet, subjectGrant, actorGrant, delegation } = compiled;
    if (input.context.actorPrincipalId !== intent.grantorPrincipalId) {
      throw new AuthorityStoreError("revision_conflict", "authenticated mutation actor must be the mandate grantor");
    }
    const mutation = await this.workspaceMutation({
      workspaceId: intent.workspaceId,
      operation: "mandate.issue",
      targetType: "mandate_projection",
      targetId: intent.id,
      context: input.context,
      request: intent,
      apply: async (transaction) => {
        await transaction.execute({
          sql: `INSERT INTO permission_set(
                  workspace_id, uri, version, implementation_digest, actions_json, status, revision
                ) VALUES (?, ?, ?, ?, ?, 'active', 1)`,
          args: [intent.workspaceId, permissionSet.uri, permissionSet.version,
            permissionSet.implementationDigest, portableJson(permissionSet.actions)],
        });
        const insertGrant = async (grant: AuthorizationGrantValue) => transaction.execute({
          sql: `INSERT INTO authorization_grant(
                  workspace_id, id, grantor_principal_id, grantee_principal_id,
                  permission_uri, permission_version, permission_digest, scope_json,
                  not_before, expires_at, status, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [grant.workspaceId, grant.id, grant.grantorPrincipalId, grant.granteePrincipalId,
            grant.permissionSet.uri, grant.permissionSet.version, grant.permissionSet.implementationDigest,
            portableJson(grant.scope), grant.notBefore, grant.expiresAt, grant.status, grant.revision],
        });
        await insertGrant(subjectGrant);
        if (actorGrant) await insertGrant(actorGrant);
        if (delegation) {
          await transaction.execute({
            sql: `INSERT INTO authority_delegation(
                    workspace_id, id, subject_principal_id, actor_principal_id, actions_json,
                    scope_json, not_before, expires_at, status, revision
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [delegation.workspaceId, delegation.id, delegation.subjectPrincipalId,
              delegation.actorPrincipalId, portableJson(delegation.actions), portableJson(delegation.scope),
              delegation.notBefore, delegation.expiresAt, delegation.status, delegation.revision],
          });
        }
      },
    });
    return { mutation, mandate: await this.inspectMandate({ workspaceId: intent.workspaceId, mandateId: intent.id }) };
  }

  async inspectMandate(input: { workspaceId: string; mandateId: string }): Promise<MandateViewValue> {
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const mandateId = Id.parse(input.mandateId);
    const ids = mandateRecordIds(workspaceId, mandateId);
    const subjectResult = await this.client.execute({
      sql: `SELECT g.*, p.actions_json, p.status AS permission_status, p.revision AS permission_revision
            FROM authorization_grant g
            JOIN permission_set p ON p.workspace_id = g.workspace_id
              AND p.uri = g.permission_uri AND p.version = g.permission_version
            WHERE g.workspace_id = ? AND g.id = ?`,
      args: [workspaceId, ids.subjectGrantId],
    });
    const subjectRow = subjectResult.rows[0] as Record<string, unknown> | undefined;
    if (!subjectRow) throw new AuthorityStoreError("not_found", `mandate ${mandateId} does not exist`);
    if (text(subjectRow, "permission_uri") !== ids.permissionUri || text(subjectRow, "permission_status") !== "active") {
      throw new AuthorityStoreError("authority_corrupt", "mandate permission projection is inconsistent");
    }
    const actorResult = await this.client.execute({
      sql: "SELECT * FROM authorization_grant WHERE workspace_id = ? AND id = ?",
      args: [workspaceId, ids.actorGrantId],
    });
    const delegationResult = await this.client.execute({
      sql: "SELECT * FROM authority_delegation WHERE workspace_id = ? AND id = ?",
      args: [workspaceId, ids.delegationId],
    });
    const actorRow = actorResult.rows[0] as Record<string, unknown> | undefined;
    const delegationRow = delegationResult.rows[0] as Record<string, unknown> | undefined;
    if ((actorRow === undefined) !== (delegationRow === undefined)) {
      throw new AuthorityStoreError("authority_corrupt", "mandate actor grant and delegation must coexist");
    }
    if (actorRow && delegationRow) {
      if (text(actorRow, "grantee_principal_id") !== text(delegationRow, "actor_principal_id") ||
          text(subjectRow, "grantee_principal_id") !== text(delegationRow, "subject_principal_id") ||
          portableJson(json(actorRow, "scope_json")) !== portableJson(json(delegationRow, "scope_json")) ||
          portableJson(json(subjectRow, "actions_json")) !== portableJson(json(delegationRow, "actions_json"))) {
        throw new AuthorityStoreError("authority_corrupt", "mandate delegation differs from its grants");
      }
    }
    const statuses = [text(subjectRow, "status")];
    if (actorRow) statuses.push(text(actorRow, "status"));
    if (delegationRow) statuses.push(text(delegationRow, "status"));
    if (!statuses.every((status) => status === statuses[0])) {
      throw new AuthorityStoreError("authority_corrupt", "mandate component lifecycle diverged");
    }
    const revisions = [integer(subjectRow, "revision")];
    if (actorRow) revisions.push(integer(actorRow, "revision"));
    if (delegationRow) revisions.push(integer(delegationRow, "revision"));
    if (!revisions.every((revision) => revision === revisions[0])) {
      throw new AuthorityStoreError("authority_corrupt", "mandate component revisions diverged");
    }
    const intent = MandateIntent.parse({
      contractVersion: "tasq.mandate-intent.v1",
      id: mandateId,
      workspaceId,
      grantorPrincipalId: text(subjectRow, "grantor_principal_id"),
      subjectPrincipalId: text(subjectRow, "grantee_principal_id"),
      actorPrincipalId: actorRow ? text(actorRow, "grantee_principal_id") : null,
      actions: json(subjectRow, "actions_json"),
      target: json(subjectRow, "scope_json"),
      notBefore: nullableInteger(subjectRow, "not_before"),
      expiresAt: nullableInteger(subjectRow, "expires_at"),
      constraints: { maxOperations: null, budget: null },
    });
    const compiled = compileMandate(intent);
    if (compiled.permissionSet.implementationDigest !== text(subjectRow, "permission_digest")) {
      throw new AuthorityStoreError("authority_corrupt", "mandate permission digest is inconsistent");
    }
    const grantFromRow = (row: Record<string, unknown>) => AuthorizationGrant.parse({
      contractVersion: "tasq.authorization-grant.v1",
      id: text(row, "id"),
      workspaceId: text(row, "workspace_id"),
      grantorPrincipalId: text(row, "grantor_principal_id"),
      granteePrincipalId: text(row, "grantee_principal_id"),
      permissionSet: {
        uri: text(row, "permission_uri"), version: integer(row, "permission_version"),
        implementationDigest: text(row, "permission_digest"),
      },
      scope: json(row, "scope_json"),
      notBefore: nullableInteger(row, "not_before"), expiresAt: nullableInteger(row, "expires_at"),
      status: text(row, "status"), revision: integer(row, "revision"),
    });
    const expectedStatus = statuses[0] as "active" | "revoked";
    const expectedRevision = revisions[0]!;
    const lifecycle = <T extends { status: "active" | "revoked"; revision: number }>(value: T): T =>
      ({ ...value, status: expectedStatus, revision: expectedRevision });
    if (digestAuthorityValue(grantFromRow(subjectRow)) !==
        digestAuthorityValue(lifecycle(compiled.subjectGrant))) {
      throw new AuthorityStoreError("authority_corrupt", "mandate subject grant differs from compiled intent");
    }
    if (actorRow && compiled.actorGrant &&
        digestAuthorityValue(grantFromRow(actorRow)) !== digestAuthorityValue(lifecycle(compiled.actorGrant))) {
      throw new AuthorityStoreError("authority_corrupt", "mandate actor grant differs from compiled intent");
    }
    if (delegationRow && compiled.delegation) {
      const storedDelegation = Delegation.parse({
        contractVersion: "tasq.delegation.v1",
        id: text(delegationRow, "id"), workspaceId: text(delegationRow, "workspace_id"),
        subjectPrincipalId: text(delegationRow, "subject_principal_id"),
        actorPrincipalId: text(delegationRow, "actor_principal_id"), actions: json(delegationRow, "actions_json"),
        scope: json(delegationRow, "scope_json"), notBefore: nullableInteger(delegationRow, "not_before"),
        expiresAt: nullableInteger(delegationRow, "expires_at"), status: text(delegationRow, "status"),
        revision: integer(delegationRow, "revision"),
      });
      if (digestAuthorityValue(storedDelegation) !== digestAuthorityValue(lifecycle(compiled.delegation))) {
        throw new AuthorityStoreError("authority_corrupt", "mandate delegation differs from compiled intent");
      }
    }
    const workspace = await this.getWorkspaceAuthorityState(workspaceId);
    if (!workspace) throw new AuthorityStoreError("authority_corrupt", "mandate workspace disappeared");
    return MandateView.parse({
      contractVersion: "tasq.mandate-view.v1",
      intent,
      status: statuses[0],
      revision: revisions[0],
      authorityRevision: workspace.authorityRevision,
      compiledRecordIds: {
        permissionUri: ids.permissionUri,
        subjectGrantId: ids.subjectGrantId,
        actorGrantId: actorRow ? ids.actorGrantId : null,
        delegationId: delegationRow ? ids.delegationId : null,
      },
      assurance: {
        secondAuthorityRecordCreated: false,
        genericUsageLimitEnforced: false,
        genericBudgetEnforced: false,
        remoteEffectDispatchEnabled: false,
      },
    });
  }

  async revokeMandate(input: {
    workspaceId: string;
    mandateId: string;
    expectedMandateRevision: number;
    context: AuthorityMutationContext;
  }): Promise<{ mutation: AuthorityMutationResult; mandate: MandateViewValue }> {
    const before = await this.inspectMandate(input);
    if (input.context.actorPrincipalId !== before.intent.grantorPrincipalId) {
      throw new AuthorityStoreError("revision_conflict", "authenticated mutation actor must be the mandate grantor");
    }
    if (before.revision !== input.expectedMandateRevision || before.status !== "active") {
      throw new AuthorityStoreError("revision_conflict", "mandate revision changed");
    }
    const ids = mandateRecordIds(input.workspaceId, input.mandateId);
    const mutation = await this.workspaceMutation({
      workspaceId: input.workspaceId,
      operation: "mandate.revoke",
      targetType: "mandate_projection",
      targetId: input.mandateId,
      context: input.context,
      request: { expectedMandateRevision: input.expectedMandateRevision },
      apply: async (transaction) => {
        const revoke = async (table: "authorization_grant" | "authority_delegation", id: string) => {
          const result = await transaction.execute({
            sql: `UPDATE ${table} SET status = 'revoked', revision = revision + 1
                  WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?`,
            args: [input.workspaceId, id, input.expectedMandateRevision],
          });
          if (result.rowsAffected !== 1) throw new AuthorityStoreError("revision_conflict", "mandate revision changed");
        };
        await revoke("authorization_grant", ids.subjectGrantId);
        if (before.compiledRecordIds.actorGrantId) await revoke("authorization_grant", ids.actorGrantId);
        if (before.compiledRecordIds.delegationId) await revoke("authority_delegation", ids.delegationId);
      },
    });
    return { mutation, mandate: await this.inspectMandate({ workspaceId: input.workspaceId, mandateId: input.mandateId }) };
  }

  /** Return a privacy-bounded explanation; protected target IDs never leave this interface. */
  async authorizeMandate(input: WorkspaceAuthorizationInput & { mandateId: string }): Promise<MandateDecision> {
    const now = requiredClockNow(this.clock);
    const base = {
      mandateId: input.mandateId,
      requestId: input.requestId,
      actionUri: input.action.uri,
      resource: input.resource,
      evaluatedAt: now,
    };
    if (input.action.uri === "urn:tasq:action:effect.dispatch") {
      return protectedMandateDecision({ ...base, decision: "deny", reasonCode: "remote_effect_dispatch_disabled" });
    }
    let mandate: MandateViewValue;
    try {
      mandate = await this.inspectMandate({ workspaceId: input.workspaceId, mandateId: input.mandateId });
    } catch (error) {
      if (error instanceof AuthorityStoreError && error.code === "not_found") {
        return protectedMandateDecision({ ...base, decision: "deny", reasonCode: "mandate_not_found" });
      }
      throw error;
    }
    if (mandate.status !== "active") {
      return protectedMandateDecision({ ...base, decision: "deny", reasonCode: "mandate_revoked",
        authorityRevision: mandate.authorityRevision });
    }
    if (!mandate.intent.actions.some((action) => action.uri === input.action.uri &&
        action.version === input.action.version && action.implementationDigest === input.action.implementationDigest)) {
      return protectedMandateDecision({ ...base, decision: "deny", reasonCode: "mandate_action_denied",
        authorityRevision: mandate.authorityRevision });
    }
    if (mandate.intent.target.kind === "exact" &&
        (mandate.intent.target.resource.kind !== input.resource.kind || mandate.intent.target.resource.id !== input.resource.id)) {
      return protectedMandateDecision({ ...base, decision: "deny", reasonCode: "mandate_target_denied",
        authorityRevision: mandate.authorityRevision });
    }
    const authorization = await this.authorizeAt(input, now);
    // The reference authorizer deterministically reports one supporting grant
    // per principal. Another equivalent live grant can sort first; the exact
    // active mandate projected above still independently covers this request.
    const supportsMandate = authorization.decision.decision === "allow";
    return protectedMandateDecision({
      ...base,
      decision: supportsMandate ? "allow" : "deny",
      reasonCode: supportsMandate ? "allowed" : authorization.decision.decision === "deny"
        ? authorization.decision.reasonCode : "mandate_not_supporting_decision",
      authorityDecision: authorization.decision,
      authorityRevision: authorization.authorityRevision,
    });
  }

  /** Trusted composition seam for one request-wide injected clock snapshot. */
  async authorizeAt(input: WorkspaceAuthorizationInput, evaluatedAt: number): Promise<WorkspaceAuthorizationResult> {
    return (await this.authorizeAndExecuteAt(input, evaluatedAt, async () => undefined)).authorization;
  }

  /**
   * Serialize a guarded side effect with authority mutations. The callback is
   * invoked only for an allow while the BEGIN IMMEDIATE authority transaction
   * remains open, so a concurrent revocation cannot commit between the live
   * decision and callback completion. The callback must be durably idempotent:
   * authority and workspace stores are intentionally separate databases.
   */
  async authorizeAndExecuteAt<T>(
    input: WorkspaceAuthorizationInput,
    evaluatedAt: number,
    execute: (authorization: WorkspaceAuthorizationResult) => Promise<T>,
  ): Promise<AuthorizedExecutionResult<T>> {
    const now = UnixMs.parse(evaluatedAt);
    const requestId = Id.parse(input.requestId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const envelopeDigest = digestAuthorityValue(input);
    const transaction = await beginAuthorityWrite(this.client);
    try {
      const previous = await transaction.execute({
        sql: `SELECT envelope_digest, decision_json, authority_revision
              FROM authorization_decision WHERE workspace_id = ? AND request_id = ?`,
        args: [workspaceId, requestId],
      });
      const previousRow = previous.rows[0] as Record<string, unknown> | undefined;
      let authorization: WorkspaceAuthorizationResult;
      if (previousRow) {
        if (text(previousRow, "envelope_digest") !== envelopeDigest) {
          throw new AuthorityStoreError("idempotency_conflict", `request ${requestId} was reused with different input`);
        }
        const decision = AuthorizationDecision.parse(json(previousRow, "decision_json"));
        const workspace = await transaction.execute({
          sql: "SELECT storage_binding_id, status, authority_revision FROM hosted_workspace WHERE workspace_id = ?",
          args: [workspaceId],
        });
        const currentWorkspace = workspace.rows[0] as Record<string, unknown> | undefined;
        const previousRevision = nullableInteger(previousRow, "authority_revision");
        const routeStillLive = decision.decision === "allow" && currentWorkspace !== undefined &&
          text(currentWorkspace, "status") === "enabled" &&
          integer(currentWorkspace, "authority_revision") === previousRevision;
        if (decision.decision === "allow" && !routeStillLive) {
          throw new AuthorityStoreError(
            "revision_conflict",
            "the authority revision changed after this request was allowed; retry with a new requestId",
          );
        }
        const storageBindingId = routeStillLive ? text(currentWorkspace!, "storage_binding_id") : null;
        authorization = {
          decision,
          authorityRevision: previousRevision,
          storageBindingId,
          replayed: true,
        };
      } else {
        const workspaceResult = await transaction.execute({
          sql: "SELECT workspace_id, storage_binding_id, status, authority_revision FROM hosted_workspace WHERE workspace_id = ?",
          args: [workspaceId],
        });
        const workspaceRow = workspaceResult.rows[0] as Record<string, unknown> | undefined;
        const workspace = workspaceRow ? workspaceFromRow(workspaceRow) : null;
        const authorityEnabled = workspace?.status === "enabled";
        const subject = authorityEnabled
          ? await this.loadBoundPrincipal(transaction, workspaceId, input.identity.issuer, input.identity.subject)
          : null;
        const actor = authorityEnabled && input.identity.actor
          ? await this.loadBoundPrincipal(transaction, workspaceId, input.identity.actor.issuer, input.identity.actor.subject)
          : null;
        const permissionSets = authorityEnabled ? await this.loadPermissionSets(transaction, workspaceId) : [];
        const subjectGrants = await this.loadGrants(transaction, workspaceId, subject?.principal.id ?? null);
        const actorGrants = await this.loadGrants(transaction, workspaceId, actor?.principal.id ?? null);
        const delegation = await this.loadDelegation(
          transaction, workspaceId, subject?.principal.id ?? null, actor?.principal.id ?? null,
          input.action, input.resource, now,
        );
        const effectivePrincipalId = input.identity.actor ? actor?.principal.id ?? null : subject?.principal.id ?? null;
        const eligibilities = await this.loadEligibilities(transaction, workspaceId, effectivePrincipalId);
        const request = AuthorizationRequest.parse({
          contractVersion: "tasq.authorization-request.v1",
          requestId,
          workspaceId,
          serviceAudience: input.serviceAudience,
          action: input.action,
          resource: input.resource,
          identity: input.identity,
          subject,
          actor,
          permissionSets,
          subjectGrants,
          actorGrants,
          delegation,
          eligibilities,
        });
        const decision = evaluateAuthorization(request, { now: () => now });
        const authorityRevision = workspace?.authorityRevision ?? null;
        await transaction.execute({
          sql: `INSERT INTO authorization_decision(
                decision_id, request_id, workspace_id, evaluated_at, decision, reason_code,
                subject_principal_id, actor_principal_id, action_uri, resource_kind, resource_id,
                authority_revision, envelope_digest, request_digest, policy_digest, decision_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [decision.decisionId, decision.requestId, decision.workspaceId, decision.evaluatedAt,
          decision.decision, decision.reasonCode, decision.subjectPrincipalId, decision.actorPrincipalId,
          decision.actionUri, decision.resourceKind, decision.resourceId, authorityRevision, envelopeDigest,
          decision.requestDigest, decision.policyImplementationDigest, portableJson(decision)],
        });
        await transaction.execute({
          sql: `INSERT INTO authority_audit(
                event_id, workspace_id, occurred_at, actor_principal_id, event_type,
                target_type, target_id, authority_revision, request_digest, reason, payload_json
              ) VALUES (?, ?, ?, ?, ?, 'authorization_decision', ?, ?, ?, ?, ?)`,
        args: [`decision:${decision.decisionId}`, workspace ? workspaceId : null, now,
          decision.actorPrincipalId, `authorization.${decision.decision}`, decision.decisionId,
          authorityRevision, decision.requestDigest, decision.reasonCode,
          portableJson({ requestId, actionUri: decision.actionUri, resourceKind: decision.resourceKind })],
        });
        authorization = {
          decision,
          authorityRevision,
          storageBindingId: decision.decision === "allow" ? workspace!.storageBindingId : null,
          replayed: false,
        };
      }
      const execution = authorization.decision.decision === "allow" && authorization.storageBindingId !== null
        ? await execute(authorization)
        : null;
      await transaction.commit();
      return {
        authorization,
        execution,
      };
    } catch (error) {
      await rollback(transaction);
      throw mapAuthorityStoreError(error);
    }
  }

  async readAudit(input: { workspaceId: string | null; afterSequence?: number; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const after = z.number().int().nonnegative().parse(input.afterSequence ?? 0);
    const limit = z.number().int().min(1).max(100).parse(input.limit ?? 100);
    const result = input.workspaceId === null
      ? await this.client.execute({
        sql: "SELECT * FROM authority_audit WHERE sequence > ? ORDER BY sequence LIMIT ?",
        args: [after, limit],
      })
      : await this.client.execute({
        sql: "SELECT * FROM authority_audit WHERE workspace_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
        args: [WorkspaceId.parse(input.workspaceId), after, limit],
      });
    return result.rows.map((row) => ({ ...row }));
  }

  async getWorkspaceAuthorityRevision(workspaceId: string): Promise<number> {
    const result = await this.client.execute({
      sql: "SELECT authority_revision FROM hosted_workspace WHERE workspace_id = ?",
      args: [WorkspaceId.parse(workspaceId)],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityStoreError("not_found", "workspace does not exist");
    return integer(row, "authority_revision");
  }
}

const initializationChains = new Map<string, Promise<void>>();
const COLD_START_BUSY_RETRIES = 256;
const coldStartRetryDelayMs = (attempt: number): number => Math.min(2 ** Math.min(attempt, 5), 25);

export async function openAuthorityStore(input: { url: string; clock: Clock }): Promise<AuthorityStore> {
  if (!input.url.startsWith("file:") && input.url !== ":memory:") {
    throw new Error("TQ-802 reference authority store accepts only explicit local file: or :memory: URLs");
  }
  let client = createClient({ url: input.url });
  const prior = initializationChains.get(input.url) ?? Promise.resolve();
  const initialization = prior.catch(() => {}).then(async () => {
    const appliedAt = requiredClockNow(input.clock);
    for (let attempt = 0; attempt < COLD_START_BUSY_RETRIES; attempt += 1) {
      try {
        await initializeAuthorityClient(client, input.url, appliedAt);
        return;
      } catch (error) {
        if (!isAuthorityBusy(error) || attempt === COLD_START_BUSY_RETRIES - 1) throw error;
        // SQLITE_BUSY_SNAPSHOT is tied to the connection's stale read
        // snapshot. Retrying on that same client can never make progress, even
        // after the competing migrator commits. Dispose it before the bounded
        // scheduling backoff so the next attempt necessarily opens a fresh
        // snapshot. No authority timestamp is derived from this delay.
        client.close();
        await new Promise<void>((resolve) => setTimeout(resolve, coldStartRetryDelayMs(attempt)));
        client = createClient({ url: input.url });
      }
    }
  });
  initializationChains.set(input.url, initialization);
  try {
    await initialization;
    return new AuthorityStore(client, input.clock);
  } catch (error) {
    client.close();
    throw error;
  } finally {
    if (initializationChains.get(input.url) === initialization) initializationChains.delete(input.url);
  }
}
