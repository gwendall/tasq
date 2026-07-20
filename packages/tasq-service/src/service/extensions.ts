/** Immutable universal extension registry and bundled reference bootstrap. */

import { and, asc, eq } from "drizzle-orm";
import type { Client } from "@libsql/client";
import {
  extensionEvaluator,
  extensionRelease,
  extensionType,
  ExtensionEvaluatorRegistration as ExtensionEvaluatorZ,
  ExtensionRecordKind,
  ExtensionRelease as ExtensionReleaseZ,
  ExtensionTypeRegistration as ExtensionTypeZ,
  Sha256Digest,
  uuidv7,
  type ExtensionEvaluatorRegistration,
  type ExtensionManifest,
  type ExtensionRelease,
  type ExtensionTypeRegistration,
  type Clock,
} from "@tasq/schema";
import { REFERENCE_EXTENSION_MANIFEST } from "@tasq-internal/reference-extension";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";

export { canonicalJson, sha256Digest } from "../util/canonical-json.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_REGISTRATIONS = 256;

export interface InstallExtensionOptions {
  tenantId?: string;
  actor?: string;
  now?: number;
  clock?: Clock;
}

export interface InstalledExtension {
  release: ExtensionRelease;
  types: ExtensionTypeRegistration[];
  evaluators: ExtensionEvaluatorRegistration[];
}

interface PreparedType {
  recordKind: ExtensionTypeRegistration["recordKind"];
  typeUri: string;
  schemaVersion: number;
  schema: Record<string, unknown>;
  schemaJson: string;
  schemaDigest: string;
}

interface PreparedEvaluator {
  evaluatorUri: string;
  evaluatorVersion: number;
  conditionTypeUri: string;
  conditionSchemaVersion: number;
  acceptedObservationTypes: Array<{ typeUri: string; schemaVersion: number }>;
  acceptedObservationTypesJson: string;
  implementationDigest: string;
}

interface PreparedManifest {
  manifest: ExtensionManifest;
  manifestJson: string;
  manifestDigest: string;
  types: PreparedType[];
  evaluators: PreparedEvaluator[];
}

