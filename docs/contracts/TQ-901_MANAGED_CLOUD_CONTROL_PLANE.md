# TQ-901 — Managed Cloud control plane

> **Status:** source candidate complete; deployed-service gate open
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-901_CLOUD_CONTROL_PLANE_CERTIFICATION.json`

`@tasq-internal/cloud-control-plane` is a provider-neutral orchestration layer
around the deployable Tasq Server. A tenant owns isolated workspace rows,
opaque storage bindings, deployment references and secret-manager references.
The same workspace name may exist in two tenants without sharing any binding
or authority.

Provisioning commits an intent before provider I/O. The stable operation ID
deduplicates the control-plane request and the stable storage binding lets
`reconcileWorkspace` recover a lost provider response without allocating a
second authority domain. Concurrent quota checks are serialized around their
transaction; the database remains the cross-process lock.

Every administrative mutation asks the host authorization service for an
allow decision and records its decision ID and actor in the tenant-scoped
audit log. Tenant text, billing state and support access never create effect
authority. Provider adapters receive no Core internals and return opaque
references, never raw credentials.

This is checked-in source, not a running managed service. Production database,
secret manager, deployment identity, SLO and multi-region evidence remain
external.

The provider-neutral evidence fields and fail-closed validation route are
defined in
[`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json)
and the
[`production-readiness runbook`](../guides/MANAGED_CLOUD_PRODUCTION_READINESS.md).
They prepare the external deployment gate without changing this ticket's
status or selecting an infrastructure provider.
