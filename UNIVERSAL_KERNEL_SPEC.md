# Tasq Universal Coordination Kernel — specification

> **Status:** accepted v1.0 — 2026-07-15  
> **Acceptance:** UK-001–UK-008, UK-EXT and generic TQ-107 inspection are
> completed; five cross-domain watcher fixtures and the real isolated `_life`
> adapter loop, machine onboarding (UK-009), neutral MCP Tasks/A2A mappings
> (UK-010) and cross-runtime universal acceptance (UK-011) now pass.
> **Scope:** target architecture; `CURRENT_STATE.md` remains authoritative for
> what is implemented today.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are
normative. Acceptance freezes the semantic boundary, not every future storage
detail. A later change that moves responsibility across kernel, extension,
policy, connector or runtime boundaries requires a new decision record.

The exhaustive current-to-target field/command/event/JSON mapping is frozen in
`UNIVERSAL_COMPATIBILITY_INVENTORY.md` and its machine-readable JSON companion.

## 1. Thesis

Tasq should become a runtime-neutral coordination ledger for durable work
shared by humans, agents and services.

Its universal job is not to decide what matters, execute workflows, call
providers or provide a universal project-management ontology. Its job is to
preserve the minimum shared truth required to answer:

1. What outcome is still owed?
2. What other outcomes constrain it?
3. Who was asked to own it, and did they accept?
4. Who currently holds the exclusive right to act?
5. What executions were attempted?
6. What outputs and evidence exist?
7. What external fact are we waiting for?
8. What was actually observed, with what provenance?
9. What deterministic decision related that fact to the commitment?
10. What real-world effect was authorized and what receipt proves it occurred?
11. How can another runtime resume without losing or duplicating work?

This is a **commitment control plane**, not a universal task manager.

## 2. Product boundary

### 2.1 The kernel owns

- durable commitments and their lifecycle;
- typed relations and causal dependencies;
- delegation/assignment records;
- exclusive expiring claims with fencing;
- execution attempts and their immutable terminal history;
- artifacts and evidence;
- typed external conditions;
- immutable observations and provenance;
- deterministic reconciliations;
- proposed/authorized/committed effects and receipts;
- ordered audit, cursors and idempotency;
- workspace and principal references required to scope those records.

### 2.2 The kernel does not own

- LLM reasoning, prompts or conversation history;
- decomposition quality or semantic prioritization;
- provider credentials or provider API calls;
- workflow scheduling and execution;
- notifications and outbound delivery channels;
- domain ontologies such as personal-life areas or software sprints;
- arbitrary executable predicates stored in data;
- a universal memory/vector store;
- presentation policy or a mandatory UI;
- proof that a self-asserted local actor is authorized.

### 2.3 Layer ownership

| Layer | Owns | Examples |
|---|---|---|
| **Kernel** | Deterministic durable coordination state | commitment, claim, attempt, evidence, condition, effect |
| **Extension** | Versioned domain schemas and pure deterministic evaluators | GitHub PR condition, HTTP observation matcher |
| **Policy** | Interpretation and choice | life-pilot priority, coding triage, robot scheduling |
| **Connector** | Credentials, provider calls, authentic receipts | Gmail, GitHub, Mercury, Stripe, robot controller |
| **Runtime** | Checkpoints, timers, execution and retries | Temporal, Restate, LangGraph, local agent loop |
| **Protocol adapter** | Translation to/from another task protocol | MCP Tasks, A2A Tasks |
| **Surface** | Human or machine interaction | embedded API, CLI, MCP, REST, web inspector |

Crossing a boundary requires an explicit record or adapter contract. No layer
may silently take ownership of another layer's truth.

## 3. Design principles

### P1 — Commitment is not execution

A commitment describes an outcome that must become true. An attempt describes
one execution toward it. A successful tool call, workflow or remote-agent task
may close an attempt without completing the commitment.

### P2 — Assignment is not a claim

Assignment records responsibility or delegation. A claim is an exclusive,
expiring coordination lease. An assignee may be responsible while temporarily
holding no claim; a runtime may hold a claim only while actively executing.

### P3 — Output is not evidence

An artifact is something an attempt produced. Evidence is an immutable binding
that says why an artifact, observation or receipt supports a success criterion.
Not every artifact is evidence, and evidence must retain provenance.

### P4 — Observation is not interpretation

A connector records a typed fact. A deterministic reconciler relates it to a
condition. A model may propose a decision for an unsupported semantic case, but
cannot rewrite an observation or impersonate a deterministic matcher.

### P5 — Authorization is not execution

An approval binds a principal to an exact effect digest, scope, limits and
expiry. Execution creates a distinct attempt. Provider success creates a
receipt. None of these records substitutes for another.

### P6 — Current state is authoritative

Tasq is state-based with append-only audit. Events provide ordering,
attribution and integration cursors; they are not a replay-complete event
sourcing protocol.

### P7 — Extensions are data plus trusted code, never stored code

Records name absolute, versioned type identifiers. Installed extension code
parses and evaluates those types. Tasq never evaluates JavaScript, SQL, prompts
or expressions supplied inside a record.

### P8 — Historical meaning is frozen

