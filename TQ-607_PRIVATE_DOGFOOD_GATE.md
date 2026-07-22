# TQ-607 — Private multi-application dogfood gate

> **Status:** accepted and in progress — 2026-07-22
> **Machine status:** `TQ-607_DOGFOOD_STATUS.json`
> **Unlocks:** the explicit public-source launch decision and TQ-603

## Outcome

Use Tasq as a real operating dependency before turning repository visibility
or package publication into a public promise. The program keeps the repository
at open-source quality while it remains private, and tests whether Tasq is
useful and natural across unrelated applications rather than merely correct in
repository fixtures.

This is a product-learning gate. It does not authorize Server, Cloud, new Core
ontology or public distribution.

## Minimum duration

The program spans at least 30 calendar days. Calendar duration alone is not
evidence: the personal composition must record at least 20 active-use days, and
each other consumer must complete its required real journeys. The earliest
possible decision date is recorded in the machine status.

## Operating sequence

The program is executed in this order; later phases do not erase evidence or
restart the ledger from an easier state:

1. **Baseline and activation — 2026-07-22 onward.** Record the exact candidate
   version/commit, take and verify the first isolated backup, and activate all
   three consumer tracks. The immediate next action is to record that baseline
   and backup evidence in `TQ-607_DOGFOOD_STATUS.json`.
2. **First complete journeys — week 1.** Complete one real personal
   commitment loop, the Kami contention/fence/reclaim journey and one
   interactive `input_required` resume. Log friction at discovery time.
3. **Repeated operation — weeks 2–4.** Reach the 20 personal active-use days,
   run multiple independent commitments and conversations, and fix or
   explicitly accept recurring friction without wiping retained data.
4. **Resilience drills — throughout, complete before review.** Perform two
   forward upgrades, backup/restore, replacement-actor recovery, cold-agent
   onboarding and support-bundle review against the same evolving data.
5. **Decision review — no earlier than 2026-08-21.** Reconcile every required
   proof and critical failure, then record `go`, `extend` or `no_go`. A `go`
   advances the backlog to TQ-603 but does not publish anything.

## Three required consumers

### 1. Personal life-pilot

Use the existing Local composition for real commitments, waits, evidence and
reviews. Record where Tasq changes an actual decision or handoff, and where it
creates administrative work without coordination value.

Required proof:

- at least 20 active-use days;
- real open, blocked, resumed and evidence-completed commitments;
- one bounded context/cursor restart by a replacement agent;
- no direct SQL or Markdown mutation used to repair normal operation.

### 2. Kami Robotics

Coordinate at least one real or hardware-faithful robot resource through an
opaque resource key, lease, fence and final pre-I/O verification. Exercise
contention, holder loss, expiry/reclaim and observable evidence.

Required proof:

- two independent actors contend for the same resource;
- a stale fence is rejected at the adapter boundary;
- one crash/reclaim journey advances the fence;
- robot/provider vocabulary remains outside Core.

### 3. Interactive agent runtime

Integrate a Denshin-shaped or equivalent private consumer using candidate
bytes or a source-built install outside its application checkout. Map a stable
conversation to `contextId`, each run to `externalId`, and runtime state to
attempts without granting completion authority.

Required proof:

- `running -> input_required -> running -> terminal` on one attempt;
- a second run in the same conversation creates a second attempt;
- a lost response or adapter restart does not duplicate the external run;
- runtime success leaves the commitment open until a separate evidence-aware
  completion decision.

This private integration is learning evidence for TQ-607. Formal public-byte
consumer conformance remains TQ-320 after TQ-603.

## Cross-cutting drills

Across the three consumers, complete all of the following against retained
dogfood data:

1. two forward upgrade drills without replacing the ledger;
2. one verified backup and restore into an isolated home;
3. one process-loss recovery by a replacement actor;
4. one cold coding-agent onboarding from repository docs only;
5. one redacted support-bundle review;
6. one review of every workaround and direct operator intervention.

No test may wipe or rewrite a live dogfood ledger to manufacture success.

## Friction log

Every material failure or workaround is classified as exactly one of:

- `kernel_invariant` — the neutral coordination model is insufficient or
  unsafe;
- `profile_policy` — adopter-specific planning or prioritization concern;
- `adapter_connector` — runtime/provider mapping or final I/O boundary;
- `product_ergonomics` — installation, commands, Console or operator flow;
- `documentation_onboarding` — a human or agent could not discover the path;
- `external_environment` — dependency or platform failure outside Tasq.

Each entry records the consumer, observable symptom, intervention, affected
version/commit, whether data or authority was at risk, and the durable fix or
explicit acceptance. Prose in a dogfood entry is evidence input, never runtime
authority.

## Critical failures

The public-launch decision cannot be `go` while any of these remain unresolved:

- data loss or an unrecoverable ledger;
- a cross-workspace isolation failure;
- a stale claim/fence authorizing protected I/O;
- runtime success implicitly completing a commitment;
- normal operation requiring direct SQL repair;
- provider, machine, conversation or personal-planning ontology leaking into
  Core;
- a fresh agent requiring undocumented maintainer knowledge;
- an upgrade that cannot preserve and inspect the same ledger.

## Exit decision

At or after the minimum date, the maintainer records one explicit decision:

- `go` — TQ-607 closes, public-source launch may be separately authorized and
  TQ-603 becomes active;
- `extend` — dogfood continues with named missing evidence and a new review
  date;
- `no_go` — public launch remains blocked and only the failed product boundary
  is reopened.

The decision must summarize observed value as well as correctness. Passing
tests without repeated useful operation across the three consumers is not a
`go` result.

## Definition of done

- all three consumer requirements pass on real retained data;
- the minimum duration and active-use threshold pass;
- two upgrades, backup/restore, crash recovery and cold onboarding pass;
- every critical incident is closed or the decision is `no_go`;
- the friction log shows no repeated hidden convention or direct-store repair;
- human and machine backlog truth agree;
- the maintainer records `go`, `extend` or `no_go` with evidence links.
