# TQ-624 — Trusted signed-statement binder registry

> **Status:** source implemented and repository certified; publication remains
> part of the authorized `v0.4.0` release gate
> **Decision:** [`ADR-012`](../decisions/ADR-012_TRUSTED_STATEMENT_BINDER_REGISTRY.md)
> **Store format:** 29

## Outcome

The signed-statement acceptance seam is no longer a central six-value switch.
A trusted host supplies `TrustedStatementBinder` implementations through a
`StatementBinderRegistry`; every implementation carries one portable
`tasq.statement-binder.v1` descriptor. Custom callers pin the binder URI,
version and implementation digest on acceptance.

The common acceptance path rejects:

- unknown binding kinds;
- duplicate kind, purpose-version or implementation registrations;
- stale implementation pins;
- purpose, version, subject-type, record-type, digest or profile drift;
- missing expected revisions and stale statements when the descriptor requires
  them;
- an online-authority binder without a trusted authority assertion;
- targets absent from the accepting workspace;
- reuse of one statement identity with another registered binding.

The target implementation still owns the exact record lookup and stored digest
comparison. Authentication, semantic truth, eligibility and authority remain
separate claims.

## Historical compatibility

Migration `0029_statement_binder_registry.sql` rebuilds only the append-only
binding table, removes its closed six-value `CHECK`, and backfills exact
descriptors for:

1. artifact authorship;
2. artifact acceptance;
3. completion attestation;
4. effect approval;
5. replication operation origin;
6. workspace checkpoint.

Their existing target queries and purpose URIs are unchanged. The descriptor
is persisted in every new row and validated against the binding kind and record
type when read.

## Portability and language boundary

Portable workspace export already includes signed-statement bindings. Format
29 therefore carries each descriptor with the proof. Import restores the exact
descriptor bytes without installing code or asserting that the destination
supports execution.

`statement-binder-registry-vector.json` freezes a custom custody descriptor,
its canonical bytes, SHA-256 digest and rejection vocabulary. TypeScript and an
independent standard-library Python fixture reproduce the same digest.

## Executable evidence

- `packages/tasq-core/test/signed-statements.test.ts` covers the six migrated
  semantics and portable signed-proof restore;
- `packages/tasq-core/test/statement-binder-registry.test.ts` covers custom
  registration, unknown/stale/conflicting/cross-workspace rejection and
  portable restore;
- `packages/tasq-evals/statement-binder-registry-cross-language.test.ts` covers
  TypeScript/Python descriptor agreement;
- `packages/tasq-service/test/migrations-events.test.ts` covers the full
  migration sequence and populated historical stores;
- `packages/tasq-service/test/data-safety.test.ts` covers the verified recovery
  envelope for the new store format.
