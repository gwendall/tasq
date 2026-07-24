# `@tasq-internal/webhook-notifier`

Generic signed attention delivery handler for the existing Tasq transactional
outbox. It accepts only six attention classes and posts a bounded neutral
envelope to one pinned HTTPS endpoint.

Receivers must deduplicate `Tasq-Delivery-Id` and acknowledge the exact
delivery ID and payload digest. Provider-specific email, Slack or paging
adapters belong behind that receiver, outside Core.
