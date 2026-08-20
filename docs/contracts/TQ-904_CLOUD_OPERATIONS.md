# TQ-904 — Cloud lifecycle and operations

> **Status:** provider backup/restore and rotation drills passed; human gate open
> **Date:** 2026-08-20
> **Machine certificate:** `TQ-904_CLOUD_OPERATIONS_CERTIFICATION.json`

The control plane implements:

- per-tenant workspace quotas with a concurrent admission test;
- expiring exports and backups with digest-bearing provider receipts;
- an injected-clock retention sweep that removes expired artifact references;
- exact-name destructive confirmation and retry-safe provider deletion;
- stable-ID backup creation and restore into the existing storage binding;
- stable-ID credential-reference rotation, with old raw references removed;
- time-bounded, tenant/scoped support grants and explicit revocation;
- incident records and billing bindings that explicitly grant no authority.

Provider backup, restore, rotation and deletion callbacks must be idempotent on
their documented stable IDs. The control plane stores opaque references only.
On 2026-08-13 the experiment passed native Server restore, encrypted off-site
object restore, secret-reference rotation and control-plane operations drills.
The earlier operations record contains the then-current Server deployment
reference; the later bootstrap record is the authoritative reconciliation to
the protected `v0.4.0` digest.

Provider export plus verified byte deletion and a previously unbriefed on-call
incident/support-access drill remain open. No SLA follows from these tests.

Retention currently governs exported/backup artifact references and expired
support grants. Ledger retention remains the underlying Server’s policy and
cannot be silently shortened by Cloud.

The remaining provider drills, SLO/RPO/RTO fields, multi-region recovery
evidence and safe evidence-reference format are defined in the
[`production-readiness runbook`](../guides/MANAGED_CLOUD_PRODUCTION_READINESS.md).
A failed drill remains failed evidence until a new protected run passes.
