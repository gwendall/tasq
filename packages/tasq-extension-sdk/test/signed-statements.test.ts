import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeEffectJson, type SigningCredentialV1 } from "@tasq-run/schema";
import {
  ED25519_STATEMENT_PROFILE_URI,
  SIGNED_STATEMENT_PAYLOAD_TYPE,
  signPurposeBoundStatement,
  statementPreAuthenticationEncoding,
  verifyPurposeBoundStatement,
} from "../src/index.js";

const PURPOSE = "https://schemas.tasq.dev/purposes/artifact-authorship/v1";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const x = publicKey.export({ format: "jwk" }).x!;
const publicMaterial = { format: "jwk-okp-ed25519", x };
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}` as const;
const credential: SigningCredentialV1 = {
  credentialId: "credential-1",
  workspaceId: "team/acme",
  principalId: "principal:author",
  profileUri: ED25519_STATEMENT_PROFILE_URI,
  profileVersion: 1,
  publicMaterial,
  publicMaterialDigest: digest(publicMaterial),
  trustRootDigest: `sha256:${"a".repeat(64)}`,
  isolationClass: "isolated_process",
  status: "active",
  revision: 1,
  validFrom: "2026-07-24T00:00:00.000Z",
  enrollmentMethod: "host-proof-of-possession",
  enrollmentEvidenceDigest: `sha256:${"b".repeat(64)}`,
};
const payload = {
  contractVersion: "tasq.signed-statement.v1" as const,
  statementId: "statement-1",
  workspaceId: "team/acme",
  audience: "https://server.tasq.example/",
  issuerPrincipalId: "principal:author",
  credentialId: "credential-1",
  purpose: { uri: PURPOSE, version: 1 },
  subject: {
    typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
    id: "artifact-1",
    digest: `sha256:${"c".repeat(64)}` as const,
  },
  nonce: "nonce-1",
  issuedAt: "2026-07-24T09:00:00.000Z",
  expiresAt: "2026-07-24T10:00:00.000Z",
  metadata: {},
};
const signer = {
  credentialId: credential.credentialId,
  profileUri: ED25519_STATEMENT_PROFILE_URI,
  profileVersion: 1 as const,
  allowedPurposeUris: [PURPOSE],
  signStatement: ({ preAuthenticationEncoding }: { preAuthenticationEncoding: Uint8Array }) =>
    sign(null, preAuthenticationEncoding, privateKey),
};

describe("TQ-613 signed statements", () => {
  test("signs and verifies exact canonical purpose-bound bytes", async () => {
    const bundle = await signPurposeBoundStatement(payload, signer);
    const used = new Set<string>();
    const verified = await verifyPurposeBoundStatement({
      bundle,
      expectedWorkspaceId: "team/acme",
      expectedAudience: "https://server.tasq.example/",
      acceptanceTime: "2026-07-24T09:30:00.000Z",
      resolveCredential: () => credential,
      consumeNonce: ({ nonce }) => !used.has(nonce) && !!used.add(nonce),
    });
    expect(verified).toMatchObject({ outcome: "valid", reasonCode: "valid_at_acceptance", payload });
    expect((await verifyPurposeBoundStatement({
      bundle,
      expectedWorkspaceId: "team/acme",
      expectedAudience: "https://server.tasq.example/",
      acceptanceTime: "2026-07-24T09:30:00.000Z",
      resolveCredential: () => credential,
      consumeNonce: ({ nonce }) => !used.has(nonce) && !!used.add(nonce),
    })).reasonCode).toBe("nonce_reused");
  });

  test("rejects changed signed bytes, routing, purpose, credential state and noncanonical payload", async () => {
    const bundle = await signPurposeBoundStatement(payload, signer);
    const changed = structuredClone(bundle);
    changed.payload = `${changed.payload.slice(0, -1)}${changed.payload.endsWith("A") ? "B" : "A"}`;
    expect((await verifyPurposeBoundStatement({
      bundle: changed, expectedWorkspaceId: "team/acme", expectedAudience: payload.audience,
      acceptanceTime: "2026-07-24T09:30:00.000Z", resolveCredential: () => credential,
    })).reasonCode).toBe("signature_invalid");
    expect((await verifyPurposeBoundStatement({
      bundle, expectedWorkspaceId: "other", expectedAudience: payload.audience,
      acceptanceTime: "2026-07-24T09:30:00.000Z", resolveCredential: () => credential,
    })).reasonCode).toBe("binding_mismatch");
    expect((await verifyPurposeBoundStatement({
      bundle, expectedWorkspaceId: "team/acme", expectedAudience: payload.audience,
      acceptanceTime: "2026-07-24T09:30:00.000Z", resolveCredential: () => ({ ...credential, status: "revoked" }),
    })).reasonCode).toBe("credential_revoked");
  });

  test("denies arbitrary-purpose use at the signer boundary", async () => {
    await expect(signPurposeBoundStatement({
      ...payload,
      purpose: { uri: "https://schemas.tasq.dev/purposes/effect-approval/v1", version: 1 },
    }, signer)).rejects.toThrow("purpose denied");
  });
});

describe("TQ-616 hostile portable verification", () => {
  const verify = (bundle: unknown, overrides: {
    workspace?: string;
    audience?: string;
    acceptanceTime?: string;
    resolved?: SigningCredentialV1;
    roots?: string[];
  } = {}) => verifyPurposeBoundStatement({
    bundle,
    expectedWorkspaceId: overrides.workspace ?? payload.workspaceId,
    expectedAudience: overrides.audience ?? payload.audience,
    acceptanceTime: overrides.acceptanceTime ?? "2026-07-24T09:30:00.000Z",
    acceptedTrustRootDigests: overrides.roots ?? [credential.trustRootDigest],
    resolveCredential: () => overrides.resolved ?? credential,
  });

  async function rawBundle(payloadText: string) {
    const exact = Buffer.from(payloadText, "utf8");
    const signature = sign(
      null,
      statementPreAuthenticationEncoding(SIGNED_STATEMENT_PAYLOAD_TYPE, exact),
      privateKey,
    );
    return {
      envelopeVersion: "tasq.signed-statement-envelope.v1",
      payloadType: SIGNED_STATEMENT_PAYLOAD_TYPE,
      payload: exact.toString("base64url"),
      signature: {
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        keyId: credential.credentialId,
        value: signature.toString("base64url"),
      },
      supportingProofs: [],
    };
  }

  test("rejects valid signatures over duplicate-key, unsafe-number and noncanonical JSON", async () => {
    const canonical = canonicalizeEffectJson(payload as never);
    const duplicate = canonical.replace('"metadata":{}', '"metadata":{},"metadata":{}');
    expect((await verify(await rawBundle(duplicate))).reasonCode)
      .toBe("payload_noncanonical_or_invalid");
    const unsafe = canonical.replace('"metadata":{}', '"metadata":{"n":9007199254740992}');
    expect((await verify(await rawBundle(unsafe))).reasonCode)
      .toBe("payload_noncanonical_or_invalid");
    const pretty = JSON.stringify(payload, null, 2);
    expect((await verify(await rawBundle(pretty))).reasonCode)
      .toBe("payload_noncanonical_or_invalid");
  });

  test("rejects wrapping, partial coverage, routing drift and an untrusted authority root", async () => {
    const bundle = await signPurposeBoundStatement(payload, signer);
    expect((await verify({
      ...bundle,
      signature: { ...bundle.signature, secondValue: bundle.signature.value },
    })).reasonCode).toBe("bundle_invalid");
    expect((await verify({
      ...bundle,
      payloadType: "application/json",
    })).reasonCode).toBe("bundle_invalid");
    expect((await verify(bundle, { workspace: "team/other" })).reasonCode)
      .toBe("binding_mismatch");
    expect((await verify(bundle, { audience: "https://other.example/" })).reasonCode)
      .toBe("binding_mismatch");
    expect((await verify(bundle, { roots: [`sha256:${"f".repeat(64)}`] })).reasonCode)
      .toBe("credential_trust_root_denied");
  });

  test("freezes credential lifecycle and validity at the injected acceptance instant", async () => {
    const bundle = await signPurposeBoundStatement(payload, signer);
    for (const status of ["suspended", "revoked", "compromised", "retired"] as const) {
      expect((await verify(bundle, {
        resolved: { ...credential, status },
      })).reasonCode).toBe(`credential_${status}`);
    }
    expect((await verify(bundle, {
      resolved: { ...credential, expiresAt: "2026-07-24T09:30:00.000Z" },
    })).reasonCode).toBe("validity_window_failed");
    expect((await verify(bundle, {
      acceptanceTime: "2026-07-24T10:00:00.000Z",
    })).reasonCode).toBe("validity_window_failed");
  });

  test("keeps a valid signature separate from semantic truth and authority", async () => {
    const bundle = await signPurposeBoundStatement(payload, signer);
    expect(await verify(bundle)).toMatchObject({
      outcome: "valid",
      reasonCode: "valid_at_acceptance",
    });
    // The verifier deliberately returns data only. It has no mutation,
    // validation-decision, approval, permit or connector-dispatch callback.
    expect(Object.keys(await verify(bundle)).sort()).toEqual([
      "bundleDigest",
      "credential",
      "outcome",
      "payload",
      "reasonCode",
      "statementDigest",
    ]);
  });
});
