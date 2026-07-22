# TQ-304 — durable-runtime reconciliation recipes

> Implemented 2026-07-19. These recipes integrate Temporal, Restate and
> LangGraph with Tasq without adding any of those runtimes to the kernel or to
> the Tasq dependency graph.

## Outcome

Temporal, Restate and LangGraph can each own workflow execution while Tasq owns
the durable commitment. The integration is a narrow reconciliation loop:

```text
Tasq commitment + lease
        │
        ├── runtime starts or resumes its own execution
        │      Temporal chain / Restate invocation / LangGraph run
        │
        └── reconciler publishes one Tasq attempt
               running ↔ input_required → succeeded | failed | cancelled
                                      │
                                      └── never completes the commitment
```

The executable proof is
`packages/tasq-evals/runtime-reconciliation-recipes.test.ts`. It uses the real
capability-scoped MCP surface and three runtime-shaped fixtures over one
minimal kernel. Tasq has no Temporal, Restate or LangGraph package dependency.

## Ownership contract

| Concern | Durable runtime owns | Tasq owns |
|---|---|---|
| Desired outcome | No | Commitment, criteria and completion policy |
| Execution | Checkpoints, code version, retries, timers, suspension | Attempt identity and coarse lifecycle |
| Temporary ownership | Worker/task routing inside the runtime | Cross-runtime claim, lease and fence |
| External input | Runtime signal/promise/interrupt mechanics | Optional typed wait, observation and evidence |
| Result | Native result/checkpoint and bounded artifact location | Artifact/evidence reference and explicit completion basis |
| External effect | Scheduling the connector call | Exact effect, authority, fence, permit and receipt |
| Time | Runtime-deterministic workflow time | Host-injected ledger `Clock` |

Do not copy runtime checkpoints, histories, prompts or arbitrary state into
Tasq metadata. Store only bounded identity/provenance needed to resume or audit
the bridge. Do not recreate runtime timers as Tasq deadlines unless they
represent a separate user-visible commitment condition.

## Common reconciliation algorithm

### 1. Discover, then bind identity

An unknown adapter first calls `tasq_discover`. It needs `read` and
`coordinate`; it needs `propose` only if it is also allowed to create the
commitment. Effect authority is not implied.

Choose identities before launching work:

| Tasq field | Meaning |
|---|---|
| `runtime` | Versioned runtime/recipe family, not a worker hostname |
| `externalId` | Stable identity of one logical execution attempt |
| `contextId` | Stable resumable conversation/workflow context |
| `metadata` | Bounded non-secret routing/audit labels |
| `idempotencyKey` | Deterministic identity of the Tasq attempt-start mutation |

Never use a PID, ephemeral worker, retry number or mutable checkpoint as
`externalId`. Never put credentials, raw prompts, provider payloads or PII in
these fields.

### 2. Claim before launching autonomous work

Acquire a Tasq claim, retain its `id` and `fence`, and start the runtime
execution. Then call `tasq_attempt_start` with that claim and the stable runtime
identity. Repeating the same call after a lost response must use exactly the
same idempotency key and input.

If the runtime starts but the Tasq response is lost, query the runtime by its
stable ID and repeat `tasq_attempt_start`. Do not launch a second runtime
execution merely because the bridge is uncertain.

### 3. Reconcile authoritative snapshots

The reconciler reads the runtime's current durable state, reads the Tasq
attempt, maps the state through the table below and applies
`tasq_attempt_transition` with `expectedRevision`.

| Runtime meaning | Tasq attempt status |
|---|---|
| accepted, scheduled, replaying, retrying, sleeping, executing | `running` |
| paused specifically for external/human input | `input_required` |
| execution returned its result | `succeeded` |
| authoritative terminal error/timeout/termination | `failed` |
| authoritative cancellation | `cancelled` |
| missing from a query, retention expired, network unknown | no transition |

