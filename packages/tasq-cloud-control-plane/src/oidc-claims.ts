export interface OidcTemporalClaims {
  iat: number;
  exp: number;
  auth_time: number;
}

export const OIDC_FUTURE_CLOCK_SKEW_MS = 30_000;

export function oidcTemporalClaimsAccepted(
  claims: OidcTemporalClaims,
  observedAt: number,
): boolean {
  const latestAcceptedIssueTime = observedAt + OIDC_FUTURE_CLOCK_SKEW_MS;
  return claims.exp * 1_000 > observedAt &&
    claims.iat * 1_000 <= latestAcceptedIssueTime &&
    claims.auth_time * 1_000 <= latestAcceptedIssueTime &&
    claims.exp - claims.iat <= 300;
}
