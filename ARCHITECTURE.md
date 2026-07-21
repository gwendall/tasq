# Architecture — tasq

> **Layered, service-owned writes, state-based with an append-only audit log, runtime-agnostic.** Tasq is not event-sourced: current rows are authoritative and events provide ordering, attribution and recovery evidence.

This document describes the implemented architecture. The accepted universal
target lives in `UNIVERSAL_KERNEL_SPEC.md`; UK-002's exhaustive map lives in
`UNIVERSAL_COMPATIBILITY_INVENTORY.md`. UK-003's additive universal registry is
implemented and UK-004 moved provider schemas/evaluator code into a reference
extension package. UK-005 is complete: life prioritization, projection,
recurrence and planning ancestry live in the DB-free bundled profile, while a
minimal `@tasq/core` composition boots without loading it.

## Product composition

The kernel and the product are deliberately distinct:

```text
Tasq Cloud (future managed operation)
└── Tasq Server (future authenticated REST/remote MCP/event transport)
    ├── authority DTOs + pure guard (implemented internally, TQ-801)
    ├── persistence/router/verifiers/transports (future, TQ-802+)
    └── Tasq Core (implemented embedded kernel)

Tasq Local (implemented single-host reference product)
├── CLI JSON / human CLI
├── local stdio MCP
├── read-only loopback Console
└── Tasq Core + one local LibSQL ledger
```

Server and Cloud are not deployed behavior. They must reuse Core through the
ADR-004 identity/routing/authorization guard, not fork state or expose current
local listeners remotely. `PRODUCT_CONSUMPTION_SPEC.md` owns the product
contract and `PRODUCT_SURFACE_MATRIX.json` owns its machine-readable support
states.

TQ-801 implements only the pure middle of that future guard in
`@tasq-internal/authority`. Authentication adapters must construct a strict
verified identity; a future TQ-802 authority store/router must supply current
bindings and grants; and only an allowed decision may precede a kernel call.
The package intentionally imports neither HTTP, persistence nor Core.

## At a glance

```
┌────────────────────────────────────────────────────────────────┐
│ Consumers (agents, humans, CLI shell, MCP, local inspector)    │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼  (CLI + JSON, today)
┌────────────────────────────────────────────────────────────────┐
│ @tasq/cli              one Bun entry point                │
│  - args parser              (no external dep)                  │
│  - commands/* (planning, claims, attempts, evidence, waits,    │
│    context links, reconciliation, audit and durability)        │
│  - runtime.ts: opens DB, runs migrations, regenerates projection│
│  - output/format.ts: TTY-aware colors, JSON output, exit codes │
└────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
┌───────────────────────────────┐  ┌─────────────────────────────┐
│ @tasq/console          │  │ @tasq/mcp              │
│ bounded index + canonical     │  │ capability-scoped local     │
│ graph HTML/JSON; GET/HEAD only│  │ stdio transport             │
│ loopback, no JS or authority  │  └─────────────────────────────┘
└───────────────────────────────┘
              │
              ▼  (function calls, in-process)
┌────────────────────────────────────────────────────────────────┐
│ @tasq-internal/local-service          the ONLY write path                │
│  - db.ts: openDb with WAL + safe pragmas                       │
│  - ordered checksum-verified SQL migrations + safe snapshots   │
│  - service/{tasks,events,agentic,waits,context-links,          │
│             observations,reconciliation,effects,replication}.ts│
│    Mutations: validate via Zod → transact → audit where scoped │
│  - prioritizer.ts: DB adapter to bundled planning policy       │
│  - projection/markdown.ts: DB read adapter to profile renderer │
└────────────────────────────────────────────────────────────────┘
                              │
                              ├──────────────┐
                              ▼              ▼
┌───────────────────────────────┐  ┌─────────────────────────────┐
│ @tasq-internal/reference-extension│  │ @tasq/extension-sdk    │
│ five v1 domain modules         │─→│ pure runtime identities,    │
│ schemas, routes, evaluators    │  │ parsers and evaluator lookup│
└───────────────────────────────┘  └─────────────────────────────┘
                              │              │
                              └──────┬───────┘
                                     ▼
┌────────────────────────────────────────────────────────────────┐
│ @tasq/schema           types + tables + ids               │
│  - types.ts/extensions.ts: records + immutable manifests       │
│  - effects.ts: canonical effect request + identity contract    │
│  - tables.ts: Drizzle table definitions (mirror types 1:1)     │
│  - ids.ts: UUIDv7 generation (no external dep)                 │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼  (file:// URL)
                  ┌──────────────────┐
                  │  ~/.tasq/db.sqlite│  ← single source of truth
                  │  LibSQL (SQLite)  │     WAL mode for concurrency
                  └──────────────────┘
                              │
                              ▼  (read-only projection)
                  ┌──────────────────┐
                  │ ~/Code/_life/    │  ← human-readable view
                  │ TASKS.md         │     auto-regenerated on mutate
                  └──────────────────┘
```

