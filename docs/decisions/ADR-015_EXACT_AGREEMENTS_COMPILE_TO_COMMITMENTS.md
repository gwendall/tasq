# ADR-015 — Exact agreements compile to commitments

> **Status:** Accepted — 2026-08-10
> **Decision owner:** `@gwendall`
> **Execution:** TQ-627

## Context

An assignment answers “who is expected to act?” It does not prove that every
party accepted the same price, cancellation rule, outcome criteria or remedy.
A commitment records work owed; adding commercial fields to every commitment
would make the universal kernel a contract taxonomy and still would not prove
mutual assent.

The missing primitive is exact, multi-party consent followed by a deterministic
compilation into existing commitments and completion-resolution policy.

## Decision

Tasq stores four append-only agreement records:

1. an immutable offer containing canonical terms and their domain-separated
   digest;
2. one immutable acceptance per party, bound to that exact digest;
3. at most one immutable withdrawal or rejection;
4. one immutable activation that names every acceptance and every compiled
   commitment/resolution-contract pair.

An agreement must have at least two parties and reciprocal obligations: every
party is both obligor and beneficiary of at least one obligation. Parties and
obligations are canonically sorted. The authenticated principal is always the
offeror, accepting party or termination actor; caller text cannot name another
principal.

The final required acceptance and all compiled rows commit in one root writer
transaction. Each obligation becomes an ordinary evidence-backed commitment
plus an existing TQ-612 resolution contract. Agreement amount, cancellation
and other terms remain in the offer; commitments carry only provenance IDs and
the terms digest in metadata. No price or contract column is added to the task
table.

Expiry is derived at an explicit authority time. Withdrawal and rejection are
append-only. An amendment is a new offer that preserves the party set and
names its predecessor. Once accepted, it supersedes the nearest prior
activation and atomically cancels its non-terminal compiled commitments; done
commitments remain historical facts.

A TQ-624 custom binder can authenticate exact acceptance bytes and the
accepting party. Signature validity does not itself grant effect authority.
Assignment acceptance never creates an agreement acceptance.

## Consequences

- parties cannot accidentally accept different offer revisions;
- partial compilation and final acceptance roll back together;
- offer, rejection, withdrawal, expiry and amendment history remains legible;
- settlement can consume exact agreement and resolution facts in TQ-628;
- payment execution still requires the separate effect approval/dispatch path;
- agreement support advances the source store to format 31 and supersedes
  earlier protected migration-candidate evidence.

