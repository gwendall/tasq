# TQ-402 — Outbox drain, retry, quarantine and repair

> **Status:** implemented 2026-07-19. TQ-401 made delivery intent atomic;
> TQ-402 now makes local JSONL delivery recoverable and observably idempotent.

## Outcome

The CLI no longer uses its process-global post-commit listener as the journal
delivery path. Every runtime now:

1. registers the logical journal sink;
2. drains recoverable work on startup;
3. executes the requested command;
4. drains newly committed work before closing the database.

If the process dies at any boundary, the next process resumes from SQLite. A
failure to mirror an event does not undo its authoritative domain mutation.
Likewise, transient drain contention during CLI shutdown is reported as
deferred delivery, not as failure of a command whose mutation already
committed; the pending row is retried at the next startup.
Operational delivery transactions are also excluded from the CLI's domain
commit retry guard. A startup acknowledgement cannot make a later rolled-back
business mutation look committed and suppress its safe contention retry.

## Delivery state machine

```text
pending ── lease ──> delivering ── append/ack ──> delivered
   ▲                     │
   │                     ├─ failure below budget ──> pending + backoff
   │                     └─ failure at budget ─────> quarantined
   │                                                    │
   └──────────────── explicit doctor repair ────────────┘

delivered ── doctor detects missing sink record ──> pending (redeliver)
```

All transitions are service-owned, transactional and clock-injected.

## Ordering and leases

- A sink leases only its oldest non-delivered event.
- An unexpired lease, future backoff or quarantined head blocks later events.
- Workers therefore cannot make a journal appear healthy while skipping a bad
  record.
- Lease identity is an opaque per-process value; acknowledgement and failure
  require the exact current owner.
- An expired lease can be reclaimed and increments `attempt_count`.
- Competing workers serialize at SQLite and cannot both own the head.
- Shutdown contention cannot turn a committed command into a false failure.

This is at-least-once execution of the handler combined with idempotent sink
application, which produces exactly-once observable journal records.

## Idempotent JSONL append

The journal lock now checks the complete active segment before appending:

- same event ID and sequence → `already_present`, then acknowledge the outbox;
- event covered by a valid checkpoint baseline → `covered_by_checkpoint`, then
  acknowledge;
- same ID with another sequence, same sequence with another ID, malformed
  content or an out-of-order append → fail closed;
- otherwise append exactly one JSON line.

The critical crash is therefore safe:

```text
append event to JSONL
process dies before SQLite acknowledgement
lease expires
replacement sees same event already present
replacement acknowledges without a second line
```

"Valid" is fail-closed: the checkpoint tenant, boundary event identity and
complete content-addressed archive chain are verified against SQLite before a
covered delivery is acknowledged. Merely writing a syntactically valid cursor
cannot hide an undelivered event.

## Retry and quarantine

Handler failure stores a bounded error and clears the lease. Retry time is
deterministic exponential backoff from the injected clock (1 second base,
5-minute cap in the CLI). The fifth failed lease quarantines the head.

There is deliberately no random jitter in persisted domain logic. Multiple
processes are already serialized by the lease/SQLite boundary, and deterministic
backoff is testable under virtual time.

Quarantine is visible failure, not a skip. Later records remain blocked until
an operator repairs the sink or explicitly accepts a new journal checkpoint.

## Doctor repair

`tasq doctor --repair-outbox --json` compares the current journal with durable
delivery state before running the normal integrity report:

- externally present but unacknowledged → `mark_delivered`;
- acknowledged but externally missing → `redeliver`;
- quarantined or previously failed and missing → reset retry budget and retry;
- expired delivering lease → retry;
- active unexpired lease → leave untouched.

Repair never guesses through malformed external state. The normal doctor
report remains unhealthy until the journal itself is fixed or checkpointed.
The JSON report includes counts for all four outbox states and every explicit
repair action.

## Public service operations

Both full and strict kernel entrypoints expose:

- `leaseNextDelivery`;
- `completeDelivery`;
- `failDelivery`;
- `repairDelivery`;
- the TQ-401 sink registration/read operations.

These primitives are handler-neutral. The JSONL handler lives in the CLI; a
different host can apply the same lease/ack/fail protocol to another local
sink without adding provider semantics to the kernel.

## Clock boundary

- leases, acknowledgements, backoff, quarantine and repair use `Clock`/`now`;
- no SQLite time function participates;
- the CLI injects the sole system-clock adapter at composition;
- tests/evals use `createMutableClock` to cross expiry and backoff boundaries.

## Executable evidence

Service tests prove:

- exclusive head leasing and strict ordering;
- active-lease blocking and expired-lease reclaim;
- stale-owner acknowledgement rejection;
- deterministic backoff, quarantine and explicit retry-budget reset.

CLI tests prove:

- append-before-ack crash recovery creates one physical line;
- malformed journal content quarantines the delivery;
- a forged checkpoint cursor cannot acknowledge a missing journal event;
- explicit repair resumes after the sink is fixed;
- `doctor --repair-outbox` redelivers an acknowledged event removed from the
  journal and returns a healthy parity report.

The TQ-402 eval runs two replacement-agent narratives under a controlled clock
and checks only public service/handler outputs.

## Remaining boundary

TQ-403 generalizes durable idempotency identity and retention for every
externally retriable mutation. TQ-404 then freezes replica conflict semantics;
delivery outbox rows remain explicitly local and are never replication input.
