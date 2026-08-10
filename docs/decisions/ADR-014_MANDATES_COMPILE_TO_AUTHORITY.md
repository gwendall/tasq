# ADR-014 — Mandates compile to live authority

> **Status:** Accepted — 2026-08-10
> **Decision owner:** `@gwendall`
> **Execution:** TQ-626

## Context

Humans and agents need to express “principal A may perform these actions on
this target until this time” in readable form. Tasq already has the security
truth required to enforce that statement: immutable permission definitions,
live grants, delegations, scopes, validity windows, effect approvals and an
authorization decision ledger.

Persisting a separate mutable `mandate` permission record would create two
answers to the same security question. Adding arbitrary `budget` or `maxUses`
JSON without an evaluator and usage ledger would be worse: the API would claim
a bound that the authorization path does not enforce.

## Decision

`tasq.mandate-intent.v1` is a compiler input and `tasq.mandate-view.v1` is a
projection. Neither is a new authority record.

Issuance atomically creates one immutable permission set, one subject grant,
and, when an actor is named, one actor grant plus one exact delegation. All
records share target scope and validity. The authenticated mutation actor must
be the named grantor. Inspection reconstructs the intent from those rows and
fails closed if their identities, digests, lifecycle or revisions diverge.
Revocation atomically revokes every live component under one workspace
authority revision. The permission definition remains immutable history.

The v1 compiler accepts only `maxOperations: null` and `budget: null`.
Non-null generic bounds return typed compile errors. Monetary and provider
limits continue through the existing effect approval and dispatch policy,
where they are actually checked against a canonical request. Remote
`effect.dispatch` cannot be placed in a mandate before TQ-906.

`authorizeMandate` validates the selected mandate, then re-enters the existing
live authorizer. Its public denial projection includes the resource kind and a
canonical digest, never the protected target identifier. It does not infer an
allow from stored intent.

## Consequences

- readable delegation cannot drift from effective authority;
- a concurrent revoke and authorize serialize at the existing authority gate;
- the request after a committed revocation is denied even if an older request
  ID had previously been allowed;
- equivalent grants may coexist without changing mandate semantics;
- generic quotas and budgets remain visibly unsupported until Tasq has a
  universal enforcing ledger;
- remote side effects remain unavailable from this interface.

