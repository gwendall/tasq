# TQ-403 — Scoped durable idempotency

> **Status:** implemented 2026-07-19. Every mutation exposed as retryable by
> the universal MCP boundary now has a transactional, caller-scoped replay
> identity. Retention and time are explicit.

## Outcome

A client may lose any response after SQLite commits, retry the same command,
and receive the already accepted result without repeating the mutation or
failing its original compare-and-swap revision. Tasq distinguishes unrelated
clients and unrelated operations even when they choose the same key.

The identity is the tuple:

```text
(workspace, caller scope, operation, client key)
```

The row binds that tuple to a versioned canonical request digest and records
the accepted result type, identity, status, revision and event sequence.
Conflicting reuse of the exact tuple fails before domain validation or writes.

## Why the old shape was unsafe

The pre-0018 table keyed only `(workspace, key)`. Six service modules each
implemented their own hashing and lookup rules. Consequences included:

- two independent runtimes could collide on a common key such as `request-1`;
- a key could not safely be reused for a different operation;
- mutable CAS operations accepted an idempotency field at MCP but ignored it;
- retention was undefined;
- stored outcomes exposed only an opaque result ID;
- canonicalization and compatibility behavior varied by module.

Migration `0018_scoped_idempotency.sql` consolidates those implementations
without discarding accepted historical identities.

## Caller scope

Authenticated identity wins: `principal:<stable-principal-id>`. Otherwise
Tasq uses `actor:<actor-alias>`; the default is `actor:system`. Transport
adapters must inject the authenticated principal when one exists. Workspace
remains a separate component even in database-per-workspace deployments.

## Request identity

New rows use `tasq.jcs.sha256.v1` over:

```json
{
  "contract": "tasq.idempotency-request.v1",
  "operation": "task.update",
  "request": { "...": "meaningful command fields" }
}
```

The object is canonicalized with Tasq's frozen JSON contract and stored as a
`sha256:<64 lowercase hex>` digest. Recording time, generated UUIDs and other
server decisions are excluded. Explicit domain time is included when it
changes command meaning; an omitted timestamp remains `null`, so a retry does
not change identity merely because the clock moved. Collections are normalized
before hashing when order is not meaningful, such as completion evidence IDs.

## Retention

| Class | Expiry | Intended use |
|---|---:|---|
| `standard` | 30 days by default; configurable up to 365 days | ordinary client commands and bounded retry windows |
| `durable` | none | effect lifecycle, protocol/external mappings, immutable artifacts and derived fallback identity |

`pruneExpiredIdempotency` removes only `standard` rows at the inclusive expiry
boundary. It is an operational transaction, so maintenance does not advance
the domain commit counter. Ordinary reads never consult ambient time or run
implicit garbage collection.

If an exact standard identity is explicitly reused at or after expiry, Tasq
deletes the expired row and accepts the new occurrence in the same mutation
transaction. If the replacement fails, the deletion rolls back too.

## Covered mutation surface

The shared primitive now backs:

- commitment create, update and every status transition;
- principal creation;
- assignment proposal, relation append, artifact append and external-ref
  append;
- claim acquire/renew and release;
- attempt start and transition;
- evidence and typed-wait creation;
- deterministic deadline fallback materialization;
- effect proposal, approval decision, authorization, dispatch begin and
  pre-dispatch cancellation.

Observation ingestion, reconciliation, effect receipts and outbox delivery
already use stronger natural external identities. Their immutable source or
delivery identity remains authoritative rather than being wrapped in a second
client-key namespace.

The MCP requires `idempotencyKey` for every exposed mutation whose response can
be lost and advertises `idempotentHint: true` only where the service implements
this contract. The trusted host supplies workspace, caller and one clock
snapshot; clients cannot override those values.

## The effect dispatch crash boundary

`effect.execution.begin` is the most sensitive retry:

```text
authorized -> executing + durable dispatch identity -> response/permit
```

If the response is lost after commit, a retry does not attempt the transition
again. It reconstructs the permit from the durable effect, exact approval,
attempt, claim fence, accepted effect revision and original
`executionStartedAt`. The caller must present the same policy identity and
permit issuer identity. Reconstruction is allowed only while the effect remains
`executing` or `indeterminate`; once a receipt resolves it, retry fails closed
and directs the caller to that receipt instead of handing out a permit that
could trigger redispatch. External dispatch still uses the effect's separate
provider idempotency key; Tasq cannot manufacture exactly-once behavior in a
provider that lacks it.

## Upgrade compatibility

Migration 0018 preserves every pre-existing row as:

```text
caller_scope    = workspace:legacy
digest_version  = tasq.legacy.sha256.v0
retention_class = durable
```

New lookup first checks the exact scoped tuple, then the compatible legacy
workspace-global tuple. Each migrated call site supplies its exact former hash
input. This deliberately preserves old over-deduplication after upgrade;
silently repeating an accepted historical mutation would be less safe.

## Clock boundary

- preparation receives one required `now` snapshot;
- expiry is stored as an absolute integer derived from that snapshot;
- pruning accepts `Clock` or explicit `now`;
- SQLite time functions are not used;
- tests cross expiry, approval and lease boundaries with controlled clocks.

The only real system clock is a composition-root adapter. Kernel logic never
reads a device clock directly.

## Inspection and diagnosis

`listIdempotencyRecords` filters by workspace, caller, operation, key and
retention class. `doctor` validates digest versions, digest shape, result
metadata and retention coherence, and deadline fallback diagnosis searches the
full scoped identity rather than assuming keys are workspace-global.

## Executable evidence

Service tests prove independent caller/operation scopes, lost-response CAS
replay, conflict rejection, inspectable outcomes, injected expiry boundaries,
durable retention, populated legacy migration and replay of claim, attempt and
effect lifecycle mutations. MCP tests prove externally retriable tools require
keys and complete a multi-step flow under a mutable injected clock.

## Remaining boundary

Idempotency is local accepted-command identity, not replica conflict
resolution. TQ-404 defines replica identity, ordering, tombstones, retention
and conflicts; TQ-405 then synchronizes explicit mutations and snapshots using
those rules.
