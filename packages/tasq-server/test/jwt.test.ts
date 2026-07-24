import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  ACTION_URIS,
  getRegisteredAction,
  type ActionIdentity,
} from "@tasq-internal/authority";
import {
  CredentialVerificationError,
  createJwtCredentialVerifier,
} from "../src/index.js";

const NOW = 1_900_000_000_000;
const ISSUER = "https://identity.tasq.example/";
const AUDIENCE = "https://server.tasq.example/";
const clock = { now: () => NOW };

function action(uri: string): ActionIdentity {
  const found = getRegisteredAction(uri);
  if (!found) throw new Error(`missing registered action ${uri}`);
  return {
    uri: found.uri,
    version: found.version,
    implementationDigest: found.implementationDigest,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(
  privateKey: KeyObject,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = encode({ alg: "RS256", typ: "at+jwt", kid: "key-1", ...header });
  const encodedClaims = encode({
    iss: ISSUER,
    sub: "agent:builder",
    aud: AUDIENCE,
    iat: NOW / 1_000 - 10,
    nbf: NOW / 1_000 - 10,
    exp: NOW / 1_000 + 300,
    jti: "token-1",
    client_id: "codex",
    scope: "tasq:read tasq:mutate",
    actor: "untrusted-actor-claim",
    ...claims,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${encodedHeader}.${encodedClaims}`)
    .end()
    .sign(privateKey)
    .toString("base64url");
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const read = action(ACTION_URIS["workspace.read"]);
  const mutate = action(ACTION_URIS["commitment.propose"]);
  const verifier = createJwtCredentialVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: [{ kid: "key-1", jwk: publicKey.export({ format: "jwk" }) }],
    scopeActions: {
      "tasq:read": [read],
      "tasq:mutate": [mutate],
    },
    clockSkewMs: 0,
  });
  return { privateKey, verifier, read, mutate };
}

async function verify(verifier: ReturnType<typeof createJwtCredentialVerifier>, bearer: string) {
  return verifier.verify({
    authorization: `Bearer ${bearer}`,
    dpopProof: null,
    method: "GET",
    requestUrl: `${AUDIENCE}v1/workspaces/team/commitments`,
    expectedAudience: AUDIENCE,
  }, clock);
}

describe("standards-based hosted JWT verifier", () => {
  test("verifies RS256 access JWTs and maps only configured scopes to exact actions", async () => {
    const { privateKey, verifier, read, mutate } = fixture();
    const identity = await verify(verifier, token(privateKey));
    expect(identity).toMatchObject({
      issuer: ISSUER,
      subject: "agent:builder",
      audience: [AUDIENCE],
      actor: null,
      clientId: "codex",
      authenticationMethod: "oauth_jwt_access_token",
    });
    expect(identity.actionUpperBound).toEqual([mutate, read].sort((a, b) => a.uri.localeCompare(b.uri)));
    expect(identity.tokenIdDigest).toStartWith("sha256:");
    expect(identity.credentialKeyDigest).toStartWith("sha256:");
  });

  test("rejects bad signatures, time bounds, audience, algorithms and unknown scopes", async () => {
    const { privateKey, verifier } = fixture();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const candidates = [
      token(other),
      token(privateKey, { exp: NOW / 1_000 }),
      token(privateKey, { nbf: NOW / 1_000 + 1 }),
      token(privateKey, { aud: "https://other.example/" }),
      token(privateKey, { scope: "tasq:admin" }),
      token(privateKey, {}, { alg: "HS256" }),
      token(privateKey, {}, { kid: "missing" }),
    ];
    for (const candidate of candidates) {
      await expect(verify(verifier, candidate)).rejects.toBeInstanceOf(CredentialVerificationError);
    }
  });

  test("fails closed on DPoP input and verifier/configuration mismatches", async () => {
    const { privateKey, verifier } = fixture();
    await expect(verifier.verify({
      authorization: `Bearer ${token(privateKey)}`,
      dpopProof: "unverified-proof",
      method: "GET",
      requestUrl: AUDIENCE,
      expectedAudience: "https://other.example/",
    }, clock)).rejects.toBeInstanceOf(CredentialVerificationError);

    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createJwtCredentialVerifier({
      issuer: "http://identity.example/",
      audience: AUDIENCE,
      keys: [{ kid: "key", jwk: publicKey.export({ format: "jwk" }) }],
      scopeActions: {},
    })).toThrow("canonical HTTPS");
  });
});
