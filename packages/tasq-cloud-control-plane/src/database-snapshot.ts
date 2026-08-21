import { createHash } from "node:crypto";
import { chmod, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { z } from "zod";
import {
  cloudControlPlaneDatabase,
  type CloudControlPlaneDatabase,
} from "./index.js";

export const CLOUD_DATABASE_SNAPSHOT_VERSION =
  "tasq.cloud-database-snapshot.v1" as const;

const ProviderRef = z.string().regex(/^urn:tasq-provider:[A-Za-z0-9._:-]{1,400}$/);
const ObservedAt = z.string().datetime({ offset: true });

export interface CloudDatabaseTableFingerprint {
  rows: number;
  schemaDigest: `sha256:${string}`;
  contentDigest: `sha256:${string}`;
}

export interface CloudDatabaseMigrationReceipt {
  contractVersion: "tasq.cloud-database-migration.v1";
  observedAt: string;
  sourceRef: string;
  targetRef: string;
  status: "passed";
  tables: Record<string, CloudDatabaseTableFingerprint>;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalCell(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value instanceof ArrayBuffer) {
    return `base64:${Buffer.from(value).toString("base64")}`;
  }
  if (value instanceof Uint8Array) {
    return `base64:${Buffer.from(value).toString("base64")}`;
  }
  throw new Error("unsupported cloud database value in fingerprint");
}

export async function fingerprintCloudDatabase(
  input: CloudControlPlaneDatabase,
): Promise<Record<string, CloudDatabaseTableFingerprint>> {
  const database = cloudControlPlaneDatabase(input);
  const client = createClient(database);
  try {
    const tables = await client.execute(
      "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name LIKE 'cloud_%' ORDER BY name",
    );
    const fingerprints: Record<string, CloudDatabaseTableFingerprint> = {};
    for (const row of tables.rows) {
      const name = String(row["name"]);
      if (!/^cloud_[a-z_]+$/.test(name)) throw new Error("unexpected cloud table name");
      const columns = await client.execute(`PRAGMA table_info("${name}")`);
      const columnNames = columns.rows.map((column) => String(column["name"]));
      if (columnNames.length === 0 || columnNames.some((column) => !/^[a-z_]+$/.test(column))) {
        throw new Error("unexpected cloud column name");
      }
      const primaryKey = columns.rows
        .map((column) => ({ name: String(column["name"]), order: Number(column["pk"]) }))
        .filter((column) => column.order > 0)
        .sort((left, right) => left.order - right.order)
        .map((column) => column.name);
      if (primaryKey.length === 0) throw new Error("cloud table has no primary key");
      const ordered = await client.execute(
        `SELECT * FROM "${name}" ORDER BY ${primaryKey.map((column) => `"${column}"`).join(",")}`,
      );
      const content = ordered.rows.map((entry) =>
        JSON.stringify(Object.fromEntries(columnNames.map((column) => [
          column,
          canonicalCell(entry[column]),
        ])))
      ).join("\n");
      fingerprints[name] = {
        rows: ordered.rows.length,
        schemaDigest: digest(String(row["sql"])),
        contentDigest: digest(content),
      };
    }
    return fingerprints;
  } finally {
    client.close();
  }
}

export async function verifyCloudDatabaseMigration(input: {
  source: CloudControlPlaneDatabase;
  target: CloudControlPlaneDatabase;
  observedAt: string;
  sourceRef: string;
  targetRef: string;
}): Promise<CloudDatabaseMigrationReceipt> {
  const observedAt = ObservedAt.parse(input.observedAt);
  const sourceRef = ProviderRef.parse(input.sourceRef);
  const targetRef = ProviderRef.parse(input.targetRef);
  if (sourceRef === targetRef) throw new Error("cloud migration source and target must differ");
  const source = await fingerprintCloudDatabase(input.source);
  const target = await fingerprintCloudDatabase(input.target);
  if (JSON.stringify(source) !== JSON.stringify(target)) {
    throw new Error("cloud database migration contents do not match source snapshot");
  }
  return {
    contractVersion: "tasq.cloud-database-migration.v1",
    observedAt,
    sourceRef,
    targetRef,
    status: "passed",
    tables: target,
  };
}

export async function snapshotLocalCloudDatabase(input: {
  sourceUrl: string;
  destination: string;
  observedAt: string;
  sourceRef: string;
}): Promise<{
  contractVersion: typeof CLOUD_DATABASE_SNAPSHOT_VERSION;
  observedAt: string;
  sourceRef: string;
  snapshotFile: string;
  sha256: `sha256:${string}`;
  bytes: number;
  integrity: "ok";
  foreignKeyViolations: 0;
  tables: Record<string, CloudDatabaseTableFingerprint>;
}> {
  const source = cloudControlPlaneDatabase({ url: input.sourceUrl });
  if (!source.url.startsWith("file:")) {
    throw new Error("cloud migration snapshot source must be a local file database");
  }
  const observedAt = ObservedAt.parse(input.observedAt);
  const sourceRef = ProviderRef.parse(input.sourceRef);
  const destinationInput = input.destination.trim();
  if (!destinationInput) throw new Error("cloud migration snapshot destination is required");
  const destination = resolve(destinationInput);
  const sourcePath = resolve(fileURLToPath(new URL(source.url)));
  if (sourcePath === destination) throw new Error("cloud migration snapshot must not overwrite its source");

  const sourceFingerprint = await fingerprintCloudDatabase(source);
  const client = createClient(source);
  try {
    await client.execute("PRAGMA busy_timeout = 30000");
    await client.execute("PRAGMA wal_checkpoint(PASSIVE)");
    await client.execute({ sql: "VACUUM INTO ?", args: [destination] });
  } finally {
    client.close();
  }
  await chmod(destination, 0o600);

  const snapshotUrl = pathToFileURL(destination).href;
  const verification = createClient({ url: snapshotUrl });
  let integrity = "";
  let foreignKeyViolations = -1;
  try {
    const checked = await verification.execute("PRAGMA integrity_check");
    integrity = String(checked.rows[0]?.["integrity_check"] ?? "");
    const foreignKeys = await verification.execute("PRAGMA foreign_key_check");
    foreignKeyViolations = foreignKeys.rows.length;
  } finally {
    verification.close();
  }
  if (integrity !== "ok" || foreignKeyViolations !== 0) {
    throw new Error("cloud migration snapshot failed SQLite verification");
  }
  const snapshotFingerprint = await fingerprintCloudDatabase({ url: snapshotUrl });
  if (JSON.stringify(snapshotFingerprint) !== JSON.stringify(sourceFingerprint)) {
    throw new Error("cloud migration snapshot contents do not match source");
  }
  const content = await readFile(destination);
  const metadata = await stat(destination);
  return {
    contractVersion: CLOUD_DATABASE_SNAPSHOT_VERSION,
    observedAt,
    sourceRef,
    snapshotFile: basename(destination),
    sha256: digestBytes(content),
    bytes: metadata.size,
    integrity: "ok",
    foreignKeyViolations: 0,
    tables: snapshotFingerprint,
  };
}

if (import.meta.main) {
  const [destination, observedAt, sourceRef] = process.argv.slice(2);
  if (!destination || !observedAt || !sourceRef) {
    throw new Error(
      "usage: database-snapshot.ts <destination> <observed-at-rfc3339> <opaque-source-ref>",
    );
  }
  const dataDir = process.env.TASQ_CLOUD_DATA_DIR ?? "/data";
  const receipt = await snapshotLocalCloudDatabase({
    sourceUrl: process.env.TASQ_CLOUD_DATABASE_URL?.trim() ||
      `file:${dataDir}/control.sqlite`,
    destination,
    observedAt,
    sourceRef,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