Schema version, evaluator version and meaningful identity fields never change
silently. A changed interpretation requires a new version and an explicit
migration or reconciliation policy.

### P9 — The kernel is portable; policy is replaceable

The same records must be usable by a local CLI, an embedded process, an MCP
server, an A2A adapter or a durable runtime without changing their semantics.

### P10 — Universality is demonstrated, not asserted

No primitive enters the kernel merely because it sounds general. It must
prevent a concrete failure in at least two unrelated domains and pass the
cross-domain conformance suite.

### P11 — Lifecycle and actionability are different

`blocked` is an explicit commitment lifecycle state chosen by an authorized
caller. Dependencies, conditions, schedules and claims contribute to a derived
actionability view; they MUST NOT silently rewrite lifecycle state. This keeps
facts, policy and intent distinguishable.

### P12 — Exactly-once stops at the ledger boundary

Tasq can guarantee one accepted ledger mutation for one idempotency identity.
It cannot guarantee exactly-once behavior in an arbitrary external provider.
Effects therefore require provider idempotency where available, durable
receipts and an `indeterminate` outcome when dispatch cannot be proven.

### P13 — Generic metadata is not a shadow schema

Metadata MUST be size-bounded, JSON-serializable and namespace-owned. Kernel
invariants MUST NOT depend on unregistered metadata fields. A field that drives
coordination behavior graduates into a versioned first-class or extension
schema.

## 4. Universal coordination algebra

The target model is split into three capability tiers. Tiers describe semantic
dependency, not separate products.

### 4.1 K0 — Commitment and collaboration

#### `workspace`

Scopes IDs, installed extensions, retention and policy references. Local mode
may have one implicit workspace; remote mode must make it explicit.

`tenant_id` is the compatibility name for `workspace_id`. Cross-workspace
references are invalid even when their raw IDs exist. Workspace deletion is a
retention/admin operation, never an ordinary commitment cascade.

#### `principal`

A stable reference to a human, agent, service or runtime identity.

Minimum fields:

```text
id, workspace_id, kind, display_name
external_identity_refs, status, metadata
revision, created_at, updated_at
```

`kind` is descriptive, not authority. Authentication is supplied by the
surface/transport and mapped to a principal. A CLI alias remains explicitly
self-asserted local attribution. Capability declarations may be attached by an
agent-profile extension or external reference and consumed by assignment
policy; they are advisory, not authority.

Remote identity mapping uses immutable `(issuer, subject)` references rather
than display names. Disabling a principal prevents new authorized mutations but
does not rewrite its historical attribution.

#### `commitment`

The durable desired outcome. The existing `task` record is the migration
starting point and may remain the storage/table name until a major version.

```text
id, workspace_id
title, description, success_criteria, completion_policy
status: open | in_progress | blocked | done | cancelled
not_before, due_at, revision
created_by, created_at, updated_at, completed_at
metadata
```

Generic priority may remain an explicit caller hint, but domain scoring never
belongs to the kernel. `scheduled_at` remains a v1 compatibility alias for
`not_before`; planning-specific `next_action`, effort estimates, recurrence and
hierarchy references belong to profiles.

The lifecycle state machine is deliberately small. `blocked` is explicit and
human/policy meaningful; a derived `actionable` view separately accounts for
unresolved `depends_on` relations, `not_before`, live claims and policy filters.
Terminal transitions require that no attempt is active. Reopening creates a new
revision and never erases the prior completion basis.

#### `relation`

A typed directed edge between commitments. V1 deliberately rejects arbitrary
polymorphic endpoints: they weaken foreign-key and workspace guarantees without
a demonstrated cross-domain invariant. Other record families use their typed
references and `external_ref`; future endpoint kinds require a new admission
decision.

```text
id, workspace_id
from_commitment_id, relation_type, to_commitment_id
revision, created_by, created_at, ended_by, ended_at
```

First-party relation types:

- `parent_of` — structural decomposition;
- `depends_on` — the `from` commitment is not actionable until `to` resolves;
- `relates_to` — non-causal association;
- `duplicates` — identity/intent overlap;
- `supersedes` — append-only correction lineage.

Extensions may add namespaced types. Relation descriptors declare direction,
allowed endpoint types, symmetry and whether cycles are forbidden.

`depends_on` is canonical because its direction is unambiguous. The historical
`task_dependency(from_task_id, to_task_id, type='blocks')` already means “from
depends on to” and migrates without reversing endpoints. An inverse “blocks”
label MAY be rendered by a surface but is not stored as a second edge. Ending a
relation is a tombstone mutation with attribution; re-adding creates a new
relation identity rather than rewriting history.

#### `assignment`

Durable delegation or responsibility, distinct from execution locking.

```text
id, workspace_id, commitment_id
assigner_principal_id, assignee_principal_id, role
status: proposed | accepted | rejected | revoked | released
instructions_ref, accepted_at, ended_at
revision, created_at, updated_at
```

Multiple assignments may coexist by role. A policy may enforce one primary
owner for a workspace, but the universal kernel does not assume that every
domain has a single assignee. Assignment never implies authority for an
external effect.

