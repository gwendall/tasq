import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import {
  SignedStatementBundleV1,
  SignedStatementPayloadV1,
  SigningCredentialV1,
  canonicalizeEffectJson,
  type SignedStatementBundleV1 as Bundle,
  type SignedStatementPayloadV1 as Payload,
  type SigningCredentialV1 as Credential,
} from "@tasq-run/schema";

export const ED25519_STATEMENT_PROFILE_URI = "https://schemas.tasq.dev/signatures/ed25519/v1" as const;
export const ED25519_STATEMENT_PROFILE_VERSION = 1 as const;
export const SIGNED_STATEMENT_PAYLOAD_TYPE = "application/vnd.tasq.signed-statement.v1+json" as const;
export const ED25519_VERIFIER_IMPLEMENTATION_DIGEST =
  "sha256:0bfef03e31f7dcbca0e3efb3ac2ad35339fb39a61f220c6f65653ac72d9a353f" as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("non-canonical base64url");
  return decoded;
}

function sha(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** DSSE v1 pre-authentication encoding over exact payload type and bytes. */
export function statementPreAuthenticationEncoding(
  payloadType: string,
  payload: Uint8Array,
): Uint8Array {
  const type = bytes(payloadType);
  return Buffer.concat([
    bytes("DSSEv1 "),
    bytes(String(type.byteLength)),
    bytes(" "),
    type,
    bytes(" "),
    bytes(String(payload.byteLength)),
    bytes(" "),
    payload,
  ]);
}

export interface PurposeBoundStatementSigner {
  credentialId: string;
  profileUri: typeof ED25519_STATEMENT_PROFILE_URI;
  profileVersion: typeof ED25519_STATEMENT_PROFILE_VERSION;
  allowedPurposeUris: readonly string[];
  signStatement(input: {
    purposeUri: string;
    canonicalPayload: Uint8Array;
    preAuthenticationEncoding: Uint8Array;
  }): Promise<Uint8Array> | Uint8Array;
}

export async function signPurposeBoundStatement(
  input: Payload,
  signer: PurposeBoundStatementSigner,
): Promise<Bundle> {
  const payload = SignedStatementPayloadV1.parse(input);
  if (payload.credentialId !== signer.credentialId) throw new Error("signer credential mismatch");
  if (!signer.allowedPurposeUris.includes(payload.purpose.uri)) throw new Error("signer purpose denied");
  const canonicalPayload = bytes(canonicalizeEffectJson(payload as never));
  const signature = await signer.signStatement({
    purposeUri: payload.purpose.uri,
    canonicalPayload: canonicalPayload.slice(),
    preAuthenticationEncoding: statementPreAuthenticationEncoding(SIGNED_STATEMENT_PAYLOAD_TYPE, canonicalPayload),
  });
  if (signature.byteLength !== 64) throw new Error("Ed25519 signature must be exactly 64 bytes");
  return SignedStatementBundleV1.parse({
    envelopeVersion: "tasq.signed-statement-envelope.v1",
    payloadType: SIGNED_STATEMENT_PAYLOAD_TYPE,
    payload: base64url(canonicalPayload),
    signature: {
      profileUri: signer.profileUri,
      profileVersion: signer.profileVersion,
      keyId: signer.credentialId,
      value: base64url(signature),
    },
    supportingProofs: [],
  });
}

export interface StatementVerificationResult {
  outcome: "valid" | "invalid" | "indeterminate";
  reasonCode: string;
  payload: Payload | null;
  statementDigest: `sha256:${string}` | null;
  bundleDigest: `sha256:${string}`;
  credential: Credential | null;
}

function result(
  bundle: unknown,
  outcome: StatementVerificationResult["outcome"],
  reasonCode: string,
  extra: Partial<StatementVerificationResult> = {},
): StatementVerificationResult {
  let bundleDigest: `sha256:${string}`;
  try {
    bundleDigest = sha(canonicalizeEffectJson(bundle as never));
  } catch {
    bundleDigest = sha("invalid-bundle");
  }
  return { outcome, reasonCode, payload: null, statementDigest: null, credential: null, bundleDigest, ...extra };
}

export async function verifyPurposeBoundStatement(input: {
  bundle: unknown;
  expectedWorkspaceId: string;
  expectedAudience: string;
  acceptanceTime: string;
  /** Host-selected trust roots. An empty list intentionally trusts no credential. */
  acceptedTrustRootDigests?: readonly string[];
  resolveCredential(id: string): Promise<unknown> | unknown;
  consumeNonce?(input: { workspaceId: string; purposeUri: string; nonce: string; statementId: string }): Promise<boolean> | boolean;
}): Promise<StatementVerificationResult> {
  let bundle: Bundle;
  try {
    bundle = SignedStatementBundleV1.parse(input.bundle);
  } catch {
    return result(input.bundle, "invalid", "bundle_invalid");
  }
  const bundleResult = result(bundle, "invalid", "verification_failed");
  if (bundle.signature.profileUri !== ED25519_STATEMENT_PROFILE_URI ||
    bundle.signature.profileVersion !== ED25519_STATEMENT_PROFILE_VERSION) {
    return { ...bundleResult, reasonCode: "profile_unsupported" };
  }
  let credential: Credential;
  try {
    credential = SigningCredentialV1.parse(await input.resolveCredential(bundle.signature.keyId));
  } catch {
    return { ...bundleResult, outcome: "indeterminate", reasonCode: "credential_unavailable" };
  }
  if (credential.profileUri !== bundle.signature.profileUri ||
    credential.profileVersion !== bundle.signature.profileVersion ||
    credential.credentialId !== bundle.signature.keyId) {
    return { ...bundleResult, reasonCode: "credential_profile_mismatch", credential };
  }
  if (input.acceptedTrustRootDigests &&
    !input.acceptedTrustRootDigests.includes(credential.trustRootDigest)) {
    return { ...bundleResult, reasonCode: "credential_trust_root_denied", credential };
  }
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  let publicKey: KeyObject;
  try {
    payloadBytes = decodeBase64url(bundle.payload);
    signature = decodeBase64url(bundle.signature.value);
    if (signature.byteLength !== 64) throw new Error("signature length");
    const material = credential.publicMaterial as { format?: unknown; x?: unknown };
    if (material?.format !== "jwk-okp-ed25519" || typeof material.x !== "string") throw new Error("public material");
    const x = decodeBase64url(material.x);
    if (x.byteLength !== 32) throw new Error("public key length");
    if (sha(canonicalizeEffectJson(credential.publicMaterial as never)) !== credential.publicMaterialDigest) {
      throw new Error("public material digest");
    }
    publicKey = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: material.x } });
  } catch {
    return { ...bundleResult, reasonCode: "cryptographic_material_invalid", credential };
  }
  const pae = statementPreAuthenticationEncoding(bundle.payloadType, payloadBytes);
  if (!verifySignature(null, pae, publicKey, signature)) {
    return { ...bundleResult, reasonCode: "signature_invalid", credential };
  }
  let payload: Payload;
  try {
    const text = decoder.decode(payloadBytes);
    payload = SignedStatementPayloadV1.parse(JSON.parse(text));
    if (canonicalizeEffectJson(payload as never) !== text) throw new Error("non-canonical payload");
  } catch {
    return { ...bundleResult, reasonCode: "payload_noncanonical_or_invalid", credential };
  }
  const statementDigest = sha(payloadBytes);
  const acceptedAt = Date.parse(input.acceptanceTime);
  if (!Number.isSafeInteger(acceptedAt)) return { ...bundleResult, outcome: "indeterminate", reasonCode: "acceptance_time_invalid", payload, statementDigest, credential };
  if (payload.workspaceId !== input.expectedWorkspaceId || payload.audience !== input.expectedAudience ||
    payload.issuerPrincipalId !== credential.principalId || payload.credentialId !== credential.credentialId ||
    payload.workspaceId !== credential.workspaceId) {
    return { ...bundleResult, reasonCode: "binding_mismatch", payload, statementDigest, credential };
  }
  const validFrom = Date.parse(credential.validFrom);
  const credentialExpiry = credential.expiresAt ? Date.parse(credential.expiresAt) : null;
  const notBefore = payload.notBefore ? Date.parse(payload.notBefore) : null;
  const expiresAt = payload.expiresAt ? Date.parse(payload.expiresAt) : null;
  if (credential.status !== "active") return { ...bundleResult, reasonCode: `credential_${credential.status}`, payload, statementDigest, credential };
  if (acceptedAt < validFrom || (credentialExpiry != null && acceptedAt >= credentialExpiry) ||
    (notBefore != null && acceptedAt < notBefore) || (expiresAt != null && acceptedAt >= expiresAt)) {
    return { ...bundleResult, reasonCode: "validity_window_failed", payload, statementDigest, credential };
  }
  if (input.consumeNonce && !(await input.consumeNonce({
    workspaceId: payload.workspaceId,
    purposeUri: payload.purpose.uri,
    nonce: payload.nonce,
    statementId: payload.statementId,
  }))) {
    return { ...bundleResult, reasonCode: "nonce_reused", payload, statementDigest, credential };
  }
  return { ...bundleResult, outcome: "valid", reasonCode: "valid_at_acceptance", payload, statementDigest, credential };
}
