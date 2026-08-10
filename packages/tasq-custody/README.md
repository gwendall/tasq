# Experimental Custody

Private provider-neutral Module for exact, append-only custody lineage.

- one immutable target root and at most one accepted successor per state;
- bilateral offer, accept and refuse with condition/evidence binding;
- append-only incidents against historical states;
- injected time, bounded contention and exact mutation replay;
- deterministic create-only portable export/import.

Custody records accountable possession/control assertions. It does not prove
physical truth or grant ownership, access or effect authority. See
[`TQ-631_EXPERIMENTAL_CUSTODY.md`](../../docs/contracts/TQ-631_EXPERIMENTAL_CUSTODY.md).
