/** Provider-neutral external-target identity and deterministic bindings. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { Sha256Digest } from "./extensions.js";

export const TARGET_REF_CONTRACT_VERSION = "tasq.target-ref.v1" as const;
export const TARGET_REF_TYPE_URI = "https://tasq.run/contracts/target-reference/v1" as const;
export const TARGET_REF_DIGEST_DOMAIN = "tasq.target-ref-digest.v1\0" as const;

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedPortableString(max: number) {
  return z.string().min(1).max(max)
    .refine(hasOnlyUnicodeScalars, "must contain only Unicode scalar values")
    .refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    "must be trimmed and contain no control characters",
    );
}

const CanonicalNamespace = boundedPortableString(2_000).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.href === value
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}, "must be one canonical absolute URI without credentials, query, or fragment");

const PlainIdentifier = z.object({
  form: z.literal("plain"),
  value: boundedPortableString(1_000).refine(
    (value) => !value.startsWith("workspace-hmac-sha256:"),
    "plain identifiers cannot use the reserved workspace-HMAC prefix",
  ),
}).strict();

const WorkspaceHmacIdentifier = z.object({
  form: z.literal("workspace_hmac_sha256"),
  value: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const TargetIdentifierV1 = z.discriminatedUnion("form", [
  PlainIdentifier,
  WorkspaceHmacIdentifier,
]);
export type TargetIdentifierV1 = z.infer<typeof TargetIdentifierV1>;

export const TargetRefV1 = z.object({
  contractVersion: z.literal(TARGET_REF_CONTRACT_VERSION),
  namespace: CanonicalNamespace,
  resourceType: z.string().regex(/^[a-z][a-z0-9._-]{0,119}$/),
  identifier: TargetIdentifierV1,
  version: boundedPortableString(500).nullable().default(null),
  digest: Sha256Digest.nullable().default(null),
}).strict();
export type TargetRefV1 = z.infer<typeof TargetRefV1>;

export type TargetSpecificity = "moving" | "versioned" | "content_addressed";

export interface PreparedTargetRefV1 {
  target: TargetRefV1;
  canonicalTarget: string;
  targetDigest: string;
  opaqueKey: string;
  specificity: TargetSpecificity;
  bindings: {
    externalRefIdentity: {
      system: string;
      resourceType: string;
      externalId: string;
      version: string | null;
      digest: string | null;
      metadata: {
        targetContractVersion: typeof TARGET_REF_CONTRACT_VERSION;
        targetIdentifierForm: TargetIdentifierV1["form"];
        targetDigest: string;
      };
    };
    authorityResource: { kind: "resource"; id: string };
    resourceKey: string;
    observationSubjectRef: string;
    signedStatementSubject: {
      typeUri: typeof TARGET_REF_TYPE_URI;
      id: string;
      digest: string;
    };
  };
}

function canonicalTarget(target: TargetRefV1): string {
  // The field order below is the language-neutral v1 canonical form. The
  // schema rejects unknown fields, so no authority-bearing input disappears.
  return JSON.stringify({
    contractVersion: target.contractVersion,
    namespace: target.namespace,
    resourceType: target.resourceType,
    identifier: {
      form: target.identifier.form,
      value: target.identifier.value,
    },
    version: target.version,
    digest: target.digest,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function externalIdentifier(identifier: TargetIdentifierV1): string {
  return identifier.form === "plain"
    ? identifier.value
    : `workspace-hmac-sha256:${identifier.value}`;
}

/**
 * Validate one target value and derive every existing Tasq identity binding.
 * No binding is independently caller-chosen, preventing target drift across
 * external references, authority, leases, observations, and statements.
 */
export function prepareTargetRefV1(input: unknown): PreparedTargetRefV1 {
  const target = TargetRefV1.parse(input);
  const canonical = canonicalTarget(target);
  const hash = createHash("sha256").update(TARGET_REF_DIGEST_DOMAIN + canonical, "utf8").digest();
  const hex = hash.toString("hex");
  const targetDigest = `sha256:${hex}`;
  const opaqueKey = `tqt1_${hash.toString("base64url")}`;
  const specificity: TargetSpecificity = target.digest != null
    ? "content_addressed"
    : target.version != null
      ? "versioned"
      : "moving";

  return deepFreeze({
    target,
    canonicalTarget: canonical,
    targetDigest,
    opaqueKey,
    specificity,
    bindings: {
      externalRefIdentity: {
        system: target.namespace,
        resourceType: target.resourceType,
        externalId: externalIdentifier(target.identifier),
        version: target.version,
        digest: target.digest,
        metadata: {
          targetContractVersion: TARGET_REF_CONTRACT_VERSION,
          targetIdentifierForm: target.identifier.form,
          targetDigest,
        },
      },
      authorityResource: { kind: "resource", id: opaqueKey },
      resourceKey: opaqueKey,
      observationSubjectRef: `urn:tasq:target-ref:${hex}`,
      signedStatementSubject: {
        typeUri: TARGET_REF_TYPE_URI,
        id: opaqueKey,
        digest: targetDigest,
      },
    },
  });
}
