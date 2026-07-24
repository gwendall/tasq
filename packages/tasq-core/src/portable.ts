import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient, type Client, type InValue } from "@libsql/client";
import {
  WorkspaceCheckpointV1,
  canonicalizeEffectJson,
  uuidv7,
  type Metadata,
  type WorkspaceCheckpointV1 as WorkspaceCheckpoint,
} from "@tasq-run/schema";
import { runMigrations, STORE_FORMAT_COMPATIBILITY } from "./migrations/index.js";
import { verifyDatabaseFile, type DatabaseVerification } from "./db.js";

export const PORTABLE_EXPORT_CONTRACT_VERSION = "tasq.portable-export.v1" as const;
export const PORTABLE_EXPORT_OMISSIONS = Object.freeze([
  "delivery_sink",
  "delivery_outbox",
  "idempotency_key",
  "replication_authority",
  "replication_authority_recovery",
  "replication_local_replica",
  "replication_replica",
  "replication_outgoing",
  "replication_accepted",
  "replication_conflict",
  "replication_retired_identity",
  "replication_materialized_record",
  "local_config",
  "credentials",
  "console_listener_registration",
  "event_journal",
] as const);

const PORTABLE_TABLES = [
  { name: "principal", scope: "tenant_id" },
  { name: "coordination_space", scope: "workspace_id" },
  { name: "resource_lease", scope: "workspace_id" },
  { name: "resource_event", scope: "workspace_id" },
  { name: "area", scope: "tenant_id" },
  { name: "goal", scope: "tenant_id" },
  { name: "project", scope: "tenant_id" },
  { name: "task", scope: "tenant_id" },
  { name: "commitment_summary", scope: "tenant_id" },
  { name: "event", scope: "tenant_id" },
  { name: "task_dependency", scope: "tenant_id" },
  { name: "commitment_relation", scope: "tenant_id" },
  { name: "assignment", scope: "tenant_id" },
  { name: "external_ref", scope: "tenant_id" },
  { name: "external_context_link", scope: "tenant_id" },
  { name: "task_claim", scope: "tenant_id" },
  { name: "task_attempt", scope: "tenant_id" },
  { name: "task_evidence", scope: "tenant_id" },
  { name: "artifact", scope: "tenant_id" },
  { name: "resolution_contract", scope: "tenant_id" },
  { name: "evidence_trust_record", scope: "tenant_id" },
  { name: "completion_proposal", scope: "tenant_id" },
  { name: "completion_challenge", scope: "tenant_id" },
  { name: "validation_decision", scope: "tenant_id" },
  { name: "completion_record", scope: "tenant_id" },
  { name: "extension_release", scope: "tenant_id" },
  { name: "extension_type", scope: "tenant_id" },
  { name: "extension_evaluator", scope: "tenant_id" },
  { name: "wait_condition", scope: "tenant_id" },
  { name: "observation", scope: "tenant_id" },
  { name: "observation_route", scope: "tenant_id" },
  { name: "reconciliation", scope: "tenant_id" },
  { name: "effect", scope: "tenant_id" },
  { name: "effect_approval", scope: "tenant_id" },
  { name: "effect_receipt", scope: "tenant_id" },
  { name: "workspace_checkpoint", scope: "tenant_id" },
  { name: "accepted_signing_credential_snapshot", scope: "tenant_id" },
  { name: "signed_statement", scope: "tenant_id" },
  { name: "signature_verification_record", scope: "tenant_id" },
  { name: "signed_statement_nonce", scope: "tenant_id" },
  { name: "signed_statement_binding", scope: "tenant_id" },
] as const;

type PortableScalar = string | number | null;
export interface PortableTable {
  name: string;
  columns: string[];
  rows: Array<Record<string, PortableScalar>>;
}

export interface PortableExportDocument {
  contractVersion: typeof PORTABLE_EXPORT_CONTRACT_VERSION;
  storeFormat: number;
  workspaceId: string;
  exportedAt: number;
  eventOrdering: { count: number; maxSequence: number };
  omissions: string[];
  tables: PortableTable[];
}

export interface PortableExportResult {
  document: PortableExportDocument;
  sha256: string;
  sizeBytes: number;
  recordCount: number;
}

