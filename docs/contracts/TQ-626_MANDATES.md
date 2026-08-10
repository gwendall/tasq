# TQ-626 — Mandates Module

> **Status:** source implemented and repository certified; publication remains
> part of the authorized `v0.4.0` release gate
> **Decision:** [`ADR-014`](../decisions/ADR-014_MANDATES_COMPILE_TO_AUTHORITY.md)
> **Storage:** projection over the TQ-802 authority store; no migration or
> mandate table

## Interface

The private Server composition exposes four operations:

```text
authority.issueMandate(intent, mutation context)
authority.inspectMandate(workspace, mandate ID)
authority.authorizeMandate(mandate ID, authorization request)
authority.revokeMandate(workspace, mandate ID, expected revision, context)
```

The intent names one grantor, one subject, an optional distinct actor, exact
registered action identities, workspace-wide or exact target scope, and an
optional validity window. Actions must be canonical, unique and sorted.

Issuance compiles, in one `BEGIN IMMEDIATE` workspace mutation:

- one content-derived immutable permission definition;
- one subject grant;
- when delegated, one actor grant and one exact subject-to-actor delegation;
- one audit event, one idempotency result and one authority-revision advance.

The mutation context's authenticated actor must equal the grantor. Exact
idempotent replay returns the existing projection; conflicting operation reuse
fails closed.

## Limits and budgets

`constraints` is mandatory so callers cannot confuse omission with support.
Version 1 accepts only:

```json
{"maxOperations": null, "budget": null}
```

A non-null use limit returns `generic_usage_limit_unsupported`. A non-null
budget returns `generic_budget_unsupported`. These are deliberate safety
outcomes: ordinary grants have no consumption counter or monetary request
semantics. Effect-specific scope and limits remain in immutable effect
approvals and are rechecked by the dispatch gate.

`urn:tasq:action:effect.dispatch` returns
`remote_effect_dispatch_disabled`; TQ-626 does not change the TQ-906 gate.

## Inspection, denial and revocation

Inspection derives the readable view from the permission, grant and delegation
rows. It verifies all component digests and lifecycle revisions against a fresh
compile. Partial or divergent state is `authority_corrupt`, not a best-effort
view.

Authorization checks mandate action and target bounds before invoking the
TQ-802 live authorizer at the same injected time. The returned
`tasq.mandate-decision.v1` contains an exact resource digest but not its ID.
Authority denial reasons remain typed. A missing, revoked, wrong-action or
wrong-target mandate has a distinct typed basis.

Revocation reprojects current state, checks the mandate revision and grantor,
then changes every grant/delegation component from active revision 1 to revoked
revision 2 in one authority revision. Concurrent writers use the existing CAS
gate, so only one can commit. The next authorization request sees revocation.

## Executable evidence

- `packages/tasq-server/src/mandates.ts` freezes contracts, compiler, record
  identities and privacy-bounded decisions;
- `packages/tasq-server/src/store.ts` owns atomic issue/revoke and live
  inspect/authorize composition;
- `packages/tasq-server/test/server-authority.test.ts` covers direct and
  delegated issue, no second table, protected-target denial, next-request
  revocation, typed unsupported limits, disabled remote dispatch and concurrent
  mutation serialization.
