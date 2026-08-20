import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createMutableClock } from "@tasq-run/schema";
import { createReferenceIdentityHandler } from "../src/reference-identity.js";

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function fixture() {
  const clock = createMutableClock(1_900_000_000_000);
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8",
  }).toString("base64url");
  let sequence = 0;
  const fetch = createReferenceIdentityHandler({
    issuer: "https://id.example/",
    clientId: "tasq-control",
    clientSecret: "client-secret",
    redirectUri: "https://control.example/oidc/callback",
    postLogoutRedirectUri: "https://control.example/",
    operatorSubject: "operator:one",
    operatorUsername: "operator",
    operatorPassword: "correct horse battery staple",
    signingKeyPkcs8: privateKey,
    clock,
    randomToken: () => `token-${++sequence}`,
  });
  return { clock, fetch };
}

function authorizationUrl(): string {
  const url = new URL("https://id.example/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "tasq-control",
    redirect_uri: "https://control.example/oidc/callback",
    scope: "openid profile",
    state: "state-one",
    nonce: "nonce-one",
  }).toString();
  return url.href;
}

describe("reference identity provider", () => {
  test("never mints an authorization code for an anonymous or wrong operator", async () => {
    const { fetch } = fixture();
    const anonymous = await fetch(new Request(authorizationUrl()));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic");

    const wrong = await fetch(new Request(authorizationUrl(), {
      headers: { authorization: basic("operator", "wrong") },
    }));
    expect(wrong.status).toBe(401);
  });

  test("binds a one-use expiring code to the exact client and redirect", async () => {
    const { clock, fetch } = fixture();
    const authorized = await fetch(new Request(authorizationUrl(), {
      headers: { authorization: basic("operator", "correct horse battery staple") },
    }));
    expect(authorized.status).toBe(303);
    const location = new URL(authorized.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://control.example/oidc/callback");
    expect(location.searchParams.get("state")).toBe("state-one");
    const code = location.searchParams.get("code")!;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "tasq-control",
      client_secret: "client-secret",
      redirect_uri: "https://control.example/oidc/callback",
    });
    const token = await fetch(new Request("https://id.example/token", { method: "POST", body }));
    expect(token.status).toBe(200);
    const result = await token.json() as { id_token: string };
    const payload = JSON.parse(Buffer.from(result.id_token.split(".")[1]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({
      iss: "https://id.example/",
      aud: "tasq-control",
      sub: "operator:one",
      nonce: "nonce-one",
    });
    expect(await fetch(new Request("https://id.example/token", { method: "POST", body }))).toMatchObject({ status: 400 });

    const second = await fetch(new Request(authorizationUrl(), {
      headers: { authorization: basic("operator", "correct horse battery staple") },
    }));
    const secondCode = new URL(second.headers.get("location")!).searchParams.get("code")!;
    clock.advance(60_001);
    const expired = await fetch(new Request("https://id.example/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: secondCode,
        client_id: "tasq-control",
        client_secret: "client-secret",
        redirect_uri: "https://control.example/oidc/callback",
      }),
    }));
    expect(expired.status).toBe(400);
  });

  test("restricts logout to the configured control origin", async () => {
    const { fetch } = fixture();
    expect((await fetch(new Request(
      "https://id.example/logout?post_logout_redirect_uri=https%3A%2F%2Fevil.example%2F",
    ))).status).toBe(400);
    const accepted = await fetch(new Request(
      "https://id.example/logout?post_logout_redirect_uri=https%3A%2F%2Fcontrol.example%2F",
    ));
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("https://control.example/");
  });
});
