# TQ-631 — Experimental Custody Module

> **Status:** source implemented and cross-domain repository certified;
> private experimental Module, not Kernel or remote product support

## Primitive

Custody is an exclusive accountable-possession/control lineage over one exact
TQ-622 target:

```text
root state
  -> offer(source revision, recipient, condition, evidence, expiry)
  -> accept -> exactly one immutable successor state
          or refuse -> terminal handoff, no successor
  -> incident(state) -> append-only observation, no custody rewrite
```

The primitive does not answer who owns the target, who may access a site, who
may execute an effect, whether physical possession is true or who is liable.
Those decisions stay with their respective authority, evidence and policy
systems.

## Interface and invariants

`ExperimentalCustodyStore` exposes `establish`, `offer`, `accept`, `refuse`,
`reportIncident`, `current`, `exportPortable` and `importPortable`.

- establishment is a self-assertion by the named initial custodian and requires
  evidence;
- only the recorded current custodian may offer a transfer;
- only the proposed recipient may accept or refuse;
- acceptance binds the exact target, source, revision, condition digest and a
  one-for-one set of required evidence categories;
- the acceptance transaction creates the successor and closes the handoff;
- a unique `(workspace, predecessor_state)` index elects one successor even
  across competing store connections;
- accepted states, target identities and incidents are immutable; handoffs
  permit only one guarded `offered -> accepted|refused` transition;
- every mutation uses one caller-scoped request digest and idempotency key;
- caller time is never authoritative: one injected `Clock` supplies decision
  time, and the exact expiry boundary is terminal;
- lock contention is bounded by an explicit host setting.

## Portable boundary

Export is deterministic for an explicit `exportedAt` and carries a content
digest over exact target, state, handoff and incident bodies. It declares that
retry identities and operational events are omitted. Import is create-only and
validates the entire graph before its transaction:

- target and condition digests recompute exactly;
- every target has one root;
- every successor has one matching accepted handoff and predecessor;
- every accepted handoff has exactly one successor;
- offered/refused handoffs have none;
- lifecycle fields and evidence coverage agree with status;
- every incident resolves to a state of the same target;
- cycles, missing links, duplicates and target drift fail without mutation.

This is a portability contract, not offline merge or remote multi-writer
replication.

## Cross-domain evidence and decision

The executable suite proves:

- parcel: seller -> courier -> warehouse -> recipient, a refusal branch and a
  damage incident that remains attached to the warehouse state;
- equipment: two recipients race from one source and exactly one successor is
  elected;
- cryptographic control: exact key identity, condition/evidence binding,
  target-drift denial and no secret/authority claim;
- exact retry, append-only SQL guards, expiry and hostile portable import.

[`ADR-017`](../decisions/ADR-017_CUSTODY_IS_AN_EXPERIMENTAL_LINEAGE.md)
records the decision: reject lease as the custody model, compose signed
observations only as evidence, graduate first-class handoff as a shared
experimental Module, and do not request Kernel admission.

## Executable evidence

- `packages/tasq-custody/src/types.ts`
- `packages/tasq-custody/src/store.ts`
- `packages/tasq-custody/src/decision.ts`
- `packages/tasq-custody/test/custody.test.ts`

## Explicit non-claims

This work does not ship a hosted custody service, provider network, identity or
access system, title registry, insurance/liability decision, physical oracle,
remote-authority surface, replicated custody ledger or Kernel primitive.