Roles use registered absolute URIs or a small first-party vocabulary. Only the
assignee may accept, reject or release by default; the assigner may revoke.
Authorization policy may narrow those rules. Assignment changes never acquire
a claim or change commitment status automatically.

#### `claim`

Exclusive expiring right to actively work on a commitment.

```text
id, commitment_id, principal_id
fence, acquired_at, heartbeat_at, expires_at
revision, released_at, release_reason
```

Fences increase monotonically per commitment. Effect-capable connectors reject
stale fences even when a stale worker still has network access.

At most one unexpired, unreleased claim exists per commitment. Expiry is
evaluated against a transaction-supplied clock. An attempt may outlive the
claim that started it, but cannot use that historical claim to authorize a new
effect.

The transaction clock is an injected kernel dependency, never an ambient
device read. A composition root may supply real, simulated or replay time. One
captured operation timestamp drives all affected state, identifiers,
idempotency records and audit rows; explicit occurrence/observation timestamps
remain separate domain inputs. No database default or evaluator may consult a
host clock implicitly.

#### `attempt`

One execution against one commitment.

```text
id, commitment_id, claim_id, principal_id
runtime_type, external_execution_ref
status: running | input_required | succeeded | failed | cancelled
revision, started_at, ended_at, status_message, metadata
```

`running` and `input_required` are active; the other states are terminal.
Terminal attempts are immutable. A commitment cannot become terminal while an
attempt remains active. Attempt success records execution success only.

#### `artifact`

Immutable output created or referenced by an attempt.

```text
id, commitment_id, attempt_id
type_uri, schema_version
name, media_type, uri, digest, inline_data_ref
created_by, created_at, metadata
```

Large or secret content remains outside Tasq; URI plus digest binds it.
An artifact used as evidence MUST have a digest over immutable bytes or a
provider-version identity with equivalent immutability. Mutable URLs alone are
not proof. Inline content is size-bounded and content-addressed.

#### `evidence`

Immutable basis for a commitment decision.

```text
id, commitment_id, attempt_id?
evidence_type_uri, schema_version
artifact_id?, observation_id?, effect_receipt_id?
summary, uri, digest, verification
criterion_refs, commitment_revision
supersedes_evidence_id, created_by, created_at
```

Completion policies decide whether evidence is required. Evidence corrections
use supersession; old evidence is never rewritten.

#### `completion_record`

Immutable basis for each successful `done` transition.

```text
id, commitment_id, resulting_revision
completion_policy_uri, completion_policy_version, policy_input_digest
evidence_ids, decided_by, decided_at
```

The current commitment row remains authoritative for lifecycle state; the
completion record makes “why was this considered done?” independently
inspectable without parsing an open-vocabulary event payload. Evidence-mode
completion requires at least one valid, non-superseded evidence binding for the
same commitment. Reopening retains the record and a later completion creates a
new one. The initial kernel ships only explicit `assertion` and
`evidence-required` policies; stricter domain policy may prevent a caller from
requesting completion but cannot forge kernel evidence.

### 4.2 K1 — External world bridge

#### `condition`

A typed fact the commitment is waiting for.

```text
id, commitment_id
type_uri, schema_version, parameters
evaluator_uri, evaluator_version
subject_refs, not_before, deadline_at
status: waiting | satisfied | expired | cancelled
fallback_spec, terminal_result_refs
supersedes_condition_id
revision, created_at, updated_at
```

K1 fallbacks are ledger mutations such as creating or activating another
commitment. They never perform provider/network effects. A future effect-based
fallback must pass through K2 proposal and approval like any other effect.

Condition identity fields, parameters, evaluator identity and deadlines are
immutable after creation. Correction creates a superseding condition; only its
lifecycle fields change in place through revision-checked transitions. A late
observation may produce an inspectable reconciliation but cannot reverse an
expired/cancelled condition or retract an already-created fallback.

#### `observation`

Immutable normalized external fact.

```text
id, workspace_id
source, external_event_id
type_uri, schema_version, payload, subject_refs
occurred_at, recorded_at, recorded_by
verification_level, verification_method
raw_ref, digest, metadata
```

Delivery identity is `(workspace, source, external_event_id)`. Identical
redelivery returns the original record; changed content under the same identity
is an integrity failure.

Normalized payload and route keys MUST be secret-minimized and size-bounded.
Route keys that expose sensitive provider identifiers SHOULD be keyed hashes
scoped to the workspace. Unknown observation types MAY be retained only under
an explicit opaque-storage workspace policy; opaque observations are never
routed or reconciled until a matching extension is installed and validation
succeeds.

#### `reconciliation`

Immutable result of applying one evaluator version to one condition and one
observation.

```text
id, condition_id, observation_id
evaluator_uri, evaluator_version
evaluator_implementation_digest
decision: matched | rejected | ambiguous
effect: satisfied | no_change | condition_terminal
reason_code, explanation, evidence_id
reconciled_at, reconciled_by
```

Only a deterministic match against a waiting condition may satisfy it. The
reconciliation may derive evidence; it never completes the commitment by
itself.

The tuple `(condition, observation, evaluator URI, evaluator version,
implementation digest)` has one durable result. Conflicting retry output is an
integrity failure, not a second opinion.