export interface PortableExportOptions {
  now: number;
  maxRecords?: number;
  maxBytes?: number;
}

export const PORTABLE_WORKSPACE_ROOT_URI =
  "https://schemas.tasq.dev/checkpoints/portable-workspace-root/v1" as const;

type PortableSqlClient = Pick<Client, "execute">;

export interface PortableImportResult {
  target: string;
  workspaceId: string;
  recordCount: number;
  sourceSha256: string;
  verification: DatabaseVerification;
}

/** Deterministic, bounded export of durable workspace-owned records. */
export async function exportPortableStore(
  client: PortableSqlClient,
  workspaceId: string,
  options: PortableExportOptions,
): Promise<PortableExportResult> {
  const maxRecords = boundedInteger(options.maxRecords ?? 100_000, 1, 1_000_000, "maxRecords");
  const maxBytes = boundedInteger(options.maxBytes ?? 128 * 1024 * 1024, 1024, 512 * 1024 * 1024, "maxBytes");
  let recordCount = 0;
  const tables: PortableTable[] = [];
  for (const table of PORTABLE_TABLES) {
    const columns = await tableColumns(client, table.name);
    const order = await tableOrder(client, table.name, columns);
    const remaining = maxRecords - recordCount;
    if (remaining <= 0) throw new Error(`Portable export exceeds maxRecords=${maxRecords}`);
    const result = await client.execute({
      sql: `SELECT * FROM ${identifier(table.name)} WHERE ${identifier(table.scope)} = ? ORDER BY ${order.map(identifier).join(", ")} LIMIT ?`,
      args: [workspaceId, remaining + 1],
    });
    if (result.rows.length > remaining) throw new Error(`Portable export exceeds maxRecords=${maxRecords}`);
    const rows = result.rows.map((row) => {
      const output: Record<string, PortableScalar> = {};
      for (const column of columns) {
        const value = row[column];
        if (value !== null && typeof value !== "string" && typeof value !== "number") {
          throw new Error(`Portable export cannot encode ${table.name}.${column}`);
        }
        output[column] = value as PortableScalar;
      }
      return output;
    });
    recordCount += rows.length;
    tables.push({ name: table.name, columns, rows });
  }
  // Replication authority state is deliberately omitted from portable
  // workspace exports. Its signed origin proof must travel with that authority
  // log, never as a dangling proof-dependent binding in an otherwise valid
  // portable workspace.
  const bindingTable = tables.find(({ name }) => name === "signed_statement_binding")!;
  const omittedStatementIds = new Set(bindingTable.rows
    .filter((row) => row.record_type === "replication_operation")
    .map((row) => String(row.statement_id)));
  if (omittedStatementIds.size > 0) {
    for (const table of tables) {
      if (["signed_statement", "signature_verification_record", "signed_statement_nonce",
        "signed_statement_binding"].includes(table.name)) {
        table.rows = table.rows.filter((row) =>
          !omittedStatementIds.has(String(row.statement_id)));
      }
    }
    const retainedVerifications = tables
      .find(({ name }) => name === "signature_verification_record")!.rows;
    const retainedCredentialIdentities = new Set(retainedVerifications.map((row) =>
      `${row.credential_id}\u0000${row.credential_revision}`));
    const credentialTable = tables.find(
      ({ name }) => name === "accepted_signing_credential_snapshot",
    )!;
    credentialTable.rows = credentialTable.rows.filter((row) =>
      retainedCredentialIdentities.has(
        `${row.credential_id}\u0000${row.credential_revision}`,
      ));
    recordCount = tables.reduce((sum, table) => sum + table.rows.length, 0);
  }
  const eventTable = tables.find(({ name }) => name === "event")!;
  const eventSequences = eventTable.rows.map((row) => Number(row.sequence));
  const document: PortableExportDocument = {
    contractVersion: PORTABLE_EXPORT_CONTRACT_VERSION,
    storeFormat: STORE_FORMAT_COMPATIBILITY.current,
    workspaceId,
    exportedAt: options.now,
    eventOrdering: {
      count: eventSequences.length,
      maxSequence: eventSequences.length === 0 ? 0 : Math.max(...eventSequences),
    },
    omissions: [...PORTABLE_EXPORT_OMISSIONS],
    tables,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maxBytes) throw new Error(`Portable export exceeds maxBytes=${maxBytes}`);
  return {
    document,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    recordCount,
  };
}

