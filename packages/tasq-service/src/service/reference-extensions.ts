/** Bundled compatibility provisioning around the neutral Core registry. */

import type { Client } from "@libsql/client";
import { uuidv7 } from "@tasq/schema";
import { REFERENCE_EXTENSION_MANIFEST } from "@tasq-internal/reference-extension";
import type { TasqDb } from "../db.js";
import { serviceNow } from "../util/clock.js";
import {
  installExtension,
  prepareExtensionManifest,
  type InstallExtensionOptions,
  type InstalledExtension,
  type PreparedManifest,
} from "@tasq/core/internal/service/extensions";

export async function ensureBundledReferenceExtension(
  db: TasqDb,
  options: InstallExtensionOptions = {},
): Promise<InstalledExtension> {
  const tenantId = options.tenantId ?? "gwendall";
  const prepared = prepareExtensionManifest(REFERENCE_EXTENSION_MANIFEST);
  const prior = await db.query.extensionRelease.findFirst({
    where: (release, { and, eq }) => and(
      eq(release.tenantId, tenantId),
      eq(release.extensionUri, prepared.manifest.extensionUri),
      eq(release.version, prepared.manifest.version),
    ),
  });
  if (prior && prior.manifestDigest !== prepared.manifestDigest) {
    throw new Error("Bundled reference extension identity conflicts with installed manifest");
  }
  return installExtension(db, REFERENCE_EXTENSION_MANIFEST, options);
}

export async function ensureBundledReferenceExtensionAvailable(
  db: TasqDb,
  options: InstallExtensionOptions = {},
): Promise<void> {
  const tenantId = options.tenantId ?? "gwendall";
  const prepared = prepareExtensionManifest(REFERENCE_EXTENSION_MANIFEST);
  const prior = await db.query.extensionRelease.findFirst({
    where: (release, { and, eq }) => and(
      eq(release.tenantId, tenantId),
      eq(release.extensionUri, prepared.manifest.extensionUri),
      eq(release.version, prepared.manifest.version),
    ),
  });
  if (!prior) {
    await installExtension(db, REFERENCE_EXTENSION_MANIFEST, options);
    return;
  }
  if (prior.manifestDigest !== prepared.manifestDigest) {
    throw new Error("Bundled reference extension identity conflicts with installed manifest");
  }
}

export async function ensureReferenceExtensionRegistry(
  client: Client,
  tenantIds?: readonly string[],
  options: Pick<InstallExtensionOptions, "clock" | "now"> = {},
): Promise<void> {
  const prepared = prepareExtensionManifest(REFERENCE_EXTENSION_MANIFEST);
  const discovered = tenantIds ?? await discoverTenants(client);
  for (const tenantId of discovered.length > 0 ? discovered : ["gwendall"]) {
    await ensureReferenceTenant(client, tenantId, prepared, serviceNow(options, options.now));
  }
}

async function ensureReferenceTenant(
  client: Client,
  tenantId: string,
  prepared: PreparedManifest,
  now: number,
): Promise<void> {
  const existing = await rawRelease(client, tenantId, prepared);
  if (existing) {
    await verifyRawReferenceChildren(client, tenantId, existing, prepared);
    return;
  }
  await client.execute("BEGIN IMMEDIATE");
  try {
    const raced = await rawRelease(client, tenantId, prepared);
    if (raced) {
      await verifyRawReferenceChildren(client, tenantId, raced, prepared);
      await client.execute("COMMIT");
      return;
    }
    const releaseId = uuidv7(now);
    await client.execute({
      sql: `INSERT INTO extension_release
        (id, tenant_id, extension_uri, version, manifest_json, manifest_digest, installed_at, installed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [releaseId, tenantId, prepared.manifest.extensionUri, prepared.manifest.version,
        prepared.manifestJson, prepared.manifestDigest, now, "system:reference-extension-bootstrap"],
    });
    for (const type of prepared.types) {
      await client.execute({
        sql: `INSERT INTO extension_type
          (id, tenant_id, extension_release_id, record_kind, type_uri, schema_version, schema_json, schema_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [uuidv7(now), tenantId, releaseId, type.recordKind, type.typeUri,
          type.schemaVersion, type.schemaJson, type.schemaDigest, now],
      });
    }
    for (const evaluator of prepared.evaluators) {
      await client.execute({
        sql: `INSERT INTO extension_evaluator
          (id, tenant_id, extension_release_id, evaluator_uri, evaluator_version,
           condition_type_uri, condition_schema_version, accepted_observation_types,
           implementation_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [uuidv7(now), tenantId, releaseId, evaluator.evaluatorUri,
          evaluator.evaluatorVersion, evaluator.conditionTypeUri,
          evaluator.conditionSchemaVersion, evaluator.acceptedObservationTypesJson,
          evaluator.implementationDigest, now],
      });
    }
    await client.execute("COMMIT");
  } catch (error) {
    await client.execute("ROLLBACK");
    throw error;
  }
}

async function discoverTenants(client: Client): Promise<string[]> {
  const rows = await client.execute(`
    SELECT tenant_id FROM task
    UNION SELECT tenant_id FROM wait_condition
    UNION SELECT tenant_id FROM observation
    UNION SELECT tenant_id FROM reconciliation
  `);
  return rows.rows
    .map((row) => String(row["tenant_id"] ?? ""))
    .filter((tenantId) => tenantId.length > 0);
}

async function rawRelease(
  client: Client,
  tenantId: string,
  prepared: PreparedManifest,
): Promise<string | null> {
  const result = await client.execute({
    sql: `SELECT id, manifest_digest FROM extension_release
      WHERE tenant_id = ? AND extension_uri = ? AND version = ? LIMIT 1`,
    args: [tenantId, prepared.manifest.extensionUri, prepared.manifest.version],
  });
  const row = result.rows[0];
  if (!row) return null;
  if (row["manifest_digest"] !== prepared.manifestDigest) {
    throw new Error("Bundled reference extension manifest conflicts with installed identity");
  }
  return String(row["id"]);
}

async function verifyRawReferenceChildren(
  client: Client,
  tenantId: string,
  releaseId: string,
  prepared: PreparedManifest,
): Promise<void> {
  const types = await client.execute({
    sql: `SELECT type_uri, schema_version, schema_digest FROM extension_type
      WHERE tenant_id = ? AND extension_release_id = ?`,
    args: [tenantId, releaseId],
  });
  const actualTypes = new Map(types.rows.map((row) => [
    `${row["type_uri"]}@${row["schema_version"]}`,
    row["schema_digest"],
  ]));
  if (actualTypes.size !== prepared.types.length || prepared.types.some((type) =>
    actualTypes.get(`${type.typeUri}@${type.schemaVersion}`) !== type.schemaDigest)) {
    throw new Error("Bundled reference extension type registry is incomplete or drifted");
  }
  const evaluators = await client.execute({
    sql: `SELECT evaluator_uri, evaluator_version, implementation_digest FROM extension_evaluator
      WHERE tenant_id = ? AND extension_release_id = ?`,
    args: [tenantId, releaseId],
  });
  const actualEvaluators = new Map(evaluators.rows.map((row) => [
    `${row["evaluator_uri"]}@${row["evaluator_version"]}`,
    row["implementation_digest"],
  ]));
  if (actualEvaluators.size !== prepared.evaluators.length || prepared.evaluators.some((evaluator) =>
    actualEvaluators.get(`${evaluator.evaluatorUri}@${evaluator.evaluatorVersion}`) !==
      evaluator.implementationDigest)) {
    throw new Error("Bundled reference extension evaluator registry is incomplete or drifted");
  }
}