Every enabled local delivery sink receives a `delivery_outbox` row from a
SQLite trigger in the same transaction that inserts its immutable source
event. The queue references event identity rather than copying payload. Sink
configuration remains host-owned and digest-bound; sink/outbox state is local
operational state and will not be replicated. See
`TQ-401_TRANSACTIONAL_OUTBOX.md`. The CLI consumes this state on startup and
close through the ordered lease protocol in `TQ-402_OUTBOX_DRAIN_AND_REPAIR.md`;
JSONL append is idempotent by event identity/sequence and poison blocks later
delivery until explicit repair.

Every externally retriable mutation uses the shared TQ-403 identity
`(workspace, caller scope, operation, client key)` in the same transaction as
its authoritative write. A versioned canonical request digest rejects
conflicting reuse; accepted result status/revision/event cursor remain
inspectable. Standard identities have an injected-clock retention horizon,
while effect, external and protocol identities are durable. See
`TQ-403_DURABLE_IDEMPOTENCY.md`.

TQ-405 now implements ADR-003 for the profile-neutral commitment projection.
One authority orders accepted operations per workspace epoch; offline replicas
atomically queue versioned service commands with semantic base/result digests,
and concurrent incompatible commands become visible durable conflicts. Pull
also carries a content-addressed canonical snapshot, so authority-required
changes converge without masquerading as offline commands. Audit JSONL, local
event sequence, delivery state and wall-clock timestamps are not a replication
protocol. Accepted generation frontiers make response-loss rebase safe;
content-addressed pages are all verified before atomic activation. Pull contact
requires the transport-authenticated replica identity. Claims/fences/effect
dispatch remain online-authority capabilities.
See `ADR-003_REPLICA_CONFLICT_MODEL.md` and
`TQ-405_EXPLICIT_REPLICATION.md`.

TQ-406 validates that design against real process death. Exact duplicate
acknowledgements are safe; stale generations cannot self-reactivate; and an
old authority backup can only resume after an exact-precondition epoch
rotation that records a durable recovery snapshot digest. See
`TQ-406_SYNC_CHAOS_AND_RECOVERY.md`.

## Dependency direction

```
tasq-cli ──→ tasq-inspector ─┐
     └────────→ tasq-service ├─→ tasq-reference-extension
                  ↑          │
                  └──────────┘
                  ├────────→ tasq-life-planning-profile (DB-free)
                  │                       │
                  ├──────────────→ tasq-extension-sdk
                  │                       │
                  └──────────────────────→ tasq-schema
                  ↑
             tasq-evals

future tasq-server ──→ tasq-authority ──→ tasq-schema
       └───────────────────────────────→ tasq-core
```

- `tasq-schema` is the foundation. Zero deps beyond zod + drizzle-orm.
- `tasq-authority` is a private DB-free, transport-free sibling that turns a
  verified identity and current authority snapshot into one digest-bound
  decision at one injected timestamp. It does not authenticate credentials or
  call the kernel.
