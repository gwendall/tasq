import { createClient, type Client, type Transaction } from "@libsql/client";
import type { Clock } from "@tasq-run/schema";
import {
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
  type ActionIdentity,
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

const Id = z.string().min(1).max(500).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const AuditTargetId = z.string().min(1).max(1_000).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const UnixMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
    && String((error as { code: unknown }).code) === "SQLITE_BUSY") return true;
  return /SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : String(error));
}

const COLD_START_BUSY_RETRIES = 256;

async function initializeAuthorityClient(client: Client, url: string, appliedAt: number): Promise<void> {
  for (let attempt = 0; attempt < COLD_START_BUSY_RETRIES; attempt += 1) {
    try {
      await client.execute("PRAGMA busy_timeout = 30000");
      if (url !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute("PRAGMA synchronous = NORMAL");
      await migrateAuthorityStore(client, appliedAt);
      return;
    } catch (error) {
      if (!isAuthorityBusy(error) || attempt === COLD_START_BUSY_RETRIES - 1) throw error;
      // Yield without consulting wall time. Cold initialization is idempotent,
      // and another process can finish the SQLite mode/migration transition.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
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

export async function openAuthorityStore(input: { url: string; clock: Clock }): Promise<AuthorityStore> {
  if (!input.url.startsWith("file:") && input.url !== ":memory:") {
    throw new Error("TQ-802 reference authority store accepts only explicit local file: or :memory: URLs");
  }
  const client = createClient({ url: input.url });
  const prior = initializationChains.get(input.url) ?? Promise.resolve();
  const initialization = prior.catch(() => {}).then(async () => {
    await initializeAuthorityClient(client, input.url, requiredClockNow(input.clock));
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
