# `@tasq-internal/delegated-runner`

Reference operational composition for delegated action. It demonstrates how a
replaceable runtime can consume Tasq's durable outbox, dispatch exact effects,
recover unknown provider outcomes and derive a bounded review inbox without
moving provider credentials, timers or runtime state into Core.

The package is private because it is executable architecture and conformance
evidence, not a supported public runtime product.

## Runtime boundary

- `processNextEvent` leases the oldest durable delivery and acknowledges it
  only after an idempotent handler returns. A crash replays the same event and
  stable handler key.
- `runEffect` begins an authorized execution atomically, requires the connector
  to invoke a live claim/fence guard adjacent to provider I/O, and records the
  verified receipt in Core.
- A persisted `executing` or `indeterminate` effect is reconciled by provider
  lookup. It is never blindly dispatched again.
- `materializeSettlementOrRecourse` derives a stable retry identity while the
  Core transaction and uniqueness constraints remain the exactly-once ledger
  boundary.
- `buildReviewInbox` re-reads authoritative records on every call. Eligibility
  and experimental custody policy are injected; no inbox row or derived status
  is stored.

This runtime does not grant authority, prove evidence true, complete an
obligation, hold funds, provide marketplace supply or enable remote effects.

See [`TQ-629_REFERENCE_DELEGATED_RUNNER.md`](../../docs/contracts/TQ-629_REFERENCE_DELEGATED_RUNNER.md).
