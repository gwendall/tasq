# TQ-614 — Signing credential authority

> **Status:** done
> **Date:** 2026-07-24

Signing credentials live in the separate Server authority database, never in
the workspace ledger. Migration `0003_signing_credentials` records immutable
Ed25519 public material, its digest, principal/workspace/profile/trust-root
binding, an honest isolation class and append-only lifecycle events.

Enrollment verifies possession of the exact public key over a
domain-separated challenge binding workspace, principal and credential ID.
The host must supply the already-authorized authority decision identity.
Private material is neither accepted nor stored.

Lifecycle updates require the exact current revision. Suspension can resume;
revocation, compromise and retirement are terminal. Compromise can retain an
earliest defensible effective time without trusting signer `issuedAt`.
Rotation/recovery creates a new immutable credential and links/retire the old
one rather than replacing key bytes under an existing ID.

Isolation is explicit:

- `shared_user_software`;
- `isolated_process`;
- `hardware`;
- `kms`;
- `webauthn`;
- `workload_identity`.

The label is an assurance fact, not permission. The Extension SDK signer
accepts a parsed registered-purpose payload and internally constructs
canonical bytes and PAE; it exposes no generic `sign(bytes)` surface to an
agent. Verification returns a typed result and performs no domain mutation.
