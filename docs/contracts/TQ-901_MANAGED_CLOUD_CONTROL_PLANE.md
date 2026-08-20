# TQ-901 — Managed Cloud control plane

> **Status:** experimental Fly composition deployed; production review gate open
> **Date:** 2026-08-20
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

On 2026-08-13 the source candidate was exercised as an experimental Fly
composition at `control.tasq.run`. It reconciled an opaque storage binding,
Fly secret references and the exact protected `v0.4.0` Server digest. The
compact record is `../../evidence/cloud-bootstrap-2026-08-13.json`.

On 2026-08-20 protected workflow run
[`32406910459`](https://github.com/gwendall/tasq/actions/runs/32406910459)
redeployed the current control and fail-closed reference-identity runtimes from
source commit `70325474fd795eb8cc5db05044d989ae0469c1dc`, while retaining the
exact certified Server digest. The compact, secret-free deployment record is
`../../evidence/managed-cloud-deployment-2026-08-20.json`.

That composition uses one encrypted-volume SQLite control database. It is a
private experiment, not a running managed service or a production database
claim. Independent acceptance or replacement of that database, infrastructure
review, SLO and multi-region evidence remain external.

The provider-neutral evidence fields and fail-closed validation route are
defined in
[`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json)
and the
[`production-readiness runbook`](../guides/MANAGED_CLOUD_PRODUCTION_READINESS.md).
They define the remaining production gate without turning the experiment into
a support claim or selecting Fly as the permanent provider.
