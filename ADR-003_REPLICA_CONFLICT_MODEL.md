# ADR-003 — Replica identity, synchronization order and conflict model

- **Status:** Accepted — 2026-07-19
- **Implements:** TQ-404
- **Depends on:** TQ-402 ordered delivery, TQ-403 durable idempotency,
  ADR-UK-006 collaboration records, ADR-006 machine discovery
- **Unlocks:** TQ-405 explicit mutation/snapshot sync and TQ-406 chaos proof
- **Supersedes:** the wall-clock LWW and audit-event replay proposal in
  `SPEC.md` §8
- **Does not authorize:** remote authentication, multi-user grants, peer-to-peer
  effect authority or raw database replication

## 1. Problem

Tasq currently has one authoritative SQLite store. Its integer revisions,
event sequences, leases and fences are correct inside that store. Copying the
file to another device creates a second writer with no shared transaction:

- both devices can legitimately use the same local revision;
- local event sequences are unrelated;
- one device may be offline when the other edits, deletes or restores a row;
- replaying audit JSON cannot reconstruct every service command or invariant;
- a copied backup can reuse a replica counter and operation identity;
- wall clocks can be wrong, user-controlled or deliberately simulated;
- two disconnected devices cannot both promise a globally exclusive claim or
  safe effect dispatch.

The sync layer must preserve Tasq's existing state machines, attribution,
idempotency, effect authority and injected-clock boundary. It must never make
data loss look like convergence.

## 2. Decision summary

Tasq v1 sync is **authority-coordinated local-first synchronization**:

1. One replica is the write authority for one workspace and authority epoch.
2. Other replicas may apply an explicit allowlist of mutations locally as
   durable speculative work while disconnected.
3. Every speculative write and its outgoing operation are committed in the
   same local transaction.
4. Push sends versioned command invocations plus exact base/result state
   digests. It never sends audit events as commands.
5. The authority applies accepted commands through the service layer and gives
   every durable result an authority sequence.
6. Pull returns canonical accepted outcomes, conflicts and snapshots. A client
   rebases still-pending mutations over that canonical state.
7. Concurrent incompatible edits produce an inspectable durable conflict. The
   already-authoritative state stays canonical until an explicit resolution.
8. Wall-clock time never orders operations or chooses a winner.
9. Expired cursors require a content-addressed snapshot plus rebase; they never
   fall back to timestamp polling or blind replay.
10. Claims, fences and effect-dispatch authority are available only from the
    online authority. Offline state cannot manufacture global exclusivity.

This is not symmetric multi-master, event sourcing or a general CRDT. The
authority is the canonical coordination point; local replicas remain useful
offline without pretending that disconnected side effects can be linearized.

## 3. Terms and trust boundary

| Term | Meaning |
|---|---|
| workspace | Isolation and replication unit. One operation belongs to exactly one workspace. |
| authority | The single replica allowed to assign accepted order and global coordination authority in an epoch. |
| replica | A durable local store participating in one workspace. |
| generation | One continuous identity/counter lifetime of a replica. Restore or clone normally creates a new generation. |
| speculative mutation | A locally committed command not yet accepted by the authority. |
| accepted operation | A command durably classified by the authority as applied, equivalent or conflicted. |
| authority cursor | Opaque exclusive resume token over authority log order. |
| snapshot | Canonical, content-addressed projection of replicated state at one authority cursor. |

Replica identity is attribution and deduplication, not authentication. A
transport MUST authenticate the workspace, principal and registered replica
before calling sync services. ADR-003 does not implement ADR-004 key rotation.
The embedded reference may use a trusted host context; a remote adapter may
not accept client fields as proof.

## 4. Replica and operation identities

### 4.1 Stable identities

An authority identity is:

```text
(workspaceId, authorityReplicaId, authorityEpoch)
```

A mutation origin is:

```text
(workspaceId, replicaId, generationId)
```

`replicaId`, `generationId` and `authorityEpoch` are opaque UUIDv7 values
created from an injected clock plus secure randomness. UUID time aids
inspection only; equality never depends on its timestamp.

`replicaId` identifies an installation. `generationId` changes whenever the
system cannot prove that its previous outgoing counter will continue without
reuse, including normal backup restore, device clone and destructive reseed.
An in-place crash restart keeps both IDs because their counter is durable.

### 4.2 Operation dot and chain

Each generation owns a positive, gap-free counter. Its operation dot is:

```text
(replicaId, generationId, counter)
```