- `tasq-extension-sdk` is DB-free and provider-neutral. It binds immutable
  manifest identities to trusted runtime parsers/routes/evaluators.
- `tasq-reference-extension` owns the five v1 domain modules. It has no DB or
  service dependency.
- `tasq-life-planning-profile` owns the reference prioritization policy and
  pure markdown renderer, canonical area/goal/project/task ancestry and
  recurrence/calendar planning. It has no runtime dependencies and consumes
  structural read models or injected structural lookups only.
- `tasq-service` is the only write path. Holds all DB knowledge.
- `tasq-service/kernel` is the profile-neutral embedded surface: canonical
  commitments, explicit workspace/actor context, injected time and migrations
  without reference-extension bootstrap. Compatibility planning modules load
  lazily only when a caller actually supplies planning fields or recurrence.
- `tasq-inspector` is a read-only sibling surface over the strict kernel. It
  owns no storage or policy, and kernel/service never import it.
- `tasq-cli` is one of several possible interfaces. MCP and the local inspector
  are current siblings; authenticated REST/hosted UI remain future adapters.
  ADR-004 now fixes their composition order: trusted transport -> verified
  issuer/subject -> workspace binding/router -> live authorization decision ->
  kernel. They may never expose the raw kernel first.
- `tasq-evals` is a sibling that exercises the public surface.

## Time is an injected dependency

No kernel, service, policy, migration or CLI business logic reads the host
clock directly. `@tasq/schema` defines the tiny `Clock { now(): number }`
contract, a mutable controlled clock for tests/simulation, and the sole
`systemClock` adapter allowed to read device time. The CLI injects that adapter
at its composition root; embedders may inject any compatible clock.

Each operation captures one timestamp and propagates it through state rows,
UUIDv7 generation, idempotency records and transactional audit events. An
explicit timestamp such as `occurredAt`, `observedAt`, `sweepNow` or `now`
remains a domain/replay input and takes precedence over the injected clock.
Timestamp formatting uses supplied values and never discovers time implicitly.
SQL migrations and defaults likewise receive application time rather than
calling SQLite clock functions.

The local inspector captures one injected time per HTTP request and explicitly
sets the HTTP `Date` header from it; this prevents the Bun server from silently
reintroducing a raw device-clock read at the transport boundary.

This boundary enables deterministic tests, replay, simulation and virtual time
without monkey-patching globals. An architecture test scans every production
TypeScript source and rejects direct wall/monotonic clock reads or zero-argument
date construction outside `tasq-schema/src/clock.ts`.

## The core entities

| Entity | Purpose | Status enum | Cardinality |
|---|---|---|---|
| **area** | A domain of life ("Health — Body", "Career — Kami") | — | small (typ. 11) |
| **goal** | Long-term outcome inside an area | active / paused / done / abandoned | ~10-30 |
| **project** | Deliverable that achieves part of a goal | active / blocked / waiting / done / cancelled | ~20-100 |
| **task** | Concrete next step | open / in_progress / blocked / done / cancelled | unbounded |
| **task_claim** | Exclusive expiring ownership lease + fencing token | active/released derived from timestamps | bounded history |
| **resource_lease** | Exclusive lease over an opaque provider-neutral resource key | active/expired/released derived from injected time | bounded history per key |
| **resource_event** | Immutable ordered acquire/renew/release/expiry stream | — | unbounded |
| **task_attempt** | One execution against a task | running / input_required / succeeded / failed / cancelled | unbounded |
| **task_evidence** | Immutable observable receipt linked to task/attempt | — | unbounded |
| **external_context_link** | Append-only pointer from a commitment to externally owned reusable context | active / detached / superseded (derived) | bounded history per commitment/purpose/target |
| **extension_release** | Immutable installed manifest snapshot | — | small append-only history |
| **extension_type** | Frozen URI/schema-version registration | — | bounded per release |
| **extension_evaluator** | Frozen deterministic evaluator identity and accepted inputs | — | bounded per release |
| **wait_condition** | Typed external expectation with deadline/fallback config | waiting / satisfied / expired / cancelled | unbounded history |
| **observation** | Immutable normalized external fact + provenance | — | unbounded history |
| **observation_route** | Derived multi-key candidate lookup | — | bounded per observation |
| **reconciliation** | Frozen matcher decision and committed effect | matched / rejected / ambiguous | unbounded history |
| **effect** | Exact immutable external-write occurrence and guarded lifecycle | proposed / authorized / executing / committed / failed / indeterminate / cancelled | unbounded history |
| **effect_approval** | Immutable exact-digest authority decision and validity provenance | approved / denied / revoked | unbounded history |
| **effect_receipt** | Immutable verified provider report bound to effect execution and task evidence | committed / failed / indeterminate | unbounded history |
| **event** | Ordered append-only task-scoped audit log | — | unbounded |
| **delivery_sink** | Local digest-bound event consumer declaration | enabled / disabled | small local set |
| **delivery_outbox** | Crash-safe per-sink event delivery control state | pending / delivering / delivered / quarantined | bounded by retention policy |

