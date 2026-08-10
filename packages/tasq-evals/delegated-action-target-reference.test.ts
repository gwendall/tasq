import { describe, expect, test } from "bun:test";
import { ResourceRef } from "@tasq-internal/authority";
import {
  ExternalRefInsert,
  ResourceKey,
  SignedStatementPayloadV1,
  TARGET_REF_CONTRACT_VERSION,
  prepareTargetRefV1,
} from "@tasq-run/schema";

function target(input: {
  namespace: string;
  resourceType: string;
  identifier: { form: "plain"; value: string } | { form: "workspace_hmac_sha256"; value: string };
  version?: string | null;
  digest?: string | null;
}) {
  return prepareTargetRefV1({
    contractVersion: TARGET_REF_CONTRACT_VERSION,
    version: null,
    digest: null,
    ...input,
  });
}

describe("TQ-622 delegated-action target conformance", () => {
  test("one value crosses existing collaboration, authority, resource and trust Interfaces", () => {
    const prepared = target({
      namespace: "urn:facility:inventory",
      resourceType: "rack_device",
      identifier: { form: "workspace_hmac_sha256", value: "1".repeat(64) },
      version: "inventory-84",
    });

    expect(ExternalRefInsert.parse({
      tenantId: "remote-hands/ops",
      recordType: "task",
      recordId: "01900000-0000-7000-8000-000000000001",
      ...prepared.bindings.externalRefIdentity,
      url: null,
    })).toMatchObject(prepared.bindings.externalRefIdentity);
    expect(ResourceRef.parse(prepared.bindings.authorityResource)).toEqual(
      prepared.bindings.authorityResource,
    );
    expect(ResourceKey.parse(prepared.bindings.resourceKey)).toBe(prepared.opaqueKey);

    const statement = SignedStatementPayloadV1.parse({
      contractVersion: "tasq.signed-statement.v1",
      statementId: "statement-target-1",
      workspaceId: "remote-hands/ops",
      audience: "https://server.example.test/",
      issuerPrincipalId: "principal:facility-agent",
      credentialId: "credential:facility-agent:1",
      purpose: { uri: "https://tasq.run/purposes/target-acceptance/v1", version: 1 },
      subject: prepared.bindings.signedStatementSubject,
      nonce: "target-acceptance-1",
      issuedAt: "2026-08-10T18:00:00.000Z",
      expiresAt: "2026-08-10T18:10:00.000Z",
      metadata: {},
    });
    expect(statement.subject).toEqual(prepared.bindings.signedStatementSubject);
  });

  test("the same Interface covers physical, software and procurement targets without vertical fields", () => {
    const cases = [
      target({
        namespace: "urn:registry:property",
        resourceType: "property",
        identifier: { form: "workspace_hmac_sha256", value: "2".repeat(64) },
        version: "registry-2026-08",
      }),
      target({
        namespace: "https://schemas.example.test/deployments/",
        resourceType: "deployment",
        identifier: { form: "plain", value: "production/web" },
        digest: `sha256:${"3".repeat(64)}`,
      }),
      target({
        namespace: "https://catalog.example.test/products/",
        resourceType: "product",
        identifier: { form: "plain", value: "model-x200" },
        version: "seller-revision-19",
      }),
    ];

    expect(new Set(cases.map((item) => item.opaqueKey)).size).toBe(cases.length);
    for (const prepared of cases) {
      expect(Object.keys(prepared.target)).toEqual([
        "contractVersion",
        "namespace",
        "resourceType",
        "identifier",
        "version",
        "digest",
      ]);
      expect(JSON.stringify(prepared.bindings.authorityResource)).not.toContain("location");
      expect(JSON.stringify(prepared.bindings.authorityResource)).not.toContain("provider");
      expect(JSON.stringify(prepared.bindings.authorityResource)).not.toContain("price");
    }
  });

  test("a compromised agent cannot reuse target-A authority after target drift", () => {
    const approved = target({
      namespace: "https://schemas.example.test/deployments/",
      resourceType: "deployment",
      identifier: { form: "plain", value: "staging/api" },
      digest: `sha256:${"4".repeat(64)}`,
    });
    const requested = target({
      namespace: "https://schemas.example.test/deployments/",
      resourceType: "deployment",
      identifier: { form: "plain", value: "production/api" },
      digest: `sha256:${"4".repeat(64)}`,
    });

    expect(requested.bindings.authorityResource).not.toEqual(approved.bindings.authorityResource);
    expect(requested.bindings.signedStatementSubject).not.toEqual(
      approved.bindings.signedStatementSubject,
    );
    expect(
      requested.opaqueKey === approved.bindings.signedStatementSubject.id
      && requested.targetDigest === approved.bindings.signedStatementSubject.digest,
    ).toBe(false);
  });
});
