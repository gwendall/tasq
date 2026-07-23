/** Immutable provider-neutral extension registry for embedded kernel consumers. */

import { and, asc, eq } from "drizzle-orm";
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
  type Clock,
  type ExtensionEvaluatorRegistration,
  type ExtensionManifest,
  type ExtensionRelease,
  type ExtensionTypeRegistration,
} from "@tasq-run/schema";
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

export interface PreparedType {
  recordKind: ExtensionTypeRegistration["recordKind"];
  typeUri: string;
  schemaVersion: number;
  schema: Record<string, unknown>;
  schemaJson: string;
  schemaDigest: string;
}

export interface PreparedEvaluator {
  evaluatorUri: string;
  evaluatorVersion: number;
  conditionTypeUri: string;
  conditionSchemaVersion: number;
  acceptedObservationTypes: Array<{ typeUri: string; schemaVersion: number }>;
  acceptedObservationTypesJson: string;
  implementationDigest: string;
}

export interface PreparedManifest {
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
    const evaluatorVersion = positiveInteger(candidate.evaluatorVersion, `evaluators[${index}].evaluatorVersion`);
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
      if (acceptedIdentities.has(identity)) throw new Error(`Duplicate accepted observation type: ${identity}`);
      acceptedIdentities.add(identity);
      return { typeUri, schemaVersion };
    });
    return {
      evaluatorUri,
      evaluatorVersion,
      conditionTypeUri,
      conditionSchemaVersion,
      acceptedObservationTypes,
      acceptedObservationTypesJson: canonicalJson(acceptedObservationTypes),
      implementationDigest: Sha256Digest.parse(candidate.implementationDigest),
    };
  });

  const manifest = JSON.parse(canonicalJson({
    extensionUri,
    version: raw.version,
    types: types.map(({ recordKind, typeUri, schemaVersion, schema }) => ({
      recordKind, typeUri, schemaVersion, schema,
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

/** Administrative install; identical release retries return the existing rows. */
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

export async function listExtensionReleases(db: TasqDb, tenantId = "gwendall") {
  const rows = await db.select().from(extensionRelease)
    .where(eq(extensionRelease.tenantId, tenantId))
    .orderBy(asc(extensionRelease.extensionUri), asc(extensionRelease.version));
  return rows.map(parseRelease);
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
) {
  for (const type of prepared.types) {
    if (await getExtensionTypeRegistration(db, type.typeUri, type.schemaVersion, tenantId)) {
      throw new Error(`Extension type identity already registered: ${type.typeUri}@${type.schemaVersion}`);
    }
  }
  for (const evaluator of prepared.evaluators) {
    if (await getExtensionEvaluatorRegistration(db, evaluator.evaluatorUri, evaluator.evaluatorVersion, tenantId)) {
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
) {
  const localTypes = new Map(prepared.types.map((type) => [
    `${type.typeUri}@${type.schemaVersion}`,
    type.recordKind,
  ]));
  const requireType = async (
    typeUri: string,
    schemaVersion: number,
    expectedKind: "condition" | "observation",
    label: string,
  ) => {
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
      await requireType(accepted.typeUri, accepted.schemaVersion, "observation", "Accepted observation type");
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
