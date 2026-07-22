# TQ-206/TQ-207 — Effect receipts, uncertainty recovery and compensation

> Implemented universal outcome boundary for external writes. Connectors verify
> provider facts; Tasq preserves the exact authority, execution and evidence
> chain without embedding provider semantics or completing commitments.

## What this adds

Migration `0016` adds the append-only `effect_receipt` ledger and the current
`effect.outcome_receipt_id` link. A receipt binds all of the following in one
canonical, digest-protected report:

- workspace, effect and exact request digest;
- stable dispatch idempotency key;
- approval, attempt claim and fencing token used at dispatch;
- connector instance and immutable connector binding digest;
- connector delivery identity and, for terminal outcomes, provider operation
  identity;
- `committed`, `failed` or `indeterminate` outcome;
- provider occurrence time, raw evidence reference/digest and minimized payload;
- the prior indeterminate receipt resolved by a later provider lookup.

The receipt is linked atomically to an immutable `task_evidence` row. Receipt
evidence does not complete the commitment: a separate completion decision must
still accept the appropriate basis.

## Trust boundary

`recordEffectReceipt` accepts a canonical connector report plus a trusted,
DB-free `EffectReceiptVerifier`. The verifier receives the parsed report and an
injected clock snapshot. Its output records verification level, method, exact
coverage and minimized details.

Terminal provider outcomes fail closed unless verification is independent of
the caller and covers all four identities:

1. provider account;
2. provider operation;
3. exact request identity;
4. provider outcome.

The service, public Zod schema, SQLite triggers and `doctor` enforce overlapping
versions of these rules. A connector delivery key is retry-safe only for the
same canonical report; reuse with different content is an integrity error.

## Uncertainty and recovery

A timeout or lost response must be recorded as `indeterminate`, with no claimed
provider operation identity. Tasq does not guess, mark success, or blindly
dispatch the effect again. A later connector lookup creates a new strongly
verified terminal receipt whose `resolvesReceiptId` points to the current
indeterminate receipt. The original uncertainty remains in history.

The only receipt state transitions are:

```text
executing ── terminal receipt ──> committed | failed
    │
    └──── uncertainty receipt ──> indeterminate
                                      │
                                      └── verified lookup receipt ──> committed | failed
```

## Compensation

Compensation is not rollback and never rewrites a committed effect. It is a new
effect occurrence with:

- a new effect ID and dispatch key;
- `compensationOfEffectId` pointing to the committed original;
- its own exact request, approval chain, execution permit and receipt;
- a complete independent audit/evidence trail.

This works for refunds, message retractions, deployment rollback operations,
filesystem restoration and any other domain where the provider exposes a
compensating action. Tasq does not assume the compensation perfectly erases the
original real-world consequence.

## Public surfaces

The strict kernel/service exports:

- `recordEffectReceipt`;
- `getEffectReceipt`;
- `listEffectReceipts`;
- `EffectReceiptVerifier` in the DB-free extension SDK.

`tasq.inspect.v1` now includes `effectReceipts`, and discovery advertises the
receipt record/get/list operations. `doctor` independently recomputes receipt
digests, checks decomposed identities, evidence/principal links, verification
coverage, recovery chains and every effect's current outcome receipt.

## Clock and I/O rules

Neither the schema, service nor verifier reads the device clock. Composition
injects `now` or a `Clock`; provider occurrence time remains an explicit signed
or authenticated report field. Tasq performs no provider network request. The
connector owns credentials, I/O, provider lookup and receipt authentication.

## Executable evidence

Service tests prove:

- weak terminal reports are rejected without changing effect state;
- one strong terminal report creates one receipt and one linked evidence row;
- identical delivery retry returns the original receipt, while conflicting
  reuse fails;
- receipt rows are immutable and visible through canonical inspection;
- timeout uncertainty can only resolve through a new linked provider receipt;
- original and compensating effects retain separate approval, dispatch and
  receipt chains;
- healthy histories pass `doctor`.

TQ-208 adds black-box adversarial acceptance across unrelated write domains.
