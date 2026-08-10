# TQ-627 — Exact multi-party Agreements Module

> **Status:** source implemented and repository certified; publication remains
> part of the authorized `v0.4.0` release gate
> **Decision:** [`ADR-015`](../decisions/ADR-015_EXACT_AGREEMENTS_COMPILE_TO_COMMITMENTS.md)
> **Store format:** 31

## Interface

The embedded Interface exposes:

```text
agreements.offer(input)
agreements.get(offer ID, explicit time?)
agreements.list()
agreements.accept(offer ID, exact terms digest)
agreements.withdraw(offer ID, exact terms digest, reason)
agreements.reject(offer ID, exact terms digest, reason)
```

Terms contain sorted parties, sorted reciprocal obligations, arbitrary bounded
portable term data, and one existing resolution-policy specification per
obligation. Canonical safe-integer JSON is domain-separated and SHA-256
digested. The offer is limited to 65,536 canonical bytes.

The service context supplies every acting principal. Offer creation verifies
all parties are enabled in the workspace. Accept, withdraw and reject require
the exact stored terms digest. One party cannot accept twice. Only the offeror
can withdraw; only a party can reject.

## Atomic activation and amendment

The final party acceptance creates, in the same root transaction:

- the final immutable acceptance;
- one ordinary evidence-backed commitment per obligation;
- one TQ-612 resolution contract per commitment;
- one immutable activation naming the exact acceptance and compilation IDs.

A late policy error rolls all four categories back. Events are mirrored only
after the root commit.

An amendment is a new offer with `supersedesOfferId`. It preserves the exact
party set, but every party must accept its new digest. Activation finds the
nearest prior activation even through withdrawn or rejected intermediate
offers, cancels its non-terminal commitments and records
`supersedesActivationId`. Queries project the older agreement as
`superseded`; they never rewrite the old offer or acceptances.

## Deliberate separations

- assignment acceptance changes no agreement row;
- agreement acceptance grants no effect authority;
- amount and cancellation terms are not task columns and are not copied into
  commitment payloads;
- activation records entitlement-producing facts but does not claim escrow,
  payment, merchant-of-record or vendor-of-record behavior;
- `AGREEMENT_ACCEPTANCE_BINDER` authenticates exact acceptance bytes only when
  a host explicitly registers and pins that trusted implementation.

## Executable evidence

- `packages/tasq-schema/src/agreements.ts` freezes terms, offer, acceptance,
  termination, activation and projection contracts;
- `packages/tasq-core/src/migrations/0031_agreements.sql` makes all four ledgers
  append-only;
- `packages/tasq-core/src/service/agreements.ts` owns exact digest checks,
  transactional compilation, amendment and custom signed binding;
- `packages/tasq-core/test/agreements.test.ts` covers exact digest mismatch,
  assignment separation, atomic rollback, reciprocal compilation, withdrawal,
  rejection, expiry, amendment, signed binding, SQLite immutability and
  portable restore.

