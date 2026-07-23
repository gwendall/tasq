/**
 * Immutable, checksum-pinned migrations plus the public store-safety envelope.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import type { Clock } from "@tasq-run/schema";
import { verifyDatabaseFile, type DatabaseVerification } from "../db.js";
import { serviceNow } from "../util/clock.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const STORE_FORMAT_COMPATIBILITY = Object.freeze({
  contractVersion: "tasq.store-format.v1" as const,
  current: 25,
  readable: Object.freeze({ min: 25, max: 25 }),
  writable: Object.freeze({ min: 25, max: 25 }),
  directlyMigratable: Object.freeze({ min: 0, max: 25 }),
  oldestDirectlyTestedSource: "tasq-zero-populated-fixture",
  irreversible: true,
  rollback: "restore-matching-verified-pre-migration-snapshot-and-binary" as const,
});

export type MigrationSafetyBoundary =
  | "before_snapshot"
  | "after_snapshot_verified"
  | "before_ddl"
  | "after_ddl_before_commit"
  | "after_commit_before_postcheck"
  | "before_receipt_finalization";

export interface MigrationPostCheck {
  ok: boolean;
  issues: string[];
}

export interface MigrationOptions {
  clock?: Clock;
  now?: number;
  /** Optional composition-level invariant check, run after schema verification. */
  postMigrationCheck?: () => Promise<MigrationPostCheck>;
  /** Deterministic test/host observation hook; it cannot authorize or skip work. */
  onSafetyBoundary?: (boundary: MigrationSafetyBoundary) => void | Promise<void>;
}

export interface MigrationReceiptSummary {
  id: string;
  path: string;
  status: "complete" | "failed" | "superseded";
  snapshotPath: string;
  snapshotSha256: string;
  sourceFormat: number;
  targetFormat: number;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  storeFormat: typeof STORE_FORMAT_COMPATIBILITY;
  beforeFormat: number | null;
  afterFormat: number;
  migrationRequired: boolean;
  irreversible: boolean;
  receipt: MigrationReceiptSummary | null;
}

export class StoreCompatibilityError extends Error {
  readonly contractVersion = "tasq.store-compatibility-problem.v1";
  constructor(
    readonly code:
      | "store_format_newer_than_executable"
      | "store_format_unrecognized"
      | "store_migration_history_partial"
      | "store_migration_checksum_drift",
    message: string,
    readonly detectedFormat: number | null,
  ) {
    super(message);
    this.name = "StoreCompatibilityError";
  }

  toJSON() {
    return {
      contractVersion: this.contractVersion,
      ok: false,
      code: this.code,
      detectedFormat: this.detectedFormat,
      supported: STORE_FORMAT_COMPATIBILITY,
      mutationPerformed: false,
      message: this.message,
    };
  }
}

export class MigrationSafetyError extends Error {
  readonly contractVersion = "tasq.migration-safety-problem.v1";
  constructor(
    message: string,
    readonly receipt: MigrationReceiptSummary,
  ) {
    super(message);
    this.name = "MigrationSafetyError";
  }

  toJSON() {
    return {
      contractVersion: this.contractVersion,
      ok: false,
      code: "migration_postcheck_failed",
      receipt: this.receipt,
      restore: {
        snapshotPath: this.receipt.snapshotPath,
        requiredStoreFormat: this.receipt.sourceFormat,
        rule: STORE_FORMAT_COMPATIBILITY.rollback,
      },
      message: this.message,
    };
  }
}

interface MigrationDefinition {
  name: string;
  format: number;
  sqlText: string;
  checksum: string;
}

interface ReceiptDocument {
  contractVersion: "tasq.migration-receipt.v1";
  id: string;
  status: "snapshot_verified" | "complete" | "failed" | "superseded";
  startedAt: number;
  completedAt: number | null;
  source: { pathIdentity: string; format: number; eventCursor: number | null };
  target: { format: number };
  migrations: Array<{ name: string; sha256: string }>;
  snapshot: {
    path: string;
    sha256: string;
    sizeBytes: number;
    verification: DatabaseVerification;
  };
  postVerification: {
    database: DatabaseVerification;
    schemaFormat: number;
    service: MigrationPostCheck;
  } | null;
  failure: string | null;
  recoveredAfterRestart: boolean;
  restoreRule: typeof STORE_FORMAT_COMPATIBILITY.rollback;
}

