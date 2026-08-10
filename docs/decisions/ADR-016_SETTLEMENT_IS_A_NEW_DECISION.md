# ADR-016 — Settlement is a new decision, never rewritten completion

> **Status:** Accepted — 2026-08-11
> **Decision owner:** `@gwendall`
> **Execution:** TQ-628

## Context

Completion answers whether one commitment met its success criteria. It does not
answer what becomes owed after full, partial, attempted, cancelled or disputed
performance. Writing a payment amount onto the completed task would conflate
outcome, entitlement and external execution. Reopening completion to represent
a refund would erase the fact that motivated the refund.

## Decision

Tasq adds one policy-driven decision primitive with two modes:

- `settlement` consumes an activated exact agreement, one compiled obligation,
  the complete bounded attempt set and an explicit unsuperseded validation
  decision when any exists;
- `recourse` additionally consumes a prior settlement decision and the complete
  set of effects it materialized.

The immutable basis snapshots every source ID, revision, status and digest. A
versioned policy contains canonically ordered rules. The first matching rule
selects one of `full`, `partial`, `show_up`, `cancellation`, `rework`, `credit`
or `indeterminate` and a bounded set of entitlements.

Each entitlement becomes a new evidence-backed commitment. An entitlement may
also create an ordinary proposed effect linked to that commitment. It remains
unapproved: the existing effect authority path is the only way to authorize
or dispatch it. Compensation can reference only a committed effect present in
the exact recourse basis.

Decision, commitments, proposed effects and append-only materialization rows
share one root writer transaction. A same-subject supersession may retire only
pre-dispatch effects and non-performed commitments. Once execution or
performance happened, the caller must create recourse rather than pretend the
old entitlement never existed.

Database uniqueness elects one root settlement per activated obligation and
one root recourse decision per source decision. Supersession is a single chain,
so retries with different idempotency keys cannot create duplicate entitlement
trees.

## Consequences

- completion history never changes because settlement changes;
- stale or cherry-picked attempt/effect sets fail closed;
- failed late materialization leaves no partial decision or entitlement;
- all seven settlement classifications share one provider-neutral contract;
- no record asserts escrow, merchant-of-record, vendor-of-record or payment
  execution;
- source store format advances to 32 and earlier protected migration evidence
  is superseded.
