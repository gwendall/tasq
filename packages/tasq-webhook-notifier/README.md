# `@tasq-internal/webhook-notifier`

Generic signed attention delivery handler for the existing Tasq transactional
outbox. It accepts only six attention classes and posts a bounded neutral
envelope to one pinned HTTPS endpoint.

Receivers must deduplicate `Tasq-Delivery-Id` and acknowledge the exact
delivery ID and payload digest. Provider-specific email, Slack or paging
adapters belong behind that receiver, outside Core.

TQ-620 adds deterministic `input_required` request records, derived-digest
attention policies, absolute do-not-disturb intervals, bounded stable batch
envelopes and externally rated cohort metrics. Core can lease a contiguous
outbox prefix and acknowledge the complete delivered batch atomically. No
transport call is possible from a deferred DND plan.