Agentic invariants are enforced twice. The service layer provides readable
errors and atomic state/event mutations; additive SQLite triggers defend the
same boundaries against damaged clients and direct SQL. In particular, claim
identity and fences cannot be rewritten, terminal attempts are immutable,
evidence is physically append-only, cross-task links are rejected, and a task
cannot become terminal while an attempt is active. Wait conditions additionally
freeze matcher/fallback identity, transition only once, and are cancelled
atomically when their task becomes terminal. `doctor` independently
detects these inconsistencies if database guards were removed or a file was
corrupted out of band.

Generic resources deliberately use a separate lease record and event stream.
They do not require a commitment, do not widen the historical task event
entity enum and do not interpret keys. One partial unique index enforces one
unreleased row per `(workspace,resourceKey)`; fence values are unique and
monotone across history. SQLite freezes lease identity and events while the
service owns CAS transitions, exact retry semantics and injected-time expiry.

Observations use a separate immutable state machine: there is no update or
delete path. `(tenant, source, externalEventId)` is the delivery identity;
identical re-delivery returns the original fact and changed content is an
integrity error. Candidate lookup is indexed by typed `kind + subjectRef`, and
polling uses `(recordedAt,id)` rather than a lossy timestamp-only cursor.

The registry stores absolute type/evaluator URIs, frozen schema/version pairs
and implementation digests. Pure compiled matchers are resolved through the
generic runtime SDK; the service maps the five closed v1 aliases to their
reference-extension identities only at its compatibility boundary.

Effects add a pre-dispatch state machine beside attempts rather than inside
them. The request/digest/dispatch identity is immutable; approvals form one
append-only linear chain over that exact digest. Service checks, output schemas,
SQLite triggers and `doctor` independently enforce lifecycle, workspace,
revision and authority invariants. TQ-205 is now the only embedded path to
`executing`: it performs a fresh authority/scope/limit/revision/attempt/claim-
fence check, signs the complete permit, and the DB-free connector helper repeats
the check before I/O. TQ-206 then accepts canonical connector reports only
through a trusted pure verifier, creates linked evidence and preserves timeout
uncertainty until a later provider lookup receipt resolves it. TQ-207 models
compensation as a new fully authorized occurrence rather than rewriting history.
See `TQ-203_EFFECT_LEDGER_AND_AUTHORITY.md` and
`TQ-205_CONNECTOR_DISPATCH_GATE.md` and
`TQ-206_EFFECT_RECEIPTS_AND_COMPENSATION.md`.
Reconciliation runs in one writer transaction: record the
decision, optionally derive evidence, transition the wait, and append the
task-scoped audit events. It never performs network I/O, model inference, task
completion, or unblocking.