/** Run every pending migration, failing closed before writes on unknown state. */
export async function runMigrations(
  client: Client,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const now = serviceNow(options, options.now);
  const definitions = migrationDefinitions();
  assertDefinitionEnvelope(definitions);

  const peek = await inspectMigrationState(client, definitions);
  if (!peek.existingStore) {
    return runMigrationsUnderEnvelope(client, options, now, definitions);
  }
  if (
    peek.format === STORE_FORMAT_COMPATIBILITY.current &&
    !(await hasPendingMigrationReceipt(client))
  ) {
    return runMigrationsUnderEnvelope(client, options, now, definitions);
  }
  const lock = await acquireMigrationFileLock(client, now);
  try {
    // Inspect again after acquiring the cross-process lock: another executable
    // may have completed the upgrade while this caller was waiting.
    return await runMigrationsUnderEnvelope(client, options, now, definitions);
  } finally {
    releaseMigrationFileLock(lock);
  }
}

async function hasPendingMigrationReceipt(client: Client): Promise<boolean> {
  const sourcePath = await mainDatabasePath(client);
  const recoveryDir = `${sourcePath}.tasq-migrations`;
  if (!existsSync(recoveryDir)) return false;
  for (const name of readdirSync(recoveryDir).filter((entry) => /^receipt-.+\.json$/.test(entry))) {
    const path = join(recoveryDir, name);
    let document: { status?: unknown };
    try {
      document = JSON.parse(readFileSync(path, "utf8")) as { status?: unknown };
    } catch {
      throw new Error(`Migration receipt is unreadable: ${path}`);
    }
    if (document.status === "snapshot_verified") return true;
  }
  return false;
}

async function runMigrationsUnderEnvelope(
  client: Client,
  options: MigrationOptions,
  now: number,
  definitions: MigrationDefinition[],
): Promise<MigrationResult> {

  const initial = await inspectMigrationState(client, definitions);
  const recoveredReceipt = initial.existingStore
    ? await recoverPendingReceipts(client, initial.format!, options, now)
    : null;
  const pending = definitions.filter((definition) => !initial.applied.has(definition.name));
  const base = {
    storeFormat: STORE_FORMAT_COMPATIBILITY,
    beforeFormat: initial.format,
    afterFormat: STORE_FORMAT_COMPATIBILITY.current,
    migrationRequired: pending.length > 0,
    irreversible: initial.existingStore && pending.length > 0,
  };

  if (pending.length === 0) {
    return {
      applied: [],
      skipped: definitions.map(({ name }) => name),
      ...base,
      receipt: recoveredReceipt,
    };
  }

  let receiptState: { document: ReceiptDocument; path: string } | null = null;
  if (initial.existingStore) {
    await options.onSafetyBoundary?.("before_snapshot");
    receiptState = await createVerifiedRecoveryPoint(client, initial.format!, pending, now);
    await options.onSafetyBoundary?.("after_snapshot_verified");
  }

  const result: MigrationResult = {
    applied: [],
    skipped: [],
    ...base,
    receipt: null,
  };

  await client.execute("BEGIN IMMEDIATE");
  try {
    const locked = await inspectMigrationState(client, definitions);
    const lockedPending = definitions.filter((definition) => !locked.applied.has(definition.name));
    if (lockedPending.length === 0) {
      await client.execute("COMMIT");
      if (receiptState) {
        receiptState.document.status = "superseded";
        receiptState.document.completedAt = now;
        writeReceipt(receiptState.path, receiptState.document);
        result.receipt = receiptSummary(receiptState.path, receiptState.document);
      }
      result.skipped = definitions.map(({ name }) => name);
      result.migrationRequired = false;
      result.irreversible = false;
      return result;
    }

    await client.execute(`
      CREATE TABLE IF NOT EXISTS _migration (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      )
    `);
    const migrationColumns = await client.execute("PRAGMA table_info('_migration')");
    if (!migrationColumns.rows.some((row) => row["name"] === "checksum")) {
      await client.execute("ALTER TABLE _migration ADD COLUMN checksum TEXT");
    }
    await options.onSafetyBoundary?.("before_ddl");
    for (const definition of definitions) {
      const recordedChecksum = locked.applied.get(definition.name);
      if (recordedChecksum === definition.checksum) {
        result.skipped.push(definition.name);
        continue;
      }
      if (locked.applied.has(definition.name) && recordedChecksum == null) {
        await client.execute({
          sql: "UPDATE _migration SET checksum = ? WHERE name = ?",
          args: [definition.checksum, definition.name],
        });
        result.skipped.push(definition.name);
        continue;
      }
      for (const statement of splitSql(definition.sqlText)) {
        if (statement.trim()) await client.execute(statement);
      }
      await client.execute({
        sql: "INSERT INTO _migration (name, applied_at, checksum) VALUES (?, ?, ?)",
        args: [definition.name, now, definition.checksum],
      });
      result.applied.push(definition.name);
    }
    await options.onSafetyBoundary?.("after_ddl_before_commit");
    await client.execute("COMMIT");
  } catch (error) {
    try {
      await client.execute("ROLLBACK");
    } catch {
      // The connection may already have rolled back after a process/driver fault.
    }
    if (receiptState) failReceipt(receiptState, error, now);
    throw error;
  }

  await options.onSafetyBoundary?.("after_commit_before_postcheck");
  try {
    const database = await verifyLiveDatabase(client);
    const finalState = await inspectMigrationState(client, definitions);
    const service = options.postMigrationCheck
      ? await options.postMigrationCheck()
      : { ok: true, issues: [] };
    if (!database.ok || finalState.format !== STORE_FORMAT_COMPATIBILITY.current || !service.ok) {
      throw new Error(
        `post-migration verification failed: integrity=${database.integrity}, ` +
        `foreignKeys=${database.foreignKeyViolations}, format=${finalState.format}, ` +
        `serviceIssues=${service.issues.length}`,
      );
    }
    if (receiptState) {
      receiptState.document.postVerification = {
        database,
        schemaFormat: finalState.format,
        service,
      };
      receiptState.document.status = "complete";
      receiptState.document.completedAt = now;
      await options.onSafetyBoundary?.("before_receipt_finalization");
      writeReceipt(receiptState.path, receiptState.document);
      result.receipt = receiptSummary(receiptState.path, receiptState.document);
    }
    return result;
  } catch (error) {
    if (!receiptState) throw error;
    failReceipt(receiptState, error, now);
    const summary = receiptSummary(receiptState.path, receiptState.document);
    throw new MigrationSafetyError(
      `Migration committed but verification did not pass; retain the store and restore ${summary.snapshotPath} with a matching binary`,
      summary,
    );
  }
}

