# TQ-628 — Settlement and Recourse Modules

> **Status:** source implemented and repository certified; publication remains
> part of the authorized `v0.4.0` gate
> **Decision:** [`ADR-016`](../decisions/ADR-016_SETTLEMENT_IS_A_NEW_DECISION.md)
> **Store format:** 32

## Interface

The embedded Interface exposes:

```text
settlement.evaluate(exact source ids, versioned policy)
settlement.get(decision ID)
settlement.list()
recourse.evaluate(prior decision, exact source ids, versioned policy)
```

Every evaluation runs against one transactionally captured basis:

- activated offer, terms digest and exact compiled obligation;
- source commitment ID, revision and state;
- every current attempt ID, revision and state, with a hard limit of 100;
- one explicit, unsuperseded validation decision if resolution decisions exist;
- for recourse, every effect materialized by the named prior decision.

The caller supplies the expected attempt/effect IDs as an optimistic read-set.
Omission or concurrent drift rejects the evaluation. Policy rules are sorted,
versioned, implementation-digested and domain-separated before hashing.

## Materialization and safety

The first matching rule produces a closed classification and zero to 100
entitlements. Each entitlement creates a normal evidence-backed commitment.
It may additionally create a normal `proposed` effect; approval and dispatch
remain separate existing authority decisions.

The following commit or roll back together:

- immutable decision and exact basis/policy digests;
- every entitlement commitment and task event;
- every optional proposed effect;
- every append-only materialization link.

A decision can supersede only the same decision kind and agreement obligation.
SQL elects one settlement root per activated obligation and one recourse root
per source decision even when distinct idempotency identities race.
The old effects must still be pre-dispatch or terminal without occurrence, and
the old commitment must not be in progress or done. Otherwise recourse is
required. A compensation effect is legal only in recourse and only for a
committed effect contained in the basis.

## Explicit non-claims

Settlement does not:

- rewrite source completion or validation;
- authorize, dispatch or claim success for an effect;
- hold funds or promise escrow;
- make Tasq merchant, vendor or employer of record;
- infer legal enforceability from an agreement record.

## Executable evidence

- `packages/tasq-schema/src/settlement.ts` freezes facts, policies, decisions,
  classifications, entitlements and views;
- `packages/tasq-core/src/migrations/0032_settlement_recourse.sql` makes decisions
  and materializations append-only;
- `packages/tasq-core/src/service/settlement.ts` owns exact snapshots, rule
  evaluation, atomic compilation, safe supersession and recourse;
- `packages/tasq-core/test/settlement.test.ts` covers proposed-effect authority
  separation, idempotency, safe supersession, recourse, late rollback and SQL
  immutability.