Deadline evaluation is another runtime-invoked ledger transaction. A due wait
first reconciles every indexed candidate whose `occurredAt` and `recordedAt`
are both strictly before the deadline. If none satisfies it, the transaction
expires the wait and performs at most one ledger fallback. `create_task`
materializes a canonically-scoped task; `activate_task` clears deferral and
reopens a blocked target without starting it. A derived idempotency identity,
the terminal wait lifecycle, and SQLite result guards make retries harmless.
Batch sweeps isolate conditions so one stale/invalid fallback cannot starve
other due work.

Core planning entities have:
- `id` (UUIDv7, time-ordered)
- `tenant_id` (default `'gwendall'`, ready for multi-tenant in v0.9)
- `metadata` (JSON escape hatch; dependencies are first-class rows)
- `created_at`, `updated_at`, `deleted_at` (tombstone)

## Status state machines

Each non-event entity has an **explicit transition table** in its service module:

```ts
// service/tasks.ts
const STATUS_TRANSITIONS = {
  open:        ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["open", "blocked", "done", "cancelled"],
  blocked:     ["open", "in_progress", "done", "cancelled"],
  done:        ["in_progress", "open"],
  cancelled:   ["open"],
};
```

**Forbidden transitions throw.** They're not silently ignored. See `state-machines.test.ts` for 20 task + 12 goal + 16 project transitions verified.

## Goal ancestry (proactive surfacing, not retroactive filter)

When the prioritizer or projection ranks tasks, it does so by traversing `task → goal → area`:
- Goal importance dominates the leverage score
- Area cadence drives drift detection
- Tasks without ancestry default to importance 3

**But** : goal ancestry is a guide for *what to surface*, never a filter for *what is allowed*. The system never refuses to log a spontaneous action that doesn't trace cleanly — personal life has a legitimate non-traceable surface (a friend in crisis, a parent in grief, a creative intuition).

## Event log = ordered audit trail

Planning, coordination and reconciliation mutations go through the service
layer and emit one or more ordered task-scoped events. Observation ingestion is
the deliberate exception: the immutable observation is provenance before any
task relationship exists, and reconciliation emits the eventual link.

Event types are open vocabulary. Current examples include:

```
created · updated · started · blocked · unblocked · completed · cancelled
claim_acquired · attempt_started · evidence_added · wait_created
reconciliation_recorded · wait_satisfied · wait_expired
```

Events carry:
- `sequence` — monotone SQLite cursor; use this for lossless pagination
- `actor` — `gwendall`, `hermes`, `claude-code`, or custom
- `createdAt` — recording time; `occurredAt` — optional domain time
- `payload.before` / `payload.after` — diff
- `payload.note`, `payload.reason`, `payload.source` — agent annotation

This is how:
- Hermes detects "what changed since my last brief" (`afterSequence` cursor)
- The user audits "when did I file 3916 ?" (`entity-id` filter)
- We resolve "who triggered this completion?" (actor filter)

The off-DB JSONL mirror is segmented for recovery. When an operator accepts a
verified restored database, `journal checkpoint` content-addresses and archives
the old segment, then starts a new segment with the accepted DB cursor and event
identity. `doctor` verifies the recursive SHA-256 chain and requires exact
parity for every event after the checkpoint. The checkpoint acknowledges a
recovery decision; it never rewrites or deletes the divergent evidence.

## Prioritizer formula

```
score = LEVERAGE_WEIGHT × leverage   (0.5)
      + URGENCY_WEIGHT  × urgency    (0.3)
      + AVOIDANCE_WEIGHT× avoidance  (0.2)
```

Each component is normalized to `[0, 5]`. **Transparent reason traces** are returned so the agent can explain its ranking to the user.

Tie-break: `(score desc, due_at asc, created_at asc)`.

See `prioritizer-quality.test.ts` for the realistic comparison evals.

## Markdown projection

Pure function `db → string`. Sections:
1. Top priorities (top 5 from prioritizer)
2. Per area (sorted by importance desc), with nested goals → projects → tasks
3. Inbox (tasks without an area)
4. Closed in last 30 days

