import { describe, expect, test } from "bun:test";
import { ExternalRefInsert } from "../src/types.js";
import {
  TARGET_REF_CONTRACT_VERSION,
  TARGET_REF_TYPE_URI,
  prepareTargetRefV1,
} from "../src/targets.js";

const property = {
  contractVersion: TARGET_REF_CONTRACT_VERSION,
  namespace: "https://schemas.example.test/property/",
  resourceType: "property",
  identifier: { form: "plain", value: "FR-75011-0042" },
  version: "cadastre-2026-08",
  digest: null,
} as const;

describe("TQ-622 target-reference value contract", () => {
  test("derives every binding from one canonical target identity", () => {
    const prepared = prepareTargetRefV1(property);

    expect(prepared).toMatchObject({
      specificity: "versioned",
      bindings: {
        externalRefIdentity: {
          system: property.namespace,
          resourceType: "property",
          externalId: "FR-75011-0042",
          version: "cadastre-2026-08",
          digest: null,
        },
        authorityResource: { kind: "resource", id: prepared.opaqueKey },
        resourceKey: prepared.opaqueKey,
        signedStatementSubject: {
          typeUri: TARGET_REF_TYPE_URI,
          id: prepared.opaqueKey,
          digest: prepared.targetDigest,
        },
      },
    });
    expect(prepared.bindings.observationSubjectRef).toBe(
      `urn:tasq:target-ref:${prepared.targetDigest.slice("sha256:".length)}`,
    );
    expect(prepared.opaqueKey).not.toContain(property.identifier.value);
    expect(prepared.bindings.observationSubjectRef).not.toContain(property.identifier.value);
    expect(Object.isFrozen(prepared)).toBe(true);

    expect(ExternalRefInsert.parse({
      tenantId: "physical/verification",
      recordType: "commitment",
      recordId: "01900000-0000-7000-8000-000000000001",
      ...prepared.bindings.externalRefIdentity,
      url: null,
    })).toMatchObject(prepared.bindings.externalRefIdentity);
  });

  test("is stable across input property order and freezes a language-neutral vector", () => {
    const reordered = {
      digest: null,
      identifier: { value: "FR-75011-0042", form: "plain" },
      resourceType: "property",
      version: "cadastre-2026-08",
      namespace: "https://schemas.example.test/property/",
      contractVersion: TARGET_REF_CONTRACT_VERSION,
    };
    const left = prepareTargetRefV1(property);
    const right = prepareTargetRefV1(reordered);

    expect(right.canonicalTarget).toBe(left.canonicalTarget);
    expect(right.targetDigest).toBe(left.targetDigest);
    expect(right.opaqueKey).toBe(left.opaqueKey);
    expect(left.targetDigest).toBe("sha256:f11a64403736c0be48c570c23e51e0f31de2253314520ee66d35cd57ef15f26c");
    expect(left.opaqueKey).toBe("tqt1_8RpkQDc2wL5IxXDCPlHg8x3iJTMUUg7mbTXNV-8V8mw");
  });

  test("distinguishes moving, versioned, and content-addressed targets", () => {
    const moving = prepareTargetRefV1({ ...property, version: null });
    const versioned = prepareTargetRefV1(property);
    const immutable = prepareTargetRefV1({
      ...property,
      digest: `sha256:${"a".repeat(64)}`,
    });

    expect(moving.specificity).toBe("moving");
    expect(versioned.specificity).toBe("versioned");
    expect(immutable.specificity).toBe("content_addressed");
    expect(new Set([moving.opaqueKey, versioned.opaqueKey, immutable.opaqueKey]).size).toBe(3);
  });

  test("supports secret-minimized workspace HMAC identifiers without leaking them into route keys", () => {
    const hmac = "b".repeat(64);
    const prepared = prepareTargetRefV1({
      contractVersion: TARGET_REF_CONTRACT_VERSION,
      namespace: "urn:facility:inventory",
      resourceType: "rack_device",
      identifier: { form: "workspace_hmac_sha256", value: hmac },
      version: null,
      digest: null,
    });

    expect(prepared.bindings.externalRefIdentity.externalId).toBe(`workspace-hmac-sha256:${hmac}`);
    expect(prepared.bindings.resourceKey).not.toContain(hmac);
    expect(prepared.bindings.observationSubjectRef).not.toContain(hmac);
  });

  test("changes every authority-bearing binding when target identity, version, or digest drifts", () => {
    const base = prepareTargetRefV1(property);
    const variants = [
      prepareTargetRefV1({ ...property, identifier: { form: "plain", value: "FR-75011-0043" } }),
      prepareTargetRefV1({ ...property, version: "cadastre-2026-09" }),
      prepareTargetRefV1({ ...property, digest: `sha256:${"c".repeat(64)}` }),
    ];

    for (const variant of variants) {
      expect(variant.targetDigest).not.toBe(base.targetDigest);
      expect(variant.bindings.authorityResource).not.toEqual(base.bindings.authorityResource);
      expect(variant.bindings.resourceKey).not.toBe(base.bindings.resourceKey);
      expect(variant.bindings.observationSubjectRef).not.toBe(base.bindings.observationSubjectRef);
      expect(variant.bindings.signedStatementSubject).not.toEqual(base.bindings.signedStatementSubject);
    }
  });

  test("rejects aliasing, secret-bearing namespaces, ambiguous identifier forms, and unknown fields", () => {
    const invalid = [
      { ...property, namespace: "HTTPS://SCHEMAS.EXAMPLE.TEST/property/" },
      { ...property, namespace: "https://user:secret@schemas.example.test/property/" },
      { ...property, namespace: "https://schemas.example.test/property/?token=secret" },
      { ...property, identifier: { form: "plain", value: " workspace " } },
      { ...property, identifier: { form: "plain", value: `workspace-hmac-sha256:${"a".repeat(64)}` } },
      { ...property, identifier: { form: "workspace_hmac_sha256", value: "not-a-digest" } },
      { ...property, resourceType: "Provider Thing" },
      { ...property, provider: "vendor-specific-kernel-field" },
    ];

    for (const candidate of invalid) expect(() => prepareTargetRefV1(candidate)).toThrow();
  });
});
