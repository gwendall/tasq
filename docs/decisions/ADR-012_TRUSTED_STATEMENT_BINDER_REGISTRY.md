# ADR-012 — Trusted statement binder registry

> **Status:** Accepted — 2026-08-10
> **Decision owner:** `@gwendall`
> **Execution:** TQ-624

## Context

A valid signature authenticates exact bytes; it does not establish that the
named subject exists, that its digest is current, or that the issuer had the
required authority. TQ-615 therefore bound six signed purposes to six typed
Core lookups. That implementation was safe but closed: every agreement,
attestation, mandate or custody purpose would require editing one central enum,
one SQL `CHECK` and one service switch.

The extension seam must preserve the same fail-closed target checks without
letting workspace data select or supply executable code.

## Considered designs

### Keep the central switch

Each new purpose edits Core and the database constraint. This is easy to audit
for six cases, but makes domain Modules accumulate inside the universal Kernel
and forces unrelated store migrations. It has low extensibility and no stable
host registration seam.

### Persist a query language or executable binder

Store SQL, JavaScript, WASM or a target-query DSL beside each purpose. This is
portable as data but turns an imported ledger into executable authority. A DSL
also becomes a second database and authorization language whose semantics every
SDK must reproduce. This design is rejected.

### Pair portable descriptors with trusted host implementations

Freeze purpose, subject, record and binder identity in a language-neutral
descriptor. A host constructs a registry from code it already trusts. The
store records the exact descriptor used, but never loads executable code from
that descriptor. Unknown, duplicate, stale or unpinned custom registrations
fail closed.

## Decision

Tasq adopts the third design.

`tasq.statement-binder.v1` contains an open `bindingKind`, exact purpose URI
and version, subject type, record type, signature-profile constraint, freshness
and revision requirements, online-authority requirement, and the binder URI,
version and implementation digest. `StatementBinderRegistry` pairs those bytes
with trusted host functions for target and, when declared, authority checks.

Registration is process-local and explicit. Workspace stores never install or
execute binder code. Every non-built-in acceptance must pin the binder URI,
version and implementation digest so a deployment change cannot silently
reinterpret a caller's request.

The common acceptance path verifies exact purpose version, subject type,
record type, subject digest, profile policy, freshness and required revision.
The registered implementation must then prove record existence and its
workspace-specific digest. A binder declaring online authority cannot register
without an authority assertion implementation.

Migration 29 removes the closed SQL enum and freezes the full descriptor into
each append-only binding. It backfills all six historical binders with their
versioned implementation digests. Portable export therefore transports the
interpretation used at acceptance while the receiving host remains free to
decline unsupported code.

## Consequences

- agreement, attestation, mandate and experimental custody Modules can add
  exact purposes without another central binding enum;
- a signature still grants no truth, eligibility or authority by itself;
- registry construction is a trusted deployment operation, not a workspace
  mutation or extension marketplace;
- changing binder semantics requires a new version or implementation digest;
- cross-language SDKs exchange descriptors and pins, not executable binders;
- source store format advances from 28 to 29 and the `v0.4.0` candidate must be
  recertified against that exact format before publication.