export function prepareExtensionManifest(input: unknown): PreparedManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Extension manifest must be an object");
  }
  const raw = input as Partial<ExtensionManifest>;
  const extensionUri = requireHttpsUri(raw.extensionUri, "extensionUri");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) {
    throw new Error("Extension version must be valid SemVer");
  }
  if (!Array.isArray(raw.types) || raw.types.length > MAX_REGISTRATIONS) {
    throw new Error(`Extension types must contain at most ${MAX_REGISTRATIONS} registrations`);
  }
  if (!Array.isArray(raw.evaluators) || raw.evaluators.length > MAX_REGISTRATIONS) {
    throw new Error(`Extension evaluators must contain at most ${MAX_REGISTRATIONS} registrations`);
  }
  if (raw.types.length === 0 && raw.evaluators.length === 0) {
    throw new Error("Extension manifest must register at least one type or evaluator");
  }

  const typeIdentities = new Set<string>();
  const types: PreparedType[] = raw.types.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Extension type ${index} must be an object`);
    }
    const recordKind = ExtensionRecordKind.parse(candidate.recordKind);
    const typeUri = requireHttpsUri(candidate.typeUri, `types[${index}].typeUri`);
    const schemaVersion = positiveInteger(candidate.schemaVersion, `types[${index}].schemaVersion`);
    const identity = `${typeUri}@${schemaVersion}`;
    if (typeIdentities.has(identity)) throw new Error(`Duplicate extension type identity: ${identity}`);
    typeIdentities.add(identity);
    const schema = requireJsonSchema(candidate.schema, `types[${index}].schema`);
    const schemaJson = canonicalJson(schema);
    return {
      recordKind,
      typeUri,
      schemaVersion,
      schema,
      schemaJson,
      schemaDigest: sha256Digest(schemaJson),
    };
  });

  const evaluatorIdentities = new Set<string>();
  const evaluators: PreparedEvaluator[] = raw.evaluators.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Extension evaluator ${index} must be an object`);
    }
    const evaluatorUri = requireHttpsUri(candidate.evaluatorUri, `evaluators[${index}].evaluatorUri`);
    const evaluatorVersion = positiveInteger(
      candidate.evaluatorVersion,
      `evaluators[${index}].evaluatorVersion`,
    );
    const evaluatorIdentity = `${evaluatorUri}@${evaluatorVersion}`;
    if (evaluatorIdentities.has(evaluatorIdentity)) {
      throw new Error(`Duplicate evaluator identity: ${evaluatorIdentity}`);
    }
    evaluatorIdentities.add(evaluatorIdentity);

    const conditionTypeUri = requireHttpsUri(
      candidate.conditionTypeUri,
      `evaluators[${index}].conditionTypeUri`,
    );
    const conditionSchemaVersion = positiveInteger(
      candidate.conditionSchemaVersion,
      `evaluators[${index}].conditionSchemaVersion`,
    );
    const conditionIdentity = `${conditionTypeUri}@${conditionSchemaVersion}`;
    if (!Array.isArray(candidate.acceptedObservationTypes) || candidate.acceptedObservationTypes.length === 0) {
      throw new Error(`Evaluator ${evaluatorIdentity} requires accepted observation types`);
    }
    const acceptedIdentities = new Set<string>();
    const acceptedObservationTypes = candidate.acceptedObservationTypes.map((accepted, acceptedIndex) => {
      const typeUri = requireHttpsUri(
        accepted?.typeUri,
        `evaluators[${index}].acceptedObservationTypes[${acceptedIndex}].typeUri`,
      );
      const schemaVersion = positiveInteger(
        accepted?.schemaVersion,
        `evaluators[${index}].acceptedObservationTypes[${acceptedIndex}].schemaVersion`,
      );
      const identity = `${typeUri}@${schemaVersion}`;
      if (acceptedIdentities.has(identity)) {
        throw new Error(`Duplicate accepted observation type: ${identity}`);
      }
      acceptedIdentities.add(identity);
      return { typeUri, schemaVersion };
    });
    const implementationDigest = Sha256Digest.parse(candidate.implementationDigest);
    return {
      evaluatorUri,
      evaluatorVersion,
      conditionTypeUri,
      conditionSchemaVersion,
      acceptedObservationTypes,
      acceptedObservationTypesJson: canonicalJson(acceptedObservationTypes),
      implementationDigest,
    };
  });

  const manifest = JSON.parse(canonicalJson({
    extensionUri,
    version: raw.version,
    types: types.map(({ recordKind, typeUri, schemaVersion, schema }) => ({
      recordKind,
      typeUri,
      schemaVersion,
      schema,
    })),
    evaluators: evaluators.map((evaluator) => ({
      evaluatorUri: evaluator.evaluatorUri,
      evaluatorVersion: evaluator.evaluatorVersion,
      conditionTypeUri: evaluator.conditionTypeUri,
      conditionSchemaVersion: evaluator.conditionSchemaVersion,
      acceptedObservationTypes: evaluator.acceptedObservationTypes,
      implementationDigest: evaluator.implementationDigest,
    })),
  })) as ExtensionManifest;
  const manifestJson = canonicalJson(manifest);
  if (Buffer.byteLength(manifestJson, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error(`Extension manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  return {
    manifest,
    manifestJson,
    manifestDigest: sha256Digest(manifestJson),
    types,
    evaluators,
  };
}

/** Administrative install; identical retries return the existing release. */
export async function installExtension(
  db: TasqDb,
  input: unknown,
  options: InstallExtensionOptions = {},
): Promise<InstalledExtension> {
  const prepared = prepareExtensionManifest(input);
  const tenantId = options.tenantId ?? "gwendall";
  const installedBy = options.actor ?? "system";
  const now = serviceNow(options, options.now);
  if (!tenantId.trim() || !installedBy.trim()) throw new Error("Extension tenant and actor are required");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Extension install time is invalid");

  return runInTransaction(db, async (tx) => {
    const prior = await getExtensionReleaseByIdentity(
      tx,
      prepared.manifest.extensionUri,
      prepared.manifest.version,
      tenantId,
    );
    if (prior) {
      if (prior.manifestDigest !== prepared.manifestDigest) {
        throw new Error(
          `Extension release identity reused with different manifest: ${prepared.manifest.extensionUri}@${prepared.manifest.version}`,
        );
      }
      return inspectInstalledExtension(tx, prior);
    }

    await assertNoRegistrationConflicts(tx, prepared, tenantId);
    await assertEvaluatorReferences(tx, prepared, tenantId);
    const releaseId = uuidv7(now);
    await tx.insert(extensionRelease).values({
      id: releaseId,
      tenantId,
      extensionUri: prepared.manifest.extensionUri,
      version: prepared.manifest.version,
      manifestJson: prepared.manifestJson,
      manifestDigest: prepared.manifestDigest,
      installedAt: now,
      installedBy,
    });
    for (const type of prepared.types) {
      await tx.insert(extensionType).values({
        id: uuidv7(now),
        tenantId,
        extensionReleaseId: releaseId,
        recordKind: type.recordKind,
        typeUri: type.typeUri,
        schemaVersion: type.schemaVersion,
        schemaJson: type.schemaJson,
        schemaDigest: type.schemaDigest,
        createdAt: now,
      });
    }
    for (const evaluator of prepared.evaluators) {
      await tx.insert(extensionEvaluator).values({
        id: uuidv7(now),
        tenantId,
        extensionReleaseId: releaseId,
        evaluatorUri: evaluator.evaluatorUri,
        evaluatorVersion: evaluator.evaluatorVersion,
        conditionTypeUri: evaluator.conditionTypeUri,
        conditionSchemaVersion: evaluator.conditionSchemaVersion,
        acceptedObservationTypes: evaluator.acceptedObservationTypesJson,
        implementationDigest: evaluator.implementationDigest,
        createdAt: now,
      });
    }
    const release = await getExtensionReleaseByIdentity(
      tx,
      prepared.manifest.extensionUri,
      prepared.manifest.version,
      tenantId,
    );
    if (!release) throw new Error("Failed to read back extension release");
    return inspectInstalledExtension(tx, release);
  });
}

export async function listExtensionReleases(
  db: TasqDb,
  tenantId = "gwendall",
): Promise<ExtensionRelease[]> {
  const rows = await db.select().from(extensionRelease)
    .where(eq(extensionRelease.tenantId, tenantId))
    .orderBy(asc(extensionRelease.extensionUri), asc(extensionRelease.version));
  return rows.map(parseRelease);
}

/** Bundled v1 compatibility provisioning for a workspace, idempotent on reads. */
export async function ensureBundledReferenceExtension(
  db: TasqDb,
  options: InstallExtensionOptions = {},
): Promise<InstalledExtension> {
  const tenantId = options.tenantId ?? "gwendall";
  const prepared = prepareExtensionManifest(REFERENCE_EXTENSION_MANIFEST);
  const prior = await getExtensionReleaseByIdentity(
    db,
    prepared.manifest.extensionUri,
    prepared.manifest.version,
    tenantId,
  );
  if (prior) {
    if (prior.manifestDigest !== prepared.manifestDigest) {
      throw new Error("Bundled reference extension identity conflicts with installed manifest");
    }
    return inspectInstalledExtension(db, prior);
  }
  return installExtension(db, REFERENCE_EXTENSION_MANIFEST, options);
}

/** Hot-path compatibility guard without materializing every child registration. */
export async function ensureBundledReferenceExtensionAvailable(
  db: TasqDb,
  options: InstallExtensionOptions = {},
): Promise<void> {
  const tenantId = options.tenantId ?? "gwendall";
  const prepared = prepareExtensionManifest(REFERENCE_EXTENSION_MANIFEST);
  const prior = await getExtensionReleaseByIdentity(
    db,
    prepared.manifest.extensionUri,
    prepared.manifest.version,
    tenantId,
  );
  if (!prior) {
    await installExtension(db, REFERENCE_EXTENSION_MANIFEST, options);
    return;
  }
  if (prior.manifestDigest !== prepared.manifestDigest) {
    throw new Error("Bundled reference extension identity conflicts with installed manifest");
  }
}

export async function getExtensionTypeRegistration(
  db: TasqDbOrTx,
  typeUri: string,
  schemaVersion: number,
  tenantId = "gwendall",
): Promise<ExtensionTypeRegistration | null> {
  const rows = await db.select().from(extensionType).where(and(
    eq(extensionType.tenantId, tenantId),
    eq(extensionType.typeUri, typeUri),
    eq(extensionType.schemaVersion, schemaVersion),
  )).limit(1);
  return rows[0] ? parseType(rows[0]) : null;
}

export async function getExtensionEvaluatorRegistration(
  db: TasqDbOrTx,
  evaluatorUri: string,
  evaluatorVersion: number,
  tenantId = "gwendall",
): Promise<ExtensionEvaluatorRegistration | null> {
  const rows = await db.select().from(extensionEvaluator).where(and(
    eq(extensionEvaluator.tenantId, tenantId),
    eq(extensionEvaluator.evaluatorUri, evaluatorUri),
    eq(extensionEvaluator.evaluatorVersion, evaluatorVersion),
  )).limit(1);
  return rows[0] ? parseEvaluator(rows[0]) : null;
}

/** Ensure every migrated workspace has the bundled five-domain release. */
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
      args: [
        releaseId,
        tenantId,
        prepared.manifest.extensionUri,
        prepared.manifest.version,
        prepared.manifestJson,
        prepared.manifestDigest,
        now,
        "system:reference-extension-bootstrap",
      ],
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

async function getExtensionReleaseByIdentity(
  db: TasqDbOrTx,
  extensionUri: string,
  version: string,
  tenantId: string,
): Promise<ExtensionRelease | null> {
  const rows = await db.select().from(extensionRelease).where(and(
    eq(extensionRelease.tenantId, tenantId),
    eq(extensionRelease.extensionUri, extensionUri),
    eq(extensionRelease.version, version),
  )).limit(1);
  return rows[0] ? parseRelease(rows[0]) : null;
}

async function inspectInstalledExtension(
  db: TasqDbOrTx,
  release: ExtensionRelease,
): Promise<InstalledExtension> {
  const [types, evaluators] = await Promise.all([
    db.select().from(extensionType).where(and(
      eq(extensionType.tenantId, release.tenantId),
      eq(extensionType.extensionReleaseId, release.id),
    )).orderBy(asc(extensionType.typeUri), asc(extensionType.schemaVersion)),
    db.select().from(extensionEvaluator).where(and(
      eq(extensionEvaluator.tenantId, release.tenantId),
      eq(extensionEvaluator.extensionReleaseId, release.id),
    )).orderBy(asc(extensionEvaluator.evaluatorUri), asc(extensionEvaluator.evaluatorVersion)),
  ]);
  return { release, types: types.map(parseType), evaluators: evaluators.map(parseEvaluator) };
}

async function assertNoRegistrationConflicts(
  db: TasqDbOrTx,
  prepared: PreparedManifest,
  tenantId: string,
): Promise<void> {
  for (const type of prepared.types) {
    const existing = await getExtensionTypeRegistration(db, type.typeUri, type.schemaVersion, tenantId);
    if (existing) throw new Error(`Extension type identity already registered: ${type.typeUri}@${type.schemaVersion}`);
  }
  for (const evaluator of prepared.evaluators) {
    const existing = await getExtensionEvaluatorRegistration(
      db,
      evaluator.evaluatorUri,
      evaluator.evaluatorVersion,
      tenantId,
    );
    if (existing) {
      throw new Error(
        `Extension evaluator identity already registered: ${evaluator.evaluatorUri}@${evaluator.evaluatorVersion}`,
      );
    }
  }
}

async function assertEvaluatorReferences(
  db: TasqDbOrTx,
  prepared: PreparedManifest,
  tenantId: string,
): Promise<void> {
  const localTypes = new Map(prepared.types.map((type) => [
    `${type.typeUri}@${type.schemaVersion}`,
    type.recordKind,
  ]));
  const requireType = async (
    typeUri: string,
    schemaVersion: number,
    expectedKind: "condition" | "observation",
    label: string,
  ): Promise<void> => {
    const identity = `${typeUri}@${schemaVersion}`;
    const localKind = localTypes.get(identity);
    if (localKind) {
      if (localKind !== expectedKind) {
        throw new Error(`${label} has record kind ${localKind}, expected ${expectedKind}: ${identity}`);
      }
      return;
    }
    const installed = await getExtensionTypeRegistration(db, typeUri, schemaVersion, tenantId);
    if (!installed || installed.recordKind !== expectedKind) {
      throw new Error(`${label} is not registered in this workspace: ${identity}`);
    }
  };

  for (const evaluator of prepared.evaluators) {
    await requireType(
      evaluator.conditionTypeUri,
      evaluator.conditionSchemaVersion,
      "condition",
      "Evaluator condition type",
    );
    for (const accepted of evaluator.acceptedObservationTypes) {
      await requireType(
        accepted.typeUri,
        accepted.schemaVersion,
        "observation",
        "Accepted observation type",
      );
    }
  }
}

function parseRelease(row: typeof extensionRelease.$inferSelect): ExtensionRelease {
  return ExtensionReleaseZ.parse({ ...row, manifest: JSON.parse(row.manifestJson) });
}

function parseType(row: typeof extensionType.$inferSelect): ExtensionTypeRegistration {
  return ExtensionTypeZ.parse({ ...row, schema: JSON.parse(row.schemaJson) });
}

function parseEvaluator(row: typeof extensionEvaluator.$inferSelect): ExtensionEvaluatorRegistration {
  return ExtensionEvaluatorZ.parse({
    ...row,
    acceptedObservationTypes: JSON.parse(row.acceptedObservationTypes),
  });
}

function requireHttpsUri(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an absolute HTTPS URI`);
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URI`);
  }
  if (uri.protocol !== "https:" || !uri.hostname) {
    throw new Error(`${label} must be an absolute HTTPS URI`);
  }
  return uri.toString();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireJsonSchema(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  const schema = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  if (schema.$schema !== JSON_SCHEMA_DIALECT || schema.type !== "object") {
    throw new Error(`${label} must declare JSON Schema Draft 2020-12 and type object`);
  }
  const serialized = canonicalJson(schema);
  if (/"\$ref":"https?:/i.test(serialized)) {
    throw new Error(`${label} must not contain a network JSON Schema reference`);
  }
  return schema;
}
