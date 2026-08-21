# TQ-901 — Managed Cloud control plane

> **Status:** managed-database Fly experiment deployed; independent review gate open
> **Date:** 2026-08-21
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

That composition originally used one encrypted-volume SQLite control database.
It remains a private experiment, not an available managed service or a public
SLA.

The current source can now bind the same control-plane service to a remote
libSQL database with a credential-free URL and separately supplied token. It
also provides a create-only, WAL-safe local migration snapshot and a
deterministic verifier over every `cloud_*` table's schema and ordered row
contents. An explicit maintenance mode rejects every non-health route while
the final snapshot and import run, closing the late-write loss window. The Fly
workflow refuses managed database mode unless the remote database URL and token
exist as encrypted app secrets. The complete non-destructive migration and
rollback sequence is in
[`deploy/managed-cloud/README.md`](../../deploy/managed-cloud/README.md).

On 2026-08-21, the final create-only snapshot of the maintained Fly database
was imported into delete-protected Turso database
`01a02434-b001-797c-8fbd-ddd59d3c8904` in group `tasq-production`. The local
snapshot was 184320 bytes with SHA-256
`3f58db88c6be7680925b1bb29e384c2ca470de0605feb2f0708117babc277580`;
the verifier matched every table schema and ordered row digest after import.
The old encrypted volume and both migration snapshots remain mounted and
untouched as rollback assets.

Protected workflow run
[`32483015765`](https://github.com/gwendall/tasq/actions/runs/32483015765)
deployed source commit `2d8ee6dd3b2a83ab59e4519330477eb21291877a`
in explicit `managed` mode and passed health, readiness, authentication,
Chromium, Firefox and WebKit certification. Probe credentials were invalidated;
the deployed database token is bounded to 30 days. This closes the database
replacement half of TQ-901. Independent multi-tenant infrastructure review is
still external and cannot be self-authored by the implementation agent.

Turso's current AWS Developer group is single-location. Provider durability or
point-in-time restore must not be described as multi-region recovery; that
remains a separate production-readiness gate.

The provider-neutral evidence fields and fail-closed validation route are
defined in
[`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json)
and the
[`production-readiness runbook`](../guides/MANAGED_CLOUD_PRODUCTION_READINESS.md).
They define the remaining production gate without turning the experiment into
a support claim or selecting Fly as the permanent provider.
