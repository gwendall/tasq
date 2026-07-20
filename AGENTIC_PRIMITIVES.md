# Agentic primitives — positioning and gap analysis

## Thesis

Tasq is a **headless commitment coordination ledger**, not a todo UI and not an
agent runtime. The implemented system owns durable desired outcomes: what must
become true, what blocks it, who is working, what executions occurred and what
evidence justifies completion. `UNIVERSAL_KERNEL_SPEC.md` proposes the stricter
provider- and policy-neutral boundary required to make this a reusable kernel.

The core separation is:

```text
commitment (Tasq task)
  ├── claim       who temporarily owns the right to work
  ├── attempt     one concrete execution, possibly remote
  └── evidence    an observable receipt about the result
```

An attempt may succeed while the commitment remains open. A tool returning
success proves that an invocation ran; it does not necessarily prove that the
desired state exists in the world.

## Alternatives reviewed

### Beads

[Beads](https://github.com/gastownhall/beads) is the closest agent-native
analogue. It provides a distributed dependency graph, `ready` work detection,
atomic claim, hash IDs, Dolt-backed merge/sync, persistent memories, messages
and semantic compaction.

Ideas worth keeping:

- atomic claim as a first-class operation;
- compute ready work from the graph rather than trusting status labels;
- separate durable memory from open work;
- graph links broader than blocking (`duplicates`, `supersedes`, replies);
- compact old context without deleting the operational record.

Tasq differs by targeting cross-domain commitments rather than repository
issues. Evidence, domain time and external observations remain kernel concerns;
goals, areas, cadence and life-specific ranking become a bundled planning
profile under the accepted universal boundary.

### Todoist and Taskwarrior

[Todoist](https://developer.todoist.com/api/v1/) now exposes an API, incremental
sync, official CLI, maintained agent skills and hosted MCP. It is the best
off-the-shelf choice when agents only need access to a mature personal task
manager.

[Taskwarrior](https://taskwarrior.org/docs/) remains the strongest local CLI
precedent: expressive queries, dependencies, urgency, recurrence, hooks, JSON
and multi-replica synchronization through TaskChampion.

Ideas worth keeping:

- ubiquitous CLI and structured JSON before a bespoke UI;
- deterministic urgency/actionability queries;
- local ownership and portable export;
- hooks/adapters instead of embedding every integration.

Their gap for Tasq's purpose is semantic: neither makes execution attempts,
actor leases and observable completion evidence one coherent state model.

### Linear Agents

[Linear Agent Sessions](https://linear.app/developers/agents) make agents visible
as workspace actors. Sessions receive delegated work through webhooks and emit
typed activities such as thought, elicitation, action, response and error. The
surface is currently a Developer Preview.

Ideas worth keeping:

- an explicit `input_required` state;
- a typed activity stream rather than opaque prose logs;
- external URLs/artifacts attached to an execution;
- guidance delivered with the work packet.

Tasq should not copy Linear's session UI or issue-centric domain. Attempts can
carry Linear/A2A/MCP external IDs while the commitment remains runtime-neutral.

### MCP Tasks and A2A Tasks

[MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
are experimental durable handles around long-running requests. They define
polling, TTL, cancellation, result retrieval and `input_required`.

[A2A Tasks](https://a2a-protocol.org/latest/specification) define a remote
agent unit of work. Terminal tasks are immutable; refinements create a new task
inside the same context, with artifacts traceable to their producing task.

Ideas adopted directly:

- attempts use `running`, `input_required`, `succeeded`, `failed`, `cancelled`;
- terminal attempts are immutable;
- `runtime`, `externalId` and `contextId` preserve protocol identity;
- refinements become new attempts, never resurrection of an old one.

Their object is an invocation, not a durable human commitment. Tasq should map
them into `task_attempt`, not map a Tasq task one-to-one onto them.

### Temporal, Restate and LangGraph

[Temporal](https://docs.temporal.io/), [Restate](https://docs.restate.dev/) and
[LangGraph](https://langchain-ai.github.io/langgraph/index.html) solve durable
execution: retries, checkpoints, timers, signals, exactly-once/durable calls and
human interruption.

Tasq must integrate with these runtimes, not reproduce them. A runtime answers
"where is this execution?"; Tasq answers "is the outcome still owed?".

### Receipts and action ledgers

[Treeship](https://www.treeship.dev/) captures signed tool calls at the function
boundary, emphasizing that proof of execution is different from a model's
self-report. Agent action ledgers add policy, budget and approval controls.

Ideas worth keeping:

- evidence is append-only and captured by watchers/tool boundaries;
- evidence may carry a digest and portable URI;
- later evidence supersedes rather than edits history;
- authority and policy enforcement belong at the effect boundary.

Tasq stores receipt references and their relationship to commitments. It should
not become a cryptographic tracing implementation.

## What is implemented now

- `task.successCriteria` states what observable condition means done.
- `task.completionMode` is `assertion` or `evidence`.
- `principal` gives every collaborator stable workspace attribution. It grants
  no authentication or authority by itself.
- `assignment` records delegation independently from claims, execution and
  commitment state.
- `commitment_relation` is the canonical directed graph; the historical
  `task_dependency` API is a transactional compatibility adapter.
- `task_claim` is an exclusive expiring lease with heartbeat and monotone
  fencing token. Reassignment increments the fence; renewal preserves it.
- `resource_lease` provides the same stale-worker protection for arbitrary
  opaque keys without inventing a task. It has mandatory retry identity,
  explicit CAS renewal/release, exact-boundary expiry, monotone fences, typed
  contention and a separate cursor-safe immutable `resource_event` stream.
- `task_attempt` records one runtime execution and becomes immutable at a
  terminal state.
- `task_evidence` is append-only, linked to an optional attempt, and can
  supersede earlier evidence without rewriting it.
- `artifact` stores immutable digest-bound outputs; `external_ref` binds kernel
  records to identities in other systems without storing credentials.
- `external_context_link` separately records a reusable many-to-many pointer
  from a commitment to externally owned context. It discloses pinned versus
  floating identity, is append-only, and stores neither content nor authority.
- Every completed commitment revision appends an immutable `completion_record`
  with policy identity, input digest, evidence IDs and deciding principal.
- `wait_condition` stores one typed, versioned external expectation. Its
  lifecycle is monotone (`waiting → satisfied | expired | cancelled`), its
  matching configuration is immutable, and correction creates a non-branching
  supersession record rather than rewriting history.
- `observation` stores one immutable normalized connector fact. Provider
  delivery identity is tenant-scoped and retry-safe; conflicting redelivery is
  rejected rather than silently rewriting the fact. Candidate routing identity
  is derived from typed payload, not trusted as a second caller assertion.
- `reconciliation` stores the immutable output of one frozen matcher version.
  `decision` records whether the fact matched; `effect` separately records
  whether it satisfied a waiting condition, changed nothing, or arrived after
  the condition was already terminal. A satisfying match creates evidence but
  never completes the task.
- Completing an evidence-mode task requires explicit evidence IDs belonging to
  that task.
- A task cannot become terminal while an attempt is active.
- Terminal completion releases its claim; deletion cancels active attempts and
  releases claims atomically.
- Agentic creates support durable idempotency keys.
- `next` hides work claimed by another actor unless explicitly overridden.
- Additive SQLite guards make released claims and terminal attempts immutable,
  evidence physically append-only, fences unique per task, and cross-row
  task/claim/attempt/evidence relationships tenant-safe. `doctor` independently
  audits the same invariants.

## Gaps and roadmap

The ordered work, dependencies, decision records and acceptance gates live in
[`BACKLOG.md`](./BACKLOG.md). This section remains the conceptual summary.

### Implemented: typed waiting, reconciliation and deadline fallback

Model a wait condition as a predicate plus deadline and fallback, for example:

```text
gmail.reply(from=arkwood, thread=X)
deadline: 2026-07-20T09:00Z
fallback: create/activate "Relance Arkwood"
```

Watchers should submit observations; a deterministic reconciler decides whether
the predicate is satisfied. Agents must not mark it satisfied from prose alone.
Wait conditions, immutable observation ingestion, deterministic reconciliation,
strict deadline evaluation and exactly-once ledger fallback are implemented.
The CLI contracts and first Gmail watcher recipe are now exposed. UK-001/002
accepted and inventoried the universal boundary, UK-003–005 extracted extension
and planning concerns, and UK-006 implemented universal collaboration records.
UK-007 proved those records across three narratives, UK-008 authorized generic
projection/cursor work, and TQ-107 delivered the canonical inspection graph.

### Delivered direction: universal kernelisation

`UNIVERSAL_KERNEL_SPEC.md` defines the target coordination algebra, namespaced
extension/evaluator contract, additive migration, protocol mappings and three
cross-domain conformance scenarios. UK-001–UK-011 now pass, including the
unfamiliar-extension/two-runtime proof in `UK-011_UNIVERSAL_ACCEPTANCE.md`. No
provider kind or life policy should be added to core.

### Delivered: authority, effects and adapters

Approvals bind an exact effect digest, principal, scope, limits and validity.
The effect ledger, authenticated connector permit, verified receipts,
indeterminate recovery and independent compensation are implemented. MCP,
MCP Tasks/A2A, durable-runtime recipes and provider-neutral connector testkits
are sibling surfaces over the same service invariants; none can silently turn
an execution success into commitment completion.

### Delivered: sync and bounded context

Authority-coordinated replicas use explicit commands, content-addressed
snapshots, visible conflicts and non-resurrecting identities; wall-clock time
never selects a winner. Bounded context packets expose omission traces, and
terminal summaries stay append-only and bound to their raw source. Reusable
knowledge remains in its owning system; Tasq stores only append-only external
context pointers with explicit pinned/floating semantics.

### Product surface and hosted boundary

- TQ-504 ships a read-first inspector only for workflow friction demonstrated
  by the existing CLI/MCP paths. It remains a sibling read surface, not a
  second state model or write path.
- ADR-004/TQ-505 now defines authenticated remote principals, workspace
  tenancy and hosted transport without claiming implementation. Local actor
  labels remain attribution, not authentication.

### Deliberately outside Tasq

- model conversation/checkpoint storage;
- generic workflow execution;
- vector retrieval and autobiographical memory;
- cryptographic signing implementation;
- connector-specific authorization enforcement;
- a universal workflow-execution UI or provider-owned memory UI.