The counter increments in the same transaction as the domain mutation and
outgoing operation row. Each operation also carries the previous operation's
digest, forming a per-generation hash chain. Therefore:

- the same dot and same digest is an exact transport retry;
- the same dot and different digest is identity corruption and fails closed;
- a gap or broken predecessor digest is quarantined rather than skipped;
- two restored copies cannot safely continue one generation independently.

Operation identity is separate from TQ-403 client idempotency. On authority
apply, the operation dot becomes the durable idempotency key under a dedicated
sync caller/operation scope, so a response loss cannot apply it twice.

## 5. Explicit operation envelope

The canonical v1 envelope is conceptually:

```text
contractVersion:       "tasq.replication-operation.v1"
workspaceId
origin:
  replicaId
  generationId
  counter
  previousDigest
causalBase:
  authorityReplicaId
  authorityEpoch
  observedSequence
caller:
  principalId
command:
  operationUri
  operationVersion
  input
preconditions[]:
  recordType
  recordId
  baseStateDigest | null      # null means the record was absent
outcomes[]:
  recordType
  recordId
  stateDigest | null          # null means tombstoned/absent per schema
  snapshot
occurredAt                    # explicit domain/audit metadata only
digestVersion:          "tasq.replication-jcs.sha256.v1"
operationDigest
```

The exact Zod DTO and operation registry are TQ-405 implementation work, but
these fields and meanings are binding.

### 5.1 Canonical content

The operation digest uses Tasq's frozen safe-integer canonical JSON and
domain-separated SHA-256. It includes every field above except
`operationDigest`. Unknown fields and non-portable JSON fail before hashing.

Generated row IDs, meaningful domain timestamps and immutable occurrence IDs
must be allocated locally and carried in command input. Server arrival time,
transport request IDs, local SQL revisions and local event sequences are not
command meaning.

### 5.2 State digests and revisions

Every syncable record type has a versioned replication projection. It
explicitly lists semantic fields and excludes:

- store-local integer `revision` values;
- local event/outbox/sync sequence values;
- derived indexes and caches;
- secrets, connector credentials and host configuration.

`baseStateDigest` is the cross-replica compare-and-swap token. Local integer
revisions remain mandatory inside each store, but are never compared across
stores. After a base digest matches, the sync adapter reads the authority's
current local revision and supplies it to the ordinary service command. It
does not bypass CAS.

A multi-record command carries its complete semantic read/precondition set and
result/write set. This is required for cascades, hierarchy changes, completion,
wait transitions and graph mutations whose safety cannot be reduced to one
row.

## 6. Atomic capture and local audit

On a client replica, one writer transaction must commit all of:

```text
validated local service mutation
local authoritative rows
local audit event(s)
next origin counter
canonical outgoing operation
```

If any part fails, none commits. A crash after commit leaves the outgoing
operation durable.

On the authority, one transaction must commit exactly one classification:

- service mutation + authority audit + accepted log entry;
- semantic-equivalence acknowledgement + accepted log entry; or
- immutable conflict occurrence + accepted log entry.

Audit events remain local evidence. The authority generates its own audit
event while applying a command and correlates it with the origin dot. It does
not import the client's event ID or sequence. Event JSONL is neither an
outgoing mutation queue nor a replay protocol.

## 7. Ordering and causality

Three orders are deliberately separate:

1. **Origin order:** counter order within one replica generation.
2. **Observed causal base:** the authority epoch/sequence visible before the
   local command plus its predecessor origin operation.
3. **Authority order:** one strictly increasing sequence assigned to each
   durable apply/equivalence/conflict/resolution result.

The authority cursor is delivery order, not proof that unrelated operations
caused one another. A client operation is causally based on current authority
state only when its authority identity/epoch is current and every declared
base digest still matches.

Timestamps are descriptive inputs. They MUST NOT:

- order two operations;
- detect concurrency;
- break a tie;
- choose a conflict winner;
- advance or validate a cursor.

This deliberately replaces `SPEC.md` §8's edit-time LWW rule. An injectable
clock can be advanced, frozen or rewound in a test without changing conflict
classification.

## 8. Authority and offline capability classes

TQ-405 maintains an explicit operation registry. Every mutation is one of:

| Class | Behavior |
|---|---|
| `offline_speculative` | May commit locally and queue. Authority later applies, marks equivalent or records conflict. |
| `authority_required` | Requires an online authority decision; no disconnected replica may claim success. |
| `local_only` | Never leaves the store. |

The initial policy is conservative.

### Offline-speculative examples

