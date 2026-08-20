import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import type { Clock } from "@tasq-run/schema";

export interface ReferenceIdentityOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  operatorSubject: string;
  operatorUsername: string;
  operatorPassword: string;
  signingKeyPkcs8: string;
  clock: Clock;
  randomToken?: () => string;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function json(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function basicCredentials(request: Request): { username: string; password: string } | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function operatorAuthenticated(
  request: Request,
  username: string,
  password: string,
): boolean {
  const credentials = basicCredentials(request);
  return credentials !== null &&
    same(credentials.username, username) &&
    same(credentials.password, password);
}

/**
 * Reference-only OIDC provider for the single-operator private beta.
 *
 * HTTP Basic is an explicit outer authentication gate; the provider must
 * never mint an authorization code from an anonymous request. This remains a
 * bounded beta adapter, not a general identity provider or a production Cloud
 * support claim.
 */
export function createReferenceIdentityHandler(options: ReferenceIdentityOptions) {
  if (options.operatorUsername.includes(":")) {
    throw new Error("reference identity operator username cannot contain ':'");
  }
  const issuerUrl = new URL(options.issuer);
  const issuer = issuerUrl.href;
  const redirectUri = new URL(options.redirectUri).href;
  const postLogoutRedirectUri = new URL(options.postLogoutRedirectUri).href;
  const privateKey = createPrivateKey({
    key: Buffer.from(options.signingKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  const keyId = "tasq-id-ed25519-2026-08";
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const codes = new Map<string, { nonce?: string; expiresAt: number }>();

  function encoded(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }

  function idToken(now: number, nonce?: string): string {
    const nowSeconds = Math.floor(now / 1_000);
    const header = encoded({ typ: "JWT", alg: "EdDSA", kid: keyId });
    const payload = encoded({
      iss: issuer,
      aud: options.clientId,
      sub: options.operatorSubject,
      iat: nowSeconds,
      exp: nowSeconds + 300,
      auth_time: nowSeconds,
      nonce,
    });
    const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      return json({ status: "ok", authorizationCodeAuthentication: "http_basic" });
    }
    const forwardedProto = request.headers.get("fly-forwarded-proto") ??
      request.headers.get("x-forwarded-proto");
    const publicOriginMatches = url.origin + "/" === issuer ||
      (request.headers.get("host") === issuerUrl.host &&
        forwardedProto === issuerUrl.protocol.slice(0, -1));
    if (!publicOriginMatches) return new Response("not found", { status: 404 });
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: new URL("authorize", issuer).href,
        token_endpoint: new URL("token", issuer).href,
        jwks_uri: new URL("jwks.json", issuer).href,
        end_session_endpoint: new URL("logout", issuer).href,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["EdDSA"],
        scopes_supported: ["openid", "profile"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.pathname === "/jwks.json") {
      return json({ keys: [{ ...publicJwk, use: "sig", alg: "EdDSA", kid: keyId }] });
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      if (!operatorAuthenticated(request, options.operatorUsername, options.operatorPassword)) {
        return new Response("authentication required", {
          status: 401,
          headers: {
            "www-authenticate": 'Basic realm="Tasq private beta", charset="UTF-8"',
            "cache-control": "no-store",
          },
        });
      }
      if (url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("client_id") !== options.clientId ||
        url.searchParams.get("redirect_uri") !== redirectUri ||
        !url.searchParams.get("state") ||
        !url.searchParams.get("scope")?.split(" ").includes("openid")) {
        return new Response("invalid authorization request", { status: 400 });
      }
      const now = options.clock.now();
      for (const [code, record] of codes) {
        if (record.expiresAt <= now) codes.delete(code);
      }
      if (codes.size >= 1_024) {
        return new Response("authorization capacity exhausted", {
          status: 503,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        });
      }
      const code = randomToken();
      codes.set(code, {
        nonce: url.searchParams.get("nonce") ?? undefined,
        expiresAt: now + 60_000,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state")!);
      return Response.redirect(target, 303);
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const now = options.clock.now();
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "";
      const record = codes.get(code);
      if (body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== options.clientId ||
        !same(body.get("client_secret") ?? "", options.clientSecret) ||
        body.get("redirect_uri") !== redirectUri ||
        !record || record.expiresAt <= now) {
        return json({ error: "invalid_grant" }, 400);
      }
      codes.delete(code);
      return json({
        token_type: "Bearer",
        access_token: randomToken(),
        expires_in: 300,
        id_token: idToken(now, record.nonce),
      });
    }
    if (request.method === "GET" && url.pathname === "/logout") {
      if (url.searchParams.get("post_logout_redirect_uri") !== postLogoutRedirectUri) {
        return new Response("invalid logout redirect", { status: 400 });
      }
      return Response.redirect(postLogoutRedirectUri, 303);
    }
    return new Response("not found", { status: 404 });
  };
}