Status icons : `[ ]` open, `[~]` in_progress, `[!]` blocked, `[x]` done, `[-]` cancelled.

Auto-regenerated after CLI mutations routed through the projection hooks when
`config.projectionTarget` is set. The current renderer covers planning/task
state only; raw observation ingestion has no projected task relationship and
does not regenerate the file.

## Key design decisions (and why)

### Why LibSQL (SQLite under the hood) ?

- Single binary, no server process, zero ops
- WAL mode = safe concurrent writes from multiple CLI processes
- Same engine local + future cloud (Turso) = no dialect divergence
- FTS5 native if we want search later
- File is portable, inspectable with `sqlite3` CLI

### Why CLI-first (not MCP) in v0.1 ?

CLI + a markdown agent contract is universally portable across runtimes
(Hermes, Claude Code, OpenClaw, shell and cron) and keeps the local-first
deployment daemon-free. An MCP adapter can remain a sibling surface over the
same service layer when typed discovery or remote runtimes justify it. See
`TASQ_ZERO.md §3` for the original historical decision and `BACKLOG.md` for the
current adapter gate.

### Why a small explicit migration runner?

Ordered manual SQL files + a small runner. Reasons:
- Applied migrations are immutable and checksum-verified
- Existing databases receive a pre-migration snapshot
- Fully inspectable — no magic generation step
- CHECK constraints + indexes spelled out, not inferred
- Lexicographic migrations are applied atomically and tracked in `_migration`

### Why service-layer-only writes ?

- Task-scoped mutations emit ordered audit events; unrelated observations keep immutable provenance until reconciliation
- Validation happens once, in one place (Zod schemas)
- ACL / FK / state-machine checks live next to the mutations they govern
- Future surfaces (MCP, REST) share invariants without code dup

### Why UUIDv7 (not v4 or auto-increment) ?

- Lexicographic sort = chronological sort (great DB locality)
- Globally unique → safe for offline / multi-machine merges later
- 48-bit ms timestamp is readable for debug
- 74 bits of randomness = collision-free in practice

### Why a launcher script (not `bun --compile`) for the binary ?

`@libsql/client` ships platform-specific N-API native addons that Bun's `--compile` cannot fully bundle today. A launcher (`exec bun run path/to/index.ts $@`) is robust, debuggable, and zero-overhead at startup. Standalone compile is a v0.2 concern (`bun:sqlite` migration or Bun improvements).

## Accepted universal package boundary

The accepted current invariants are intended to evolve into this dependency
shape without destructive migration:

```text
tasq-surfaces (CLI / embedded / future MCP and REST)
                         │
                         ▼
tasq-kernel  ◀── tasq-extension-contract
     ▲                    ▲
     │                    │
profiles/policies    domain extensions
(life, coding)       (GitHub, Gmail, HTTP, ...)
     ▲                    ▲
     └──────── adapters / connectors ──────── runtimes
```

The kernel owns only deterministic durable coordination records. Closed
Gmail/GitHub/Mercury/HTTP/filesystem kinds become versioned reference
extensions. Area/goal/project, cadence, avoidance scoring and the `_life`
projection become a bundled planning profile. Protocol/runtime tasks map to
attempts and artifacts rather than silently completing commitments.