- commitment/profile create, edit, status, soft-delete and restore;
- principal, assignment and relation proposals;
- immutable artifacts, evidence, external references and observations;
- wait creation and effect proposal;
- a verified provider receipt queued after a dispatch that was already
  authorized online.

These remain subject to base-digest and semantic conflicts. “Offline-safe”
means durable to queue, not guaranteed to be accepted.

### Authority-required examples

- claim acquire/renew/release and fencing-token issuance;
- attempt transitions whose authority depends on a live global claim;
- reconciliation/deadline decisions that mutate shared terminal state;
- effect approval, authorization, execution begin and pre-dispatch cancel;
- extension installation or other workspace contract changes;
- conflict resolution and irreversible purge.

An authority may issue a bounded offline execution permit in a future ADR, but
ordinary local state is not such a permit. Effect dispatch still requires the
TQ-205 authenticated permit and a live authority fence.

### Local-only state

The following is never part of replicated semantic state:

- `_migration` and host configuration;
- `delivery_sink` and `delivery_outbox`;
- TQ-403 `idempotency_key` rows;
- `observation_route` and other reproducible indexes/caches;
- replica counters, push queues, pull cursors, leases and snapshot caches;
- JSONL journal files and projection files.

Extension releases/types/evaluators are authority-managed workspace contract
state. A snapshot may carry their immutable declarations and digests, but code
installation stays an explicit trusted host action.

## 9. Conflict classification

For one authenticated, structurally valid operation in correct origin order,
the authority applies these rules in order:

1. **Exact retry:** same dot and digest → return the prior result.
2. **Identity corruption:** same dot and different digest → quarantine/fail;
   never create a semantic conflict from corrupt identity.
3. **Already equivalent:** declared canonical outcome already equals current
   semantic state and every immutable identity agrees → acknowledge without a
   second mutation.
4. **Clean apply:** authority epoch is current, all base digests match and the
   command passes the service invariants → apply.
5. **Explicit conflict:** a well-formed intended mutation has a stale/divergent
   base or its combination with accepted state violates a semantic invariant →
   preserve it as a durable conflict.
6. **Hard rejection:** unauthorized, unknown-version, oversized, malformed or
   cryptographically inconsistent input → reject/quarantine without treating
   it as user data.

Distinct immutable creates normally commute. Natural-key collision, graph
cycle, hierarchy contradiction, effect identity drift or append-only content
drift is an explicit conflict/integrity failure, not a guessed merge.

### 9.1 No silent winner

When two offline replicas edit the same base, the first operation accepted by
the designated authority may become the current authoritative state. The
second is not overwritten, discarded or relabeled as success. It creates a
conflict containing:

```text
conflict identity and authority sequence
incoming origin dot and operation digest
affected record identities
reason code
declared base snapshots/digests
current authority snapshots/digests
incoming intended snapshots/digests
principal attribution
authority recordedAt
optional resolution operation identity
```

“First accepted” is serialization, not a semantic claim that the first value
is better. Reads/inspection/discovery must surface unresolved conflict counts
and identities. Agents must not have to opt into a hidden `conflicts=true`
mode to learn that state diverged.

### 9.2 Resolution

Resolution is a new authority-required command that:

- names every conflict and current authority head it resolves;
- chooses the current variant, incoming variant or an explicit merged input;
- passes the normal service validation and current local revision;
- emits a new accepted operation and audit event;
- never deletes the original variants or falsifies attribution.

No generic field merge is implied. Operation-specific code may define a
commutative merge only when it can prove the same invariants for all orders.

## 10. Tombstones, restore and retired identities

Soft deletion remains a semantic mutation, not transport absence.

- A causal edit followed by delete applies normally.
- A delete concurrent with edit is a conflict; v1 has no automatic
  delete-wins or edit-wins rule.
- Restore is another guarded mutation and can itself conflict.
- Pull uses explicit tombstone snapshots; omission never means deletion.

Reference retention has two stages:

1. The full tombstoned record remains restorable for at least 90 authority
   days.
2. After payload GC, a compact retired-identity marker remains in authority
   snapshots so a stale replica cannot resurrect the ID as a create.

IDs are never reused. An irreversible purge may remove sensitive payload, but
the non-secret identity marker/digest remains unless every pre-purge replica
generation is acknowledged or revoked and the workspace explicitly accepts
loss of resurrection defense.

All retention boundaries use the authority's injected clock. A client-provided
timestamp cannot accelerate deletion or garbage collection.

## 11. Authority cursors and snapshots

