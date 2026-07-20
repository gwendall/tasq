# TQ-405 — Explicit mutation and snapshot replication

**Status:** Implemented — 2026-07-19
**Contract:** `ADR-003_REPLICA_CONFLICT_MODEL.md`
**Follow-on proof:** TQ-406 crash, reorder, expiry and restore chaos passed; see
`TQ-406_SYNC_CHAOS_AND_RECOVERY.md`

## What now exists

Tasq has a real authority-coordinated replication service. It does not copy
SQLite rows and it does not replay audit JSONL. A replica commits a validated
commitment mutation, its audit event, the next generation counter and a
canonical outgoing operation in one SQLite transaction. The workspace
authority then classifies that operation in one transaction as applied,
equivalent or conflicted.

In short, replicas atomically queue versioned service commands instead of
manufacturing a second write path.

The shipped v1 projection is deliberately narrow and honest: it covers
profile-neutral commitments whose area, goal, project and parent fields are
null. `_life` hierarchy records and extension-specific records are not claimed
as synchronized yet. They remain ordinary layers above the universal kernel.

## Public service surface

Authority and replica lifecycle:

- `initializeReplicationAuthority`
- `getReplicationAuthority`
- `registerReplicationReplica`
- `initializeLocalReplica`

Offline-speculative commitment commands:

- `queueReplicatedCommitmentCreate`
- `queueReplicatedCommitmentUpdate`
- `queueReplicatedCommitmentDelete`
- `queueReplicatedCommitmentRestore`

Transport and convergence:

- `buildReplicationPushRequest` / `acceptReplicationPush`
- `acknowledgeReplicationPush`
- `pullReplication`
- `getReplicationSnapshot`
- `installReplicationSnapshotAndRebase`
- `listReplicationConflicts`

Retention:

- `retireReplicatedCommitment`
- `pruneReplicationHistory`

Every mutating or retention API requires an explicit `Clock`. Device time is
read only by the production composition root; tests can freeze, advance or
rewind their own clock. A client's `occurredAt` is descriptive evidence only:
the authority always stamps applied state, conflicts and retention age from
its own injected clock. Cross-replica state digests exclude recording
timestamps (`createdAt`, `updatedAt`, `deletedAt`) while retaining the semantic
deleted/live distinction, so clock skew cannot create false conflicts or
accelerate deletion compaction.

## Durable state

Migration `0019_replication.sql` adds separate tables for:

- workspace authority identity, epoch and sequence;
- local replica generation, counter chain and observed cursor;
- authority-side registered generations and acknowledgement frontiers;
- local outgoing operations;
- authority accepted results;
- unresolved conflicts and their three inspectable variants;
- compact retired identities;
- canonical snapshot-materialized records.

Delivery sinks/outbox rows, idempotency keys, claims, attempts, credentials,
host configuration and JSONL journals never enter a snapshot.

## Push semantics

A push contains at most 500 operations from one authenticated generation in
contiguous order. Each operation carries:

- the generation dot and predecessor digest;
- the authority epoch/sequence it observed;
- an explicit versioned command;
- the complete base and intended commitment snapshots plus their digests;
- descriptive `occurredAt`; and
- a safe-integer canonical SHA-256 digest.

The authority rejects a gap, broken chain, unknown epoch, unauthenticated
origin, oversized body or digest mismatch. The same dot plus the same digest
returns the exact prior result. The same dot plus another digest fails closed
as identity corruption.

Pull likewise requires the transport-authenticated replica identity to match
the requested generation. A caller cannot impersonate another replica merely
by copying its public IDs and advance its acknowledgement/retention frontier.

If the base still matches, the command executes through the same
`createTaskInTransaction`, `updateTaskInTransaction`, delete or restore service
primitive used locally. Store-local `revision` remains the actual SQL CAS and
is excluded from cross-replica digests. If another operation changed the base,
the authority preserves the current state and records a conflict with base,
authority and incoming variants. Device timestamps never select a winner.

## Pull, snapshots and rebase

Pull cursors are opaque, digest-protected and bound to workspace, authority
replica, epoch and sequence. Incremental pulls contain accepted outcomes and a
fresh content-addressed canonical snapshot. Including the snapshot is
intentional: authority-required mutations can change canonical state without
pretending they were offline client commands.

Snapshots include every registered generation's accepted counter and digest.
This is essential recovery information, not bookkeeping: if a push committed
but its response was lost, the client preserves that accepted dot and digest
for an exact retry even when later canonical mutations make its old outcome
unrecognizable. Snapshot activation rejects duplicate/overlapping identities,
foreign-workspace conflicts, impossible frontiers and digest drift before it
touches local state.

Transport uses a content-addressed manifest plus independently digested pages
of at most 500 items and 8 MiB each. Pages may arrive out of order, but missing,
duplicate, oversized or modified pages fail assembly. Only a completely
verified assembled snapshot reaches the atomic install transaction; discovery
advertises the exact page limits.

A cursor from another epoch, below the retained floor, or ahead of the current
authority sequence (for example after restoring an older authority backup)
returns typed `cursor_expired` plus a verified snapshot. Installing a snapshot is atomic.
The client still rejects a same-epoch sequence regression: authority disaster
recovery must rotate `authorityEpoch` as ADR-003 requires, rather than silently
rolling clients back.
The client preserves its pending command chain, installs canonical records in
an isolated transaction, replays pending commands through the service layer,
then recomputes their base/outcome digests and predecessor chain. A failure
rolls the complete install/rebase back.

## Tombstones and retention

Deletes synchronize as full semantic tombstones. After the injected authority
clock proves the 90-day minimum, an authority may remove the payload while
retaining a compact record ID and tombstone digest. A stale create or edit of
that ID becomes a durable `retired_identity` conflict; omission can never
resurrect it.

Accepted entries are pruned only after the 30-day minimum and acknowledgement
by every active generation. Generations become stale after 90 days without
authenticated contact and must snapshot-bootstrap. Unresolved conflicts are
not pruned.

## Discovery and boundaries

Before authority initialization, discovery advertises no replication
capability. Afterwards it exposes the exact authority identity, projection and
contract digests, cursor floor, limits, retention and operation registry.
Create/update/delete/restore are `offline_speculative`; status transitions,
claims, attempts, effect dispatch and extension changes are
`authority_required`; host/delivery state is `local_only`.

Transport authentication remains an adapter responsibility under ADR-004.
Replica identity deduplicates and attributes; it is not a credential. Remote
effect-capable deployment is therefore still not claimed.

## Evidence

`packages/tasq-service/test/replication.test.ts` proves:

- local mutation/event/outgoing rollback together;
- authority mutation/event/accepted-result rollback together;
- exact retry and same-dot corruption behavior;
- same-base offline conflict despite extreme opposite device clocks;
- visible base/authority/incoming variants;
- successful pending-command rebase over a newer snapshot;
- tombstone compaction and stale-resurrection defense;
- injected-clock retention and typed cursor expiry;
- capability-on-initialization discovery and local-only exclusion.

TQ-406 now supplies the complementary black-box proof. These deterministic
integration tests prove the state machine; `TQ-406_SYNC_CHAOS_AND_RECOVERY.md`
kills processes at commit/ack boundaries, duplicates and reorders transport,
and restores old backups against it.
