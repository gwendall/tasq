import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  diagnoseStore,
  ensureBundledReferenceExtension,
  getExtensionEvaluatorRegistration,
  getExtensionTypeRegistration,
  installExtension,
  listExtensionReleases,
  openDb,
  prepareExtensionManifest,
  REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
  REFERENCE_EXTENSION_MANIFEST,
  runMigrations,
  sha256Digest,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-extension-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

const objectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
};

function thirdPartyManifest(namespace = "https://acme.example/robotics", version = "1.0.0") {
  const conditionTypeUri = `${namespace}/conditions/part-at-station`;
  const observationTypeUri = `${namespace}/observations/part-scan`;
  return {
    extensionUri: `${namespace}/extension`,
    version,
    types: [
      { recordKind: "condition", typeUri: conditionTypeUri, schemaVersion: 1, schema: objectSchema },
      { recordKind: "observation", typeUri: observationTypeUri, schemaVersion: 1, schema: objectSchema },
    ],
    evaluators: [{
      evaluatorUri: `${namespace}/evaluators/part-at-station`,
      evaluatorVersion: 1,
      conditionTypeUri,
      conditionSchemaVersion: 1,
      acceptedObservationTypes: [{ typeUri: observationTypeUri, schemaVersion: 1 }],
      implementationDigest: sha256Digest(`${namespace}:evaluator:v1`),
    }],
  };
}