The pull cursor contract is opaque, exclusive and bound to:

```text
workspaceId
authorityReplicaId
authorityEpoch
authoritySequence
cursorContractVersion
```

Clients compare or advance cursors only through returned contract fields. They
never synthesize one from event sequence, UUID or time.

The authority advertises its minimum retained sequence. A cursor from another
authority epoch or below that floor returns typed `cursor_expired`; the server
must not silently return a partial delta.

A snapshot is a canonical, content-addressed, paginated bundle containing:

- workspace and authority identity/epoch;
- covered authority sequence and accepted frontier;
- replication projection/version and compatibility digest;
- current replicated record snapshots and state digests;
- live tombstones plus compact retired identities;
- unresolved conflicts and resolution links;
- a snapshot digest over canonical page identities/content.

It excludes local-only tables, credentials, host paths, delivery state and
audit JSONL. Each page is verified before activation; the whole snapshot is
installed atomically or not at all.

A stale client with pending work must not wipe it. It preserves the pending
operation chain, installs the snapshot into an isolated base, then replays the
pending commands through the local service. Rebase failure becomes visible
local conflict/rejection state.

## 12. Push and pull semantics

Reference limits are advertised through discovery:

- at most 500 operations and 8 MiB canonical bytes per push;
- at most 1 MiB per operation;
- at most 1,000 authority entries per pull page;
- bounded snapshot pages with an independently verified digest.

A push contains operations from exactly one replica generation in contiguous
counter order. The authority processes a durable contiguous prefix. Applied,
equivalent and conflicted entries all advance acknowledgement; a hard rejection
stops before that counter so no causal hole is skipped. Retrying after a lost
response returns the same per-operation results.

Pull returns entries strictly after the supplied cursor in authority order.
The response, next cursor and per-origin accepted high-water marks are read
from one transactionally consistent authority snapshot.

Transport batching is not domain atomicity. Each domain command keeps its own
service transaction. A crash between operations is harmless because the
client resumes from its last acknowledged contiguous counter and the authority
deduplicates by origin dot/digest.

## 13. Retention and garbage collection

The reference policy is:

- a registered replica generation is active for 90 days after its last
  authenticated authority contact;
- accepted operation entries remain for at least 30 days and until every
  active generation has acknowledged a covering sequence and a verified
  snapshot covers the compacted range;
- unresolved conflicts are retained without automatic expiry;
- resolved conflict variants remain for the configured audit/evidence horizon;
- full tombstones remain at least 90 days; retired identities remain as above;
- snapshot manifests/digests needed by the advertised cursor floor remain
  available.

An inactive replica is not silently deleted. It becomes `stale` and must
rebootstrap from a snapshot before pushing. Revocation is an explicit authority
action. GC is an operational transaction and does not mint domain mutations.

All policy time comes from one authority `Clock` snapshot. No SQLite clock
function, device wall clock, monotonic process timer or zero-argument `Date`
may decide retention.

## 14. Backup, restore and authority failover

Backups include domain state, replication projections, accepted operation
metadata, conflicts, snapshot manifests and replica registration. They do not
turn a copied store into two valid writers with one generation.

Default restore behavior allocates a new replica generation. Continuing the
same generation is allowed only for an exclusive in-place disaster recovery
that proves no other copy can continue and preserves the durable counter.

Restoring or failing over the authority creates a new `authorityEpoch`, even
when `authorityReplicaId` stays the same. Old cursors then expire explicitly.
The new authority publishes a snapshot rooted in the restored accepted
frontier before accepting new client pushes. A backup older than acknowledged
client operations is detected as authority regression; clients do not blindly
re-upload into it.

## 15. Discovery and autonomous onboarding

TQ-405 adds a sync capability to `tasq.discovery.v1` only when the complete
implemented contract exists. Discovery must expose:

- replication operation/snapshot/cursor contract URIs and versions;
- authority identity/epoch and current cursor floor;
- operation registry and offline/authority/local classes;
- projection and compatibility digests;
- push/pull/snapshot size limits and replica retention policy;
- typed conflict and cursor-expiry problem codes.

Joining a workspace requires a trusted transport handshake that returns a
registered replica/generation, current snapshot and cursor. Replicas do not
need to know each other. They know the workspace authority and discover the
same protocol. Discovery remains capability metadata, not permission.

## 16. Security and effect boundary