/**
 * Freeze one exact portable workspace root and cursor inside the same SQLite
 * write transaction. The checkpoint is public evidence; external witnessing
 * is still required for rollback-resistance claims.
 */
export async function createPortableWorkspaceCheckpoint(
  client: Client,
  input: {
    workspaceId: string;
    authorityEpoch: string;
    createdByPrincipalId: string;
    createdAt: number;
    metadata?: Metadata;
    id?: string;
  },
): Promise<WorkspaceCheckpoint> {
  if (!input.workspaceId.trim() || !input.authorityEpoch.trim()
    || !input.createdByPrincipalId.trim()) {
    throw new Error("workspace checkpoint identities must not be blank");
  }
  const transaction = await client.transaction("write");
  try {
    const exported = await exportPortableStore(transaction, input.workspaceId, {
      now: input.createdAt,
    });
    const checkpoint = WorkspaceCheckpointV1.parse({
      contractVersion: "tasq.workspace-checkpoint.v1",
      id: input.id ?? uuidv7(input.createdAt),
      workspaceId: input.workspaceId,
      authorityEpoch: input.authorityEpoch,
      eventCursor: exported.document.eventOrdering.maxSequence,
      rootContract: { uri: PORTABLE_WORKSPACE_ROOT_URI, version: 1 },
      rootDigest: `sha256:${exported.sha256}`,
      exportedRecordCount: exported.recordCount,
      createdByPrincipalId: input.createdByPrincipalId,
      createdAt: input.createdAt,
      metadata: input.metadata ?? {},
    });
    await transaction.execute({
      sql: `INSERT INTO workspace_checkpoint(
              id, tenant_id, authority_epoch, event_cursor, root_contract_uri,
              root_contract_version, root_digest, exported_record_count,
              created_by_principal_id, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        checkpoint.id,
        checkpoint.workspaceId,
        checkpoint.authorityEpoch,
        checkpoint.eventCursor,
        checkpoint.rootContract.uri,
        checkpoint.rootContract.version,
        checkpoint.rootDigest,
        checkpoint.exportedRecordCount,
        checkpoint.createdByPrincipalId,
        checkpoint.createdAt,
        canonicalizeEffectJson(checkpoint.metadata as never),
      ],
    });
    await transaction.commit();
    return checkpoint;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/** Validate the complete document before creating or mutating a target store. */
export function validatePortableExport(value: unknown): PortableExportDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Portable export must be an object");
  const candidate = value as Partial<PortableExportDocument>;
  if (candidate.contractVersion !== PORTABLE_EXPORT_CONTRACT_VERSION) throw new Error("Unsupported portable export contract");
  if (candidate.storeFormat !== STORE_FORMAT_COMPATIBILITY.current) {
    throw new Error(`Portable export format ${candidate.storeFormat} is not importable by format ${STORE_FORMAT_COMPATIBILITY.current}`);
  }
  if (typeof candidate.workspaceId !== "string" || !candidate.workspaceId.trim()) throw new Error("Portable export workspaceId is required");
  if (!Number.isSafeInteger(candidate.exportedAt) || (candidate.exportedAt ?? -1) < 0) throw new Error("Portable export exportedAt is invalid");
  if (!Array.isArray(candidate.omissions) || JSON.stringify(candidate.omissions) !== JSON.stringify(PORTABLE_EXPORT_OMISSIONS)) {
    throw new Error("Portable export omissions do not match the v1 contract");
  }
  if (!Array.isArray(candidate.tables) || candidate.tables.length !== PORTABLE_TABLES.length) {
    throw new Error("Portable export has an incomplete table set");
  }
  for (const [index, expected] of PORTABLE_TABLES.entries()) {
    const table = candidate.tables[index];
    if (!table || table.name !== expected.name || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new Error(`Portable export table ${expected.name} is missing or out of order`);
    }
    if (new Set(table.columns).size !== table.columns.length || table.columns.some((column) => typeof column !== "string")) {
      throw new Error(`Portable export table ${expected.name} has invalid columns`);
    }
    for (const row of table.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== table.columns.length) {
        throw new Error(`Portable export table ${expected.name} has an invalid row`);
      }
      if (Object.keys(row).some((column, offset) => column !== table.columns[offset])) {
        throw new Error(`Portable export table ${expected.name} row columns are not canonical`);
      }
      for (const value of Object.values(row)) {
        if (value !== null && typeof value !== "string" && (!Number.isSafeInteger(value) || typeof value !== "number")) {
          throw new Error(`Portable export table ${expected.name} has a non-portable value`);
        }
      }
      if (row[expected.scope] !== candidate.workspaceId) {
        throw new Error(`Portable export table ${expected.name} escapes workspace ${candidate.workspaceId}`);
      }
    }
  }
  const eventTable = candidate.tables.find(({ name }) => name === "event")!;
  const eventSequences = eventTable.rows.map((row) => Number(row.sequence));
  const expectedOrdering = {
    count: eventSequences.length,
    maxSequence: eventSequences.length === 0 ? 0 : Math.max(...eventSequences),
  };
  if (JSON.stringify(candidate.eventOrdering) !== JSON.stringify(expectedOrdering)) {
    throw new Error("Portable export event ordering summary is inconsistent");
  }
  return candidate as PortableExportDocument;
}

/** Import only into a brand-new explicit database path. */
export async function importPortableStore(
  value: unknown,
  targetPathInput: string,
  sourceSha256: string,
  now: number,
): Promise<PortableImportResult> {
  const document = validatePortableExport(value);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("Portable export digest is invalid");
  const target = resolve(targetPathInput);
  if (existsSync(target)) throw new Error(`Portable import target already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.import-${process.pid}-${randomUUID()}.tmp`;
  const client = createClient({ url: `file:${temporary}` });
  try {
    await client.execute("PRAGMA busy_timeout = 30000");
    await client.execute("PRAGMA foreign_keys = ON");
    await runMigrations(client, { now });
    for (const table of document.tables) {
      const actualColumns = await tableColumns(client, table.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(table.columns)) {
        throw new Error(`Portable import schema mismatch for ${table.name}`);
      }
    }
    await client.execute("PRAGMA foreign_keys = OFF");
    await client.execute("BEGIN IMMEDIATE");
    try {
      for (const table of document.tables) {
        if (table.rows.length === 0) continue;
        const placeholders = table.columns.map(() => "?").join(", ");
        const sql = `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(", ")}) VALUES (${placeholders})`;
        for (const row of table.rows) {
          await client.execute({
            sql,
            args: table.columns.map((column) => row[column] as InValue),
          });
        }
      }
      await client.execute("COMMIT");
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    } finally {
      await client.execute("PRAGMA foreign_keys = ON");
    }
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length > 0) throw new Error(`Portable import has ${foreignKeys.rows.length} foreign-key violation(s)`);
  } catch (error) {
    client.close();
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  client.close();
  chmodSync(temporary, 0o600);
  let verification: DatabaseVerification;
  try {
    verification = await verifyDatabaseFile(temporary);
    if (!verification.ok || verification.eventCursor !== document.eventOrdering.maxSequence) {
      throw new Error("Portable import verification failed; target is not accepted for use");
    }
    // Publish only the already-verified inode. link(2) fails atomically if a
    // competing operator created the explicit target after our first check.
    linkSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return {
    target,
    workspaceId: document.workspaceId,
    recordCount: document.tables.reduce((sum, table) => sum + table.rows.length, 0),
    sourceSha256,
    verification,
  };
}

async function tableColumns(client: PortableSqlClient, table: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${identifier(table)})`);
  const columns = result.rows
    .sort((left, right) => Number(left["cid"]) - Number(right["cid"]))
    .map((row) => String(row["name"]));
  if (columns.length === 0) throw new Error(`Portable table is missing from the store: ${table}`);
  return columns;
}

async function tableOrder(client: PortableSqlClient, table: string, fallback: string[]): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${identifier(table)})`);
  const primary = result.rows
    .filter((row) => Number(row["pk"]) > 0)
    .sort((left, right) => Number(left["pk"]) - Number(right["pk"]))
    .map((row) => String(row["name"]));
  return primary.length > 0 ? primary : fallback;
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
