# TQ-502 — Source-bound compaction for terminal work

**Status:** implemented — 2026-07-20
**Contracts:** `tasq.commitment-summary.v1`, `tasq.commitment-summary-page.v1`
**Depends on:** TQ-501 bounded context, TQ-403 durable idempotency, M4 audit
and retention rules

## Outcome

A mature workspace can expose a small amount of recent closed-work context to
a cold agent without replaying every historical record. Tasq stores an
append-only semantic summary only for a `done` or `cancelled` commitment and
binds it to the exact canonical graph that existed when it was written.

This is a derived index, not a new truth source. `inspectCommitment`, the task
event stream, evidence, artifacts, completion records and effect receipts
remain authoritative and are never deleted, shortened or rewritten.

## First-principles invariants

1. **Lossless source:** compaction never mutates raw records. Every summary
   carries an `inspectCommitment` coordinate plus exact event, evidence,
   artifact, completion, receipt and external-reference IDs.
2. **Visible derivation:** the source has a domain-separated SHA-256 digest,
   terminal task revision/status and the last non-summary task-event sequence.
   The text has an independent digest.
3. **No self-invalidating write:** `commitment_summary_appended` is audit, but
   is excluded from the raw source frontier/digest. Appending or correcting a
   summary therefore cannot make that same source stale.
4. **Automatic staleness:** a leaf is `current` only while the commitment is
   still terminal at the same revision and raw audit frontier. Reopen or later
   source activity yields explicit `staleReasons`; no device clock decides.
5. **Append-only correction:** the first summary is the unique chain root.
   A correction names the exact current leaf in `expectedPreviousSummaryId`.
   Unique root/child indexes plus compare-and-swap reject forks.
6. **Durable retry:** append requires a caller-scoped idempotency key with
   durable retention. An exact lost-response retry returns the original row;
   key reuse with different bytes fails.
7. **No authority:** summary text cannot complete a commitment, satisfy an
   evidence policy, approve/dispatch an effect, acquire a claim/resource or
   become reusable memory.
8. **Injected time:** all IDs and timestamps use `now` or a supplied `Clock`.

## Agent surfaces

The embedded kernel exports `appendCommitmentSummary`,
`getCommitmentSummary`, `listCommitmentSummaries` and
`listCurrentCommitmentSummaries`. Discovery advertises
`https://schemas.tasq.dev/capabilities/commitment-summaries`.

```bash
tasq summary current --limit 20 --tenant <space> --actor <actor> --json
tasq summary list <commitment-id> --tenant <space> --actor <actor> --json
tasq summary add <commitment-id> --text "..." \
  --idempotency-key <stable-key> --tenant <space> --actor <actor> --json
```

Corrections add `--supersedes <current-summary-id>`. Cold onboarding returns
`summary.current` plus per-commitment `summary.list` to `read` clients and
`summary.append`/`summary.correct` to `coordinate` clients as argument arrays.
The current page explicitly says that empty items do not prove no summary
history because stale and superseded leaves are excluded. MCP exposes
`tasq_summary_current/list/get` under
`read` and `tasq_summary_append` only under `coordinate`.

The existing `tasq.context-packet.v1` remains byte- and schema-compatible.
Agents compose its active-work view with `summary.current` instead of receiving
an undeclared v1 field.

### Rendezvous and replication boundary

Summary rows are currently a derived projection of one authoritative store;
TQ-405's neutral commitment replica does not replicate them. Two readers see
the same summary only through the same store/transport and exact workspace.
After importing raw commitments into another authority, that authority must
regenerate summaries from its local canonical inspection rather than treating
copied prose as canonical state. A hosted authority may expose the projection
to remote clients under an implementation of ADR-004/TQ-505, but no current
local claim implies cross-store summary convergence.

## Storage and failure behavior

Migration `0023_commitment_summaries.sql` adds one append-only table. SQLite
guards reject non-terminal/mismatched source revisions, cross-workspace task or
principal references, invalid correction parents, updates and deletes. Unique
partial indexes allow one root and one child per parent. Concurrent writers
therefore elect one winner; losers must re-read the leaf.

`current` is ordered by terminal time, summary creation time and ID, and is
hard-limited to 500 records. Its service implementation batches task and raw
event-frontier reads rather than issuing one query per summary.

## Acceptance evidence

- service tests cover terminal-only writes, source references/digests,
  corrections, stale detection, exact retries, direct-SQL immutability and a
  forbidden clock;
- CLI E2E executes `summary.append` and `summary.current` directly from a fresh
  onboarding document, then drills back into raw inspection;
- MCP tests freeze capability isolation and a full terminal-summary read flow;
- cross-domain evals repeat producer-to-unrelated-reader handoff for robotics,
  software and research, then test concurrent roots and reopen staleness;
- inventory and discovery tests make the table, command, event, contract and
  advertised implementation impossible to add silently.

## Deliberate boundary for TQ-503

A closed-work summary describes one immutable commitment source. Reusable
knowledge such as “this robot needs a 2 mm offset” or “deploys require two
approvers” has a different lifecycle, scope and correction model. Tasq does not
promote summaries into memory. TQ-503 will decide whether real workflows need
links to an external memory system; the kernel will not disguise memory as a
task or summary.
