import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kernel from "../src/kernel.js";
import * as service from "../src/index.js";
import {
  CLIENT_HELLO_CONTRACT_VERSION,
  createMutableClock,
} from "@tasq-run/schema";
import { canonicalJson, sha256Digest } from "../src/service/extensions.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function database(reference: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "tasq-discovery-"));
  tmpDirs.push(dir);
  const opened = await service.openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  if (reference) await service.runMigrations(opened.client, { now: 1_000 });
  else await kernel.runKernelMigrations(opened.client, { now: 1_000 });
  return opened;
}

function hello(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: CLIENT_HELLO_CONTRACT_VERSION,
    supportedProtocolVersions: [1],
    requiredCapabilities: [],
    requiredTypes: [],
    requiredCursors: [],
    ...overrides,
  };
}

describe("UK-009 machine discovery", () => {
  it("keeps minimal-kernel discovery neutral, deterministic and clock-injected", async () => {
    const { db, close } = await database(false);
    const clock = createMutableClock(2_000);
    try {
      const first = await kernel.getTasqDiscovery(db, {
        workspaceId: "minimal-workspace",
        transportBoundary: "embedded",
        clock,
      });
      expect(first.contractVersion).toBe("tasq.discovery.v1");
      expect(first.generatedAt).toBe(2_000);
      expect(first.expiresAt).toBe(302_000);
      expect(first.extensions).toEqual([]);
      expect(first.capabilities.map((capability) => capability.uri)).toEqual([
        "https://schemas.tasq.dev/capabilities/artifacts",
        "https://schemas.tasq.dev/capabilities/assignments",
        "https://schemas.tasq.dev/capabilities/attempts",
        "https://schemas.tasq.dev/capabilities/audit",
        "https://schemas.tasq.dev/capabilities/claims",
        "https://schemas.tasq.dev/capabilities/commitment-summaries",
        "https://schemas.tasq.dev/capabilities/commitments",
        "https://schemas.tasq.dev/capabilities/completion-records",
        "https://schemas.tasq.dev/capabilities/context-packets",
        "https://schemas.tasq.dev/capabilities/effects",
        "https://schemas.tasq.dev/capabilities/evidence",
        "https://schemas.tasq.dev/capabilities/extension-registry",
        "https://schemas.tasq.dev/capabilities/external-context-links",
        "https://schemas.tasq.dev/capabilities/inspection",
        "https://schemas.tasq.dev/capabilities/principals",
        "https://schemas.tasq.dev/capabilities/relations",
        "https://schemas.tasq.dev/capabilities/resource-leases",
        "https://schemas.tasq.dev/capabilities/spaces",
      ]);
      expect(first.cursors.map((cursor) => [cursor.uri, cursor.fields])).toEqual([
        ["https://schemas.tasq.dev/cursors/event-sequence", ["sequence"]],
        ["https://schemas.tasq.dev/cursors/observation-recorded-at-id", ["recordedAt", "id"]],
        ["https://schemas.tasq.dev/cursors/resource-event-sequence", ["sequence"]],
      ]);
      const serialized = JSON.stringify(first).toLowerCase();
      for (const forbidden of ["gmail", "github", "mercury", "_life", "area", "goal", "project"]) {
        expect(serialized).not.toContain(forbidden);
      }
      clock.advance(10_000);
      const second = await kernel.getTasqDiscovery(db, {
        workspaceId: "minimal-workspace",
        transportBoundary: "local_process",
        clock,
      });
      expect(second.generatedAt).toBe(12_000);
      expect(second.compatibilityDigest).toBe(first.compatibilityDigest);
      expect(second.transportBoundary).not.toBe(first.transportBoundary);
      expect(Buffer.byteLength(canonicalJson(second))).toBeLessThanOrEqual(second.limits.documentBytes);
    } finally {
      await close();
    }
  });

  it("discovers exact installed schemas/evaluators and maps every advertised operation to code", async () => {
    const { db, close } = await database(true);
    try {
      const document = await service.getTasqDiscovery(db, {
        workspaceId: "gwendall",
        transportBoundary: "local_process",
        capabilityProfile: "compatibility",
        now: 2_000,
      });
      expect(document.extensions).toHaveLength(1);
      expect(document.extensions[0]?.types).toHaveLength(10);
      expect(document.extensions[0]?.evaluators).toHaveLength(5);
      expect(document.capabilities.map((capability) => capability.uri)).toContain(
        "https://schemas.tasq.dev/capabilities/observations",
      );

      for (const extension of document.extensions) {
        for (const type of extension.types) {
          const resource = await service.getDiscoverySchema(db, type.resourceId, { workspaceId: "gwendall" });
          expect(resource).not.toBeNull();
          expect(resource).toMatchObject({
            resourceId: type.resourceId,
            typeUri: type.typeUri,
            schemaVersion: type.schemaVersion,
            schemaDigest: type.schemaDigest,
            schemaBytes: type.schemaBytes,
          });
          expect(sha256Digest(canonicalJson(resource!.schema))).toBe(type.schemaDigest);
          expect(Buffer.byteLength(canonicalJson(resource!.schema))).toBe(type.schemaBytes);
          expect(await service.getDiscoverySchema(db, type.resourceId, {
            workspaceId: "another-workspace",
          })).toBeNull();
        }
      }

      for (const capability of document.capabilities) {
        const implementations = service.DISCOVERY_CAPABILITY_IMPLEMENTATIONS[capability.uri];
        expect(implementations, capability.uri).toBeDefined();
        for (const operation of capability.operations) {
          const exportName = implementations![operation]!;
          expect(typeof (service as Record<string, unknown>)[exportName], `${capability.uri}/${operation}`).toBe("function");
        }
      }
      const strict = await kernel.getTasqDiscovery(db, { workspaceId: "gwendall", now: 2_000 });
      for (const capability of strict.capabilities) {
        const implementations = kernel.DISCOVERY_CAPABILITY_IMPLEMENTATIONS[capability.uri];
        for (const operation of capability.operations) {
          const exportName = implementations![operation]!;
          expect(typeof (kernel as Record<string, unknown>)[exportName], `${capability.uri}/${operation}`).toBe("function");
        }
      }
    } finally {
      await close();
    }
  });

  it("negotiates exact compatible subsets without downgrade or mutation", async () => {
    const { db, client, close } = await database(true);
    try {
      const document = await service.getTasqDiscovery(db, {
        workspaceId: "gwendall",
        capabilityProfile: "compatibility",
        now: 2_000,
      });
      const type = document.extensions[0]!.types[0]!;
      const before = await client.execute("SELECT total_changes() AS changes");
      const compatible = service.negotiateOnboarding(document, hello({
        knownCompatibilityDigest: document.compatibilityDigest,
        requiredCapabilities: [{
          uri: "https://schemas.tasq.dev/capabilities/commitments",
          version: 1,
        }],
        requiredTypes: [{
          typeUri: type.typeUri,
          schemaVersion: type.schemaVersion,
          schemaDigest: type.schemaDigest,
        }],
        requiredCursors: [{ uri: service.EVENT_CURSOR_URI, version: 1 }],
        maxSchemaBytes: type.schemaBytes,
      }));
      expect(compatible).toMatchObject({
        contractVersion: "tasq.onboarding.v1",
        status: "compatible",
        selectedProtocolVersion: 1,
        problems: [],
      });
      expect(compatible.capabilities).toHaveLength(1);
      expect(compatible.types).toEqual([{
        typeUri: type.typeUri,
        schemaVersion: type.schemaVersion,
        schemaDigest: type.schemaDigest,
      }]);
      expect(compatible.cursors).toHaveLength(1);

      const badDigest = service.negotiateOnboarding(document, hello({
        requiredTypes: [{
          typeUri: type.typeUri,
          schemaVersion: type.schemaVersion,
          schemaDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        }],
      }));
      expect(badDigest.problems.map((entry) => entry.code)).toEqual(["schema_digest_mismatch"]);

      const tooLarge = service.negotiateOnboarding(document, hello({
        requiredTypes: [{ typeUri: type.typeUri, schemaVersion: type.schemaVersion }],
        maxSchemaBytes: Math.max(1, type.schemaBytes - 1),
      }));
      expect(tooLarge.problems.map((entry) => entry.code)).toEqual(["schema_too_large"]);

      const missing = service.negotiateOnboarding(document, hello({
        supportedProtocolVersions: [99],
        requiredCapabilities: [{ uri: "https://schemas.example.test/capability", version: 1 }],
        requiredTypes: [{ typeUri: "https://schemas.example.test/type", schemaVersion: 1 }],
        requiredCursors: [{ uri: "https://schemas.example.test/cursor", version: 1 }],
      }));
      expect(missing.status).toBe("incompatible");
      expect(missing.selectedProtocolVersion).toBeNull();
      expect(missing.capabilities).toEqual([]);
      expect(missing.problems.map((entry) => entry.code)).toEqual([
        "missing_capability", "missing_cursor", "missing_type", "unsupported_protocol_version",
      ]);

      const refresh = service.negotiateOnboarding(document, hello({
        knownCompatibilityDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        supportedProtocolVersions: [99],
      }));
      expect(refresh).toMatchObject({
        status: "refresh_required",
        selectedProtocolVersion: null,
        capabilities: [], types: [], cursors: [],
      });
      expect(refresh.problems.map((entry) => entry.code)).toEqual(["discovery_changed"]);

      const duplicate = service.negotiateOnboarding(document, hello({
        requiredCursors: [
          { uri: service.EVENT_CURSOR_URI, version: 1 },
          { uri: service.EVENT_CURSOR_URI, version: 1 },
        ],
      }));
      expect(duplicate.problems.map((entry) => entry.code)).toEqual(["invalid_hello"]);
      const oversized = service.negotiateOnboarding(document, {
        ...hello(),
        padding: "x".repeat(document.limits.helloBytes),
      });
      expect(oversized.problems).toMatchObject([{ code: "invalid_hello" }]);
      const after = await client.execute("SELECT total_changes() AS changes");
      expect(after.rows[0]?.changes).toBe(before.rows[0]?.changes);
    } finally {
      await close();
    }
  });
});
