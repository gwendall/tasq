# TQ-625 — Provider-neutral Attestations Module

> **Status:** source implemented and repository certified; publication remains
> part of the authorized `v0.4.0` release gate
> **Decision:** [`ADR-013`](../decisions/ADR-013_ATTESTATION_TRUST_AND_ELIGIBILITY.md)
> **Store format:** 30

## Public contract

The embedded Interface exposes:

```text
attestations.issue(assertion)
attestations.revoke(id, reason)
attestations.get(id)
attestations.getRevocation(id)
attestations.current(subject, purpose?, at)
attestations.evaluate(subject, exact requirements, at)
```

An assertion freezes an authenticated issuer, exact subject, purpose/version,
canonical scope, typed claim/version/digest, evidence references, validity
interval, optional predecessor and content digest. Scope entries are unique and
sorted. Supersession preserves issuer, subject, purpose and scope; it may change
the claim or evidence.

Revocation is a separate append-only record. Core accepts it only from the
original issuer principal and never mutates or deletes the assertion. A second
revocation fails closed. SQLite triggers reject direct updates and deletes for
both ledgers. Caller-scoped idempotency keys replay exact issue/revoke results
and reject conflicting key reuse.

## Current and eligibility semantics

Every current query carries an explicit authority time. An assertion is current
only when:

- `notBefore <= at` and `expiresAt` is absent or greater than `at`;
- no successor valid by `at` names it as predecessor;
- no revocation effective by `at` names it;
- workspace, subject identity/digest and optional purpose/version match.

Eligibility requirements pin accepted issuer principals, purpose/version,
claim type/version, optional claim digest and required scope entries. The
result lists its basis assertions and failed requirement indexes. Its assurance
block explicitly says issuer authentication is not established by eligibility,
claim truth and availability are not asserted, and authority is not granted.

## Signed issuer proof

`ATTESTATION_ISSUANCE_BINDER` is a custom trusted binder, not a new central
enum case. `attestationStatementBinding(record)` pins its URI, version and
implementation digest. It checks workspace-local record existence, exact whole
record digest and equality between the signed issuer and stored issuer.

The signature layer continues to report only validity at acceptance. The
attestation and eligibility layers do not infer truth or authority from it.

## Executable evidence

- `packages/tasq-core/test/attestations.test.ts` covers licence, site access,
  software provenance, wrong purpose, expiry, supersession, revocation,
  cross-workspace rejection, issuer-only revocation, signed binding and
  portable restore;
- `packages/tasq-service/test/migrations-events.test.ts` covers migration 30
  across fresh and populated historical stores;
- `packages/tasq-service/test/data-safety.test.ts` covers snapshot, recovery,
  process-loss and portable round-trip at format 30;
- `packages/tasq-core/src/service/attestations.ts` is the provider-neutral
  service boundary; no provider, marketplace, licence taxonomy or access
  policy is compiled into Core.