interface MigrationFileLock {
  path: string;
  descriptor: number;
  token: string;
}

async function acquireMigrationFileLock(client: Client, now: number): Promise<MigrationFileLock> {
  const sourcePath = await mainDatabasePath(client);
  const path = `${sourcePath}.tasq-migration.lock`;
  const token = randomUUID();
  const candidatePath = `${path}.candidate-${process.pid}-${token}`;
  writeFileSync(candidatePath, `${JSON.stringify({
    contractVersion: "tasq.migration-lock.v1",
    token,
    pid: process.pid,
    startedAt: now,
  })}\n`, { mode: 0o600 });
  chmodSync(candidatePath, 0o600);
  const candidateDescriptor = openSync(candidatePath, "r");
  try {
    fsyncSync(candidateDescriptor);
  } finally {
    closeSync(candidateDescriptor);
  }
  for (let attempt = 0; attempt < 2_400; attempt++) {
    try {
      // A hard link is an atomic exclusive publish of already-fsynced owner
      // bytes. A crash can leave a complete lock or only an ignored candidate,
      // never an unreadable partially-written authority record.
      linkSync(candidatePath, path);
      const descriptor = openSync(path, "r");
      unlinkSync(candidatePath);
      return { path, descriptor, token };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "EEXIST") throw error;
      let stale = false;
      let stalePid = "unknown";
      try {
        const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
        stalePid = String(owner.pid);
        stale = typeof owner.pid === "number" && !processIsAlive(owner.pid);
      } catch (readError) {
        const readCode = readError && typeof readError === "object" && "code" in readError
          ? String((readError as { code?: unknown }).code)
          : "";
        if (readCode === "ENOENT") continue;
        throw new Error(`Migration lock is unreadable and cannot be reclaimed safely: ${path}`);
      }
      if (stale) {
        try {
          renameSync(path, `${path}.stale-${stalePid}-${randomUUID()}`);
          continue;
        } catch {
          // Another contender reclaimed or released the exact lock first.
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    unlinkSync(candidatePath);
  } catch {
    // The candidate may already have been linked and removed by this caller.
  }
  throw new Error(`Timed out waiting for migration lock ${path}`);
}

function releaseMigrationFileLock(lock: MigrationFileLock): void {
  closeSync(lock.descriptor);
  try {
    const owner = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: unknown };
    if (owner.token === lock.token) unlinkSync(lock.path);
  } catch {
    // Never delete an unverified replacement lock.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    return code === "EPERM";
  }
}

function migrationDefinitions(): MigrationDefinition[] {
  return readdirSync(__dirname)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sqlText = readFileSync(join(__dirname, name), "utf8");
      return {
        name,
        format: Number.parseInt(name.slice(0, 4), 10),
        sqlText,
        checksum: sha256Bytes(sqlText),
      };
    });
}