- Workspace, principal and replica identity come from trusted adapter context.
- Unknown or revoked replicas fail before operation parsing can mutate state.
- Canonical digests detect corruption; they do not authenticate the sender.
- Secrets and connector credentials never enter operations or snapshots.
- Effect dispatch is never replayed as a generic state snapshot.
- An accepted remote effect state cannot cause a connector call merely by
  being pulled.
- Claims and fences are authority-local coordination tokens.
- Malformed and oversized chains are bounded/quarantined to prevent resource
  exhaustion.
- Every security/retention decision uses explicit injected time.

Remote effect-capable deployment remains blocked on ADR-004 implementation and
key rotation even after local sync conformance passes.

## 17. Alternatives and adopted ideas

### Replicache-style mutation replay and rebase — adopted selectively

Replicache gives each client sequential mutation IDs, reruns named mutations
on canonical server state and rebases pending local mutations after pull. That
is the closest fit for Tasq's service-owned writes and state machines. Tasq
adds base/result digests, durable visible conflicts, generation identity and
effect authority rather than letting arbitrary mutator code silently choose a
branch. See the official [sync model](https://doc.replicache.dev/concepts/how-it-works)
and [push contract](https://doc.replicache.dev/reference/server-push).

### Electric immutable synced state plus persistent optimistic state — adopted

Separating canonical synced state from pending local writes makes rollback and
rebase intelligible. Tasq uses this logical separation even when both live in
one SQLite file. Electric's current write guide likewise calls out manual
conflict display and causal rollback for rejected offline writes. See
[Electric writes](https://electric-sql.com/docs/guides/writes).

### Automerge/CRDT for the complete ledger — rejected

Automerge's actor+counter operations and inspectable multi-value conflicts are
useful precedents. Its generic JSON merge is not sufficient for guarded task
state machines, graph cycles, approval chains, leases or external effects.
Tasq adopts stable operation dots and visible variants, not CRDT ownership of
domain semantics. See [Automerge conflicts](https://automerge.org/docs/reference/documents/conflicts/).

### CouchDB revision trees and deterministic hidden winner — rejected as UX

CouchDB correctly treats conflicts as durable state and retains losing
revisions, but default reads expose a deterministic arbitrary winner unless a
caller explicitly asks for conflicts. Tasq must surface unresolved conflicts
in normal inspection and keeps the authority's already-accepted state merely
as a provisional canonical base. See the official
[replication/conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html).

### Wall-clock LWW — rejected

Edit-time LWW cannot distinguish causality, rewards clock skew and silently
turns a testing clock into business authority. Preserving a loser in an audit
event is not enough if normal reads claim the winner is resolved.

### Raw LibSQL/Turso or SQLite row replication — rejected

It would bypass service validation, CAS, idempotency, events, extension parsing
and effect authority while copying local delivery/configuration state.

### Audit event replay — rejected

Tasq is state-based, not event-sourced. Current event payloads are intentionally
human/audit projections and do not contain every validated command input,
generated ID, precondition or multi-row result.

### Symmetric peer-to-peer multi-master — deferred

It would require consensus or domain-specific CRDTs for leases, fences,
deadline races and effect authority. Authority-coordinated sync solves the
demonstrated multi-device need without pretending disconnected replicas can
provide global exclusivity.

## 18. TQ-405 and TQ-406 acceptance obligations

TQ-405 is not complete until executable tests prove:

- atomic local mutation/outgoing capture;
- exact retry and same-dot/different-digest failure;
- clean apply through the service layer with local CAS preserved;
- rebase of pending work over pulled canonical state;
- explicit same-base offline conflict with both variants inspectable;
- no wall-clock influence on order/conflict;
- tombstone propagation and retired-identity resurrection defense;
- typed cursor expiry and snapshot bootstrap;
- local-only table exclusion;
- claims/effect dispatch unavailable offline;
- discovery advertises only the implemented contract.

TQ-406 fulfills this obligation by killing processes at every external
commit/ack boundary, duplicating and reordering transport, diverging two
offline replicas, expiring cursors, restoring old backups and advancing
controlled clocks across retention boundaries. See
`TQ-406_SYNC_CHAOS_AND_RECOVERY.md`.

## 19. Consequences

The model is more work than copying rows, but the complexity is explicit and
testable. Ordinary single-store use pays no semantic cost. Multi-device users
get immediate offline local writes for safe commands, canonical convergence
after sync and honest conflicts rather than guessed outcomes.

The first implementation may expose conflicts through CLI/service inspection
before a rich UI exists. That is acceptable: a headless agent can reason over
typed variants and issue a resolution command. Hiding divergence until a web
surface exists is not acceptable.