### 4.3 K2 — Authority and effects

K2 is required before Tasq can safely coordinate consequential external writes.

#### `effect`

Exact proposed external side effect.

```text
id, commitment_id, attempt_id?
effect_type_uri, schema_version
canonical_request, request_digest, idempotency_key
status: proposed | authorized | executing | committed | failed | indeterminate | cancelled
connector_ref, claim_id, fence
created_at, updated_at
```

A provider timeout after dispatch transitions to `indeterminate`, not `failed`.
The connector reconciles it from an authentic receipt or later observation;
the kernel never guesses and blindly retries the side effect.

Normative transitions are:

```text
proposed → authorized → executing → committed
    │           │            ├────→ failed         (proven no effect occurred)
    │           │            └────→ indeterminate  (outcome cannot be proven)
    └───────────┴─────────────────→ cancelled       (before dispatch only)
indeterminate → committed | failed                  (reconciliation only)
```

`authorized` is entered only from a current approval over the exact request
digest. The execution boundary atomically verifies approval, connector scope,
idempotency identity and live claim fence before entering `executing`. A retry
from `indeterminate` is permitted only when a provider lookup proves absence or
the connector can reuse a provider-enforced idempotency identity safely.

#### `approval`

Immutable authority decision bound to the exact effect digest.

```text
id, effect_id, request_digest
approver_principal_id
decision: approved | denied | revoked
scope, limits, expires_at, decided_at
verification, supersedes_approval_id
```

Approval decisions are immutable. Revocation is a new decision that references
the approval it supersedes; it cannot retroactively erase an already committed
effect.

The effective authority decision is the latest valid non-superseded decision
for the exact digest. Revocation prevents dispatch that has not crossed the
execution boundary; it cannot promise cancellation after dispatch. Denial and
revocation do not mutate provider state.

#### `effect_receipt`

Provider-grounded result of an effect attempt.

```text
id, effect_id
provider, external_operation_id
status, occurred_at, recorded_at
raw_ref, digest, verification
```

Compensation is a new effect related to the original. A committed effect is
never rewritten as though it did not happen.

Provider receipts MUST be authenticated or honestly marked with their weaker
verification level. A receipt is evidence that the provider reported an
operation, not proof that the larger commitment succeeded.

### 4.4 Cross-cutting records

#### `external_ref`

Stable mapping between any kernel record and an outside resource or execution.

```text
id, workspace_id, record_type, record_id
system, resource_type, external_id
url, version, digest, metadata
```

Active mappings are unique by both local record identity and the registered
external identity rules. Sync direction and source-of-truth policy are explicit
adapter configuration; the presence of an external reference never authorizes
silent bidirectional synchronization.

#### `idempotency_key`

Scopes retriable mutations by operation, caller/workspace and canonical input
digest. Canonical JSON uses RFC 8785 JCS and a versioned SHA-256 digest for the
first release. Reuse with different meaningful input is rejected. The record
retains the accepted result identity/status long enough for the operation's
documented retry horizon; effect identities and external delivery identities
are not subject to short automatic expiry.

#### `event`

Ordered task/record-scoped audit with monotone sequence, actor principal,
recording time, optional domain time and structured payload. Events remain open
vocabulary and do not replace authoritative current rows.

The event append and authoritative mutation MUST commit in one transaction.
Delivery to external consumers is at-least-once through a lossless cursor, so
consumers deduplicate by event identity/sequence. A sequence is monotone within
one store deployment; cross-replica ordering remains out of scope until the
replica conflict ADR.

#### `revision`

Every mutable aggregate carries a monotone integer revision. Public updates and
state transitions MUST supply `expected_revision`; stale revisions fail without
mutation. Append-only creates rely on idempotency instead. Claims additionally
use fences because optimistic revision alone cannot stop a stale worker from
acting outside the transaction. Human-facing surfaces MAY fetch and supply the
current revision for convenience, but the embedded service never performs an
unguarded read-modify-write.

## 5. Extension contract

### 5.1 Type identifiers

Domain types use absolute, globally namespaced URIs plus an integer schema
version. Examples:

```text
https://schemas.tasq.dev/conditions/github/pull-request-state
https://schemas.tasq.dev/observations/github/pull-request
https://acme.example/robotics/conditions/part-at-station
```

No central enum is modified when a third party adds a type.

URI ownership is decentralized: the publisher MUST control the URI namespace.
Tasq-owned reference types use `https://schemas.tasq.dev/`. Type URI plus
integer schema version identifies data meaning; evaluator URI plus integer
version and implementation digest identifies decision meaning. Versions are
never mutable aliases such as `latest`.

### 5.2 Extension manifest

Each installed extension declares a machine-readable manifest:

```json
{
  "extensionUri": "https://schemas.tasq.dev/extensions/github",
  "version": "1.0.0",
  "conditionTypes": [{
    "typeUri": "https://schemas.tasq.dev/conditions/github/pull-request-state",
    "schemaVersions": [1],
    "evaluatorUri": "https://schemas.tasq.dev/evaluators/github/pull-request-state",
    "evaluatorVersions": [1],
    "acceptedObservationTypes": [
      "https://schemas.tasq.dev/observations/github/pull-request"
    ]
  }],
  "observationTypes": [{
    "typeUri": "https://schemas.tasq.dev/observations/github/pull-request",
    "schemaVersions": [1]
  }]
}
```