function assertDefinitionEnvelope(definitions: MigrationDefinition[]): void {
  if (definitions.length !== STORE_FORMAT_COMPATIBILITY.current + 1) {
    throw new Error("Store format constant does not match bundled migration count");
  }
  for (const [index, definition] of definitions.entries()) {
    if (definition.format !== index) throw new Error(`Migration sequence is not contiguous at ${definition.name}`);
  }
}

async function inspectMigrationState(
  client: Client,
  definitions: MigrationDefinition[],
): Promise<{ applied: Map<string, string | null>; format: number | null; existingStore: boolean }> {
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tableNames = tables.rows.map((row) => String(row["name"]));
  if (!tableNames.includes("_migration")) {
    if (tableNames.length > 0) {
      throw new StoreCompatibilityError(
        "store_format_unrecognized",
        "Store contains tables but no Tasq migration history; refusing to modify it",
        null,
      );
    }
    return { applied: new Map(), format: null, existingStore: false };
  }

  const columns = await client.execute("PRAGMA table_info('_migration')");
  const columnNames = new Set(columns.rows.map((row) => String(row["name"])));
  if (!columnNames.has("name") || !columnNames.has("applied_at")) {
    throw new StoreCompatibilityError(
      "store_format_unrecognized",
      "Tasq migration history has an unsupported shape; refusing to modify it",
      null,
    );
  }
  const rows = await client.execute(columnNames.has("checksum")
    ? "SELECT name, checksum FROM _migration ORDER BY name"
    : "SELECT name, NULL AS checksum FROM _migration ORDER BY name");
  const applied = new Map<string, string | null>();
  for (const row of rows.rows) {
    const name = String(row["name"]);
    if (applied.has(name)) {
      throw new StoreCompatibilityError(
        "store_migration_history_partial",
        `Duplicate applied migration identity: ${name}`,
        null,
      );
    }
    applied.set(name, row["checksum"] == null ? null : String(row["checksum"]));
  }
  if (applied.size === 0) {
    throw new StoreCompatibilityError(
      "store_migration_history_partial",
      "Existing Tasq migration table is empty; refusing ambiguous initialization",
      null,
    );
  }

  const known = new Map(definitions.map((definition) => [definition.name, definition]));
  let highest = -1;
  for (const [name, recorded] of applied) {
    const definition = known.get(name);
    if (!definition) {
      const parsed = /^([0-9]{4})_/.exec(name);
      const detected = parsed ? Number.parseInt(parsed[1]!, 10) : null;
      const newer = detected != null && detected > STORE_FORMAT_COMPATIBILITY.current;
      throw new StoreCompatibilityError(
        newer ? "store_format_newer_than_executable" : "store_format_unrecognized",
        newer
          ? `Store format ${detected} is newer than this executable's maximum ${STORE_FORMAT_COMPATIBILITY.readable.max}`
          : `Applied migration is missing from this executable: ${name}`,
        detected,
      );
    }
    if (recorded != null && recorded !== definition.checksum) {
      throw new StoreCompatibilityError(
        "store_migration_checksum_drift",
        `Migration checksum mismatch for ${name}; applied migrations are immutable`,
        definition.format,
      );
    }
    highest = Math.max(highest, definition.format);
  }
  for (let format = 0; format <= highest; format++) {
    const expected = definitions[format]!;
    if (!applied.has(expected.name)) {
      throw new StoreCompatibilityError(
        "store_migration_history_partial",
        `Migration history is non-contiguous: ${expected.name} is missing before format ${highest}`,
        highest,
      );
    }
  }
  return { applied, format: highest, existingStore: true };
}

