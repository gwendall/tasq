# TQ-813 — Attention webhook

> **Status:** done
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-813_ATTENTION_WEBHOOK_CERTIFICATION.json`

The generic attention sink supports only assignment, blocking, expiring
authority, recovery required, validation requested and completion challenged.
It is an external handler for the existing TQ-401/TQ-402 transactional delivery
outbox; it does not add provider policy or task state to Core.

Each envelope binds workspace, immutable event identity and sequence,
attention class, opaque recipient, optional commitment, reason, bounded
summary and source time. The delivery ID and payload digest are deterministic.
The sink posts canonical JSON to one credential-free pinned HTTPS endpoint,
forbids redirects and signs the exact bytes with a named HMAC-SHA256 key.

The receiver contract must deduplicate `Tasq-Delivery-Id` and return an exact
acknowledgement containing that delivery ID and payload digest. A valid
`accepted` or `duplicate` acknowledgement commits the outbox delivery.
Explicit 429/503 backpressure retries the same identity. Network failures,
oversized/malformed acknowledgements and identity mismatch are indeterminate,
so the host cannot mark them delivered. Other rejection is terminal.

Email, Slack, SMS and paging systems are not kernel concepts. A downstream
receiver may fan the neutral attention out to those providers.

TQ-620 adds a separate, backward-compatible `tasq.attention-batch.v1`
envelope for digest-bound `input_required` requests. The six-class v1 envelope
above remains unchanged. See [`TQ-620_BOUNDED_ATTENTION.md`](TQ-620_BOUNDED_ATTENTION.md).
