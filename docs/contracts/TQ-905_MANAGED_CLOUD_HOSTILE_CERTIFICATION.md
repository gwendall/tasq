# TQ-905 — Managed Cloud hostile source certification

> **Status:** repository candidate complete; independent operations gate open
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-905_CLOUD_HOSTILE_CERTIFICATION.json`

The executable source matrix creates two tenants with colliding workspace
names and proves distinct storage bindings, tenant-scoped reads, tenant-scoped
support grants and cross-tenant backup/rotation rejection. A concurrent
one-slot quota race admits exactly one workspace.

The same matrix covers denied administrator authority, missing/incorrect CSRF,
foreign browser origin, remote-effect denial, device revocation, recovery
epoch invalidation, tenant suspension, workload revocation, provider failure
and reconciliation, credential-reference rotation, backup/restore, export
expiry, explicit support revocation, deletion confirmation and retry after an
unknown provider outcome.

A byte scan proves raw identity subjects, browser tokens, Server credentials
and replaced secret references are not retained in the control database.

This is not a production certification. It does not prove a real infrastructure
provider, multi-region failover, off-site restore, secret-manager rotation,
external penetration testing or an on-call operator. Those remain required
before Tasq Cloud can be advertised as available.

The complete external matrix is frozen in
[`MANAGED_CLOUD_PRODUCTION_READINESS.template.json`](MANAGED_CLOUD_PRODUCTION_READINESS.template.json).
Its validator may report `ready_for_maintainer_decision`; it never changes
`managedCloudAvailable`, enables remote effects or self-approves an independent
review.
