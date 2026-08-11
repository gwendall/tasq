# ADR-017 — Custody is an experimental lineage, not a lease or observation

> **Status:** Accepted — 2026-08-11
> **Decision owner:** `@gwendall`
> **Execution:** TQ-631

## Context

Custody answers who is recorded as possessing or controlling one exact target
through a sequence of bilateral transfers. Neither an expiring resource lease
nor a signed observation can provide that answer. A lease coordinates temporary
use and can expire without a successor. A signature authenticates an assertion,
but two contradictory assertions may both be validly signed.

Custody is also not ownership, access, assignment, effect authority, physical
truth or liability. Collapsing any of those meanings into a `custodian` field
would let one record silently grant rights that another authority owns.

## Decision

Tasq adds a private experimental Custody Module with a separate append-only
store. One target begins with one self-asserted root state. The current
custodian may create multiple offers, but recipient acceptance transactionally
elects at most one successor for the source state. A handoff binds the exact
target digest, source state, parties, condition digest, evidence requirements,
expiry and revision. Only the named recipient may accept or refuse it.

Accepted handoffs create immutable successor states. Refusals are terminal.
Incidents append against the exact historical state and never change the
current custodian or decide liability. Portable export contains the target,
states, handoffs and incidents, while explicitly omitting operational events
and retry keys. Create-only import validates the complete graph before writing.

The Module uses the TQ-622 target contract, injected time, bounded contention,
transactional idempotency and database uniqueness. It composes signed evidence
where useful but does not use a signature as successor election.

Cross-domain parcel, equipment and cryptographic-control evidence graduates the
concept from roadmap sketch to shared experimental Module. Kernel admission is
not requested: authenticated remote authority, replication/conflict behavior
and wider independent product evidence remain unproven.

## Consequences

- one source state cannot have two accepted successor states;
- acceptance at the expiry boundary fails closed;
- condition drift, missing evidence and stale revisions fail before transfer;
- exact retries return the original result and conflicting retries are denied;
- no record contains secret key material or grants ownership/effect authority;
- the public product surface and Kernel schema do not change;
- future distributed custody must earn a separate admission decision.
