# Tasq Local data safety

Tasq distinguishes three different operations:

- a **migration snapshot** is an automatic byte-exact recovery point created
  before an existing store is upgraded;
- `tasq backup` is an operator-requested byte-exact recovery snapshot;
- `tasq export` is a bounded, portable workspace document. It is useful for
  inspection and transfer, but it is not a recovery snapshot.

## Check compatibility before an upgrade

```bash
tasq version --json
```

The `storeFormat` object declares the executable's current, readable, writable
and directly migratable ranges. Published `v0.3.0` reports format 26; current
repository source reports format 29 after signed-statement,
replica-principal-binding and trusted-binder-registry migrations. Trust the exact executable output rather
than this prose when upgrading a retained ledger. An executable
refuses unknown, newer, checksum-drifted or non-contiguous migration history
before applying a corrective write. JSON callers receive a typed
`tasq.store-compatibility-problem.v1` response and exit code 3.

Opening an older existing store is irreversible in place. Tasq first creates a
mode-0600 SQLite snapshot beside the store under
`<db-path>.tasq-migrations/`, verifies integrity, foreign keys and the event
cursor, then atomically writes `tasq.migration-receipt.v1`. A private
cross-process lock serializes the complete snapshot-to-receipt operation and
is reclaimed when its owning process no longer exists.

After commit, Tasq verifies SQLite integrity, foreign keys, the exact schema
format and service invariants. A crash-left pending receipt is reconciled on
the next open. Failed post-checks retain the snapshot and return
`tasq.migration-safety-problem.v1`; they never report the upgrade as successful.
Quota exhaustion during snapshot creation leaves the source schema unchanged;
any partial diagnostic file remains inside the private recovery directory,
mode 0600, and never receives a successful migration receipt.

## Create and verify a recovery snapshot

```bash
tasq backup /private/path/tasq-before-change.sqlite --json
```

Keep the returned SHA-256, event cursor, store format and exact executable
version together. A rollback always requires both the matching snapshot and a
binary that supports its format. Never point an older binary at a newer live
store and never delete `~/.tasq/db.sqlite` to recover.

Recovery is deliberately not an autonomous CLI mutation. Stop every process
using the ledger, preserve the rejected/current database and its `-wal`/`-shm`
sidecars for forensics, copy the verified snapshot to a new explicit path, and
run the matching binary against that path first:

```bash
TASQ_DB_URL=file:/private/recovery/tasq.sqlite \
  tasq doctor --tenant <space> --actor <operator> --json
```

Only an operator should decide whether that verified copy replaces the normal
store. The JSONL journal is parity evidence, not a replay-complete backup.

## Export or transfer one workspace

```bash
tasq export ./workspace.tasq.json --max-records 100000 --json
tasq import ./workspace.tasq.json --db /private/new-tasq.sqlite --json
```

Import validates the whole `tasq.portable-export.v1` document before creating
the target and refuses an existing target. The new database is mode 0600. The
document preserves durable workspace-owned commitments, coordination records,
event ordering and extension references. It explicitly omits credentials,
listener registration, the local delivery outbox, idempotency cache,
replication transport state, local configuration and the event journal.

Run the exact `next.doctor` argv returned by import before using the new store.
Portable import is create-only in v1; there is no merge into an existing
ledger.

## N-2 compatibility rule

For the `v0.4.0` candidate, exact public `v0.2.0`/format-25 and
`v0.3.0`/format-26 binaries and bytes are mandatory inputs. The local
source-candidate matrix passes locally and in protected CI on Darwin arm64 and
Linux x64 GNU, including nontrivial retained ledgers, format-28 migration
receipts, doctor and matching-binary restore. The protected result is run
[30625856802](https://github.com/gwendall/tasq/actions/runs/30625856802),
bound to source commit `71f7f8c3f70f712ff06d51bec0f30b82cbe372b5`.
The later exact published `v0.4.0` replay has not run, so candidate evidence is
not shipped support.

An old binary's typed refusal guarantees no logical ledger, journal, receipt
or recovery-snapshot mutation. Do not interpret that as a byte-exact
filesystem promise for historical alpha binaries: published `v0.3.0` may touch
SQLite `-shm` and empty `-wal` sidecars during refusal. Preserve the complete
store and sidecars for forensics, and restore only the verified snapshot plus
its corresponding journal with the matching binary.
