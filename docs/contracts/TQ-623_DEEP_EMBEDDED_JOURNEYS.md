# TQ-623 — Deep embedded delegated-action journeys

> **Status:** source implemented and repository certified; publication remains
> part of the authorized `v0.4.0` release gate
> **Package seam:** `@tasq-run/core#createLocalTasq`
> **Kernel impact:** no new record, table, migration or provider policy

## Outcome

The embedded Interface now exposes the collaboration and effect records that
already existed behind low-level Core functions:

| Interface | Operations |
|---|---|
| `assignments` | propose, get, list, accept, reject, revoke, release |
| `artifacts` | append, get, list |
| `externalReferences` | append, get, list |
| `effects` | propose/read/list, approval lineage, authorize, begin, receipts, cancel |

The client binds workspace, principal, actor and injected clock. Callers no
longer repeat those values and cannot override the bound workspace through the
high-level input. Existing service functions remain the only write path.

Two transactional journeys compose the same records:

- `journeys.claimAndStart(...)` acquires or recovers the live claim and starts
  its bound attempt in one writer transaction;
- `journeys.submitOutcome(...)` appends immutable artifacts and evidence,
  succeeds the attempt and creates the criterion-bound completion proposal in
  one writer transaction.

Neither journey completes the commitment. A successful attempt reports what
the executor did; the proposal asks the frozen resolution policy to decide
whether the commitment is satisfied.

## Transaction composition

`runInTransaction` is now reentrant only for the exact transaction handle held
by its current async scope. A nested service therefore reuses the outer writer
transaction instead of opening another SQLite transaction. The outer boundary
alone increments the committed-mutation counter.

External event-journal notifications are also scoped to that boundary. Nested
services queue their already-persisted audit events, and listeners see them
only after the root transaction commits. A late validation failure rolls back
domain rows, idempotency rows and audit rows and emits no mirror notification.
There is no general nested savepoint API and no ambient transaction exposed to
consumers.

## Retry and concurrency contract

Each journey requires one non-empty caller idempotency key. It derives stable,
operation-specific child keys for every existing service mutation. Therefore:

- rollback leaves no partial child retry record;
- an exact retry after a lost response returns the existing claim, attempt,
  artifact, evidence and proposal identities;
- a changed child request under the same key is rejected by the existing
  idempotency digest checks;
- claim fencing, attempt revision checks, workspace isolation and append-only
  audit continue to be enforced by the owning services;
- a replay reads the current mutable claim/attempt projection. It preserves
  durable identity, not a stale serialized response snapshot.

`submitOutcome` requires every submitted evidence item to name one or more
frozen criterion IDs. The journey constructs the completion proposal from the
persisted evidence IDs; callers never coordinate those IDs between separate
transactions.

## Explicit non-claims

This work does not yet provide `delegate`, `accept-and-start`,
`resolve-and-settle` or `recover` as complete delegated-action workflows.
Assignments express responsibility, not exact agreement. The journey does not
invent qualification, mandate, settlement, custody or provider dispatch.
Those remain TQ-625–TQ-631. Effect execution still requires the existing exact
approval, live claim fence, connector policy and permit issuer.

## Executable evidence

- `packages/tasq-core/test/delegated-journeys.test.ts` proves exposed existing
  records, root-transaction rollback, after-commit audit mirroring, restart
  replay and invalid-final-step rollback.
- `packages/tasq-core/examples/delegated-action.mjs` is a runtime-neutral
  claim/start and outcome-submission program.
- `packages/tasq-cli/test/public-packages.test.ts` installs generated tarballs
  and runs that exact program twice against one ledger under Node 22+ and Bun
  1.3+.
- the historical simple `examples/local-client.mjs` remains unchanged and is
  still executed twice under both runtimes.

Verification:

```bash
pnpm --filter @tasq-run/core test
pnpm --filter @tasq-run/core typecheck
bun test packages/tasq-cli/test/public-packages.test.ts
pnpm docs:check
```
