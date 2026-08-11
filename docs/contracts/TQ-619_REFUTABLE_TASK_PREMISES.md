# TQ-619 — Observation-backed, refutable task premises

> **Status:** source candidate complete; protected publication pending
> **Date:** 2026-08-11
> **Machine certificate:** [`TQ-619_REFUTABLE_TASK_PREMISES.json`](TQ-619_REFUTABLE_TASK_PREMISES.json)

## First-principles model

An observation and a reason to act are not the same object. An observation is
an immutable sourced fact delivered by a connector. A premise is the explicit,
refutable proposition that says why that fact justifies creating one
commitment.

```text
observation → motivating premise → commitment
                         ↓
          proposal → challenge → decision
                         ↓
                   invalidation
```

The task, source observation and every resolution record remain immutable or
append-only. Refutation never deletes the task or rewrites its original status.

## Atomic intake

`createTaskWithPremise` accepts one existing workspace observation, a bounded
proposition, eligible validators and optional adjudicators. It creates the task
and its premise in one writer transaction. A missing observation, disabled
validator, duplicate retry conflict or late insert failure leaves no task.

The premise freezes the task revision, exact observation ID and a canonical
SHA-256 digest of the observation row. The observation remains the source fact;
the proposition remains the independently disputable interpretation.

The Local CLI exposes the same atomic boundary:

```text
tasq add "Review PR 42" \
  --premise-observation <observation-id> \
  --premise "PR 42 remains open and needs review" \
  --premise-validators reviewer-a,reviewer-b \
  --idempotency-key create:pr-42
```

Premise-backed creation is opt-in. Existing task creation remains unchanged.
No connector, remote Server or MCP route silently creates a premise.

## Resolution mechanics

The chain uses the same separation as independent completion resolution:

- a proposal says `uphold` or `refute` and binds exact task evidence;
- a challenge appends counter-evidence without overwriting the proposal;
- a decision is appended by an eligible validator;
- a challenged proposal requires a named adjudicator before it can be
  accepted;
- self-validation is denied unless the premise explicitly allows it;
- an accepted refutation atomically appends an invalidation.

The typed premise records are stored as digest-bound, reserved
`external_ref` resources. The generic external-reference API cannot insert
these types and bypass the resolution service. This adds no migration and is
already covered by portable export/import of external references.

## Invalidation semantics

Premise invalidation withdraws execution authority, not history:

- active claims are released with `premise_invalidated`;
- running or input-required attempts become cancelled;
- later claims fail closed;
- `tasq next` excludes the commitment;
- `premise show` still returns the original task, premise, proposals,
  challenges, decision and invalidation;
- task status and `deletedAt` are not rewritten.

Keeping premise validity orthogonal to task lifecycle prevents a later factual
correction from pretending that the commitment never existed or from rewriting
a completion that may already have happened.

## CLI

```text
tasq premise show <task>
tasq premise propose <task> --verdict uphold|refute --evidence <ids> ...
tasq premise challenge <task> --proposal <id> --counter-evidence <ids> ...
tasq premise decide <task> --proposal <id> --outcome <outcome> ...
```

Every mutation requires durable retry identity. JSON output returns the exact
append-only record; `show` returns `tasq.task-premise-state.v1` and an explicit
`actionable` boolean.

## Evidence

- atomic task/premise creation and exact lost-response replay;
- missing-observation rollback;
- task-scoped evidence enforcement;
- independent-validator and challenged-adjudicator enforcement;
- accepted refutation releasing claims and cancelling live attempts;
- subsequent claim refusal and `next` exclusion;
- retained, readable non-deleted history;
- generic external-reference bypass denial;
- Core/service typechecks and Local CLI end-to-end execution.