async function createVerifiedRecoveryPoint(
  client: Client,
  sourceFormat: number,
  pending: MigrationDefinition[],
  now: number,
): Promise<{ document: ReceiptDocument; path: string }> {
  const databases = await client.execute("PRAGMA database_list");
  const main = databases.rows.find((row) => row["name"] === "main");
  const sourcePath = typeof main?.["file"] === "string" ? resolve(main["file"]) : "";
  if (!sourcePath || sourcePath === ":memory:") {
    throw new Error("Existing stores require a filesystem path for verified pre-migration recovery");
  }
  const recoveryDir = `${sourcePath}.tasq-migrations`;
  mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  chmodSync(recoveryDir, 0o700);
  const id = `${now}-${randomUUID()}`;
  const snapshotPath = join(recoveryDir, `${basename(sourcePath)}.format-${sourceFormat}.${id}.sqlite`);
  try {
    await client.execute({ sql: "VACUUM INTO ?", args: [snapshotPath] });
  } catch (error) {
    // A quota/device failure may leave a partial SQLite file. It is never a
    // recovery point and gets no receipt, but keep it private for diagnosis.
    if (existsSync(snapshotPath)) chmodSync(snapshotPath, 0o600);
    throw error;
  }
  chmodSync(snapshotPath, 0o600);
  const verification = await verifyDatabaseFile(snapshotPath);
  if (!verification.ok) {
    throw new Error(
      `Pre-migration snapshot verification failed: integrity=${verification.integrity}, foreignKeys=${verification.foreignKeyViolations}`,
    );
  }
  const document: ReceiptDocument = {
    contractVersion: "tasq.migration-receipt.v1",
    id,
    status: "snapshot_verified",
    startedAt: now,
    completedAt: null,
    source: {
      pathIdentity: `sha256:${sha256Bytes(sourcePath)}`,
      format: sourceFormat,
      eventCursor: verification.eventCursor,
    },
    target: { format: STORE_FORMAT_COMPATIBILITY.current },
    migrations: pending.map(({ name, checksum }) => ({ name, sha256: checksum })),
    snapshot: {
      path: snapshotPath,
      sha256: sha256File(snapshotPath),
      sizeBytes: statSync(snapshotPath).size,
      verification,
    },
    postVerification: null,
    failure: null,
    recoveredAfterRestart: false,
    restoreRule: STORE_FORMAT_COMPATIBILITY.rollback,
  };
  const receiptPath = join(recoveryDir, `receipt-${id}.json`);
  writeReceipt(receiptPath, document);
  return { document, path: receiptPath };
}

/** Reconcile a crash that left a durable snapshot receipt pending. */
async function recoverPendingReceipts(
  client: Client,
  detectedFormat: number,
  options: MigrationOptions,
  now: number,
): Promise<MigrationReceiptSummary | null> {
  const sourcePath = await mainDatabasePath(client);
  const recoveryDir = `${sourcePath}.tasq-migrations`;
  if (!existsSync(recoveryDir)) return null;
  const pending = readdirSync(recoveryDir)
    .filter((name) => /^receipt-.+\.json$/.test(name))
    .sort()
    .map((name) => {
      const path = join(recoveryDir, name);
      let document: ReceiptDocument;
      try {
        document = JSON.parse(readFileSync(path, "utf8")) as ReceiptDocument;
      } catch {
        throw new Error(`Migration receipt is unreadable: ${path}`);
      }
      return { path, document };
    })
    .filter(({ document }) => document.status === "snapshot_verified");
  if (pending.length === 0) return null;

  let recovered: MigrationReceiptSummary | null = null;
  for (const state of pending) {
    const { document } = state;
    const snapshotPath = resolve(document.snapshot?.path ?? "");
    const snapshotInsideRecoveryDir = dirname(snapshotPath) === resolve(recoveryDir);
    const envelopeValid =
      document.contractVersion === "tasq.migration-receipt.v1" &&
      document.source?.pathIdentity === `sha256:${sha256Bytes(sourcePath)}` &&
      document.target?.format === STORE_FORMAT_COMPATIBILITY.current &&
      snapshotInsideRecoveryDir &&
      existsSync(snapshotPath) &&
      statSync(snapshotPath).size === document.snapshot.sizeBytes &&
      sha256File(snapshotPath) === document.snapshot.sha256;
    const snapshotVerification = envelopeValid
      ? await verifyDatabaseFile(snapshotPath)
      : null;
    if (!envelopeValid || !snapshotVerification?.ok) {
      document.status = "failed";
      document.completedAt = now;
      document.failure = "Pending migration receipt has an invalid or corrupt recovery snapshot";
      document.recoveredAfterRestart = true;
      writeReceipt(state.path, document);
      throw new MigrationSafetyError(document.failure, receiptSummary(state.path, document));
    }

    if (detectedFormat === document.source.format) {
      document.status = "failed";
      document.completedAt = now;
      document.failure = "Process stopped before schema commit; source store remained unchanged";
      document.recoveredAfterRestart = true;
      writeReceipt(state.path, document);
      continue;
    }
    if (detectedFormat !== document.target.format) {
      document.status = "failed";
      document.completedAt = now;
      document.failure = `Interrupted migration has unexpected store format ${detectedFormat}`;
      document.recoveredAfterRestart = true;
      writeReceipt(state.path, document);
      throw new MigrationSafetyError(document.failure, receiptSummary(state.path, document));
    }

    const database = await verifyLiveDatabase(client);
    const service = options.postMigrationCheck
      ? await options.postMigrationCheck()
      : { ok: true, issues: [] };
    if (!database.ok || !service.ok) {
      document.status = "failed";
      document.completedAt = now;
      document.failure = `Restart verification failed: integrity=${database.integrity}, serviceIssues=${service.issues.length}`;
      document.recoveredAfterRestart = true;
      writeReceipt(state.path, document);
      throw new MigrationSafetyError(document.failure, receiptSummary(state.path, document));
    }
    document.postVerification = {
      database,
      schemaFormat: detectedFormat,
      service,
    };
    document.status = "complete";
    document.completedAt = now;
    document.recoveredAfterRestart = true;
    writeReceipt(state.path, document);
    recovered = receiptSummary(state.path, document);
  }
  return recovered;
}

