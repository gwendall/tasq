# TQ-307 — public-surface compatibility suite

> Implemented 2026-07-19. This is an executable compatibility proof over one
> local ledger, not a claim that Tasq already ships a hosted remote transport.

## Outcome

One durable commitment can now be created, coordinated, executed and completed
through three independently usable public boundaries without creating three
versions of truth:

1. the real `tasq` CLI creates an evidence-mode commitment;
2. an official MCP client discovers the capability-scoped server, reads the
   same commitment, starts it and acquires its lease;
3. the A2A 1.0 adapter imports a completed remote Task as one succeeded attempt,
   external reference and digest-bound artifact;
4. MCP records coordinator evidence and releases the lease;
5. the CLI sees the complete graph and makes the explicit evidence-bound
   completion decision;
6. MCP reads the final state, including the same attempt, artifact, evidence
   and immutable completion record.

The black-box scenario is
`packages/tasq-evals/surface-compatibility.test.ts`. All three surfaces use the
same SQLite file, workspace and commitment ID. The test invokes the actual CLI
process, the official MCP client over linked transports, and the separately
packaged A2A adapter rather than calling a private compatibility facade.

## What compatibility means

Compatibility is semantic, not merely syntactic. The suite requires:

- one authoritative commitment row and one canonical inspection graph;
- host-bound MCP workspace, actor, capability set and clock;
- no effect tool on a read/coordinate-only MCP connection;
- an exclusive leased claim attached to the remote attempt;
- replay of the identical A2A snapshot to reuse the same attempt and artifact;
- remote `TASK_STATE_COMPLETED` to produce attempt `succeeded`, while the
  commitment remains `in_progress` with no completion record;
- evidence to bind the verified artifact to that attempt;
- release of active ownership before terminal commitment state;
- a separate CLI completion decision that names the evidence ID;
- identical final graph visibility from MCP after the CLI write.

There is deliberately no cross-surface DTO shared by clients. Each boundary
keeps its own transport contract and delegates to the same kernel invariants.
This avoids a second orchestration database and prevents protocol status from
becoming commitment truth.

## Clock boundary

Production code still reads host time only through the sole `systemClock`
adapter at composition roots. MCP and the A2A adapter require an injected
`Clock`. The scenario creates its controlled clock from the timestamp already
persisted by the CLI, advances it explicitly, and supplies an explicit final
completion timestamp. The eval itself never reads ambient device time.

## Run the proof

```bash
bun test packages/tasq-evals/surface-compatibility.test.ts
```

The normal Tasq test command also includes it:

```bash
pnpm test
```

## Honest limits

- MCP is exercised through the embeddable local server. Authentication and a
  hosted HTTP transport remain outside the shipped boundary.
- A2A is an import adapter for bounded remote snapshots, not a network client
  or workflow runtime.
- The compatibility suite proves one evidence-backed coordination flow. The
  existing unit, migration, concurrency, authority and adversarial suites own
  the broader state-space.
- CLI compatibility retains its historical v1 JSON records while MCP exposes
  canonical commitment records. Both map to the same kernel state; equality of
  transport-specific field sets is neither required nor desirable.

TQ-304 subsequently closed M3 in `RUNTIME_RECONCILIATION_RECIPES.md`: Temporal,
Restate and LangGraph reconcile their execution state into these same attempt
semantics without embedding any of those runtimes in Tasq.
