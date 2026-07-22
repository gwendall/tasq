# TQ-608 — Migration and data-safety envelope

**Status:** accepted next work; compatibility implementation and hostile proof pending  
**Depends on:** TQ-403, TQ-405 and the TQ-604 candidate lifecycle  
**Blocks:** first protected package release in TQ-603

## Outcome

An alpha user can upgrade Tasq without trusting that a successful process exit
means their ledger survived. Every persisted format has an explicit
compatibility envelope, every forward migration produces a verified recovery
point and receipt, and an older binary fails closed when it sees a newer store.

## Current baseline

The migration runner already serializes concurrent upgrades, checksum-pins
immutable SQL files and creates a mode-0600 `VACUUM INTO` snapshot before
migrating an existing file. `tasq backup --json` already verifies SQLite
integrity, foreign keys and the highest event cursor. The candidate lifecycle
proves same-ledger upgrade, rollback with a matching snapshot and
data-preserving uninstall.

The missing public contract is visibility and enforcement: there is no single
store-format version/range response, no durable receipt binding the automatic
snapshot to before/after verification, no explicit newer-schema diagnostic and
no portable user export contract.

## Required compatibility contract

Every executable and release manifest declares:

- `storeFormat.current`;
- `storeFormat.readable.min/max`;
- `storeFormat.writable.min/max`;
- the oldest directly tested source release;
- whether migration is required and irreversible;
- the rollback rule: matching binary plus verified pre-migration snapshot.

Opening a store newer than the executable's readable or writable range must
return a typed, non-mutating error with detected and supported versions. Unknown
or missing applied migrations, checksum drift and partial migration state fail
closed. Downgrade never mutates a newer live store in place.

## Migration transaction and receipt

Before the first schema mutation, Tasq must create and verify a private snapshot
and durably record a receipt containing source path identity, source format,
target format, migration set/digests, snapshot path/digest/size, pre-migration
integrity and event cursor. After migration it runs integrity, foreign-key,
schema and service-level doctor checks and appends the post-migration cursor and
result. A failed post-check keeps the snapshot and returns an actionable restore
plan; it never reports upgrade success.

The receipt contains no task prose or secret values. Automatic snapshot
rotation may occur only after a later verified backup exists and must never
delete the last compatible recovery point.

## Portable export

Add a versioned, bounded export containing durable user-owned records,
workspace identity, event ordering and extension type references without
credentials, local listener registrations or runtime caches. Export is for
portability and inspection, not a substitute for a byte-exact recovery
snapshot. Import validates the entire document before mutation and uses a new
store unless the operator explicitly chooses a separately designed merge.

## Hostile acceptance matrix

For every supported direct upgrade, and at minimum N-2 through current:

- real old binaries create nontrivial ledgers; current bytes upgrade them;
- concurrent first-open processes apply each migration once;
- process kill is injected before snapshot, after snapshot, during DDL and
  before/after receipt finalization;
- disk-full, corrupt snapshot, checksum drift and missing migration cases fail
  without claiming success;
- an old binary refuses the newer store without writing;
- doctor proves commitments, evidence, audit sequences, idempotency and leases
  remain coherent;
- restore of the verified pre-migration snapshot with its matching binary works;
- portable export round-trips through a fresh store with declared omissions.

No public package release passes TQ-608 on synthetic in-memory databases alone.
The certificate must identify exact old/new artifacts, database and export
digests, injected fault boundaries and retained recovery files.