See `UNIVERSAL_KERNEL_SPEC.md` for the target algebra, extension contract,
migration phases and cross-domain conformance gate. UK-006 collaboration
records, UK-007 black-box conformance and the UK-008 readiness gate are
implemented. TQ-107 is now implemented as the additive `tasq.inspect.v1` graph
and profile-neutral renderer. TQ-108's five watcher fixtures are implemented.
TQ-109 adds a DB-free filesystem adapter and proves the real manually invoked
`_life` loop on an unchanged live source plus isolated DB/WAL snapshot. UK-009
now exposes bounded, digest-bound discovery and strict no-downgrade onboarding
through the embedded service and local CLI. UK-010 now maps version-pinned MCP
Tasks and A2A Tasks through a standalone outward-dependent package; remote
completion remains attempt state and artifacts remain non-evidence. UK-011 now
composes discovery, an unfamiliar SDK extension, independent MCP/A2A subprocess
runtimes and exclusive event cursors into the accepted universal M1 proof. The
full database schema fingerprint is unchanged. TQ-201 freezes the K2
effect/authority threat model and injected-clock safety properties. ADR-002 adds
the DB-free strict request canonicalizer and separates request, occurrence and
dispatch identity. TQ-203/TQ-204 persist the guarded effect/approval ledger and
TQ-205 implements its authenticated connector gate, and TQ-206/TQ-207 add
verified receipts, uncertainty recovery and independently authorized
compensation. TQ-208 now passes adversarial acceptance across money,
communication, filesystem and deployment policies without changing the kernel.
TQ-305 now adds a DB-free provider-neutral connector profile, derived failure
dispositions and black-box behavioral suite over the SDK boundary. The real
filesystem watcher passes the observation gate; synthetic provider
instrumentation covers protected writes. TQ-302 capability-separated MCP is
current. TQ-501/TQ-502 add bounded source indexes and source-bound terminal
compaction. TQ-503 adds the deliberately smaller reusable-context primitive:
an append-only commitment-to-external-identity link. Content, retrieval,
credentials and authority remain owned by external systems; links are exposed
consistently through the embedded kernel, CLI, MCP, discovery and inspection.

## Forward compat with the v0.9 vision

`SPEC.md` describes a multi-tenant cloud-synced direction with MCP / REST /
sync. It is not a promise that the current schema is already identical to that
future design. Evolution should remain additive where the invariants permit it;
new surfaces are sibling adapters over the service layer, not alternate write
paths. `ADR-004_AUTHENTICATED_HOSTED_TENANCY.md` is the accepted identity,
authorization, store-isolation, revocation and clock design. TQ-801 now
implements its pure authority contracts and evaluator, while its machine
matrix and all remote surfaces remain explicitly unshipped. `CURRENT_STATE.md`
is the implemented compatibility boundary.

## File layout

```

├── README.md / AGENTS.md / CURRENT_STATE.md / UNIVERSAL_KERNEL_SPEC.md
├── UNIVERSAL_COMPATIBILITY_INVENTORY.md + .json
├── SKILL.md / RECIPES.md / EXTENSION_SDK.md
├── ARCHITECTURE.md / CLI_JSON_CONTRACT.md / ADR-*.md / BACKLOG.md
├── SPEC.md / TASQ_ZERO.md / ATLAS.md / DOGFOOD_*.md  (history/strategy)
├── packages/
│   ├── tasq-schema/    ── @tasq/schema    (types/tables/ids/effect identity + tests)
│   ├── tasq-extension-sdk/ ── runtime contract + connector conformance + tests
│   ├── tasq-life-planning-profile/ ── DB-free bundled policy + tests
│   ├── tasq-reference-extension/ ── five bundled domain modules + parity tests
│   ├── tasq-filesystem-watcher/ ── DB-free read-only connector + CLI
│   ├── tasq-protocol-adapters/ ── version-pinned MCP Tasks/A2A import boundary
│   ├── tasq-inspector/ ── loopback GET/HEAD HTML/JSON projection + browser tests
│   ├── tasq-authority/ ── pure hosted identity/authorization contracts + evaluator
│   ├── tasq-service/   ── @tasq-internal/local-service   (service layer + tests)
│   ├── tasq-cli/       ── @tasq/cli       (CLI + E2E tests)
│   └── tasq-evals/     ── @tasq-internal/evals     (agent scenarios)
└── scripts/
    ├── install-cli.sh           install ~/.local/bin/tasq launcher
    ├── migrate-from-life.ts     one-shot _life/TASKS.md → tasq DB
    └── dogfood-life-watcher.ts  isolated real-input TQ-109 proof
```
