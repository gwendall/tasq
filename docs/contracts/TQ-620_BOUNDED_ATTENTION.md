# TQ-620 — Bounded human attention

> **Status:** done in source
> **Date:** 2026-08-11
> **Machine certificate:** [`TQ-620_BOUNDED_ATTENTION.json`](TQ-620_BOUNDED_ATTENTION.json)

Human attention is neither an unbounded webhook stream nor a provider channel.
It is a scarce decision resource with four independently testable parts:

1. an immutable request for one exact decision context;
2. an explicit recipient policy;
3. a bounded delivery batch;
4. an externally assessed outcome cohort.

## Request and policy

`createInputRequiredAttentionRequest` binds workspace, event sequence,
recipient, commitment, attempt, reason, bounded summary, source time and the
digest of the exact decision context. Its request identity and payload digest
are deterministic. Replanning the same queue cannot silently change the bytes.

`defineAttentionPolicy` derives its own digest from the complete normalized
policy; callers cannot assert a second, contradictory digest. A do-not-disturb
window is an absolute half-open interval `[startsAt, endsAt)` with a source
reference. Calendar recurrence, timezone and DST materialization belong to the
policy owner. This keeps the notification decision independent of the host
machine's locale or timezone database.

Do-not-disturb always wins over a full batch and a due response deadline. The
surface performs no network call during the interval. Interrupting a quiet
window requires a new explicit policy; there is no hidden "urgent" bypass.
Overlapping windows are honored through the end of their complete union.

## Batch and durable outbox

The planner delays a partial queue only until its declared maximum batch wait,
then emits stable `tasq.attention-batch.v1` envelopes. A full batch or due
response deadline makes the queue eligible immediately outside DND. Each batch
is capped at 50 requests and 65,536 canonical bytes, preserves exact request
order and decision-context digests, and uses a retry-stable delivery identity.

Core's existing transactional delivery outbox remains the durable authority.
`leaseDeliveryBatch` leases only a contiguous eligible prefix of one sink's
strict event-order queue. Backoff, an active lease or quarantine remains a
head-of-line stop. `completeDeliveryBatch` acknowledges the whole externally
committed batch atomically; losing any item rolls the acknowledgement back.
No schema change or second attention store is introduced.

`deliverAttentionPlan` cannot invoke transport for an empty, batching or DND
plan. It signs ready batches through the existing pinned HTTPS sink and stops
at the first retryable, failed or indeterminate result. Receiver-side request
deduplication and the outbox lease/recovery contract remain required across a
crash boundary.

## Measurement without invented quality

`measureAttentionCohort` reports solicitations per work unit, requests per
solicitation, delivery coverage and mean decision quality in integer micros.
Decision-quality scores come from an external evaluator; delivery success is
never treated as quality. `compareAttentionCohorts` refuses to call
solicitations reduced when either cohort dropped requests, and calls quality
comparable only when every work unit in both cohorts has an external rating.

The source tests demonstrate a reduction from two single-request
solicitations to one two-request batch with identical externally supplied
quality. They prove the measurement and no-loss envelope, not a universal
claim that batching leaves human judgment unchanged in production.

## Boundary

Email, Slack, SMS, paging, calendars, preference UI, recipient lookup and
decision-quality evaluation remain integrations. The primitive grants no task,
effect or completion authority and sends nothing unless a host supplies a
policy, pending requests and the existing webhook sink configuration.
