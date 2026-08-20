# TQ-905 — Managed Cloud hostile certification

> **Status:** source and experimental provider drills complete; independent gate open
> **Date:** 2026-08-20
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

The 2026-08-13 experiment additionally bound the exact protected Server image,
rotated an opaque Fly secret reference and restored a native backup from an
encrypted off-site object. Those records close those bounded automated gates.

This is not a production certification. The current fail-closed reference
identity source still needs deployment and browser replay. Region failover,
external multi-tenant security review and a previously unbriefed incident
operator also remain required before Tasq Cloud can be advertised as available.

The complete external matrix is frozen in
[`MANAGED_CLOUD_PRODUCTION_READINESS.template.json`](MANAGED_CLOUD_PRODUCTION_READINESS.template.json).
Its validator may report `ready_for_maintainer_decision`; it never changes
`managedCloudAvailable`, enables remote effects or self-approves an independent
review.
