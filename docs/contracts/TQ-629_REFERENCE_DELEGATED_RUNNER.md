# TQ-629 — Reference delegated-action Runner and Review Inbox

> **Status:** source implemented and repository certified; private reference
> composition, not a published runtime or remote-effect claim

## Boundary

The reference Runner owns operational policy outside Core:

```text
durable outbox -> leased event -> idempotent handler -> acknowledgement
authorized effect -> atomic begin -> live boundary guard -> connector I/O
executing/indeterminate effect -> provider lookup -> verified receipt
exact settlement inputs -> Core transaction -> decision + materializations
ledger reads -> bounded Review Inbox projection
```

Core remains the only commitment, attempt, authority, effect, receipt,
settlement and recourse ledger. The Runner stores no provider credential and
the Review Inbox stores no derived row.

## Recovery invariants

1. A delivery lease is acknowledged only after the event handler returns.
   Expiry or failure replays the same delivery with the same event-derived
   idempotency identity.
2. The first effect dispatch calls `beginEffectExecution`, binding the exact
   approval, running attempt, claim and fence in one Core transaction.
3. The connector contract requires a live authority callback adjacent to the
   provider mutation. The callback re-reads the exact claim, principal, fence,
   release state and expiry. The connector separately authenticates the signed
   permit and exact request.
4. Once Core says `executing` or `indeterminate`, restart performs provider
   lookup by the immutable dispatch identity. No blind redispatch occurs.
5. Unknown lookup remains unknown without adding another receipt. A terminal
   lookup resolves the exact prior indeterminate receipt.
6. Settlement and recourse use stable runner identities, while Core's durable
   idempotency and unique decision roots are the exactly-once materialization
   boundary.

## Review Inbox

`buildReviewInbox` is a bounded projection over current authoritative records.
It can surface:

- unaccepted assignments and agreements;
- purpose-specific ineligibility through an injected evaluator;
- input-required or stale running attempts;
- completion proposals and unresolved challenges;
- effects awaiting approval or provider reconciliation;
- indeterminate settlements and overdue recourse;
- experimental custody attention through an injected read projector.

Every call rebuilds the result. The contract explicitly asserts
`persistedShadowState: false` and `authorityGranted: false`. A bounded scan can
report truncation rather than pretending completeness.

## Explicit non-claims

The package does not:

- run as a managed service or promise availability;
- provide a provider router, marketplace supply or credentials;
- make a signature, assignment, agreement or eligibility decision sufficient
  authority for an effect;
- claim that an inbox item or provider receipt proves the larger outcome;
- enable remote effects, which remain behind TQ-906.

## Executable evidence

- `packages/tasq-delegated-runner/src/runner.ts` implements durable event
  delivery, last-boundary fence checks, lookup-before-retry and stable
  settlement/recourse materialization.
- `packages/tasq-delegated-runner/src/review-inbox.ts` implements the bounded,
  derived-only attention view.
- `packages/tasq-delegated-runner/test/runner.test.ts` proves event restart,
  lost-response lookup without redispatch, revocation immediately before I/O,
  settlement/recourse replay and no-shadow inbox updates.
