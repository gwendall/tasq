# TQ-903 — Cloud identity, device and workload lifecycle

> **Status:** source candidate complete; identity-provider gate open
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-903_CLOUD_IDENTITY_CERTIFICATION.json`

Human identity subjects are HMACed with a control-plane pepper before storage.
Browser session and CSRF tokens are random and only keyed digests are stored.
A session is bound to one tenant, principal, enrolled device, tenant epoch and
principal recovery revision.

Device revocation invalidates all of its sessions. Verified human recovery
increments the recovery revision and invalidates every principal session.
Tenant suspension increments the tenant epoch, revokes all sessions and
suspends its workspaces. Workload principals reference credentials held by an
external secret manager; workload revocation is revision-checked and does not
depend on browser sessions.

The caller remains responsible for proving the upstream identity or recovery
event before invoking these methods. The source candidate does not implement
an OAuth callback, email recovery, passkeys or secret-manager issuance.
Real OIDC, workload issuance, recovery and revocation evidence is recorded
only through the external gates in
[`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json);
opaque references never substitute for upstream identity proof.