Only `input_required → running` is a normal backwards-looking resume. Terminal
attempt states are immutable. If a stale poll reports older progress, ignore
it. If two reconcilers race, one compare-and-swap wins; the loser rereads and
converges.

### 4. Publish output separately

A succeeded attempt says the runtime finished, not that its output satisfies
the commitment. Keep large output in runtime/provider storage and publish a
bounded digest-bound artifact through an embedded adapter, or attach evidence
only after a verifier has checked the result. A model-generated summary is not
itself provider proof.

### 5. Release ownership, then decide completion

After the attempt is terminal and any required evidence is recorded, release
the claim. A coordinator may then explicitly complete the commitment against
the correct evidence IDs. Runtime success must never call commitment completion
as an implicit side effect.

## Temporal recipe

Recommended identity:

| Field | Value |
|---|---|
| `runtime` | `temporal:workflow-chain` |
| `externalId` | first execution Run ID of the chain |
| `contextId` | business Workflow ID |
| metadata | namespace and Workflow Type |

Temporal permits one open Workflow Execution per Workflow ID, but Retry,
Continue-As-New, Cron and Reset can create new Run IDs in a chain. The current
Run ID is therefore not stable attempt identity. Use the first execution Run ID
for the Tasq attempt and keep following the chain. A Continue-As-New closure or
an intermediate retry is still `running`; only the chain's authoritative final
state is terminal.

Place Tasq network/database calls in an Activity or in an external reconciler,
not directly in Workflow code. Temporal Workflow code is deterministically
replayed; external side effects belong in Activities, and Activities themselves
may retry. Every Tasq write therefore needs a deterministic idempotency key.

Suggested lifecycle:

1. coordinator claims the Tasq commitment;
2. client starts or finds the Workflow by the chosen Workflow ID;
3. an Activity/reconciler records the chain attempt with the first Run ID;
4. Temporal remains owner of Activity retries, timers and heartbeats;
5. the reconciler follows the execution chain to final status;
6. it records output evidence, terminates the attempt and releases the claim;
7. a separate coordinator decides commitment completion.

Do not map an Activity failure directly to attempt failure while the Workflow
is still handling or retrying it. Do not create a new Tasq attempt for each
Activity retry or Continue-As-New run. Create a new attempt only when the
system intentionally starts a new logical execution toward the commitment.

