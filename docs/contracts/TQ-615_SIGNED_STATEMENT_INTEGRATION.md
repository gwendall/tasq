# TQ-615 — Signed-statement domain and surface integration

> **Status:** done in source
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-615_SIGNED_STATEMENT_CERTIFICATION.json`

Tasq now persists an accepted principal statement as four separate,
append-only facts: the exact canonical statement and bundle, the verification
record at one injected acceptance instant, a frozen public credential
snapshot, and a typed domain binding. A valid signature is still neither
semantic truth nor authority.

## Durable boundary

Migration 27 adds immutable tables for statements, verification records,
credential snapshots, nonces, typed bindings and workspace checkpoints.
Acceptance is one Core transaction after a host-injected verifier has resolved
an enrolled credential. The deployable Server runs that verification and the
domain transaction while its authority writer gate is held, so credential
revocation cannot commit in the middle.

The six v1 binders are:

- artifact authorship;
- artifact acceptance;
- completion attestation;
- effect approval;
- replication-operation origin;
- workspace checkpoint.

Each binder checks an exact existing record identity and digest. It does not
create that record, grant eligibility, complete a commitment, issue an effect
permit, dispatch a connector or resolve a replication conflict.

## Surfaces

- Core and the embedded client expose exact proof and bounded binding reads.
- Server exposes guarded `statement.accept` through the same REST and remote
  MCP operation catalog and requires an operator-configured signing trust-root
  allowlist.
- Local CLI exposes `signature show` and `signature bindings`.
- Local MCP exposes the equivalent read tools; it deliberately exposes no
  arbitrary-byte signer.
- Console renders “valid at acceptance” together with explicit
  “current credential state not asserted”, “truth not asserted” and
  “authorization not granted” labels.
- discovery advertises the installed signed-statement read contract.

Signing remains a host concern. Tasq accepts public credential material and a
signature bundle; it never accepts a private key, secret signer handle or
generic `sign(bytes)` capability.

## Portable data and recovery

Portable export preserves retained statements, verifications, public
credential snapshots, nonces, bindings and checkpoints. Private signing
material cannot enter the schema and is scanned out by tests.

Replication authority records are intentionally outside the portable Local
export. Therefore replication-origin statements and bindings are pruned from
that export as one complete proof-dependent unit instead of becoming dangling
proof. All other retained proof round-trips through a new store.

A workspace checkpoint signs the exact portable root computed in the same
SQLite write transaction. It does not claim rollback resistance unless an
independent witness retains the checkpoint outside the database.

## Compatibility

Historical records remain unsigned. The existing `add → list → done` journey
has no signing ceremony or key dependency. Exact replay returns the original
accepted result; reuse of a statement identity with different bytes conflicts;
nonce uniqueness admits at most one racing acceptance.

Public support remains blocked on TQ-616's protected, downloaded-byte gate.
