# TQ-608 — Migration and data-safety envelope

**Status:** complete for published `v0.4.0`; format-32 source and exact
published-byte N-2 replay pass on both supported targets
**Depends on:** TQ-403, TQ-405 and the TQ-604 candidate lifecycle  
**Blocks:** each protected package line that changes the store format

## Outcome

An alpha user can upgrade Tasq without trusting that a successful process exit
means their ledger survived. Every persisted format has an explicit
compatibility envelope, every forward migration produces a verified recovery
point and receipt, and an older binary fails closed when it sees a newer store.

## Historical baseline before this candidate

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

That paragraph is the historical pre-implementation baseline. The source
candidate now implements all four contracts. `tasq version --json`, CLI
artifact metadata and public release manifests share `tasq.store-format.v1`.
The runner fails closed on unknown, newer, partial and checksum-drifted
histories, serializes existing-store upgrades with a crash-reclaimable private
lock, creates a verified mode-0600 snapshot and atomic receipt, runs database
plus service post-checks, and reconciles a pending receipt on restart.

`tasq backup --json` now binds digest, cursor, store format and rollback rule.
`tasq export` and create-only `tasq import` implement the bounded portable
workspace contract and declared omissions. Operator instructions live in
`../guides/DATA_SAFETY.md`; stable JSON shapes live in `../reference/CLI_JSON_CONTRACT.md`.

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

## Candidate acceptance result

`packages/tasq-service/test/data-safety.test.ts` uses real filesystem LibSQL
databases. It proves populated format-5 upgrade receipts, concurrent first
open, typed newer-store refusal, corrupt snapshot refusal, failed post-check
restore guidance and portable round-trip. Five separate child processes are
actually killed with `SIGKILL` before snapshot, after verified snapshot, during
DDL, after commit and before receipt finalization; the next process reconciles
each file without leaving a pending receipt. The existing migration suite also
upgrades populated format-0 and format-5 fixtures and rejects checksum drift or
non-contiguous history.

The machine summary is `TQ-608_MIGRATION_CERTIFICATION.json`. Protected run
[30051196124](https://github.com/gwendall/tasq/actions/runs/30051196124)
downloaded and attestation-verified `v0.3.0` on both supported targets, migrated
the populated format-5 fixture to format 26 and passed the post-migration
receipt and doctor checks. A real POSIX file-size quota additionally proves
that snapshot exhaustion leaves the source format unchanged and any partial
snapshot private.

The next-line contract is
`TQ-608_V040_PRERELEASE_MATRIX.json`. Its local harness downloads and
digest-pins the exact public `v0.2.0`/format-25 and `v0.3.0`/format-26
artifacts, has each old binary create a nontrivial ledger, migrates both to the
current `v0.4.0`/format-32 source candidate, verifies the private snapshot, receipt and
post-migration doctor, then restores the snapshot plus journal with the
matching old binary. On Darwin arm64 this full local matrix passes.

Both old binaries return the typed compatibility refusal with exit code 3 and
leave canonical ledger rows, journal, receipt and recovery snapshot unchanged.
The published `v0.3.0` binary does touch SQLite's physical `db.sqlite-shm` and
empties `db.sqlite-wal` while refusing; therefore its refusal is not
byte-exact across the whole filesystem tree. This is recorded as known
historical alpha behavior, not described as a byte-exact no-write guarantee,
and does not weaken the fail-closed domain/recovery-state assertion.

`.github/workflows/certify-v040-migration-candidate.yml` is the protected
Darwin/Linux source-candidate route. It attestation-verifies both public source
lines, binds the candidate checkout to an exact commit and derives the expected
target format from the machine matrix. Protected run
[31447846496](https://github.com/gwendall/tasq/actions/runs/31447846496)
passed on Darwin arm64 and Linux x64 GNU against source commit
`e27451d3510c71a9f875a48991eb2fd80496bfdb` and target format 32. The
downloaded evidence files are SHA-256 bound in the machine certificates. After
`v0.4.0` publication, protected run
[31625205138](https://github.com/gwendall/tasq/actions/runs/31625205138)
replayed the exact downloaded artifacts and attestations on both supported
targets. `publishedV040Replay` is `passed` and TQ-608 is closed for `v0.4.0`.
