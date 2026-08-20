import { describe, expect, test } from "bun:test";
import {
  OIDC_FUTURE_CLOCK_SKEW_MS,
  oidcTemporalClaimsAccepted,
} from "../src/oidc-claims.js";

describe("OIDC temporal claims", () => {
  const observedAt = 1_900_000_000_000;

  test("accepts bounded issuer clock skew without extending expiry", () => {
    expect(oidcTemporalClaimsAccepted({
      iat: (observedAt + OIDC_FUTURE_CLOCK_SKEW_MS) / 1_000,
      auth_time: (observedAt + OIDC_FUTURE_CLOCK_SKEW_MS) / 1_000,
      exp: observedAt / 1_000 + 300,
    }, observedAt)).toBe(true);

    expect(oidcTemporalClaimsAccepted({
      iat: observedAt / 1_000 - 300,
      auth_time: observedAt / 1_000 - 300,
      exp: observedAt / 1_000,
    }, observedAt)).toBe(false);
  });

  test("rejects excessive future skew and oversized token lifetimes", () => {
    expect(oidcTemporalClaimsAccepted({
      iat: (observedAt + OIDC_FUTURE_CLOCK_SKEW_MS + 1_000) / 1_000,
      auth_time: observedAt / 1_000,
      exp: observedAt / 1_000 + 300,
    }, observedAt)).toBe(false);

    expect(oidcTemporalClaimsAccepted({
      iat: observedAt / 1_000,
      auth_time: observedAt / 1_000,
      exp: observedAt / 1_000 + 301,
    }, observedAt)).toBe(false);
  });
});
