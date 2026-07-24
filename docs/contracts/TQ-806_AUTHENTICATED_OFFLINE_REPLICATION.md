# TQ-806 — Authenticated optional offline replication

> **Status:** source candidate complete; protected Server artifact gate open
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-806_OFFLINE_REPLICATION_CERTIFICATION.json`

Tasq Server now composes the existing ADR-003/TQ-405 replication protocol with
the ADR-004 authority guard and TQ-613–TQ-616 signed-origin primitive.

## Remote journey

An authorized, sender-constrained caller:

1. registers one UUID replica/generation through `replication.enroll`;
2. initializes an offline Core store with the returned authority identity;
3. queues only the v1 offline-speculative commitment create/update/delete/
   restore operations;
4. signs every exact operation digest for the
   `replication-operation-origin` purpose;
5. pushes the bounded batch through `replication.push`;
6. pulls incremental results or a verified recovery snapshot through
   `replication.pull`;
7. acknowledges/rebases locally with the existing TQ-405 APIs.

All three operations are discovered through the existing REST and remote MCP
catalog and use the same live authority writer gate and durable idempotency
receipt as every hosted mutation.

## Identity and atomicity

Migration 28 permanently binds a replica identity and every generation to one
authenticated authority principal. Another principal cannot re-register,
push or pull that identity.

Every pushed operation must also carry one valid, purpose-bound signed origin:

- signer principal equals the authenticated transport principal;
- workspace, audience, operation digest and purpose are signed;
- credential is active under one configured trust root at the injected
  acceptance instant;
- the signed proof, public credential snapshot, nonce, binding and accepted
  replication operation commit in the same SQLite transaction.

A missing, duplicated, tampered, wrong-purpose or foreign-principal proof
rejects the operation before application. Exact response-loss retry is
idempotent.

## Authority boundary

Offline v1 remains deliberately narrow. It cannot claim or renew work, acquire
resource leases, approve or dispatch effects, change credentials or authority
policy, complete contested work or resolve conflicts. Those actions require a
fresh online guarded operation. A valid signature does not widen that set.

Stale/revoked generations, authority-epoch drift and expired cursors fail
closed. Cursor recovery returns the explicit snapshot and visible unresolved
conflicts. Restoring an older authority rotates the epoch and marks every old
generation stale.

This source candidate is not yet a shipped Server support claim. TQ-806 closes
only when the same matrix passes against the protected published Server digest
and supported clients.
