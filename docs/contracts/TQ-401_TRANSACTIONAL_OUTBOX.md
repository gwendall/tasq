# TQ-401 — Transactional delivery outbox

> **Status:** implemented 2026-07-19. Database events remain authoritative;
> delivery intent is now durable across the commit/process boundary. Drain,
> retry, quarantine and repair are deliberately TQ-402.

## Outcome

Before TQ-401, Tasq invoked a process-global listener after a mutation had
committed. This avoided journaling rolled-back events, but a process killed
after SQLite `COMMIT` and before the listener call could permanently omit the
event from the JSONL mirror.

Tasq now has a provider-neutral local delivery primitive:

- `delivery_sink` declares a stable local consumer and stores only a digest of
  its host-owned logical handler semantics;
- `delivery_outbox` records one mutable delivery lifecycle per sink/event pair;
- the immutable `event` row remains the content and ordering source of truth;
- a SQLite `AFTER INSERT` trigger creates outbox rows inside the same
  transaction as the event;
- the trigger copies `event.created_at`, which came from the injected operation
  clock. It never calls a SQLite or device clock.

The CLI registers its JSONL mirror as one sink before executing a command. A
new sink begins strictly after the current event cursor, so upgrading an
existing installation does not replay old database history into a journal
that may already contain it.

## First-principles invariants

1. **State and events are truth.** An outbox failure rolls back the event and
   its surrounding domain mutation. A delivery failure never rewrites either.
2. **Intent is atomic.** For every enabled sink at event insertion, the event
   and exactly one outbox row commit or roll back together.
3. **Content is not duplicated.** Outbox rows reference `event.sequence` and
   `event.id`; they do not carry a second mutable copy of the payload.
4. **Sinks are local.** Sink and delivery state are operational host state and
   must not participate in future replica synchronization.
5. **Bindings fail closed.** Reusing a sink ID with a different kind or
   configuration digest is rejected. Pending work cannot silently move to a
   different destination.
6. **Registration is non-retroactive.** The sink snapshots the current event
   cursor as `start_after_sequence`; only later events are enqueued.
7. **Disable is not delete.** Disabling a sink stops future enqueueing but
   preserves its existing delivery history and pending records.
8. **Time is injected.** Registration/disable operations use `Clock`/`now`;
   enqueue time inherits the already-injected event timestamp.

## Storage contract

### `delivery_sink`

| Field | Meaning |
|---|---|
| `id` | Stable host-chosen sink identity |
| `tenant_id` | Workspace boundary |
| `kind` | Versioned handler identity, not executable code |
| `configuration_digest` | SHA-256 binding to host-owned handler semantics |
| `status` | `enabled` or `disabled` |
| `start_after_sequence` | Registration baseline; historical events at/below it are excluded |
| `created_at`, `updated_at` | Injected operation time |

### `delivery_outbox`

| Field | Meaning |
|---|---|
| `id` | Deterministic `sink_id/event_id` identity |
| `sink_id` | Declared local consumer |
| `event_sequence`, `event_id` | Immutable source event identity/order |
| `status` | `pending`, `delivering`, `delivered`, or `quarantined` |
| `attempt_count`, `available_at` | Retry control plane reserved for TQ-402 |
| `lease_owner`, `lease_expires_at` | Exclusive drain ownership reserved for TQ-402 |
| `last_error` | Bounded diagnostic reserved for TQ-402 |
| `delivered_at`, `quarantined_at` | Mutually exclusive terminal delivery timestamps |
| `created_at`, `updated_at` | Injected/inherited time |

Database checks enforce every status/timestamp/lease combination. The unique
workspace/sink/event index and deterministic row ID make enqueue identity
unambiguous.

## Transaction boundary

```text
service mutation transaction
  ├─ write current domain row
  ├─ insert immutable event
  │    └─ SQLite trigger: insert pending row for each enabled local sink
  └─ COMMIT all three, or ROLLBACK all three

process may die here ────────────────────────────────────────────────

TQ-402 drain reads pending rows and delivers them idempotently
```

Putting the boundary in SQLite matters: `recordEvent` can be called directly,
and future service modules cannot accidentally forget an application-level
`enqueue()` call.

## Implemented API

The full and strict kernel service entrypoints both expose:

- `ensureDeliverySink`;
- `disableDeliverySink`;
- `getDeliverySink`;
- `listDeliveryOutbox`.

These APIs are administrative/operational. They do not create task audit
events and do not grant provider effect authority.

## Executable evidence

`packages/tasq-service/test/delivery.test.ts` proves:

- registration snapshots the existing cursor and does not backfill history;
- a later event receives exactly one pending row with the event's controlled
  timestamp;
- deleting the outbox table makes the real trigger fail and rolls back both
  the task and event;
- closing and reopening the database after commit, with no listener, preserves
  the pending delivery;
- configuration retargeting fails closed;
- disabling a sink preserves the record and stops future enqueueing.

Migration tests also run `0017_transactional_outbox.sql` against fresh,
legacy pre-agentic and populated stores.

## TQ-402 follow-through

TQ-401 made loss impossible but did not consume or acknowledge rows. TQ-402 is
now implemented: the CLI uses a lease-based drain, idempotent JSONL append,
bounded retry, poison quarantine and explicit `doctor --repair-outbox` repair.
See `TQ-402_OUTBOX_DRAIN_AND_REPAIR.md`.
