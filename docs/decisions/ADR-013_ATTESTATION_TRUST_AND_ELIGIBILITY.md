# ADR-013 — Attestation trust and eligibility separation

> **Status:** Accepted — 2026-08-10
> **Decision owner:** `@gwendall`
> **Execution:** TQ-625

## Context

Delegated action needs durable claims such as “this technician holds licence
X”, “this principal may enter site Y”, or “this artifact came from build Z”. A
single badge model is unsafe: it collapses the issuer's assertion, signature
authentication, claim truth, policy sufficiency, current availability and
authority to act into one ambiguous boolean.

The durable primitive is an assertion with a lifecycle. The consuming policy
must remain explicit and authority must continue through Tasq's existing
authority/effect controls.

## Considered designs

### Store a mutable qualification badge

This makes current reads simple but destroys history, makes retroactive audit
ambiguous and encourages callers to treat a badge as permission. Rejected.

### Store policy-specific eligibility decisions

This preserves why one workflow accepted a claim, but duplicates every
consumer's policy in Core and makes old decisions look current after expiry or
revocation. Eligibility is a projection and may be recorded by a higher layer
when needed; it is not the source assertion. Rejected as the primitive.

### Append assertions and revocations; derive exact policy decisions

An issuer creates a purpose-scoped assertion about one exact subject, scope,
claim, validity interval and evidence set. Revocation is a separate append-only
record. A successor can replace only an assertion with the same issuer,
subject, purpose and scope. Consumers evaluate pinned issuer, purpose, claim
version/digest and required scope at an explicit authority time.

## Decision

Tasq adopts the third design.

`tasq.attestation.v1` stores issuer, subject, purpose, canonical scope, typed
claim and digest, evidence references, validity, optional predecessor and an
exact whole-record digest. The authenticated service context supplies the
issuer; callers cannot name another issuer. `tasq.attestation-revocation.v1`
is append-only and only the original issuer principal can create it in Core.
Delegated issuer authority, if required, must be proven through the separate
Mandates Module.

`current(subject, purpose?, at)` uses an explicit Unix-ms authority time. It
rejects not-yet-valid, expired, superseded and effectively revoked assertions.
`evaluate(subject, requirements, at)` returns a derived, non-authoritative
decision whose assurance block states that claim truth, authority and
availability are not asserted.

A custom TQ-624 binder authenticates exact attestation bytes. The host must
register and pin its trusted implementation. Signature acceptance proves the
credential/issuer binding at acceptance; it does not upgrade the claim to
truth or sufficiency.

Migration 30 adds only the assertion and revocation ledgers. Both are included
in portable workspace export.

## Consequences

- licence, access and software provenance share one provider-neutral shape;
- policies can evolve without rewriting historical assertions;
- past-time queries are reproducible after later supersession or revocation;
- a signed claim still grants no effect authority;
- append-only revocation has no “unrevoke”; a fresh assertion is required;
- source store format advances to 30 and protected release certification must
  target the final candidate format before publication.
