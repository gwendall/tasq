/** TQ-305: the real filesystem watcher passes the universal read-connector gate. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CONNECTOR_CONFORMANCE_PROTOCOL,
  assertConnectorConformance,
  runConnectorConformance,
  type ConnectorConformanceProfile,
  type NormalizedConnectorObservation,
} from "@tasq-run/extension-sdk";
import { watchFilesystemArtifact } from "@tasq-internal/filesystem-watcher";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function profile(): ConnectorConformanceProfile {
  return {
    protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
    connectorUri: "https://schemas.tasq.dev/connectors/filesystem-watcher",
    connectorVersion: "1.0.0",
    instanceRef: "connector:filesystem:conformance-root",
    bindingDigest: sha256("filesystem-conformance-root-binding-v1"),
    provider: {
      issuerUri: "https://schemas.tasq.dev/providers/local-filesystem",
      accountRef: "conformance-root",
      audience: "local-filesystem:conformance-root",
    },
    clock: "injected",
    credentials: "secret_refs_only",
    redirects: "forbid_credential_forwarding",
    observations: {
      deliveryIdentity: "source_external_event_id",
      exactReplay: "return_original",
      conflictingReplay: "reject",
      sourceTime: "provenance_only",
      secretMinimized: true,
      digestBoundRawReference: true,
    },
    effects: [],
  };
}

describe("TQ-305 real connector conformance", () => {
  test("passes the read-only filesystem connector without touching its source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-connector-conformance-"));
    tmpDirs.push(dir);
    const root = join(dir, "root");
    const nested = join(root, "artifacts");
    const target = join(nested, "result.json");
    mkdirSync(nested, { recursive: true });
    writeFileSync(target, "{\"status\":\"ready\"}\n", "utf8");
    utimesSync(target, 1_700_000_000, 1_700_000_000);
    const before = sha256(readFileSync(target));

    const normalize = async (): Promise<NormalizedConnectorObservation> => {
      const envelope = await watchFilesystemArtifact({
        connectorRoot: "conformance-root",
        rootPath: root,
        relativePath: "artifacts/result.json",
      });
      return {
        source: envelope.source,
        externalEventId: envelope.externalEventId,
        typeUri: "https://schemas.tasq.dev/observations/filesystem/stat",
        schemaVersion: 1,
        payload: envelope.payload,
        occurredAt: envelope.occurredAt,
        verificationLevel: envelope.verificationLevel,
        verificationMethod: envelope.verificationMethod,
        rawRef: envelope.rawRef,
        digest: envelope.digest,
        metadata: envelope.metadata,
      };
    };
    const exact = await normalize();
    const report = await runConnectorConformance(profile(), {
      observation: {
        exactDelivery: () => exact,
        replayExactDelivery: normalize,
        conflictingDelivery: () => ({
          ...exact,
          payload: { ...exact.payload, sizeBytes: Number(exact.payload.sizeBytes) + 1 },
          digest: sha256("conflicting-provider-content"),
        }),
      },
    }, { now: 1_800_000_000_000 });

    expect(report.passed).toBe(true);
    expect(report.checks.map((value) => value.id)).toEqual([
      "profile.valid",
      "observation.valid",
      "observation.exact_replay",
      "observation.conflict_identity",
      "observation.conflict_content",
      "observation.conflict_secret_minimized",
    ]);
    expect(() => assertConnectorConformance(report)).not.toThrow();
    expect(sha256(readFileSync(target))).toBe(before);
  });
});