The manifest also binds canonical JSON Schemas, route-key derivation and
implementation digests. Installation stores a content-addressed snapshot of
the manifest and every JSON Schema in the workspace registry. The trusted code
remains in the installed package; code is never loaded from a database record.
Reinstalling the same `(URI, version)` with another digest is rejected.

The kernel refuses an unknown condition/effect type because those records can
drive state or external action. A workspace MAY retain unknown observations or
artifacts in explicit opaque-storage mode, but it never validates, routes,
reconciles or executes opaque data. Installing the missing extension can make
future processing possible only after validation; it does not silently invent
historical decisions.

### 5.3 Evaluator interface

Evaluators are installed trusted code with a pure interface:

```ts
interface Evaluator<C, O> {
  parseCondition(input: unknown, schemaVersion: number): C;
  parseObservation(input: unknown, schemaVersion: number): O;
  conditionRouteKeys(condition: C): readonly string[];
  observationRouteKeys(observation: O): readonly string[];
  evaluate(condition: C, observation: O, context: {
    evaluationTime: number;
  }): {
    decision: "matched" | "rejected" | "ambiguous";
    reasonCode: string;
    explanation: string;
    evidenceDraft?: unknown;
  };
}
```

Evaluators must not perform network I/O, read credentials, call a model, depend
on ambient wall-clock time, generate randomness or mutate state. Time is an
explicit stored input. Execution is resource-bounded and conformance-tested.

Changing any outcome for the same canonical input requires a new evaluator
version. Reconciliations record the implementation digest. Production
installations MUST retain exact evaluator packages needed to re-inspect active
conditions; historical records remain intelligible from stored schemas and
recorded outputs even if code is archived.

The first release permits only trusted in-process evaluator packages. The pure
interface is a determinism contract, not a security sandbox: an untrusted
publisher could still execute host-language code. Sandboxed WASM or a separate
evaluator process is a later hardening option and must preserve the same test
vectors.

### 5.4 Connector contract

Connectors live outside the kernel and must:

- keep credentials outside Tasq;
- normalize provider data into a registered observation schema;
- provide a stable external delivery identity;
- minimize secrets and retain raw content by reference when needed;
- state verification level and method honestly;
- make effect execution idempotent at the provider boundary;
- require effect identity, approval and current claim fence for protected writes;
- return authentic receipts or an explicit unknown outcome after timeout.

### 5.5 Policy contract

Policies consume kernel views and emit proposals or explicit mutations. They
may rank, decompose, assign or request approval, but cannot bypass state
machines. Life-pilot's cadence and avoidance scoring is one policy package, not
kernel behavior.

## 6. Protocol and runtime mappings

External protocols are peers/adapters, not alternate sources of truth.

| External concept | Tasq mapping | Important rule |
|---|---|---|
| MCP Task | `attempt` + `external_ref` | MCP completion succeeds the attempt, not automatically the commitment |
| A2A Task | `attempt` + context/external refs | A2A artifacts import as artifacts; terminal remote state remains execution state |
| A2A Artifact | `artifact` | Becomes evidence only through an explicit evidence binding |
| Temporal/Restate workflow | `attempt` | Runtime owns replay/checkpoints; Tasq owns what remains owed |
| LangGraph thread/run | `attempt` + external refs | Checkpoint state stays in LangGraph |
| Linear/Beads issue | `commitment` + `external_ref` | Synchronization policy must be explicit; no silent dual source of truth |
| Provider webhook | `observation` | It records a fact, never a semantic completion command |

MCP Tasks currently models durable asynchronous request execution; A2A models
server-owned task interaction with status and artifacts. Both are valuable
transport/execution adapters but neither replaces the shared commitment ledger.

Reference material:

- [MCP Tasks specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [A2A 1.0 specification](https://a2a-protocol.org/latest/specification)
- [Temporal documentation](https://docs.temporal.io/)
- [Restate documentation](https://docs.restate.dev/)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Linear agents](https://linear.app/docs/agents-in-linear)
- [OpenAI Symphony](https://github.com/openai/symphony)
- [Beads](https://github.com/gastownhall/beads)

## 7. Current implementation classification

| Current capability | Classification | Target action |
|---|---|---|
| `task` lifecycle | Kernel | Retain; document as commitment semantics |
| task title/description/status/due date | Kernel | Map to commitment fields; add revisions and completion records |
| `scheduled_at` | Kernel compatibility | Expose canonically as `not_before` |
| `task_dependency` | Kernel | Backfill a new commitment relation table; preserve v1 commands as adapters |
| claims and fences | Kernel | Replace actor strings with principal refs compatibly |
| attempts | Kernel | Retain; add generic runtime/external refs |
| task evidence | Kernel | Retain and evolve; introduce artifact/evidence distinction |
| wait conditions | Kernel K1 | Rename conceptually to generic condition; migrate kinds to URIs |
| observations/routes | Kernel K1 | Retain lifecycle and provenance; migrate kinds to URIs |
| reconciliation | Kernel K1 | Retain decision/effect split; evaluator URI replaces closed registry key |
| deadline fallback | Kernel K1 | Retain ledger-only semantics |
| events/cursors/idempotency | Kernel | Retain and generalize record references |
| `area`, `goal`, `project` | Planning profile | Keep compatible, remove from mandatory kernel ontology |
| `next_action`, effort estimates, priority | Planning/policy profile | Preserve bundled behavior; remove from minimal commitment contract |
| stored recurrence/materialization | Scheduling profile | Extract automatic spawning from kernel lifecycle behavior |
| life cadence | Life policy | Extract from kernel behavior |
| avoidance/leverage prioritizer | Life policy | Move behind a policy interface |
| markdown `_life` projection | Life surface | Move to planning/life projection package |
| Gmail/GitHub/Mercury/HTTP/filesystem schemas | Reference extensions | Move out of core schema/service enums |
| hard-coded actor examples/default tenant | Local profile | Replace with neutral defaults and optional local aliases |
| local LibSQL/CLI | Surface/deployment | Keep as first reference deployment, not the semantic boundary |

The five existing domains are not discarded. They become the first extension
conformance corpus and prove that the extension contract handles communication,
code, money, network and filesystem facts.

## 8. Compatibility and migration strategy

Kernelisation must be additive and preserve every existing Tasq store.

### Phase U0 — Freeze and inventory

- preserve this accepted specification as the UK-001 boundary;
- inventory every current field, event and CLI JSON key;
- classify each as kernel, extension, policy or legacy compatibility;
- freeze the current v1 JSON contract before changing representation.

No v1 field or command is removed during U0–U5. Deprecation begins only after
UK-011. Removal requires an opt-in public v2, at least one preceding minor
release with warnings, an automatic migration, and a `doctor` check proving no
legacy-only record remains. This criterion-based window replaces an arbitrary
calendar deadline.

### Phase U1 — Introduce generic identities

- add principal and external-reference records;
- map existing actor strings to local self-asserted principal aliases;
- add type URI/evaluator URI columns beside current enums;
- backfill first-party URIs deterministically;
- add monotone revisions beside timestamp-based mutation checks;
- continue reading and writing old fields through one service-owned
  compatibility adapter—never two independent sources of truth.

### Phase U2 — Extract extensions

- introduce the extension manifest/registry;
- snapshot canonical schemas and manifests by digest;
- move the five schemas, route functions and evaluators into reference packages;
- have the core depend only on extension interfaces;
- prove byte-equivalent decisions for every historical fixture.

### Phase U3 — Separate policy and planning profile

- move cadence, avoidance scoring and `_life` projection behind policy/profile
  interfaces;
- preserve existing commands through the bundled planning profile;
- allow a minimal deployment with commitments and relations only.

### Phase U4 — Complete collaboration records

- add explicit assignment/delegation;
- add artifacts distinct from evidence;
- add inspectable completion records;
- make principal references available on claims, attempts, evidence and events;
- preserve actor-string output aliases in CLI JSON v1 until a deliberate v2.

### Phase U5 — Adapter and conformance release

- add MCP Tasks and A2A mappings;
- publish the embedded API and extension SDK;
- run the same black-box suite against local CLI and at least one protocol
  adapter;
- only then call the kernel universal.

No destructive rename is required in the initial migration. Storage table names
may remain historical while public semantics and interfaces generalize.

## 9. Cross-domain conformance suite

All three scenarios must run on the same unmodified kernel. Domain packages may
provide schemas, evaluators and policies; they may not add kernel tables.

### Scenario A — Software delivery

```text
commitment: ship a bug fix
dependency: failing reproduction must be resolved first
assignment: coding agent accepts implementation
claim: worker A holds fence 4
attempt: remote A2A coding task
artifact: pull request
condition: PR merged at required commit
observation: authenticated GitHub webhook
reconciliation: deterministic match
evidence: merged commit receipt
completion: explicit commitment transition
```

Required failures: stale worker effect rejected, duplicate webhook deduplicated,
remote task success without merge evidence leaves the commitment open, and
reversing dependency direction is caught by the actionability assertion.

### Scenario B — Research and human acceptance

```text
commitment: produce a decision-ready market report
assignment: research agent accepts author role; human remains approver
attempt: research run
artifacts: report plus source bundle
evidence: source digest and coverage checklist
condition: named human accepts version digest
observation: authenticated approval response
completion: evidence-backed explicit transition
```

Required failures: replacing the report invalidates approval, an agent cannot
self-approve a human-bound criterion, rejected work remains inspectable, and a
reopened/recompleted report retains both completion records.

### Scenario C — Operations and external health

```text
commitment: deploy service version N and establish health
effect: deploy exact immutable version
approval: bound to request digest and environment
attempt: durable deployment workflow
condition: endpoint returns expected status/body for version N
observation: authenticated HTTP monitor fact
reconciliation: deterministic match or deadline expiry
evidence: deployment receipt plus health observation
fallback: exactly one rollback/investigation commitment
```

Required failures: provider timeout becomes unknown rather than blind retry,
late health does not erase an expired fallback, duplicate sweep creates no
second fallback.

### Global acceptance criteria

- two runtimes cannot hold a live exclusive claim simultaneously;
- stale fences cannot reach effect execution;
- no execution protocol can directly mark a commitment complete;
- identical delivery/retry is idempotent and conflicting reuse is rejected;
- records remain tenant/workspace safe across every relation;
- stale expected revisions fail without partial events or state changes;
- all state transitions and extension decisions are inspectable;
- unknown actionable types are rejected while opaque facts remain inert;
- removing any one domain extension does not change kernel schema or behavior;
- the same CLI/embedded contract passes on all three scenarios.

## 10. API and surface requirements

The embedded service contract is the semantic reference. Other surfaces map to
it without creating alternate invariants.

Minimum capability groups:

```text
commitments: create, inspect, update, transition, list
relations: add, remove, traverse
assignments: propose, accept, reject, revoke, list
claims: acquire, renew, release, inspect
attempts: start, transition, inspect, list
artifacts/evidence: append, supersede, inspect
conditions: create, supersede, cancel, inspect, sweep
observations: ingest, inspect, poll by lossless cursor
reconciliations: evaluate, inspect
effects/approvals/receipts: propose, decide, execute-boundary check, reconcile
audit: ordered feed, record history, doctor
```

Every mutation accepts caller identity, workspace, idempotency key where retry
is plausible, and `expected_revision` for every existing mutable aggregate.
Claim operations additionally carry the current claim identity/fence where
required. Mutation results return the new revision and committed event cursor.

The v1 reference embedded SDK is framework-free TypeScript over a transactional
store interface with JSON-compatible DTOs and extension interfaces. It MUST NOT
read global CLI config, environment credentials or a hard-coded database path.
Language-neutral JSON Schemas, canonicalization rules and black-box conformance
vectors are part of the contract; additional language SDKs are generated or
implemented only after the TypeScript reference passes UK-007.

## 11. Security and trust model

- Local aliases provide attribution only.
- Remote surfaces authenticate a principal before constructing service context.
- The first remote reference adapter validates OAuth 2.1/OIDC bearer tokens and
  maps the immutable `(issuer, subject)` pair to an enabled workspace principal.
  Anonymous remote mutation is forbidden. Authentication does not itself grant
  authorization; a separate policy guard evaluates the requested capability.
- Authorization is evaluated separately from event actor attribution.
- Extension installation is a trusted-code operation, not a task mutation.
- Connector verification claims are explicit and never inferred from actor name.
- Secrets and raw provider payloads stay outside normalized records by default.
- Protected effect execution requires effect digest, valid approval, connector
  scope, idempotency identity and current claim fence.
- Audit retention does not grant replay authority.

`TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md` is the accepted K2 threat model. It
freezes the fail-closed control sequence and adversarial gates.
`ADR-002_EFFECT_REQUEST_IDENTITY.md` now accepts canonical request bytes and
distinct request/effect/dispatch identities, unblocking TQ-203/TQ-204 schema.

## 12. Non-goals

The universal kernel will not:

- choose the best agent for a task;
- negotiate bids or implement a marketplace by default;
- reimplement durable workflow runtimes;
- provide universal semantic search or autobiographical memory;
- infer completion from prose;
- embed Gmail, GitHub, Mercury or any provider in core;
- force every domain into area/goal/project hierarchy;
- standardize every possible status used by remote protocols;
- guarantee multi-device replication before a conflict ADR exists;
- ship a SaaS/UI before embedded and local semantics are proven.

## 13. Accepted boundary decisions

UK-001 makes the following binding:

1. Tasq's product category is **universal commitment coordination kernel**.
2. Existing provider kinds are reference extensions, not core ontology.
3. Life prioritization and planning hierarchy are bundled profiles, not kernel
   requirements.
4. MCP/A2A/runtime tasks map to attempts unless explicitly imported as a
   commitment by policy.
5. Assignment, claim and attempt remain separate records.
6. Artifact and evidence become distinct semantics.
7. Type/evaluator identity is URI-namespaced and versioned.
8. Evaluators are pure installed code; arbitrary stored predicates remain
   forbidden.
9. TQ-107 pauses until its projection/doctor contracts target generic records.
10. Universal claims require the three-domain conformance suite.
11. Lifecycle state and derived actionability remain separate.
12. Completion has an immutable first-class basis; event payloads alone are
    insufficient proof.
13. Exactly-once is claimed only for ledger acceptance, never arbitrary
    provider effects.

## 14. Resolved implementation decisions

The adversarial UK-001 review resolves every former pre-implementation
question:

1. **Public terminology:** `commitment` is canonical in the new embedded API,
   docs and protocol mappings. Existing `task` storage, CLI commands and JSON
   v1 fields remain compatibility aliases with a strict 1:1 mapping until an
   opt-in v2.
2. **Relations:** add a new commitment-only relation table. Backfill historical
   task dependencies as `depends_on` without reversing endpoints. Existing
   dependency commands become compatibility adapters over the new authority;
   there is no indefinite dual-write ownership.
3. **Schema retention:** manifests and canonical JSON Schemas are snapshotted in
   the registry by content digest. Evaluator code remains installed trusted code
   and each evaluator identity is permanently bound to an implementation
   digest.
4. **Compatibility window:** preserve all v1 commands/fields throughout U0–U5
   and the first universal release. Removal requires opt-in v2, one prior minor
   release with warnings, an automatic migration and a clean legacy `doctor`
   check—not an arbitrary date.
5. **Artifacts:** artifacts are first-class before protocol adapters and
   cross-domain acceptance. Evidence cannot safely stand in for produced
   outputs.
6. **Remote authentication:** the first network adapter uses validated OAuth
   2.1/OIDC bearer identity mapped by `(issuer, subject)` to a workspace
   principal. Authorization remains a separate guard; local aliases remain
   self-asserted.
7. **Optimistic concurrency:** every mutable aggregate uses a monotone revision
   and `expected_revision`. Append-only creates use idempotency; claims also use
   fences; effects require both revision-safe state and fence-safe dispatch.
8. **Embedded SDK:** the reference v1 SDK is framework-free TypeScript with a
   transactional store interface, JSON DTOs, extension contracts and no ambient
   CLI/config/credential dependency. JSON Schemas and conformance vectors are
   language-neutral.

### Adversarial review findings incorporated

| Failure pressure | Binding resolution |
|---|---|
| “Blocked” silently changes because a dependency appears | Lifecycle is explicit; actionability is derived |
| `blocks` direction is interpreted oppositely by two agents | Store only unambiguous `from depends_on to` |
| Generic polymorphic edges bypass foreign keys/workspace safety | V1 relations connect commitments only |
| A task is marked done but nobody can prove why | Immutable completion record references the exact basis |
| A package silently changes an evaluator under the same version | URI/version is pinned to an implementation digest |
| Unknown extension data accidentally drives state | Opaque facts are inert; actionable unknown types are rejected |
| Timestamp races overwrite another agent's decision | Expected monotone revision on every mutable aggregate |
| Provider timeout is retried into a duplicate payment/deploy | `indeterminate` plus receipt/lookup reconciliation; no blind retry |
| “Exactly once” is overclaimed across a network boundary | Guarantee is limited to ledger acceptance |
| A remote actor name is mistaken for permission | Authenticated subject mapping and authorization are separate |
| `metadata` becomes provider logic hidden in core | Registered, bounded schemas own behavior-driving data |
| Recurrence/project planning keeps `_life` in the kernel | Scheduling and planning move to bundled profiles |

The review found no reason to abandon the commitment/attempt/claim/evidence/
condition algebra. It did find that completion records, revisions and explicit
relation direction are required kernel primitives rather than optional polish.

### Deliberately deferred ADRs

Acceptance does not pretend that later threats are solved. The following remain
gated decisions before their features ship:

- extension artifact loading, publisher verification and sandbox hardening
  before remotely supplied executable code is trusted;
- authority/key rotation and completion-evidence validity before any
  effect-capable remote deployment (UK-006 principals are attribution only);
- effect request canonicalization and the full K2 threat model are accepted in
  `ADR-002_EFFECT_REQUEST_IDENTITY.md` and
  `TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md`; effect-capable remote identity and
  key rotation require implementation of accepted ADR-004;
- replica conflicts, tombstones and causal ordering are now accepted in
  `ADR-003_REPLICA_CONFLICT_MODEL.md`; TQ-405 implements the neutral commitment
  projection, and TQ-406 now supplies the required crash/restore chaos proof
  before broad multi-device production readiness is advertised.

None of these deferred ADRs may move provider calls, credentials, policy or
runtime execution into the kernel.

## 15. Accepted implementation order

```text
UK-001  DONE — accepted universal boundary and terminology
UK-002  DONE — executable inventory + compatibility matrix
UK-003  DONE — generic type/evaluator URI registry beside current enums
UK-004  DONE — extract five current domains as reference extensions
UK-005  DONE — extract life planning/prioritization/projection profile
UK-006  DONE — principal + assignment + relation + external_ref + artifact + completion records
UK-007  DONE — three-domain conformance harness
UK-008  DONE — authorized generic TQ-107 inspection/projection/cursor integration
UK-009  DONE — machine discovery + safe cold-start onboarding
UK-010  DONE — MCP Tasks + A2A attempt adapters
UK-011  DONE — real cross-runtime dogfood and universal-kernel acceptance
```

Effect/approval implementation begins only after the generic identity and
extension boundaries are stable. Multi-device sync remains gated by real
dogfood evidence.

## 16. Success test

Tasq earns the word “universal” when an unfamiliar third party can:

1. install the kernel without `_life` concepts;
2. define a new domain using an extension manifest and schemas;
3. coordinate two different runtimes on one commitment;
4. survive crash, duplicate delivery and stale-worker races;
5. inspect why the commitment is still open or why it was completed;
6. do all of this without modifying kernel source or schema.

UK-011 demonstrates this complete gate composition; see
`UK-011_UNIVERSAL_ACCEPTANCE.md`. Tasq is now an accepted universal embedded
coordination-kernel implementation. It is not yet a hosted protocol service or
an external standard.
