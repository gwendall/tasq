import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  ActionIdentity,
  VerifiedIdentity,
  digestAuthorityValue,
  getRegisteredAction,
  type ActionIdentity as ActionIdentityValue,
} from "@tasq-internal/authority";
import { z } from "zod";
import {
  CredentialVerificationError,
  type CredentialVerifier,
} from "./http.js";

export const JWT_CREDENTIAL_VERIFIER_CONTRACT_VERSION = "tasq.jwt-credential-verifier.v1" as const;

const Opaque = z.string().min(1).max(500).refine((value) => value === value.trim());
const NumericDate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Header = z.object({
  alg: z.literal("RS256"),
  kid: Opaque,
  typ: z.literal("at+jwt"),
}).strict();
const Claims = z.object({
  iss: z.string().url(),
  sub: Opaque,
  aud: z.union([z.string().url(), z.array(z.string().url()).min(1).max(16)]),
  iat: NumericDate,
  nbf: NumericDate.optional(),
  exp: NumericDate,
  jti: Opaque,
  client_id: Opaque.optional(),
  scope: z.string().max(4_000).default(""),
}).passthrough();

export interface JwtVerifierKey {
  kid: string;
  jwk: JsonWebKey;
}

export interface JwtCredentialVerifierOptions {
  issuer: string;
  audience: string;
  keys: JwtVerifierKey[];
  scopeActions: Record<string, ActionIdentityValue[]>;
  clockSkewMs?: number;
}

function canonicalHttps(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.href !== value) {
    throw new Error(`${label} must be one canonical HTTPS URL`);
  }
  return value;
}

function decodeSegment(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new CredentialVerificationError("invalid_token");
  return Uint8Array.from(Buffer.from(segment, "base64url"));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseJson(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeSegment(segment)));
  } catch {
    throw new CredentialVerificationError("invalid_token");
  }
}

function exactActions(scopeActions: Record<string, ActionIdentityValue[]>): Map<string, ActionIdentityValue[]> {
  const result = new Map<string, ActionIdentityValue[]>();
  for (const [scope, values] of Object.entries(scopeActions)) {
    if (!/^[A-Za-z0-9:._/-]{1,200}$/.test(scope)) throw new Error(`invalid OAuth scope mapping: ${scope}`);
    const actions = z.array(ActionIdentity).min(1).max(32).parse(values)
      .sort((left, right) => left.uri.localeCompare(right.uri));
    if (new Set(actions.map(({ uri }) => uri)).size !== actions.length) {
      throw new Error(`duplicate action in OAuth scope mapping: ${scope}`);
    }
    for (const action of actions) {
      const registered = getRegisteredAction(action.uri);
      if (!registered || registered.version !== action.version
        || registered.implementationDigest !== action.implementationDigest) {
        throw new Error(`OAuth scope ${scope} maps to an unknown action identity`);
      }
    }
    result.set(scope, actions);
  }
  return result;
}

function numericDateMs(value: number): number {
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new CredentialVerificationError("invalid_token");
  return milliseconds;
}

export function createJwtCredentialVerifier(options: JwtCredentialVerifierOptions): CredentialVerifier {
  const issuer = canonicalHttps(options.issuer, "JWT issuer");
  const audience = canonicalHttps(options.audience, "JWT audience");
  const skew = z.number().int().min(0).max(300_000).parse(options.clockSkewMs ?? 30_000);
  if (options.keys.length === 0 || options.keys.length > 32) throw new Error("JWT verifier requires 1-32 keys");
  const actionsByScope = exactActions(options.scopeActions);
  const imported = new Map<string, ReturnType<typeof webcrypto.subtle.importKey>>();
  const keyDigests = new Map<string, string>();
  for (const entry of options.keys) {
    const kid = Opaque.parse(entry.kid);
    if (imported.has(kid)) throw new Error(`duplicate JWT kid: ${kid}`);
    const jwk = z.object({
      kty: z.literal("RSA"),
      n: z.string().min(1),
      e: z.string().min(1),
      alg: z.literal("RS256").optional(),
      use: z.literal("sig").optional(),
      kid: z.string().optional(),
    }).passthrough().parse(entry.jwk);
    if (jwk.kid !== undefined && jwk.kid !== kid) throw new Error(`JWT JWK kid mismatch: ${kid}`);
    imported.set(kid, webcrypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ));
    keyDigests.set(kid, digestAuthorityValue(jwk));
  }
  const issuerConfigurationDigest = digestAuthorityValue({
    contractVersion: JWT_CREDENTIAL_VERIFIER_CONTRACT_VERSION,
    issuer,
    audience,
    algorithms: ["RS256"],
    kids: [...imported.keys()].sort(),
    scopeActions: [...actionsByScope.entries()],
    skew,
  });

  return {
    async verify(input, clock) {
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorization);
      if (!match || input.dpopProof !== null || input.expectedAudience !== audience) {
        throw new CredentialVerificationError("invalid_token");
      }
      const token = match[1]!;
      if (token.length > 32_768) throw new CredentialVerificationError("invalid_token");
      const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
      const header = Header.safeParse(parseJson(encodedHeader!));
      const claims = Claims.safeParse(parseJson(encodedClaims!));
      if (!header.success || !claims.success) throw new CredentialVerificationError("invalid_token");
      const key = imported.get(header.data.kid);
      if (!key) throw new CredentialVerificationError("invalid_token");
      const validSignature = await webcrypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        await key,
        exactArrayBuffer(decodeSegment(encodedSignature!)),
        new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
      );
      if (!validSignature) throw new CredentialVerificationError("invalid_token");
      const now = z.number().int().nonnegative().parse(clock.now());
      const notBefore = numericDateMs(claims.data.nbf ?? claims.data.iat);
      const issuedAt = numericDateMs(claims.data.iat);
      const expiresAt = numericDateMs(claims.data.exp);
      const audiences = (Array.isArray(claims.data.aud) ? claims.data.aud : [claims.data.aud]).sort();
      if (claims.data.iss !== issuer || !audiences.includes(audience)
        || issuedAt > now + skew || notBefore > now + skew || expiresAt <= now - skew
        || expiresAt <= issuedAt) {
        throw new CredentialVerificationError("invalid_token");
      }
      const scopes = claims.data.scope.split(" ").filter(Boolean);
      if (new Set(scopes).size !== scopes.length) throw new CredentialVerificationError("invalid_token");
      const actionMap = new Map<string, ActionIdentityValue>();
      for (const scope of scopes) {
        const mapped = actionsByScope.get(scope);
        if (!mapped) throw new CredentialVerificationError("invalid_token");
        for (const action of mapped) actionMap.set(action.uri, action);
      }
      return VerifiedIdentity.parse({
        contractVersion: "tasq.verified-identity.v1",
        issuer,
        subject: claims.data.sub,
        audience: audiences,
        authenticationMethod: "oauth_jwt_access_token",
        authenticatedAt: issuedAt,
        notBefore,
        expiresAt,
        clientId: claims.data.client_id ?? null,
        actor: null,
        credentialBinding: { kind: "none" },
        tokenIdDigest: digestAuthorityValue({ issuer, jti: claims.data.jti }),
        issuerConfigurationDigest,
        credentialKeyDigest: keyDigests.get(header.data.kid)!,
        actionUpperBound: [...actionMap.values()].sort((left, right) => left.uri.localeCompare(right.uri)),
      });
    },
  };
}