Official basis: Temporal's
[Workflow/Run identity](https://docs.temporal.io/workflow-execution/workflowid-runid),
[TypeScript Workflow determinism](https://docs.temporal.io/develop/typescript/workflows/basics),
and [retryable Activities](https://docs.temporal.io/develop/typescript/activities/basics).

## Restate recipe

Recommended identity:

| Field | Value |
|---|---|
| `runtime` | `restate:workflow-invocation` |
| `externalId` | Restate invocation ID |
| `contextId` | Restate Workflow ID / `ctx.key` |
| metadata | service and handler names |

Record Tasq writes as named `ctx.run` durable steps, or perform them in an
external reconciler keyed by the invocation ID. `ctx.run` persists the result
of non-deterministic I/O and may retry failures, so the Tasq idempotency key
must remain stable across replay. Do not call Tasq from an unjournaled callback
whose repetition would mint a new attempt.

Restate owns its invocation journal, retry policy, durable timers, awakeables
and Workflow promises:

- retrying, suspended for internal backoff or sleeping stays `running`;
- waiting on an awakeable/promise that requires an outside actor is
  `input_required`;
- resolving the external input returns the same attempt to `running`;
- a returned handler result is `succeeded`;
- a terminal error is `failed`; an ordinary retryable error is not;
- cancellation is `cancelled` only after Restate confirms it.

Use Restate's invocation ID to attach/query after an uncertain response. An
HTTP timeout when starting or attaching is not evidence that the invocation
failed. Restate's deterministic `ctx.date.now()` may be useful inside its
journal, but it does not replace the Tasq host's injected ledger clock.

Official basis: Restate's
[durable steps](https://docs.restate.dev/develop/ts/durable-steps),
[invocation attachment and idempotency](https://docs.restate.dev/develop/ts/service-communication),
[Workflows](https://docs.restate.dev/develop/ts/services), and
[durable external events](https://docs.restate.dev/develop/ts/external-events).

## LangGraph recipe

Recommended identity:

| Field | Value |
|---|---|
| `runtime` | `langgraph:thread-run` |
| `externalId` | Agent Server run ID, or an integration-minted stable run ID |
| `contextId` | LangGraph `thread_id` |
| metadata | graph/assistant ID and checkpoint namespace |

A LangGraph thread is a checkpointed context and can host multiple runs. It is
therefore `contextId`, not attempt identity. If self-hosting without a native
run ID, mint one before `invoke`/`stream`, persist it in the run input/config,
and reuse it during recovery. Checkpoint IDs change at each super-step and must
not identify the Tasq attempt.

With a durable checkpointer, reconcile a run from its latest state:

- active tasks or nodes in `next` map to `running`;
- a durable interrupt waiting for outside input maps to `input_required`;
- resuming the same thread/run maps back to `running`;
- a successful invocation with no remaining node maps to `succeeded`;
- a recorded terminal task/run error maps to `failed`;
- absence of a checkpoint or a changed graph deployment is not terminal proof.

LangGraph restarts an interrupted node from its beginning when resumed, so code
before `interrupt()` can execute again. Wrap external work in replay-safe tasks
where appropriate and keep every Tasq mutation idempotent. Do not create a new
Tasq attempt merely because a checkpoint advances or the same node re-enters.

Keep graph-version compatibility in the runtime layer. Resuming a thread may
use newer graph code; Tasq should retain only stable run/thread identity and
observable output, not attempt to interpret checkpoint internals.

Official basis: LangGraph's
[checkpoint/thread persistence](https://docs.langchain.com/oss/python/langgraph/persistence),
[interrupt and resume rules](https://docs.langchain.com/oss/python/langgraph/interrupts),
and [thread upgrade compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility).

## Crash and ambiguity table

| Failure window | Correct recovery |
|---|---|
| claim committed, runtime not started | let lease expire or release it; do not invent an attempt |
| runtime accepted, attempt response lost | query by stable runtime ID; replay identical attempt-start input/key |
| attempt transition response lost | inspect Tasq; if already at that revision/state, stop; otherwise CAS from fresh revision |
| duplicate/out-of-order runtime poll | no-op equal state; ignore regression; reject change after terminal |
| runtime query unavailable | preserve current attempt state; uncertainty is not failure |
| bridge down longer than lease | runtime may continue computing, but must reacquire current authority before any fenced effect |
| output exists, verification missing | succeed attempt, leave commitment in progress |
| claim release response lost | inspect claim; repeat only if it is still active and the caller still owns it |

## Clock rules

- The Tasq MCP/embedded host injects `Clock`; no adapter reads raw device time.
- Capture one Tasq clock snapshot per ledger operation.
- Runtime timestamps are remote domain facts. Validate and retain them only when
  useful; they never override the ledger recording clock.
- Tests use `createMutableClock` and explicit advancement.
- Temporal deterministic time, Restate `ctx.date.now()` and LangGraph checkpoint
  timestamps remain owned by their runtimes.

## Acceptance evidence

The TQ-304 eval proves, without importing any runtime SDK, that:

- all three recipes use the same public MCP tools and kernel schema;
- attempt start is replay-idempotent;
- Restate/LangGraph input suspension resumes the same attempt;
- stable execution IDs and context IDs remain distinct;
- every runtime ends with one succeeded attempt;
- all three commitments remain `in_progress`, with no evidence or completion
  record invented by runtime success;
- claims are released explicitly; and
- all ledger time is controlled by an injected clock.

This closes M3. TQ-401 is next: replace best-effort post-commit journal
delivery with a transactional outbox while keeping database events as truth.