async function mainDatabasePath(client: Client): Promise<string> {
  const databases = await client.execute("PRAGMA database_list");
  const main = databases.rows.find((row) => row["name"] === "main");
  const sourcePath = typeof main?.["file"] === "string" ? resolve(main["file"]) : "";
  if (!sourcePath || sourcePath === ":memory:") {
    throw new Error("Existing stores require a filesystem path for verified migration recovery");
  }
  return sourcePath;
}

async function verifyLiveDatabase(client: Client): Promise<DatabaseVerification> {
  const integrity = await client.execute("PRAGMA integrity_check");
  const foreignKeys = await client.execute("PRAGMA foreign_key_check");
  const eventColumns = await client.execute("PRAGMA table_info('event')");
  const hasSequence = eventColumns.rows.some((row) => row["name"] === "sequence");
  return {
    ok: String(integrity.rows[0]?.["integrity_check"] ?? "unknown") === "ok" && foreignKeys.rows.length === 0,
    integrity: String(integrity.rows[0]?.["integrity_check"] ?? "unknown"),
    foreignKeyViolations: foreignKeys.rows.length,
    eventCursor: hasSequence
      ? Number((await client.execute("SELECT coalesce(max(sequence), 0) AS cursor FROM event")).rows[0]?.["cursor"] ?? 0)
      : null,
  };
}

function receiptSummary(path: string, document: ReceiptDocument): MigrationReceiptSummary {
  return {
    id: document.id,
    path,
    status: document.status === "snapshot_verified" ? "failed" : document.status,
    snapshotPath: document.snapshot.path,
    snapshotSha256: document.snapshot.sha256,
    sourceFormat: document.source.format,
    targetFormat: document.target.format,
  };
}

function failReceipt(
  state: { document: ReceiptDocument; path: string },
  error: unknown,
  now: number,
): void {
  state.document.status = "failed";
  state.document.completedAt = now;
  state.document.failure = error instanceof Error ? error.message : String(error);
  writeReceipt(state.path, state.document);
}

function writeReceipt(path: string, document: ReceiptDocument): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  const descriptor = openSync(temporary, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Split top-level SQL statements while retaining CREATE TRIGGER bodies. */
function splitSql(text: string): string[] {
  const out: string[] = [];
  let buffer = "";
  let inLineComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index] as string;
    const next = (index + 1 < text.length ? text[index + 1] : "") as string;
    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        buffer += "\n";
      }
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === "-" && next === "-") {
      inLineComment = true;
      index++;
      continue;
    }
    if (!inDoubleQuote && character === "'") {
      inSingleQuote = !inSingleQuote;
      buffer += character;
      continue;
    }
    if (!inSingleQuote && character === '"') {
      inDoubleQuote = !inDoubleQuote;
      buffer += character;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === ";") {
      const candidate = buffer.trim();
      const trigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(candidate);
      if (trigger && !/\bEND\s*$/i.test(candidate)) {
        buffer += character;
        continue;
      }
      out.push(candidate);
      buffer = "";
      continue;
    }
    buffer += character;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}
