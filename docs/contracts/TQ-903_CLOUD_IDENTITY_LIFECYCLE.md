# TQ-903 — Cloud identity, device and workload lifecycle

> **Status:** lifecycle drill passed; identity-provider gate open
> **Date:** 2026-08-20
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

The 2026-08-13 operator drill proved recovery-revision, device-revocation and
workload-revocation invalidation against the experimental composition. The
caller remains responsible for proving the upstream identity or recovery event
before invoking these methods. The reference adapter is not a real identity
provider and does not implement email recovery, passkeys or secret-manager
workload issuance. Its fail-closed Basic authentication boundary was deployed
and browser-replayed on 2026-08-20, but that bounded proof does not close the
real OIDC or workload issuance gates. Their evidence is recorded only
through the external gates in
[`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json);
opaque references never substitute for upstream identity proof.
