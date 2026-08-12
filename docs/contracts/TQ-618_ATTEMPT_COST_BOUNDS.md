# TQ-618 — Observed attempt cost and hard claim bounds

> **Status:** published and protected-byte certified in `v0.4.0`
> **Date:** 2026-08-11
> **Machine certificate:** [`TQ-618_ATTEMPT_COST_BOUNDS.json`](TQ-618_ATTEMPT_COST_BOUNDS.json)

## First-principles decision

Tasq cannot observe provider spend from an agent's prompt or claim. A cost is
knowable only where a runtime, provider adapter or operator can produce a
receipt. Therefore the primitive is not provider-specific token accounting. It
is an immutable external meter observation bound to one execution attempt.

The implementation reuses two universal records rather than adding a table:

- task metadata holds a typed `tasq.task-cost-budget.v1` policy;
- `external_ref` holds a digest-bound `tasq.attempt-cost-observation.v1`, with
  provider/meter URI plus external observation identity as its unique key.

Amounts are unsigned decimal micros strings, never binary floats. A hard bound
uses one ISO-style three-letter currency; receipts in other currencies fail
closed rather than being converted with an ambient exchange rate. Gross spend
is conservative: refunds do not silently restore execution authority.

## Metering contract

Each receipt freezes:

```text
attempt_id, task_id
meter_uri, observation_id
currency, gross_micros
observed_at
basis: provider_receipt | runtime_meter | operator_attestation
```

Canonical bytes produce the stored SHA-256 digest. The external meter identity
deduplicates delivery across actors and retries. Exact redelivery returns the
same reference; changed bytes under the same identity are rejected. The generic
external-reference API reserves this resource type so callers cannot bypass
atomic bound enforcement.

Tasq records attribution and provenance, not billing truth. `basis` states what
was observed. Authentication, signature verification and provider-specific
normalization remain host/connector responsibilities.

## Budget and renewal semantics

The task policy freezes:

```text
currency
max_gross_micros
renewal_reserve_micros
metering: required | best_effort
```

An initial claim may start before the first receipt. In `required` mode, a live
claim cannot renew until at least one receipt—including a valid zero-cost
receipt—is linked to an attempt under that exact claim. This makes unsupported
runtime observability explicit without instrumenting model reasoning. In
`best_effort` mode, missing receipts remain visible but do not alone refuse.

Renewal is refused when observed gross has reached the maximum or when gross
plus the configured reserve would exceed it. New claims cannot reset the task
total. All checks run inside the claim writer transaction.

Cost recording and heartbeat can race. Both use the same serialized writer
boundary:

- receipt first: the subsequent renewal sees the bound and refuses;
- renewal first: the receipt still commits, then releases the live claim in
  the same transaction if the bound is reached.

After both operations settle there is no active claim beyond the observed hard
bound. The receipt is never rolled back merely to preserve execution authority.

## Surface

```text
tasq cost budget <task> --currency USD --max-micros N [...]
tasq cost record <attempt> --meter <uri> --observation <id>
  --currency USD --gross-micros N --basis <kind> --idempotency-key <key>
tasq cost show <task>
```

Machine claim refusals return `tasq.cost-bound-problem.v1` with code
`cost_metering_required` or `cost_bound_reached` and the exact summary basis.

## Evidence

- strict and best-effort metering tests;
- exact provider-identity replay and changed-byte denial;
- task aggregation with decimal micros;
- reserve exhaustion and new-claim refusal;
- concurrent receipt/renewal proof ending with no active authority;
- generic external-ref bypass denial;
- CLI end-to-end budget, zero receipt, renewal, exhaustion, release and summary.

TQ-608 remains a declared dependency. This source candidate is not a published
support claim until that release gate closes.
