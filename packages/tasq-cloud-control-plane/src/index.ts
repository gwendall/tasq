import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createClient, type Client, type Transaction } from "@libsql/client";
import type { Clock } from "@tasq-run/schema";
import { z } from "zod";

export const CLOUD_CONTROL_PLANE_CONTRACT_VERSION =
  "tasq.cloud-control-plane.v1" as const;
export const CLOUD_BFF_CONTRACT_VERSION = "tasq.cloud-bff.v1" as const;

const Id = z.string().min(1).max(500).refine((value) => value === value.trim());
const TenantId = z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/);
const WorkspaceId = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const Region = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CanonicalHttpsOrigin = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/" || url.href !== value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be one canonical HTTPS origin",
    });
  }
});

const migration = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS cloud_tenant (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active','suspended','deleting','deleted')),
  plan TEXT NOT NULL,
  max_workspaces INTEGER NOT NULL CHECK(max_workspaces BETWEEN 1 AND 10000),
  retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
  session_epoch INTEGER NOT NULL DEFAULT 1 CHECK(session_epoch > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_workspace (
  tenant_id TEXT NOT NULL REFERENCES cloud_tenant(id),
  id TEXT NOT NULL,
  region TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('provisioning','ready','failed','suspended','deleting','deleted')),
  storage_binding_id TEXT NOT NULL UNIQUE,
  deployment_ref TEXT,
  server_origin TEXT,
  secret_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(secret_refs_json)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS cloud_workspace_status
  ON cloud_workspace(tenant_id,status,updated_at);
CREATE TABLE IF NOT EXISTS cloud_principal (
  tenant_id TEXT NOT NULL REFERENCES cloud_tenant(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human','workload','support')),
  issuer TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  recovery_revision INTEGER NOT NULL DEFAULT 1 CHECK(recovery_revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,issuer,subject_digest)
);
CREATE TABLE IF NOT EXISTS cloud_device (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES cloud_principal(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS cloud_session (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  csrf_digest TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  tenant_session_epoch INTEGER NOT NULL,
  principal_recovery_revision INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(tenant_id,principal_id) REFERENCES cloud_principal(tenant_id,id),
  FOREIGN KEY(tenant_id,device_id) REFERENCES cloud_device(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS cloud_session_live
  ON cloud_session(tenant_id,principal_id,expires_at,revoked_at);
CREATE TABLE IF NOT EXISTS cloud_workload (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES cloud_principal(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS cloud_export (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','running','ready','failed','expired')),
  artifact_ref TEXT,
  artifact_digest TEXT,
  expires_at INTEGER,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES cloud_workspace(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS cloud_backup (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','ready','failed','restored','expired')),
  artifact_ref TEXT,
  artifact_digest TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  restored_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES cloud_workspace(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS cloud_backup_retention
  ON cloud_backup(tenant_id,status,expires_at);
CREATE TABLE IF NOT EXISTS cloud_credential_rotation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','ready','failed')),
  previous_refs_json TEXT NOT NULL CHECK(json_valid(previous_refs_json)),
  replacement_refs_json TEXT CHECK(replacement_refs_json IS NULL OR json_valid(replacement_refs_json)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES cloud_workspace(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS cloud_support_access (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES cloud_tenant(id),
  support_principal_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('metadata','content')),
  reason TEXT NOT NULL,
  ticket_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired')),
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS cloud_incident (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('sev1','sev2','sev3','sev4')),
  status TEXT NOT NULL CHECK(status IN ('open','mitigated','closed')),
  summary TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_billing (
  tenant_id TEXT PRIMARY KEY REFERENCES cloud_tenant(id),
  provider_customer_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('trial','active','past_due','cancelled')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_operation (
  operation_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  committed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL,
  tenant_id TEXT,
  actor_principal_id TEXT NOT NULL,
  authority_decision_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
);`;

export type CloudAction =
  | "tenant.create"
  | "tenant.suspend"
  | "workspace.provision"
  | "workspace.reconcile"
  | "workspace.suspend"
  | "workspace.rotate_credentials"
  | "workspace.backup"
  | "workspace.restore"
  | "workspace.export"
  | "workspace.delete"
  | "principal.register"
  | "device.enroll"
  | "device.revoke"
  | "principal.recover"
  | "workload.enroll"
  | "workload.revoke"
  | "support.grant"
  | "support.revoke"
  | "retention.sweep"
  | "incident.record"
  | "billing.bind";

export interface CloudAuthorizationRequest {
  action: CloudAction;
  tenantId: string;
  resourceId: string;
}

export interface CloudAuthorizationDecision {
  decisionId: string;
  actorPrincipalId: string;
  decision: "allow" | "deny";
  evaluatedAt: number;
}

export interface CloudProvisioningResult {
  deploymentRef: string;
  serverOrigin: string;
  /** Opaque secret-manager references only, never raw credentials. */
  secretRefs: string[];
}

export interface CloudProvisioner {
  provision(input: {
    tenantId: string;
    workspaceId: string;
    region: string;
    storageBindingId: string;
  }): Promise<CloudProvisioningResult>;
  export(input: {
    tenantId: string;
    workspaceId: string;
    exportId: string;
  }): Promise<{ artifactRef: string; artifactDigest: string; expiresAt: number }>;
  rotateCredentials(input: {
    /** Stable retry identity. The provider must make this idempotent. */
    rotationId: string;
    tenantId: string;
    workspaceId: string;
    deploymentRef: string;
    previousSecretRefs: string[];
  }): Promise<{ secretRefs: string[] }>;
  backup(input: {
    /** Stable retry identity. The provider must make this idempotent. */
    tenantId: string;
    workspaceId: string;
    backupId: string;
    deploymentRef: string;
    expiresAt: number;
  }): Promise<{ artifactRef: string; artifactDigest: string }>;
  restore(input: {
    /** backupId is the stable retry identity for this restore. */
    tenantId: string;
    workspaceId: string;
    backupId: string;
    artifactRef: string;
    storageBindingId: string;
  }): Promise<CloudProvisioningResult>;
  delete(input: {
    /** The provider must make repeated deletion of this deployment idempotent. */
    tenantId: string;
    workspaceId: string;
    deploymentRef: string;
  }): Promise<void>;
}

export interface CloudControlPlaneDatabase {
  url: string;
  authToken?: string;
}

export interface CloudControlPlaneOptions {
  database: CloudControlPlaneDatabase;
  clock: Clock;
  identityPepper: Uint8Array;
  sessionPepper: Uint8Array;
  authorize(input: CloudAuthorizationRequest): Promise<CloudAuthorizationDecision>;
  provisioner: CloudProvisioner;
}

type CloudControlPlaneRuntimeOptions = Omit<CloudControlPlaneOptions, "database">;

export function cloudMaintenanceMode(input: string | undefined): boolean {
  const value = input?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("TASQ_CLOUD_MAINTENANCE must be true or false");
}

export function cloudControlPlaneDatabase(
  input: CloudControlPlaneDatabase,
): CloudControlPlaneDatabase {
  const url = input.url.trim();
  if (!url) throw new Error("cloud database URL is required");
  const parsed = new URL(url);
  if (!["file:", "libsql:", "https:"].includes(parsed.protocol)) {
    throw new Error("cloud database URL must use file, libsql or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("cloud database URL must not contain credentials, query or fragment");
  }
  const authToken = input.authToken?.trim();
  if (parsed.protocol === "file:") {
    if (authToken) throw new Error("local cloud database must not receive an auth token");
    return { url };
  }
  if (!authToken) throw new Error("remote cloud database requires an auth token");
  return { url, authToken };
}

export function cloudRuntimeDatabase(input: {
  mode: string | undefined;
  localUrl: string;
  remoteUrl: string | undefined;
  remoteAuthToken: string | undefined;
}): CloudControlPlaneDatabase {
  const mode = input.mode?.trim().toLowerCase() || "local";
  if (mode === "local") {
    if (input.remoteUrl?.trim() || input.remoteAuthToken?.trim()) {
      throw new Error("local cloud database mode must not receive remote database secrets");
    }
    return cloudControlPlaneDatabase({ url: input.localUrl });
  }
  if (mode !== "managed") {
    throw new Error("TASQ_CLOUD_DATABASE_MODE must be local or managed");
  }
  return cloudControlPlaneDatabase({
    url: input.remoteUrl ?? "",
    authToken: input.remoteAuthToken,
  });
}

export interface CloudWorkspace {
  tenantId: string;
  id: string;
  region: string;
  status: "provisioning" | "ready" | "failed" | "suspended" | "deleting" | "deleted";
  storageBindingId: string;
  deploymentRef: string | null;
  serverOrigin: string | null;
  secretRefs: string[];
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudSession {
  token: string;
  csrfToken: string;
  expiresAt: number;
  tenantId: string;
  principalId: string;
  deviceId: string;
}

function now(clock: Clock): number {
  const value = clock.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("cloud control-plane clock must return non-negative unix ms");
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("cloud JSON requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("cloud JSON contains a non-portable value");
}

function sha(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function secretDigest(pepper: Uint8Array, value: string): string {
  return `sha256:${createHmac("sha256", pepper).update(value).digest("hex")}`;
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${key}`);
  return value;
}

function workspace(row: Record<string, unknown>): CloudWorkspace {
  return {
    tenantId: text(row, "tenant_id"),
    id: text(row, "id"),
    region: text(row, "region"),
    status: text(row, "status") as CloudWorkspace["status"],
    storageBindingId: text(row, "storage_binding_id"),
    deploymentRef: row["deployment_ref"] == null ? null : text(row, "deployment_ref"),
    serverOrigin: row["server_origin"] == null ? null : text(row, "server_origin"),
    secretRefs: JSON.parse(text(row, "secret_refs_json")) as string[],
    lastErrorCode: row["last_error_code"] == null ? null : text(row, "last_error_code"),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  };
}

async function begin(client: Client): Promise<Transaction> {
  try {
    return await client.transaction("write");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code.startsWith("SQLITE_BUSY")) throw new Error("cloud_control_plane_busy");
    throw error;
  }
}

export class CloudControlPlane {
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly client: Client,
    private readonly options: CloudControlPlaneRuntimeOptions,
  ) {}

  static async open(options: CloudControlPlaneOptions): Promise<CloudControlPlane> {
    if (options.identityPepper.byteLength < 32 || options.sessionPepper.byteLength < 32) {
      throw new Error("cloud peppers must contain at least 32 bytes");
    }
    const { database: databaseInput, ...runtimeOptions } = options;
    const database = cloudControlPlaneDatabase(databaseInput);
    const client = createClient(database);
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 30000");
    await client.executeMultiple(migration);
    return new CloudControlPlane(client, runtimeOptions);
  }

  close(): void {
    this.client.close();
  }

  /**
   * A single process may issue concurrent mutations through one LibSQL client.
   * Serialize transaction lifetimes so one request cannot commit while another
   * still owns a statement. Database locking remains the cross-process guard.
   */
  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async allowed(
    action: CloudAction,
    tenantId: string,
    resourceId: string,
  ): Promise<CloudAuthorizationDecision> {
    const decision = await this.options.authorize({ action, tenantId, resourceId });
    if (decision.decision !== "allow" || !decision.decisionId ||
      !decision.actorPrincipalId ||
      !Number.isSafeInteger(decision.evaluatedAt)) {
      throw new Error("cloud_access_denied");
    }
    return decision;
  }

  private async exact<T>(
    transaction: Transaction,
    input: {
      operationId: string;
      action: CloudAction;
      tenantId: string;
      resourceId: string;
      payload: unknown;
    },
  ): Promise<T | null> {
    const digest = sha(input.payload);
    const prior = await transaction.execute({
      sql: "SELECT * FROM cloud_operation WHERE operation_id = ?",
      args: [Id.parse(input.operationId)],
    });
    const row = prior.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (text(row, "action") !== input.action ||
      text(row, "tenant_id") !== input.tenantId ||
      text(row, "resource_id") !== input.resourceId ||
      text(row, "input_digest") !== digest) {
      throw new Error("cloud_idempotency_conflict");
    }
    return JSON.parse(text(row, "result_json")) as T;
  }

  private async commitExact(
    transaction: Transaction,
    input: {
      operationId: string;
      action: CloudAction;
      tenantId: string;
      resourceId: string;
      payload: unknown;
      result: unknown;
      decision: CloudAuthorizationDecision;
      at: number;
    },
  ): Promise<void> {
    await transaction.execute({
      sql: `INSERT INTO cloud_operation(
              operation_id,action,tenant_id,resource_id,input_digest,result_json,committed_at
            ) VALUES (?,?,?,?,?,?,?)`,
      args: [
        input.operationId,
        input.action,
        input.tenantId,
        input.resourceId,
        sha(input.payload),
        canonical(input.result),
        input.at,
      ],
    });
    await transaction.execute({
      sql: `INSERT INTO cloud_audit(
              event_id,occurred_at,tenant_id,actor_principal_id,
              authority_decision_id,action,resource_id,detail_json
            ) VALUES (?,?,?,?,?,?,?,?)`,
      args: [
        randomUUID(),
        input.at,
        input.tenantId || null,
        input.decision.actorPrincipalId,
        input.decision.decisionId,
        input.action,
        input.resourceId,
        canonical({ inputDigest: sha(input.payload), result: input.result }),
      ],
    });
  }

  async createTenant(input: {
    id: string;
    slug: string;
    plan: string;
    maxWorkspaces: number;
    retentionDays: number;
    operationId: string;
  }): Promise<{ id: string; status: "active" }> {
    const tenantId = TenantId.parse(input.id);
    const decision = await this.allowed("tenant.create", tenantId, tenantId);
    const at = now(this.options.clock);
    const transaction = await begin(this.client);
    try {
      const prior = await this.exact<{ id: string; status: "active" }>(
        transaction,
        {
          operationId: input.operationId,
          action: "tenant.create",
          tenantId,
          resourceId: tenantId,
          payload: input,
        },
      );
      if (prior) {
        await transaction.commit();
        return prior;
      }
      const result = { id: tenantId, status: "active" as const };
      await transaction.execute({
        sql: `INSERT INTO cloud_tenant(
                id,slug,status,plan,max_workspaces,retention_days,created_at,updated_at
              ) VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          tenantId,
          TenantId.parse(input.slug),
          "active",
          Id.parse(input.plan),
          z.number().int().min(1).max(10_000).parse(input.maxWorkspaces),
          z.number().int().min(1).max(3_650).parse(input.retentionDays),
          at,
          at,
        ],
      });
      await this.commitExact(transaction, {
        operationId: input.operationId,
        action: "tenant.create",
        tenantId,
        resourceId: tenantId,
        payload: input,
        result,
        decision,
        at,
      });
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async suspendTenant(input: {
    tenantId: string;
    confirmation: string;
  }): Promise<{ tenantId: string; status: "suspended" }> {
    const tenantId = TenantId.parse(input.tenantId);
    if (input.confirmation !== tenantId) {
      throw new Error("tenant_suspend_confirmation_mismatch");
    }
    const decision = await this.allowed("tenant.suspend", tenantId, tenantId);
    const at = now(this.options.clock);
    const transaction = await begin(this.client);
    try {
      const tenant = await transaction.execute({
        sql: `UPDATE cloud_tenant
              SET status='suspended',session_epoch=session_epoch+1,updated_at=?
              WHERE id=? AND status='active'`,
        args: [at, tenantId],
      });
      if (tenant.rowsAffected !== 1) throw new Error("tenant_not_active");
      await transaction.execute({
        sql: `UPDATE cloud_workspace SET status='suspended',updated_at=?
              WHERE tenant_id=? AND status IN ('provisioning','ready','failed')`,
        args: [at, tenantId],
      });
      await transaction.execute({
        sql: `UPDATE cloud_session SET revoked_at=?
              WHERE tenant_id=? AND revoked_at IS NULL`,
        args: [at, tenantId],
      });
      await transaction.execute({
        sql: `INSERT INTO cloud_audit(
                event_id,occurred_at,tenant_id,actor_principal_id,
                authority_decision_id,action,resource_id,detail_json
              ) VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          randomUUID(),
          at,
          tenantId,
          decision.actorPrincipalId,
          decision.decisionId,
          "tenant.suspend",
          tenantId,
          canonical({ sessionsInvalidated: true, workspacesSuspended: true }),
        ],
      });
      await transaction.commit();
      return { tenantId, status: "suspended" };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getWorkspace(tenantInput: string, workspaceInput: string): Promise<CloudWorkspace | null> {
    const tenantId = TenantId.parse(tenantInput);
    const workspaceId = WorkspaceId.parse(workspaceInput);
    const result = await this.client.execute({
      sql: "SELECT * FROM cloud_workspace WHERE tenant_id = ? AND id = ?",
      args: [tenantId, workspaceId],
    });
    return result.rows[0] ? workspace(result.rows[0] as Record<string, unknown>) : null;
  }

  async provisionWorkspace(input: {
    tenantId: string;
    workspaceId: string;
    region: string;
    operationId: string;
  }): Promise<CloudWorkspace> {
    return this.serialized(() => this.provisionWorkspaceSerial(input));
  }

  private async provisionWorkspaceSerial(input: {
    tenantId: string;
    workspaceId: string;
    region: string;
    operationId: string;
  }): Promise<CloudWorkspace> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const region = Region.parse(input.region);
    const decision = await this.allowed("workspace.provision", tenantId, workspaceId);
    const at = now(this.options.clock);
    const transaction = await begin(this.client);
    let storageBindingId = "";
    try {
      const prior = await this.exact<CloudWorkspace>(transaction, {
        operationId: input.operationId,
        action: "workspace.provision",
        tenantId,
        resourceId: workspaceId,
        payload: input,
      });
      if (prior) {
        await transaction.commit();
        return (await this.getWorkspace(tenantId, workspaceId)) ?? prior;
      }
      const tenant = await transaction.execute({
        sql: `SELECT status,max_workspaces,
                     (SELECT count(*) FROM cloud_workspace
                      WHERE tenant_id = ? AND status != 'deleted') AS workspace_count
              FROM cloud_tenant WHERE id = ?`,
        args: [tenantId, tenantId],
      });
      const tenantRow = tenant.rows[0] as Record<string, unknown> | undefined;
      if (!tenantRow || tenantRow["status"] !== "active") throw new Error("tenant_not_active");
      if (integer(tenantRow, "workspace_count") >= integer(tenantRow, "max_workspaces")) {
        throw new Error("workspace_quota_exceeded");
      }
      storageBindingId = `cloud-binding:${randomUUID()}`;
      const pending: CloudWorkspace = {
        tenantId,
        id: workspaceId,
        region,
        status: "provisioning",
        storageBindingId,
        deploymentRef: null,
        serverOrigin: null,
        secretRefs: [],
        lastErrorCode: null,
        createdAt: at,
        updatedAt: at,
      };
      await transaction.execute({
        sql: `INSERT INTO cloud_workspace(
                tenant_id,id,region,status,storage_binding_id,created_at,updated_at
              ) VALUES (?,?,?,?,?,?,?)`,
        args: [tenantId, workspaceId, region, "provisioning", storageBindingId, at, at],
      });
      await this.commitExact(transaction, {
        operationId: input.operationId,
        action: "workspace.provision",
        tenantId,
        resourceId: workspaceId,
        payload: input,
        result: pending,
        decision,
        at,
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    try {
      const provisioned = await this.options.provisioner.provision({
        tenantId,
        workspaceId,
        region,
        storageBindingId,
      });
      const origin = CanonicalHttpsOrigin.parse(provisioned.serverOrigin);
      const secretRefs = z.array(Id).min(1).max(32).parse(provisioned.secretRefs);
      await this.client.execute({
        sql: `UPDATE cloud_workspace SET status = 'ready',deployment_ref = ?,
                server_origin = ?,secret_refs_json = ?,last_error_code = NULL,
                updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'provisioning'`,
        args: [
          Id.parse(provisioned.deploymentRef),
          origin,
          canonical(secretRefs),
          now(this.options.clock),
          tenantId,
          workspaceId,
        ],
      });
    } catch (error) {
      await this.client.execute({
        sql: `UPDATE cloud_workspace SET status = 'failed',last_error_code = ?,
                updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'provisioning'`,
        args: [
          error instanceof Error ? error.message.slice(0, 120) : "provision_failed",
          now(this.options.clock),
          tenantId,
          workspaceId,
        ],
      });
    }
    const result = await this.getWorkspace(tenantId, workspaceId);
    if (!result) throw new Error("workspace_provisioning_intent_disappeared");
    return result;
  }

  async reconcileWorkspace(input: {
    tenantId: string;
    workspaceId: string;
  }): Promise<CloudWorkspace> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    await this.allowed("workspace.reconcile", tenantId, workspaceId);
    const current = await this.getWorkspace(tenantId, workspaceId);
    if (!current) throw new Error("workspace_not_found");
    if (current.status === "ready") return current;
    if (!["provisioning", "failed"].includes(current.status)) {
      throw new Error("workspace_not_reconcilable");
    }
    await this.client.execute({
      sql: `UPDATE cloud_workspace SET status = 'provisioning',
              last_error_code = NULL,updated_at = ? WHERE tenant_id = ? AND id = ?`,
      args: [now(this.options.clock), tenantId, workspaceId],
    });
    try {
      const provisioned = await this.options.provisioner.provision({
        tenantId,
        workspaceId,
        region: current.region,
        storageBindingId: current.storageBindingId,
      });
      await this.client.execute({
        sql: `UPDATE cloud_workspace SET status='ready',deployment_ref=?,
                server_origin=?,secret_refs_json=?,updated_at=?
              WHERE tenant_id=? AND id=?`,
        args: [
          Id.parse(provisioned.deploymentRef),
          CanonicalHttpsOrigin.parse(provisioned.serverOrigin),
          canonical(z.array(Id).min(1).max(32).parse(provisioned.secretRefs)),
          now(this.options.clock),
          tenantId,
          workspaceId,
        ],
      });
    } catch (error) {
      await this.client.execute({
        sql: `UPDATE cloud_workspace SET status='failed',last_error_code=?,
                updated_at=? WHERE tenant_id=? AND id=?`,
        args: [
          error instanceof Error ? error.message.slice(0, 120) : "provision_failed",
          now(this.options.clock),
          tenantId,
          workspaceId,
        ],
      });
    }
    return (await this.getWorkspace(tenantId, workspaceId))!;
  }

  async suspendWorkspace(input: {
    tenantId: string;
    workspaceId: string;
  }): Promise<CloudWorkspace> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const decision = await this.allowed("workspace.suspend", tenantId, workspaceId);
    const at = now(this.options.clock);
    const updated = await this.client.execute({
      sql: `UPDATE cloud_workspace SET status='suspended',updated_at=?
            WHERE tenant_id=? AND id=? AND status='ready'`,
      args: [at, tenantId, workspaceId],
    });
    if (updated.rowsAffected !== 1) throw new Error("workspace_not_ready");
    await this.audit(decision, "workspace.suspend", tenantId, workspaceId, {});
    return (await this.getWorkspace(tenantId, workspaceId))!;
  }

  async rotateWorkspaceCredentials(input: {
    tenantId: string;
    workspaceId: string;
    rotationId: string;
  }): Promise<{
    rotationId: string;
    status: "ready" | "failed";
    secretRefs: string[];
  }> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const rotationId = Id.parse(input.rotationId);
    const decision = await this.allowed(
      "workspace.rotate_credentials",
      tenantId,
      workspaceId,
    );
    const current = await this.getWorkspace(tenantId, workspaceId);
    if (!current?.deploymentRef || current.status !== "ready") {
      throw new Error("workspace_not_ready");
    }
    const existing = await this.client.execute({
      sql: "SELECT * FROM cloud_credential_rotation WHERE id=?",
      args: [rotationId],
    });
    const prior = existing.rows[0] as Record<string, unknown> | undefined;
    if (prior) {
      if (text(prior, "tenant_id") !== tenantId ||
        text(prior, "workspace_id") !== workspaceId) {
        throw new Error("credential_rotation_identity_conflict");
      }
      if (prior["status"] === "ready") {
        return {
          rotationId,
          status: "ready",
          secretRefs: JSON.parse(text(prior, "replacement_refs_json")) as string[],
        };
      }
    } else {
      const at = now(this.options.clock);
      await this.client.execute({
        sql: `INSERT INTO cloud_credential_rotation(
                id,tenant_id,workspace_id,status,previous_refs_json,created_at,updated_at
              ) VALUES (?,?,?,'running',?,?,?)`,
        args: [
          rotationId,
          tenantId,
          workspaceId,
          canonical(current.secretRefs.map(sha)),
          at,
          at,
        ],
      });
    }
    try {
      const rotated = await this.options.provisioner.rotateCredentials({
        rotationId,
        tenantId,
        workspaceId,
        deploymentRef: current.deploymentRef,
        previousSecretRefs: current.secretRefs,
      });
      const secretRefs = z.array(Id).min(1).max(32).parse(rotated.secretRefs);
      if (secretRefs.some((reference) => current.secretRefs.includes(reference))) {
        throw new Error("credential_rotation_reused_previous_reference");
      }
      const at = now(this.options.clock);
      const transaction = await begin(this.client);
      try {
        await transaction.execute({
          sql: `UPDATE cloud_workspace SET secret_refs_json=?,updated_at=?
                WHERE tenant_id=? AND id=? AND status='ready'`,
          args: [canonical(secretRefs), at, tenantId, workspaceId],
        });
        await transaction.execute({
          sql: `UPDATE cloud_credential_rotation SET status='ready',
                  replacement_refs_json=?,last_error_code=NULL,updated_at=?
                WHERE id=?`,
          args: [canonical(secretRefs), at, rotationId],
        });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
      await this.audit(
        decision,
        "workspace.rotate_credentials",
        tenantId,
        workspaceId,
        {
          rotationId,
          previousReferenceDigests: current.secretRefs.map(sha),
          replacementReferenceDigests: secretRefs.map(sha),
        },
      );
      return { rotationId, status: "ready", secretRefs };
    } catch (error) {
      await this.client.execute({
        sql: `UPDATE cloud_credential_rotation SET status='failed',
                last_error_code=?,updated_at=? WHERE id=? AND status!='ready'`,
        args: [
          error instanceof Error ? error.message.slice(0, 120) : "rotation_failed",
          now(this.options.clock),
          rotationId,
        ],
      });
      return { rotationId, status: "failed", secretRefs: current.secretRefs };
    }
  }

  private subjectDigest(issuer: string, subject: string): string {
    return secretDigest(this.options.identityPepper, canonical({ issuer, subject }));
  }

  async registerPrincipal(input: {
    tenantId: string;
    principalId: string;
    kind: "human" | "workload" | "support";
    issuer: string;
    subject: string;
    operationId: string;
  }): Promise<{ tenantId: string; principalId: string; revision: 1 }> {
    const tenantId = TenantId.parse(input.tenantId);
    const principalId = Id.parse(input.principalId);
    const decision = await this.allowed("principal.register", tenantId, principalId);
    const at = now(this.options.clock);
    const transaction = await begin(this.client);
    try {
      const prior = await this.exact<{
        tenantId: string;
        principalId: string;
        revision: 1;
      }>(transaction, {
        operationId: input.operationId,
        action: "principal.register",
        tenantId,
        resourceId: principalId,
        payload: input,
      });
      if (prior) {
        await transaction.commit();
        return prior;
      }
      const result = { tenantId, principalId, revision: 1 as const };
      await transaction.execute({
        sql: `INSERT INTO cloud_principal(
                tenant_id,id,kind,issuer,subject_digest,status,revision,
                recovery_revision,created_at,updated_at
              ) VALUES (?,?,?,?,?,'active',1,1,?,?)`,
        args: [
          tenantId,
          principalId,
          input.kind,
          CanonicalHttpsOrigin.parse(input.issuer),
          this.subjectDigest(input.issuer, Id.parse(input.subject)),
          at,
          at,
        ],
      });
      await this.commitExact(transaction, {
        operationId: input.operationId,
        action: "principal.register",
        tenantId,
        resourceId: principalId,
        payload: input,
        result,
        decision,
        at,
      });
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async enrollDevice(input: {
    tenantId: string;
    principalId: string;
    deviceId: string;
    label: string;
  }): Promise<{ deviceId: string; revision: 1 }> {
    const tenantId = TenantId.parse(input.tenantId);
    const principalId = Id.parse(input.principalId);
    const deviceId = Id.parse(input.deviceId);
    const decision = await this.allowed("device.enroll", tenantId, deviceId);
    const at = now(this.options.clock);
    await this.client.execute({
      sql: `INSERT INTO cloud_device(
              tenant_id,principal_id,id,label,status,revision,created_at
            ) VALUES (?,?,?,?,'active',1,?)`,
      args: [tenantId, principalId, deviceId, Id.parse(input.label), at],
    });
    await this.audit(decision, "device.enroll", tenantId, deviceId, {
      principalId,
      label: input.label,
    });
    return { deviceId, revision: 1 };
  }

  async revokeDevice(input: {
    tenantId: string;
    deviceId: string;
    expectedRevision: number;
  }): Promise<{ deviceId: string; revision: number; status: "revoked" }> {
    const tenantId = TenantId.parse(input.tenantId);
    const deviceId = Id.parse(input.deviceId);
    const decision = await this.allowed("device.revoke", tenantId, deviceId);
    const at = now(this.options.clock);
    const updated = await this.client.execute({
      sql: `UPDATE cloud_device SET status='revoked',revision=revision+1,
              revoked_at=? WHERE tenant_id=? AND id=? AND status='active' AND revision=?`,
      args: [at, tenantId, deviceId, input.expectedRevision],
    });
    if (updated.rowsAffected !== 1) throw new Error("device_revision_conflict");
    await this.client.execute({
      sql: `UPDATE cloud_session SET revoked_at=?
            WHERE tenant_id=? AND device_id=? AND revoked_at IS NULL`,
      args: [at, tenantId, deviceId],
    });
    await this.audit(decision, "device.revoke", tenantId, deviceId, {});
    return { deviceId, revision: input.expectedRevision + 1, status: "revoked" };
  }

  async issueHumanSession(input: {
    tenantId: string;
    issuer: string;
    subject: string;
    deviceId: string;
    lifetimeMs?: number;
  }): Promise<CloudSession> {
    const tenantId = TenantId.parse(input.tenantId);
    const at = now(this.options.clock);
    const lifetime = z.number().int().min(60_000).max(24 * 60 * 60 * 1_000)
      .parse(input.lifetimeMs ?? 8 * 60 * 60 * 1_000);
    const result = await this.client.execute({
      sql: `SELECT p.id AS principal_id,p.recovery_revision,
                   t.session_epoch,d.id AS device_id
            FROM cloud_principal p
            JOIN cloud_tenant t ON t.id=p.tenant_id
            JOIN cloud_device d ON d.tenant_id=p.tenant_id
              AND d.principal_id=p.id
            WHERE p.tenant_id=? AND p.issuer=? AND p.subject_digest=?
              AND p.kind='human' AND p.status='active'
              AND t.status='active' AND d.id=? AND d.status='active'`,
      args: [
        tenantId,
        CanonicalHttpsOrigin.parse(input.issuer),
        this.subjectDigest(input.issuer, Id.parse(input.subject)),
        Id.parse(input.deviceId),
      ],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("cloud_session_identity_denied");
    const token = opaque("tasq_cloud_session");
    const csrfToken = opaque("tasq_cloud_csrf");
    const expiresAt = at + lifetime;
    await this.client.execute({
      sql: `INSERT INTO cloud_session(
              id,token_digest,csrf_digest,tenant_id,principal_id,device_id,
              tenant_session_epoch,principal_recovery_revision,issued_at,expires_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [
        randomUUID(),
        secretDigest(this.options.sessionPepper, token),
        secretDigest(this.options.sessionPepper, csrfToken),
        tenantId,
        text(row, "principal_id"),
        text(row, "device_id"),
        integer(row, "session_epoch"),
        integer(row, "recovery_revision"),
        at,
        expiresAt,
      ],
    });
    return {
      token,
      csrfToken,
      expiresAt,
      tenantId,
      principalId: text(row, "principal_id"),
      deviceId: text(row, "device_id"),
    };
  }

  async authenticateSession(
    token: string,
    csrfToken?: string,
  ): Promise<{
    tenantId: string;
    principalId: string;
    deviceId: string;
    expiresAt: number;
  } | null> {
    const at = now(this.options.clock);
    const result = await this.client.execute({
      sql: `SELECT s.*,t.session_epoch,p.recovery_revision,
                   p.status AS principal_status,d.status AS device_status,
                   t.status AS tenant_status
            FROM cloud_session s
            JOIN cloud_tenant t ON t.id=s.tenant_id
            JOIN cloud_principal p ON p.tenant_id=s.tenant_id AND p.id=s.principal_id
            JOIN cloud_device d ON d.tenant_id=s.tenant_id AND d.id=s.device_id
            WHERE s.token_digest=?`,
      args: [secretDigest(this.options.sessionPepper, token)],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || row["revoked_at"] != null || integer(row, "expires_at") <= at ||
      row["tenant_status"] !== "active" || row["principal_status"] !== "active" ||
      row["device_status"] !== "active" ||
      integer(row, "tenant_session_epoch") !== integer(row, "session_epoch") ||
      integer(row, "principal_recovery_revision") !== integer(row, "recovery_revision")) {
      return null;
    }
    if (csrfToken !== undefined) {
      const expected = Buffer.from(text(row, "csrf_digest"));
      const actual = Buffer.from(secretDigest(this.options.sessionPepper, csrfToken));
      if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
        return null;
      }
    }
    return {
      tenantId: text(row, "tenant_id"),
      principalId: text(row, "principal_id"),
      deviceId: text(row, "device_id"),
      expiresAt: integer(row, "expires_at"),
    };
  }

  async recoverHuman(input: {
    tenantId: string;
    principalId: string;
    verifiedRecoveryProofId: string;
  }): Promise<{ principalId: string; recoveryRevision: number }> {
    const tenantId = TenantId.parse(input.tenantId);
    const principalId = Id.parse(input.principalId);
    const decision = await this.allowed("principal.recover", tenantId, principalId);
    const at = now(this.options.clock);
    const updated = await this.client.execute({
      sql: `UPDATE cloud_principal SET recovery_revision=recovery_revision+1,
              revision=revision+1,updated_at=?
            WHERE tenant_id=? AND id=? AND kind='human' AND status='active'
            RETURNING recovery_revision`,
      args: [at, tenantId, principalId],
    });
    const row = updated.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("principal_not_recoverable");
    await this.client.execute({
      sql: `UPDATE cloud_session SET revoked_at=?
            WHERE tenant_id=? AND principal_id=? AND revoked_at IS NULL`,
      args: [at, tenantId, principalId],
    });
    await this.audit(decision, "principal.recover", tenantId, principalId, {
      verifiedRecoveryProofId: Id.parse(input.verifiedRecoveryProofId),
    });
    return {
      principalId,
      recoveryRevision: integer(row, "recovery_revision"),
    };
  }

  async enrollWorkload(input: {
    tenantId: string;
    principalId: string;
    workloadId: string;
    credentialRef: string;
  }): Promise<{ workloadId: string; revision: 1 }> {
    const tenantId = TenantId.parse(input.tenantId);
    const workloadId = Id.parse(input.workloadId);
    const decision = await this.allowed("workload.enroll", tenantId, workloadId);
    const at = now(this.options.clock);
    await this.client.execute({
      sql: `INSERT INTO cloud_workload(
              tenant_id,principal_id,id,credential_ref,status,revision,created_at
            ) VALUES (?,?,?,?,'active',1,?)`,
      args: [
        tenantId,
        Id.parse(input.principalId),
        workloadId,
        Id.parse(input.credentialRef),
        at,
      ],
    });
    await this.audit(decision, "workload.enroll", tenantId, workloadId, {
      principalId: input.principalId,
      credentialRefDigest: sha(input.credentialRef),
    });
    return { workloadId, revision: 1 };
  }

  async revokeWorkload(input: {
    tenantId: string;
    workloadId: string;
    expectedRevision: number;
  }): Promise<{ workloadId: string; revision: number; status: "revoked" }> {
    const tenantId = TenantId.parse(input.tenantId);
    const workloadId = Id.parse(input.workloadId);
    const decision = await this.allowed("workload.revoke", tenantId, workloadId);
    const at = now(this.options.clock);
    const result = await this.client.execute({
      sql: `UPDATE cloud_workload SET status='revoked',revision=revision+1,
              revoked_at=? WHERE tenant_id=? AND id=? AND status='active' AND revision=?`,
      args: [at, tenantId, workloadId, input.expectedRevision],
    });
    if (result.rowsAffected !== 1) throw new Error("workload_revision_conflict");
    await this.audit(decision, "workload.revoke", tenantId, workloadId, {});
    return {
      workloadId,
      revision: input.expectedRevision + 1,
      status: "revoked",
    };
  }

  async requestExport(input: {
    tenantId: string;
    workspaceId: string;
  }): Promise<{
    id: string;
    status: "ready" | "failed";
    artifactRef: string | null;
    artifactDigest: string | null;
    expiresAt: number | null;
  }> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const decision = await this.allowed("workspace.export", tenantId, workspaceId);
    const exportId = randomUUID();
    const at = now(this.options.clock);
    await this.client.execute({
      sql: `INSERT INTO cloud_export(
              id,tenant_id,workspace_id,status,requested_at,updated_at
            ) VALUES (?,?,?,'running',?,?)`,
      args: [exportId, tenantId, workspaceId, at, at],
    });
    try {
      const exported = await this.options.provisioner.export({
        tenantId,
        workspaceId,
        exportId,
      });
      await this.client.execute({
        sql: `UPDATE cloud_export SET status='ready',artifact_ref=?,
                artifact_digest=?,expires_at=?,updated_at=? WHERE id=?`,
        args: [
          Id.parse(exported.artifactRef),
          Digest.parse(exported.artifactDigest),
          z.number().int().positive().parse(exported.expiresAt),
          now(this.options.clock),
          exportId,
        ],
      });
      await this.audit(decision, "workspace.export", tenantId, workspaceId, {
        exportId,
        artifactDigest: exported.artifactDigest,
      });
      return {
        id: exportId,
        status: "ready",
        artifactRef: exported.artifactRef,
        artifactDigest: exported.artifactDigest,
        expiresAt: exported.expiresAt,
      };
    } catch {
      await this.client.execute({
        sql: "UPDATE cloud_export SET status='failed',updated_at=? WHERE id=?",
        args: [now(this.options.clock), exportId],
      });
      return {
        id: exportId,
        status: "failed",
        artifactRef: null,
        artifactDigest: null,
        expiresAt: null,
      };
    }
  }

  async createBackup(input: {
    tenantId: string;
    workspaceId: string;
    backupId: string;
    lifetimeMs?: number;
  }): Promise<{
    id: string;
    status: "ready" | "failed";
    artifactDigest: string | null;
    expiresAt: number;
  }> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const backupId = Id.parse(input.backupId);
    const decision = await this.allowed("workspace.backup", tenantId, workspaceId);
    const current = await this.getWorkspace(tenantId, workspaceId);
    if (!current?.deploymentRef || current.status !== "ready") {
      throw new Error("workspace_not_ready");
    }
    const at = now(this.options.clock);
    const retention = z.number().int()
      .min(60_000)
      .max(365 * 24 * 60 * 60 * 1_000)
      .parse(input.lifetimeMs ?? 30 * 24 * 60 * 60 * 1_000);
    const expiresAt = at + retention;
    const inserted = await this.client.execute({
      sql: `INSERT INTO cloud_backup(
              id,tenant_id,workspace_id,status,created_at,expires_at,updated_at
            ) VALUES (?,?,?,'requested',?,?,?)
            ON CONFLICT(id) DO NOTHING`,
      args: [backupId, tenantId, workspaceId, at, expiresAt, at],
    });
    if (inserted.rowsAffected === 0) {
      const existing = await this.client.execute({
        sql: "SELECT * FROM cloud_backup WHERE id=?",
        args: [backupId],
      });
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row || text(row, "tenant_id") !== tenantId ||
        text(row, "workspace_id") !== workspaceId) {
        throw new Error("backup_identity_conflict");
      }
      if (row["status"] === "ready" || row["status"] === "restored") {
        return {
          id: backupId,
          status: "ready",
          artifactDigest: text(row, "artifact_digest"),
          expiresAt: integer(row, "expires_at"),
        };
      }
    }
    try {
      const created = await this.options.provisioner.backup({
        tenantId,
        workspaceId,
        backupId,
        deploymentRef: current.deploymentRef,
        expiresAt,
      });
      const digest = Digest.parse(created.artifactDigest);
      await this.client.execute({
        sql: `UPDATE cloud_backup SET status='ready',artifact_ref=?,
                artifact_digest=?,updated_at=? WHERE id=?`,
        args: [
          Id.parse(created.artifactRef),
          digest,
          now(this.options.clock),
          backupId,
        ],
      });
      await this.audit(decision, "workspace.backup", tenantId, workspaceId, {
        backupId,
        artifactDigest: digest,
        expiresAt,
      });
      return { id: backupId, status: "ready", artifactDigest: digest, expiresAt };
    } catch {
      await this.client.execute({
        sql: "UPDATE cloud_backup SET status='failed',updated_at=? WHERE id=?",
        args: [now(this.options.clock), backupId],
      });
      return { id: backupId, status: "failed", artifactDigest: null, expiresAt };
    }
  }

  async restoreBackup(input: {
    tenantId: string;
    workspaceId: string;
    backupId: string;
  }): Promise<CloudWorkspace> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    const backupId = Id.parse(input.backupId);
    const decision = await this.allowed("workspace.restore", tenantId, workspaceId);
    const backupResult = await this.client.execute({
      sql: `SELECT * FROM cloud_backup WHERE id=? AND tenant_id=?
              AND workspace_id=? AND status IN ('ready','restored') AND expires_at>?`,
      args: [backupId, tenantId, workspaceId, now(this.options.clock)],
    });
    const backup = backupResult.rows[0] as Record<string, unknown> | undefined;
    if (!backup) throw new Error("backup_not_restorable");
    const current = await this.getWorkspace(tenantId, workspaceId);
    if (!current) throw new Error("workspace_not_found");
    const restored = await this.options.provisioner.restore({
      tenantId,
      workspaceId,
      backupId,
      artifactRef: text(backup, "artifact_ref"),
      storageBindingId: current.storageBindingId,
    });
    const secretRefs = z.array(Id).min(1).max(32).parse(restored.secretRefs);
    const at = now(this.options.clock);
    const transaction = await begin(this.client);
    try {
      await transaction.execute({
        sql: `UPDATE cloud_workspace SET status='ready',deployment_ref=?,
                server_origin=?,secret_refs_json=?,last_error_code=NULL,updated_at=?
              WHERE tenant_id=? AND id=?`,
        args: [
          Id.parse(restored.deploymentRef),
          CanonicalHttpsOrigin.parse(restored.serverOrigin),
          canonical(secretRefs),
          at,
          tenantId,
          workspaceId,
        ],
      });
      await transaction.execute({
        sql: `UPDATE cloud_backup SET status='restored',restored_at=?,updated_at=?
              WHERE id=?`,
        args: [at, at, backupId],
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    await this.audit(decision, "workspace.restore", tenantId, workspaceId, {
      backupId,
      artifactDigest: text(backup, "artifact_digest"),
    });
    return (await this.getWorkspace(tenantId, workspaceId))!;
  }

  async deleteWorkspace(input: {
    tenantId: string;
    workspaceId: string;
    confirmation: string;
  }): Promise<{ workspaceId: string; status: "deleted" }> {
    const tenantId = TenantId.parse(input.tenantId);
    const workspaceId = WorkspaceId.parse(input.workspaceId);
    if (input.confirmation !== `${tenantId}/${workspaceId}`) {
      throw new Error("workspace_delete_confirmation_mismatch");
    }
    const decision = await this.allowed("workspace.delete", tenantId, workspaceId);
    const current = await this.getWorkspace(tenantId, workspaceId);
    if (!current?.deploymentRef ||
      !["ready", "deleting"].includes(current.status)) {
      throw new Error("workspace_not_deletable");
    }
    if (current.status === "ready") {
      await this.client.execute({
        sql: `UPDATE cloud_workspace SET status='deleting',updated_at=?
              WHERE tenant_id=? AND id=? AND status='ready'`,
        args: [now(this.options.clock), tenantId, workspaceId],
      });
    }
    await this.options.provisioner.delete({
      tenantId,
      workspaceId,
      deploymentRef: current.deploymentRef,
    });
    const at = now(this.options.clock);
    await this.client.execute({
      sql: `UPDATE cloud_workspace SET status='deleted',deployment_ref=NULL,
              server_origin=NULL,secret_refs_json='[]',updated_at=?
            WHERE tenant_id=? AND id=? AND status='deleting'`,
      args: [at, tenantId, workspaceId],
    });
    await this.audit(decision, "workspace.delete", tenantId, workspaceId, {
      confirmation: true,
    });
    return { workspaceId, status: "deleted" };
  }

  async grantSupportAccess(input: {
    tenantId: string;
    supportPrincipalId: string;
    scope: "metadata" | "content";
    reason: string;
    ticketRef: string;
    lifetimeMs: number;
  }): Promise<{ id: string; expiresAt: number }> {
    const tenantId = TenantId.parse(input.tenantId);
    const decision = await this.allowed("support.grant", tenantId, input.supportPrincipalId);
    const at = now(this.options.clock);
    const lifetime = z.number().int().min(60_000).max(60 * 60 * 1_000)
      .parse(input.lifetimeMs);
    const id = randomUUID();
    const expiresAt = at + lifetime;
    await this.client.execute({
      sql: `INSERT INTO cloud_support_access(
              id,tenant_id,support_principal_id,scope,reason,ticket_ref,
              status,granted_at,expires_at
            ) VALUES (?,?,?,?,?,?,'active',?,?)`,
      args: [
        id,
        tenantId,
        Id.parse(input.supportPrincipalId),
        input.scope,
        z.string().min(1).max(2_000).parse(input.reason),
        Id.parse(input.ticketRef),
        at,
        expiresAt,
      ],
    });
    await this.audit(decision, "support.grant", tenantId, id, {
      supportPrincipalId: input.supportPrincipalId,
      scope: input.scope,
      ticketRef: input.ticketRef,
      expiresAt,
    });
    return { id, expiresAt };
  }

  async revokeSupportAccess(input: {
    id: string;
    tenantId: string;
    expectedStatus?: "active";
  }): Promise<{ id: string; status: "revoked" }> {
    const id = Id.parse(input.id);
    const tenantId = TenantId.parse(input.tenantId);
    const decision = await this.allowed("support.revoke", tenantId, id);
    const at = now(this.options.clock);
    const updated = await this.client.execute({
      sql: `UPDATE cloud_support_access SET status='revoked',revoked_at=?
            WHERE id=? AND tenant_id=? AND status='active'`,
      args: [at, id, tenantId],
    });
    if (updated.rowsAffected !== 1) throw new Error("support_access_not_active");
    await this.audit(decision, "support.revoke", tenantId, id, {});
    return { id, status: "revoked" };
  }

  async hasSupportAccess(input: {
    id: string;
    tenantId: string;
    supportPrincipalId: string;
    scope: "metadata" | "content";
  }): Promise<boolean> {
    const at = now(this.options.clock);
    const result = await this.client.execute({
      sql: `SELECT 1 FROM cloud_support_access
            WHERE id=? AND tenant_id=? AND support_principal_id=?
              AND scope=? AND status='active' AND expires_at>?`,
      args: [
        Id.parse(input.id),
        TenantId.parse(input.tenantId),
        Id.parse(input.supportPrincipalId),
        input.scope,
        at,
      ],
    });
    return result.rows.length === 1;
  }

  async sweepRetention(input: {
    tenantId: string;
  }): Promise<{ expiredExports: number; expiredBackups: number; expiredSupportGrants: number }> {
    const tenantId = TenantId.parse(input.tenantId);
    const decision = await this.allowed("retention.sweep", tenantId, tenantId);
    const at = now(this.options.clock);
    const transaction = await begin(this.client);
    try {
      const exports = await transaction.execute({
        sql: `UPDATE cloud_export SET status='expired',artifact_ref=NULL,
                artifact_digest=NULL,updated_at=?
              WHERE tenant_id=? AND status='ready' AND expires_at<=?`,
        args: [at, tenantId, at],
      });
      const backups = await transaction.execute({
        sql: `UPDATE cloud_backup SET status='expired',artifact_ref=NULL,
                artifact_digest=NULL,updated_at=?
              WHERE tenant_id=? AND status IN ('ready','restored') AND expires_at<=?`,
        args: [at, tenantId, at],
      });
      const support = await transaction.execute({
        sql: `UPDATE cloud_support_access SET status='expired'
              WHERE tenant_id=? AND status='active' AND expires_at<=?`,
        args: [tenantId, at],
      });
      await transaction.commit();
      const result = {
        expiredExports: exports.rowsAffected,
        expiredBackups: backups.rowsAffected,
        expiredSupportGrants: support.rowsAffected,
      };
      await this.audit(decision, "retention.sweep", tenantId, tenantId, result);
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async recordIncident(input: {
    tenantId?: string | null;
    severity: "sev1" | "sev2" | "sev3" | "sev4";
    summary: string;
  }): Promise<{ id: string; status: "open" }> {
    const tenantId = input.tenantId ? TenantId.parse(input.tenantId) : "";
    const decision = await this.allowed("incident.record", tenantId, "incident");
    const id = randomUUID();
    const at = now(this.options.clock);
    await this.client.execute({
      sql: `INSERT INTO cloud_incident(
              id,tenant_id,severity,status,summary,opened_at,updated_at
            ) VALUES (?,?,?,'open',?,?,?)`,
      args: [
        id,
        tenantId || null,
        input.severity,
        z.string().min(1).max(2_000).parse(input.summary),
        at,
        at,
      ],
    });
    await this.audit(decision, "incident.record", tenantId, id, {
      severity: input.severity,
    });
    return { id, status: "open" };
  }

  async bindBilling(input: {
    tenantId: string;
    providerCustomerRef: string;
    status: "trial" | "active" | "past_due" | "cancelled";
  }): Promise<{ tenantId: string; status: string; grantsAuthority: false }> {
    const tenantId = TenantId.parse(input.tenantId);
    const decision = await this.allowed("billing.bind", tenantId, tenantId);
    const at = now(this.options.clock);
    await this.client.execute({
      sql: `INSERT INTO cloud_billing(tenant_id,provider_customer_ref,status,updated_at)
            VALUES (?,?,?,?)
            ON CONFLICT(tenant_id) DO UPDATE SET
              provider_customer_ref=excluded.provider_customer_ref,
              status=excluded.status,updated_at=excluded.updated_at`,
      args: [tenantId, Id.parse(input.providerCustomerRef), input.status, at],
    });
    await this.audit(decision, "billing.bind", tenantId, tenantId, {
      status: input.status,
      providerCustomerRefDigest: sha(input.providerCustomerRef),
      grantsAuthority: false,
    });
    return { tenantId, status: input.status, grantsAuthority: false };
  }

  async listAudit(tenantInput: string): Promise<Array<Record<string, unknown>>> {
    const tenantId = TenantId.parse(tenantInput);
    const result = await this.client.execute({
      sql: `SELECT sequence,event_id,occurred_at,tenant_id,actor_principal_id,
                   authority_decision_id,action,resource_id,detail_json
            FROM cloud_audit WHERE tenant_id=? ORDER BY sequence`,
      args: [tenantId],
    });
    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        sequence: integer(row, "sequence"),
        eventId: text(row, "event_id"),
        occurredAt: integer(row, "occurred_at"),
        tenantId: text(row, "tenant_id"),
        actorPrincipalId: text(row, "actor_principal_id"),
        authorityDecisionId: text(row, "authority_decision_id"),
        action: text(row, "action"),
        resourceId: text(row, "resource_id"),
        detail: JSON.parse(text(row, "detail_json")),
      };
    });
  }

  private async audit(
    decision: CloudAuthorizationDecision,
    action: CloudAction,
    tenantId: string,
    resourceId: string,
    detail: unknown,
  ): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO cloud_audit(
              event_id,occurred_at,tenant_id,actor_principal_id,
              authority_decision_id,action,resource_id,detail_json
            ) VALUES (?,?,?,?,?,?,?,?)`,
      args: [
        randomUUID(),
        now(this.options.clock),
        tenantId || null,
        decision.actorPrincipalId,
        decision.decisionId,
        action,
        resourceId,
        canonical(detail),
      ],
    });
  }
}

export interface CloudBffOptions {
  publicOrigin: string;
  controlPlane: CloudControlPlane;
  resolveServerCredential(input: {
    tenantId: string;
    workspaceId: string;
    principalId: string;
  }): Promise<string>;
  fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/**
 * Same-origin browser BFF. Browser sessions never receive a Server bearer
 * credential, and remote effects are unconditionally absent.
 */
export function createCloudBff(options: CloudBffOptions) {
  const publicOrigin = CanonicalHttpsOrigin.parse(options.publicOrigin);
  const fetcher = options.fetch ?? fetch;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin + "/" !== publicOrigin) {
      return new Response("not found", { status: 404, headers: { "x-tasq-bff-rejection": "origin" } });
    }
    const match = /^\/api\/tenants\/([^/]+)\/workspaces\/([^/]+)(\/.*)$/
      .exec(url.pathname);
    if (!match) return new Response("not found", { status: 404, headers: { "x-tasq-bff-rejection": "route" } });
    const tenantId = decodeURIComponent(match[1]!);
    const workspaceId = decodeURIComponent(match[2]!);
    let workspace: CloudWorkspace | null;
    try {
      workspace = await options.controlPlane.getWorkspace(tenantId, workspaceId);
    } catch {
      return new Response("not found", { status: 404 });
    }
    if (!workspace || workspace.status !== "ready" || !workspace.serverOrigin) {
      return new Response(JSON.stringify({
        contractVersion: CLOUD_BFF_CONTRACT_VERSION,
        code: "workspace_unavailable",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const sessionToken = cookieValue(request.headers.get("cookie"), "__Host-tasq_session");
    if (!sessionToken) return new Response("unauthorized", { status: 401 });
    const mutating = !["GET", "HEAD"].includes(request.method);
    const csrf = mutating ? request.headers.get("x-tasq-csrf") ?? undefined : undefined;
    if (mutating && !csrf) {
      return new Response("unauthorized", { status: 401 });
    }
    const session = await options.controlPlane.authenticateSession(sessionToken, csrf);
    if (!session || session.tenantId !== tenantId) {
      return new Response("unauthorized", { status: 401 });
    }
    if (mutating) {
      const origin = request.headers.get("origin");
      if (origin !== publicOrigin.slice(0, -1)) {
        return new Response("forbidden", { status: 403 });
      }
    }
    const downstreamPath = match[3]!;
    if (/\/effects(?:\/|$)/.test(downstreamPath)) {
      return new Response(JSON.stringify({
        contractVersion: CLOUD_BFF_CONTRACT_VERSION,
        code: "remote_effects_disabled",
      }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const token = await options.resolveServerCredential({
      tenantId,
      workspaceId,
      principalId: session.principalId,
    });
    const target = new URL(downstreamPath + url.search, workspace.serverOrigin);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("origin");
    headers.delete("x-tasq-csrf");
    headers.set("authorization", token.startsWith("Bearer ") ? token : `Bearer ${token}`);
    headers.set("x-tasq-bff-principal", session.principalId);
    const response = await fetcher(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      signal: request.signal,
      duplex: "half",
      redirect: "manual",
    } as RequestInit & { duplex: "half" });
    const outgoing = new Headers(response.headers);
    outgoing.delete("set-cookie");
    // The runtime fetch implementation decodes compressed upstream bodies.
    // Forwarding the stale transport headers makes browsers decode them twice.
    outgoing.delete("content-encoding");
    outgoing.delete("content-length");
    outgoing.delete("transfer-encoding");
    outgoing.set("cache-control", "private, no-store");
    outgoing.set("x-content-type-options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  };
}

export function cloudSessionCookie(token: string, expiresAt: number, now: number): string {
  Id.parse(token);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid cookie clock");
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1_000));
  return `__Host-tasq_session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