describe("universal extension registry", () => {
  test("canonicalizes JSON independently of object insertion order and rejects non-JSON values", () => {
    expect(canonicalJson({ "ä": 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"ä":1}');
    expect(prepareExtensionManifest(thirdPartyManifest()).manifestDigest).toBe(
      prepareExtensionManifest(structuredClone(thirdPartyManifest())).manifestDigest,
    );
    expect(() => prepareExtensionManifest({
      ...thirdPartyManifest(),
      types: [{
        ...thirdPartyManifest().types[0],
        schema: { ...objectSchema, maximum: Number.POSITIVE_INFINITY },
      }],
    })).toThrow(/non-finite numbers/);
  });

  test("bootstraps the five-domain reference release with frozen schemas and evaluators", async () => {
    const { db, client, close } = await freshDb();
    try {
      const releases = await listExtensionReleases(db);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({
        extensionUri: REFERENCE_EXTENSION_MANIFEST.extensionUri,
        version: REFERENCE_EXTENSION_MANIFEST.version,
      });
      const types = await client.execute("SELECT count(*) AS n FROM extension_type");
      const evaluators = await client.execute("SELECT count(*) AS n FROM extension_evaluator");
      expect(Number(types.rows[0]?.["n"])).toBe(10);
      expect(Number(evaluators.rows[0]?.["n"])).toBe(5);
      expect(await getExtensionTypeRegistration(
        db,
        "https://schemas.tasq.dev/conditions/github/pull-request-state",
        1,
      )).toMatchObject({ recordKind: "condition", schemaVersion: 1 });
      expect(await getExtensionEvaluatorRegistration(
        db,
        "https://schemas.tasq.dev/evaluators/github/pull-request-state",
        1,
      )).toMatchObject({ implementationDigest: REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST });
      expect(await diagnoseStore(db, client)).toMatchObject({ ok: true, issues: [] });
    } finally {
      await close();
    }
  });

  test("installs one release atomically and returns the same resources on identical retry", async () => {
    const { db, close } = await freshDb();
    try {
      const manifest = thirdPartyManifest();
      const first = await installExtension(db, manifest, { actor: "admin", now: 1_800_000_000_000 });
      const retry = await installExtension(db, structuredClone(manifest), {
        actor: "another-admin",
        now: 1_800_000_000_100,
      });
      expect(retry).toEqual(first);
      expect(first.types).toHaveLength(2);
      expect(first.evaluators).toHaveLength(1);
      expect(first.release.installedBy).toBe("admin");
    } finally {
      await close();
    }
  });

  test("rejects release identity drift and rolls back type conflicts", async () => {
    const { db, close } = await freshDb();
    try {
      const manifest = thirdPartyManifest();
      await installExtension(db, manifest);
      const changed = structuredClone(manifest);
      changed.types[0]!.schema = {
        ...objectSchema,
        properties: { id: { type: "integer" } },
      };
      await expect(installExtension(db, changed)).rejects.toThrow(/identity reused with different manifest/);

      const conflicting = thirdPartyManifest("https://other.example/extension-space");
      conflicting.types[0]!.typeUri = manifest.types[0]!.typeUri;
      conflicting.evaluators[0]!.conditionTypeUri = manifest.types[0]!.typeUri;
      await expect(installExtension(db, conflicting)).rejects.toThrow(/type identity already registered/);
      expect(await listExtensionReleases(db)).toHaveLength(2); // reference + first Acme release only
    } finally {
      await close();
    }
  });

  test("keeps all registry rows physically immutable", async () => {
    const { client, close } = await freshDb();
    try {
      for (const [table, timestampColumn, message] of [
        ["extension_release", "installed_at", "extension releases are immutable"],
        ["extension_type", "created_at", "extension types are immutable"],
        ["extension_evaluator", "created_at", "extension evaluators are immutable"],
      ] as const) {
        const rows = await client.execute(`SELECT id FROM ${table} LIMIT 1`);
        const id = String(rows.rows[0]?.["id"]);
        await expect(client.execute({
          sql: `UPDATE ${table} SET ${timestampColumn} = ${timestampColumn} WHERE id = ?`,
          args: [id],
        }))
          .rejects.toThrow(message);
        await expect(client.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] }))
          .rejects.toThrow(message);
      }
    } finally {
      await close();
    }
  });

  test("scopes identical third-party identities independently by tenant", async () => {
    const { db, close } = await freshDb();
    try {
      const manifest = thirdPartyManifest();
      const alpha = await installExtension(db, manifest, { tenantId: "alpha" });
      const beta = await installExtension(db, manifest, { tenantId: "beta" });
      expect(alpha.release.id).not.toBe(beta.release.id);
      expect(alpha.release.manifestDigest).toBe(beta.release.manifestDigest);
      await ensureBundledReferenceExtension(db, { tenantId: "alpha" });
      expect(await listExtensionReleases(db, "alpha")).toHaveLength(2);
    } finally {
      await close();
    }
  });

  test("composes evaluator-only releases with types owned by another installed extension", async () => {
    const { db, close } = await freshDb();
    try {
      const manifest = {
        extensionUri: "https://acme.example/alternate-github-evaluator",
        version: "1.0.0",
        types: [],
        evaluators: [{
          evaluatorUri: "https://acme.example/evaluators/github/pull-request-policy",
          evaluatorVersion: 1,
          conditionTypeUri: "https://schemas.tasq.dev/conditions/github/pull-request-state",
          conditionSchemaVersion: 1,
          acceptedObservationTypes: [{
            typeUri: "https://schemas.tasq.dev/observations/github/pull-request",
            schemaVersion: 1,
          }],
          implementationDigest: sha256Digest("acme:alternate-github-evaluator:v1"),
        }],
      };
      const installed = await installExtension(db, manifest);
      expect(installed.types).toEqual([]);
      expect(installed.evaluators).toHaveLength(1);
      expect(await listExtensionReleases(db)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  test("rejects unsafe or internally inconsistent manifests before any write", async () => {
    const { db, close } = await freshDb();
    try {
      const http = thirdPartyManifest("http://acme.example/robotics");
      expect(() => prepareExtensionManifest(http)).toThrow(/absolute HTTPS URI/);
      const missingType = thirdPartyManifest();
      missingType.evaluators[0]!.acceptedObservationTypes[0]!.typeUri =
        "https://acme.example/robotics/observations/missing";
      await expect(installExtension(db, missingType)).rejects.toThrow(/not registered in this workspace/);
      const empty = { ...thirdPartyManifest(), types: [], evaluators: [] };
      expect(() => prepareExtensionManifest(empty)).toThrow(/at least one type or evaluator/);
      expect(await listExtensionReleases(db)).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
