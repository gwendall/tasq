# TQ-501 — bounded, reason-traced context packets

> **Status:** implemented 2026-07-19  
> **Contract:** `tasq.context-packet.v1`  
> **Surfaces:** embedded kernel API, `tasq context` / `tasq brief`, local MCP

## 1. Problem from first principles

An agent cannot act safely from either no shared state or the complete history
of a mature ledger. The first causes duplicate or conflicting work. The second
has unbounded cost, lets stale detail crowd out current authority and eventually
exceeds every model context window.

A useful cold-start packet therefore needs five properties at once:

1. **bounded** — a caller chooses hard record and portable-token ceilings;
2. **sufficient as an index** — current commitments, coordination pressure and
   an exact drill-down operation are present;
3. **explainable** — ordering, inclusion reasons, truncation and omissions are
   data, not undocumented ranking behavior;
4. **resumable** — the packet returns the workspace event frontier;
5. **non-destructive** — projection never replaces raw records or audit.

This is not a planner, vector search result or conversation checkpoint. Those
systems may consume the packet, but their policy is not kernel semantics.

## 2. Contract

```bash
tasq context \
  --tenant robotics/team-a \
  --actor agent:planner \
  --max-records 20 \
  --max-tokens 8192 \
  --json
```

`brief` is an exact CLI alias. Cold onboarding advertises an executable
`context.read` recipe, and read-capable MCP hosts expose `tasq_context`.
Discovery advertises
`https://schemas.tasq.dev/capabilities/context-packets@1` with operation
`build`.

The response contains the exact scope and snapshot time, complete ordering
tuple, requested and consumed budgets, selection and omission counts, compact
commitment and coordination facts, reason and truncation traces,
`inspectCommitment` drill-down coordinates and the exclusive
`afterEventSequence` cursor. Snapshot and defer/expiry decisions use only the
injected `Clock`.

## 3. Portable token budget

There is no universal tokenizer across model vendors or model versions. V1
therefore uses this versioned estimator:

```text
https://schemas.tasq.dev/token-estimators/utf8-byte-upper-bound/v1
```

Every UTF-8 byte counts as one possible token. This is conservative, language
neutral, deterministic and safe for byte-fallback tokenizers. `usedTokens`
equals `measuredUtf8Bytes` for the exact canonical compact JSON payload. The
CLI emits that exact encoding plus one trailing newline.

`maxTokens` is a hard payload ceiling. An item is included whole or reported
under `omitted.tokenBudget`. Descriptions and success criteria have separate
byte caps; each truncation reports its field and original/projected byte
lengths.

## 4. Deterministic selection

V1 includes live `in_progress`, `blocked` and `open` commitments. Future
`notBefore` work is excluded unless `includeDeferred=true`. The ordering tuple
is:

1. status tier descending: `in_progress`, `blocked`, `open`;
2. deadline tier descending: overdue, due within 24 hours, future, none;
3. explicit priority descending;
4. due time ascending with nulls last;
5. update time descending;
6. commitment ID ascending.

This is deliberately simpler than the bundled life prioritizer. It is a
neutral continuity and attention index, not strategic judgment; attention is
not authorization. Every item
exposes the rank inputs and reason codes.

Query cost is bounded too: at most
`min(max(maxRecords × 20, 200), 5000)` candidates are evaluated. A count query
reports the exact eligible total and the remainder is explicit under
`omitted.candidateScanLimit`. Active claim details and aggregate active attempt,
assignment, relation and unresolved-effect counts are loaded in bounded batch
queries, never one query per item.

## 5. Source fidelity and boundaries

The packet omits profile-only area/goal/project/next-action/recurrence fields,
metadata and raw effect payloads. Full canonical inspection remains the
drill-down source. The response never claims that selection authorizes work,
that a claim grants effect authority, that omitted records are unimportant,
that context is reusable memory or that the cursor is a backup.

TQ-502 may add compact summaries of terminal work only as additive,
source-bound records. Raw audit, evidence and inspection remain authoritative.
TQ-503 keeps reusable memory outside the commitment model.

## 6. Acceptance evidence

Executable tests prove deterministic ordering/reasons, exact record and byte
accounting, whole-record omission, visible Unicode-safe truncation, a
205-record bounded-query ledger, deferred behavior, mutable and forbidden
clock injections, unchanged cold-recipe execution, read-only MCP isolation and
discovery implementation coverage.
