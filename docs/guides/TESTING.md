# TESTING — tasq

> How tests are organized, what they verify, and how to run them.

## Coverage at a glance

Run `pnpm test` from the canonical repository root for the complete workspace
suite. It covers schemas, transactional/concurrent invariants, migrations and
cursors, the real CLI in subprocesses, documentation consistency and realistic
agent flows. Counts are intentionally not copied into docs because they drift
on every change.

## Thirteen layers of testing

The codebase distinguishes **thirteen test layers**, each living with its owning package:

### 1. Schema tests (`packages/tasq-schema/test/`)

**Question** : *Are the foundations of the type system correct?*

- `ids.test.ts` — UUIDv7 generation: format (8-4-4-4-12 hex), version nibble, variant bits, timestamp encoding round-trip, lexicographic ordering matches chronological, 1000-id uniqueness in tight loop
- `clock.test.ts` — controlled clock snapshots, explicit overrides, advancement and invalid-time rejection
- `types.test.ts` — Zod schema validators: each enum, each numeric range, each required field, each default value, each forward-compat invariant

Run :
```bash
cd packages/tasq-schema && bun test
```

### 2. Extension SDK tests (`packages/tasq-extension-sdk/test/`)

**Question**: *Can an unfamiliar domain load and resolve exact runtime
identities without importing the service or changing kernel source?*

These tests cover manifest/runtime drift, duplicate identities,
cross-extension resolution and a complete synthetic robotics evaluator. They
also exercise the DB-free connector conformance profile and black-box harness:
observation replay/conflict, classified failures, effect mutation, provider
operation counts, stale fences, timeout lookup and hostile receipts.

### 3. Life-planning profile tests (`packages/tasq-life-planning-profile/test/`)

**Question**: *Does the bundled planning policy remain deterministic and usable
without a database, service or kernel-schema dependency?*

The package tests freeze structural inputs, reason traces and policy weights.
They also cover deterministic UTC recurrence stepping, month-end clamping,
anchor selection and streak policy without a database or kernel record type.
Structural hierarchy tests cover derived project/goal/area ancestry, parent
inheritance, contradictions and missing ancestors through injected lookups.
CLI architecture tests enforce the dependency boundary while service tests
preserve the historical public re-export and DB-aware behavior.

### 4. Reference extension tests (`packages/tasq-reference-extension/test/`)

**Question**: *Do the five bundled v1 domains preserve their schemas, routes
and exact deterministic decisions outside the kernel?*

These tests freeze all ten types, five evaluators, canonical defaults, HTTP and
Mercury vocabularies, routing keys and exact decision output. CLI boundary tests
also prevent provider definitions from leaking back into core packages.

### 5. Reference connector tests (`packages/tasq-reference-connectors/test/`)

**Question**: *Do concrete connectors preserve the universal provider boundary
under actual HTTPS request construction and hostile outcomes?*

The package tests run its read and effect implementations through the reusable
TQ-305 conformance suite. They cover replay/conflict visibility, pinned-origin
HTTPS and redirect refusal, late secret resolution, exact permit/content
binding, provider idempotency, stale fences, unknown-outcome lookup, complete
HMAC receipts, hostile receipts and immutable verification-to-ledger binding.

### 6. Hosted authority and Server-foundation tests (`packages/tasq-authority/test/`, `packages/tasq-server/test/`)

**Question**: *Can a future authenticated adapter make one deterministic,
deny-by-default decision without transport, persistence, kernel or device-time
coupling?*

The TQ-801 suite freezes strict identity/binding/grant/delegation/decision
contracts and 16 exact action identities. It covers live revocation, complete
snapshot digests, two-issuer subject collision, delegated subject/actor
intersection, sender constraints, effect eligibility, corrupt snapshots and
one injected-clock capture. The separate clean-room eval exercises human,
headless delegated-agent and SPIFFE service configurations without claiming a
remote surface.

The TQ-802 Server-foundation suite adds real SQLite migration races,
CAS/idempotency conflicts, append-only SQL guards, persisted delegation and
effect eligibility, stale-allow replay refusal, authority corruption and an
instrumented opaque router that proves a foreign workspace opener is never
called. Its eval repeats cold migration in separate processes and proves
revocation across close/reopen boundaries.

The TQ-803 suite drives real Fetch requests through a host verifier, the live
authority database and an instrumented workspace reader. It covers RFC 9728
discovery, challenge and outage semantics, encoded workspace IDs, issuer
collision, invalid-input short circuiting, bounded/redacted reads, foreign
workspace probes, next-request revocation and strict host-output failure. One
request-wide injected clock value reaches verification, authority and output.

The TQ-804 suite adds a second real SQLite workspace database and a second
authority connection. It proves registered catalog discovery, mandatory
idempotency, exact replay/conflict, redaction, cross-workspace denial,
`authority_busy` serialization against concurrent revocation, post-revocation
denial and exact recovery after a domain commit returns a corrupt outcome.
The certificate explicitly rejects a false cross-database ACID claim.

```bash
pnpm --filter @tasq-internal/authority test
pnpm --filter @tasq-internal/server test
pnpm --filter @tasq-internal/evals test -- hosted-authority-foundation.test.ts
pnpm --filter @tasq-internal/evals test -- hosted-authority-store-router.test.ts
pnpm --filter @tasq-internal/evals test -- hosted-read-rest.test.ts
pnpm --filter @tasq-internal/evals test -- hosted-mutation-rest.test.ts
```

### 7. Service tests (`packages/tasq-service/test/`)

**Question** : *Does the service layer enforce the contract?*

- `smoke.test.ts` — full happy-path lifecycle on a temp-file SQLite
- `state-machines.test.ts` — every allowed and forbidden transition for task / goal / project (48 transitions verified). Side effects (`startedAt`, `completedAt`) and event payloads
- `prioritizer-projection.test.ts` — scoring formula in isolation + DB-aware `pickNext` + markdown projection happy path
- `migrations-events.test.ts` — migration idempotency, static populated historical fixtures (`0000 → current` and `0005 → current`), data/event preservation, table creation, FK enforcement, event log ordering, actor filtering, multi-actor scenarios
- `waits.test.ts`, `observations.test.ts`, `reconciliation.test.ts` — typed wait/fact lifecycles, immutable delivery provenance, indexed matching, replay and race behavior
- `deadlines.test.ts` — strict two-clock boundaries, queued-fact reconciliation, exactly-once create/activate fallback, concurrent retry, rollback isolation and direct-SQL guards
- `clock.test.ts` — one injected clock drives migrations, row timestamps,
  UUIDv7 timestamps, lifecycle transitions and transactional event timestamps
- `resources.test.ts` — opaque-key validation, mandatory clocks/idempotency,
  one-winner contention, exact replay, CAS renewal/release, fence monotonicity,
  exact expiry/reclaim, clock rewind, sweep/cursor replay and SQL immutability
- `delivery.test.ts` — registration baselines, fail-closed sink binding,
  trigger-enqueued event delivery, real rollback on outbox failure and durable
  pending state after close/reopen with no listener; ordered lease contention,
  expiry reclaim, deterministic backoff, quarantine and repair use controlled time
- `discovery.test.ts` — exact implemented capabilities, bounded canonical
  schemas and digests, injected cache time, strict negotiation failures,
  zero-mutation onboarding and minimal-kernel provider neutrality
- `effects.test.ts` — exact proposal identity, durable retries, immutable linear
  authority, revocation/expiry, corrections, workspace/type isolation,
  authenticated dispatch permits, attempt/claim/fence enforcement, immutable
  verified receipts, timeout recovery, independent compensation and doctor
  detection after simulated SQL-guard bypass
- `inspection.test.ts` — complete profile-neutral commitment graph including
  exact effects, approval histories and outcome receipts
- `inspector-index.test.ts` — hard bounds, literal search, coordination signal
  aggregates, status filtering and mandatory injected time
- `console-read-models.test.ts` — missing/empty, mature, hostile and
  2,501-commitment views; scoped keyset cursors, redaction, injected expiry,
  honest health scope and coarse request budgets

Run :
```bash
cd packages/tasq-service && bun test
```

**Test isolation** : each test creates its own temp file SQLite via `mkdtempSync` and cleans up in `afterEach`. No shared state, no flakiness from in-memory cache leakage.
The package runner gives every file a fresh Bun process; the 52-case historical
state-machine file is additionally split by Task/Goal/Project suite so Bun
1.3.11 native-driver teardown cannot accumulate across all cases on the
memory-bounded macOS arm64 CI runner. The same 52 tests remain mandatory.

The eval runner applies the same file-level isolation. Its subprocess- and
SQLite-heavy cold-start matrix otherwise accumulates enough native/JSC state
for Bun 1.3.11 to crash during teardown on the macOS runner after all assertions
in a file have passed. Every eval file remains mandatory and fail-fast.

### 8. Protocol adapter tests (`packages/tasq-protocol-adapters/test/`)

**Question**: *Can untrusted MCP Tasks and A2A execution state be imported
without contaminating or completing the commitment kernel?*

The tests freeze every version-pinned state mapping, remote identity namespace,
replay behavior, monotone timestamp rule, terminal immutability, small/large
artifact content binding and the no-implicit-completion invariant. The CLI
architecture test enforces the one-way adapter-to-kernel dependency and scans
the adapter for ambient clock reads.

### 9. MCP transport tests (`packages/tasq-mcp/test/`)

**Question**: *Does transport-level capability separation remain a real
security boundary while preserving kernel semantics?*

The tests connect the official MCP client over an in-memory transport. They
assert exact tool visibility, absent handlers for denied tools, fail-closed
effect authority, host-bound identity, injected time and a complete attempt
flow that cannot implicitly complete its commitment. The eval suite adds a
cold-start runtime that discovers the surface without repository knowledge.

### 10. CLI E2E tests (`packages/tasq-cli/test/`)

**Question** : *Does the actual command-line surface work the way an agent or user would invoke it?*

`e2e.test.ts` spawns `bun run src/index.ts` as a subprocess with an isolated HOME, runs realistic command sequences, and asserts on:
- stdout (JSON when `--json`, formatted text otherwise)
- stderr (error messages)
- exit codes (0 / 1 / 2)
- side effects (DB writes, projection file content)

The durability scenarios also perform a complete restore drill into a second
isolated HOME: snapshot verification, DB/journal cursor comparison, stale
snapshot detection, exact-parity restart, and the first post-restore mutation.
They also cover legacy pre-sequence journals, explicit DB-baseline checkpoints,
idempotent checkpoint retry, post-checkpoint append, recursive archive-chain
tamper detection, and report-only versus opt-in POSIX permission repair.
`outbox-drain.test.ts` covers append-before-ack recovery, physical JSONL
deduplication, poison quarantine and explicit retry. The subprocess doctor
scenario removes an acknowledged journal record and proves
`doctor --repair-outbox` restores exact parity.
The agentic CLI scenario freezes the v1 JSON field sets for tasks, claims,
attempts, evidence, list/show responses and evidence-backed completion; see
`../reference/CLI_JSON_CONTRACT.md` for the compatibility policy.
It also exercises typed wait creation/inspection/cancellation, observation
ingestion and composite pagination, reconciliation, candidate lookup and
deadline sweeping through the real subprocess surface.
The resource CLI scenarios execute an argv recipe returned by cold onboarding,
race independent processes, verify/release/reacquire fences, inspect world
state and assert typed JSON-only contention with no hidden workspace/actor.
The context packet suites cover deterministic neutral ordering, reason traces,
canonical byte/token ceilings, Unicode truncation, whole-record omission,
bounded scans on a mature ledger, unchanged onboarding argv, MCP read-only
exposure and mutable/forbidden injected clocks.
The TQ-503 service/CLI/MCP tests add append-only external context links,
current/history selection, pinned/floating disclosure and capability isolation.
`external-context-links.test.ts` repeats reusable pointers across robotics,
software and research; unreachable URLs and physical-column checks prove Tasq
neither fetches nor stores memory content, embeddings, credentials or authority.
`extension-boundary.test.ts` additionally scans production sources and permits
raw host time only inside the explicit `systemClock` adapter.
`public-release.test.ts` builds the target release twice and requires identical
archive/SBOM/manifest/checksum bytes. It rejects target mismatch, detects a
tampered archive, proves no absolute builder path remains, extracts outside the
checkout and performs real onboarding from only the shipped files.
`public-lifecycle.test.ts` executes the complete target release lifecycle from
outside the checkout: self/checksum/manifest verification, side-by-side
install, autonomous onboarding, two-process resource contention and recovery,
same-ledger v1 Console announcement/discovery/UI inspection, backup, upgrade,
v2 Console identity and unchanged-ledger inspection, `doctor`, matching
snapshot/binary restore, and data-preserving uninstall. It also refuses a
tampered archive and an unmanaged executable collision. CI runs it on both
supported native targets.
`artifact-smoke.test.ts` and `public-packages.test.ts` load the complete UI,
self-hosted assets and runtime identity from standalone and npm candidate bytes
outside the checkout. `web.test.ts` starts the real loopback listener on an
ephemeral port, parses its versioned NDJSON announcement, proves it through a
second `web status` process, refuses duplicate ownership, sends `SIGTERM` and
proves the registration, socket and database close. `console-lifecycle.test.ts`
freezes private atomic file ownership, stale-process recovery and fail-closed
invalid or possibly-live registrations.

The CLI runner executes test files sequentially in fresh Bun processes. The
release, npm and lifecycle files each build or install real artifacts; running
them concurrently causes builder/native-driver contention and nondeterministic
180-second teardown timeouts on the macOS CI runner. File-level isolation keeps
all 125 cases mandatory and fail-fast.

Run :
```bash
cd packages/tasq-cli && bun test
```

### 11. Local inspector tests (`packages/tasq-inspector/`)

**Question**: *Can a human audit canonical state locally without creating a
second truth or a hidden write/network/time boundary?*

Bun tests cover HTML escaping, workspace isolation, constant-query bounded
indexing, TQ-701 JSON routes and audit redaction, TQ-702 polling/SSE reconnect,
backpressure, overflow continuation and typed cursor recovery, all non-read
methods, malformed routes/filters/cursors, security headers, DNS-rebinding host refusal,
internal errors, loopback binding and injected HTTP time/scheduling. TQ-703
adds support-bundle redaction/completeness and client asset checks. TQ-704 adds
the exact `tasq.console-listener.v1` runtime endpoint and deterministic injected
listener identity. TQ-705 Playwright tests start the production Console server
over five fixed-clock, process-isolated stores: empty, mature, hostile, corrupt
and 2,501 commitments with matching audit events. Nine Chromium journeys cover
keyboard/filter behavior, deep navigation, active claim/resource inspection,
390px dark/reduced-motion layout, cross-process live invalidation,
preview-before-download support, HTTP mutation refusal, inert hostile markup,
metadata redaction, safe corruption errors and bounded keyset pagination. The
same suite runs in dedicated Ubuntu and macOS Chromium CI jobs.

```bash
cd packages/tasq-inspector
bun test
pnpm test:browser
```

### 12. Public site tests (`apps/site/`)

**Question**: *Can an unfamiliar human or agent learn the real product without
marketing drift, private data or an invented release path?*

The generator validates three canonical machine contracts and writes identical
application and public JSON snapshots with source digests. Bun tests reject
stale truth, absent-surface entrypoints, unpublished install claims, API/Console
coupling and ambient clock reads. The optimized Next.js static export must
produce every consumer route. Playwright checks the homepage, documentation,
machine status endpoint and 390px responsive path in a dedicated CI job.

```bash
pnpm --filter @tasq-internal/site test
pnpm --filter @tasq-internal/site test:browser
```

### 13. Evals (`packages/tasq-evals/`)

**Question** : *Is the agent's experience good?*

Not unit/integration tests. **Scenarios** that simulate full agent sessions and assert on the kind of state and outputs the agent observes.

- `hermes-daily-brief.test.ts` — morning brief flow with a realistic seed (11 areas-style state), priority ranking, evening completion via observed watcher signal, area-scoped review, audit attribution
- `prioritizer-quality.test.ts` — realistic side-by-side comparisons (overdue vs scary-avoided, high-leverage vs fresh-low-priority, blocked discount, in-progress zero-avoidance, reason traces)
- `markdown-snapshot.test.ts` — comprehensive board renders correctly, empty DB doesn't crash, area-with-only-closed-tasks hidden from active, status icons stay stable across runs
- service `agentic.test.ts` — exclusive lease races, fencing, retry idempotence, immutable attempts/evidence, claim-aware next, deletion cleanup, evidence-backed completion, raw-SQL guard enforcement and `doctor` detection after simulated guard removal
- eval `agentic-resilience.test.ts` — assertion/evidence agent journeys through lost responses, worker crash, lease takeover, stale retries, orphan-attempt reconciliation and duplicate terminal callbacks
- eval `outbox-drain-recovery.test.ts` — two generic replacement-agent journeys
  prove effect-before-ack deduplication, strict poison blocking and explicit
  repair under a controlled clock
- eval `universal-kernel-acceptance.test.ts` — UK-011 runs two package-independent
  MCP/A2A subprocesses against a discovered unfamiliar extension, loses their
  in-memory continuity, resumes through an exclusive event cursor and proves
  the complete SQLite schema fingerprint never changes
- eval `life-filesystem-loop.test.ts` — DB-free read-only adapter, deterministic
  filesystem fact, duplicate replay, typed reconciliation, explicit
  evidence-backed completion, injected clock and unchanged source artifact
- eval `machine-onboarding.test.ts` — a package-independent subprocess starts
  with only a discovery document and schemas, verifies every canonical digest,
  constructs a strict hello and negotiates the exact compatible subset
- service `context-packet.test.ts` plus CLI/MCP scenarios — exact bounded
  context accounting, reasons, omissions, large-ledger scan bounds and clock
  injection across all shipped surfaces
- eval `external-context-links.test.ts` — one external runbook/method identity
  is reused by several commitments without becoming a task, artifact, evidence
  or memory body; floating pointers and concurrent append/detach stay explicit
- eval `protocol-interoperability.test.ts` — MCP and A2A successes become two
  attempts and digest-bound artifacts while the commitment remains open until
  a separate coordinator binds evidence and explicitly completes it
- eval `effect-authority-adversarial.test.ts` — one generic protected-write
  boundary survives money, communication, filesystem and deployment mutation,
  approval races, crash recovery, receipt attacks, workspace isolation and a
  controlled-clock production scan
- eval `connector-conformance.test.ts` — the real DB-free filesystem watcher
  passes the universal observation profile/replay/conflict checks using an
  explicit clock snapshot while its source artifact remains byte-identical
- eval `reference-connectors.test.ts` — the TQ-306 work-item reader and effect
  connector compose with an unmodified minimal kernel; exact retry performs one
  provider write, a verified receipt becomes evidence, and the commitment stays
  open pending a separate completion decision
- eval `surface-compatibility.test.ts` — TQ-307 drives one commitment through
  the real CLI, official MCP client and A2A adapter over one SQLite ledger;
  replay reuses the remote attempt/artifact, the lease is released explicitly,
  and only a separate evidence-bound CLI decision completes the commitment
- eval `runtime-reconciliation-recipes.test.ts` — TQ-304 executes
  Temporal/Restate/LangGraph-shaped lifecycles through the same MCP contract
  without importing their SDKs; stable attempt identity, suspension/resume,
  retry idempotency, injected time and zero implicit completion are asserted
- eval `delivery-crash-recovery.test.ts` — TQ-401 closes the process immediately
  after a robot commitment commits, then proves a replacement process sees the
  same commitment/event and its pending sink delivery under injected time
- service `idempotency.test.ts` — TQ-403 proves caller/operation isolation,
  lost-response CAS replay, conflict rejection, inspectable outcomes and exact
  injected retention boundaries
- eval `durable-idempotency-recovery.test.ts` — two unrelated runtimes reuse a
  local key safely, one recovers a lost mutable response, and durable protocol
  identity survives explicit pruning under a mutable clock
- eval `replica-conflict-contract.test.ts` — TQ-404's pre-implementation oracle
  freezes same-base offline conflict behavior, same-dot corruption failure,
  tombstone resurrection defense and typed cursor expiry without clock-based
  ordering
- service `replication.test.ts` — TQ-405 replaces that oracle with independent
  SQLite stores and proves atomic capture/apply rollback, lost-response retry
  identity, authenticated pull, clock-independent conflicts, independently
  verified snapshot pages, safe rebase, retired tombstones, discovery honesty,
  authority-regression refusal and injected-clock cursor retention
- eval `sync-chaos-recovery.test.ts` — TQ-406 kills independent processes after
  local operation, authority accept, local ack, snapshot install, recovery
  rotation and outbox intent/lease/external-effect/ack commits; reopened SQLite stores prove
  exact retry, hostile-order rejection, visible offline conflict, injected
  cursor expiry and fresh-generation old-backup failover
- eval `cold-start-configuration-matrix.test.ts` — TQ-316 builds the real CLI
  artifact, moves it outside the repository and runs it with a scrubbed
  environment through absolute and PATH invocation. Python, Node and POSIX+jq
  clients execute discovered argv unchanged across spaces/non-ASCII paths,
  locales and shell metacharacters; rendezvous/isolation, additive v1 fields,
  unknown-version refusal, bounded output and pre-state typed failures are
  asserted. No fixture may replace the returned executable.
- the same eval's TQ-317 section greedily generates a deterministic all-pairs
  matrix across independent client, invocation, locale, capability profile,
  initial ledger state, hostile cwd, actor boundary and space boundary. It
  also continues through raw MCP and rejects corrupt storage, unsafe modes,
  truncated/unknown/malformed contracts. GitHub Actions executes this built
  artifact gate on Linux and macOS from a frozen filtered install.
- eval `cold-start-configuration-matrix.test.ts` — TQ-316 through TQ-319 make operation
  selection observable instead of handing deterministic clients a recipe ID.
  Python, Node and POSIX+jq select by advertised mutation/output/input metadata;
  a raw MCP client selects by annotations, description and input schema.
  Unknown CLI and MCP actors contend over the same ledger in both directions,
  additive/reordered contracts remain usable, mutation-without-read profiles
  fail before storage, and caller-defined context bounds run without argv
  reconstruction. The content-addressed blind runner adds Codex, Claude Code
  and OpenCode under pointer-only natural-language intent.
- eval `hosted-tenancy-design.test.ts` — ADR-004/TQ-505 distinguishes the
  integration-required read handler from future remote surfaces, freezes the
  six trust layers, three identity
  classes, hostile cross-workspace/revocation/delegation/key/clock scenarios,
  non-compensable failures and state-based release evidence. It validates a
  design matrix, not a hosted implementation certificate.
- eval `hosted-authority-foundation.test.ts` — TQ-801 independently composes
  browser-human, delegated headless-agent and SPIFFE connector-service inputs
  through the pure guard; it checks transport normalization parity,
  issuer/workspace isolation, live revocation, privilege separation and a
  freeze/advance/rewind injected-clock matrix.
- eval `hosted-authority-store-router.test.ts` — TQ-802 races two independent
  cold migrators, restarts the authority store, routes one robotics workspace
  only through its opaque host binding, then revokes/restarts and proves the
  decoy ledger was never opened.
- eval `hosted-read-rest.test.ts` — TQ-803 independently composes a protected
  resource under a non-root path, verified agent identity, fresh authority
  store and opaque robotics ledger, then proves discovery, isolation,
  payload-free reads and immediate revocation.
- eval `hosted-mutation-rest.test.ts` — TQ-804 lets a clean client select a
  registered operation by action identity, commits it once, closes/reopens the
  domain store, recovers the exact result and then observes live revocation.
- eval `product-consumption-design.test.ts` — TQ-601 freezes the four product
  shapes, the closed support vocabulary and consumer inputs. TQ-604 extends
  the claims guard with a candidate-only public install lifecycle while REST,
  remote MCP and self-host lifecycle remain explicitly absent. The machine
  certificate cannot claim published-byte completion before a release exists.
- eval `public-adoption.test.ts` — TQ-606 installs a real candidate outside the
  checkout, then sends a human-shell proxy and a package-independent Node agent
  from the public adoption contract through semantic recipe selection,
  contention, higher-fence recovery, evidence completion and same-ledger
  installed Console inspection. The harness and clients contain no Tasq import
  or device-clock read; published bytes and a real blind human remain external.
- eval `public-roadmap.test.ts` — freezes the canonical public execution order,
  closed task states, dependency closure, the machine-tracked TQ-607 dogfood
  gate, npm/publication blockers, remote non-claims and the authority/clock
  invariants every future checkpoint keeps.
- eval `documentation-contract.test.ts` — verifies relative documentation
  links, workspace READMEs, canonical root commands, onboarding/release
  guardrails and public/private package metadata.

See `packages/tasq-evals/README.md` for the rationale of evals vs tests.

Run :
```bash
cd packages/tasq-evals && bun test
```

## Running everything

```bash
# From the canonical repository root
pnpm docs:check
pnpm typecheck
pnpm test

# Required additionally for Console or site UI changes
pnpm --filter @tasq/console test:browser
pnpm --filter @tasq-internal/site test:browser
```

## What's NOT tested (intentionally)

- **Bun runtime itself** — we assume `bun test` works
- **drizzle-orm query correctness** — we use a small subset and trust the library
- **Platform-specific ACLs beyond POSIX modes** — POSIX 0700/0600 behavior is checked by `tasq doctor`.

## Adding a test for new code

| You added... | Add a test in... |
|---|---|
| A Zod schema or enum | `packages/tasq-schema/test/types.test.ts` |
| An id-related function | `packages/tasq-schema/test/ids.test.ts` |
| A generic extension runtime primitive | `packages/tasq-extension-sdk/test/` |
| A connector profile, failure or behavioral check | `packages/tasq-extension-sdk/test/` plus one real `packages/tasq-evals/` adapter scenario |
| A concrete provider connector | its package test through the conformance suite plus one `packages/tasq-evals/` kernel scenario |
| A bundled planning policy or projection | `packages/tasq-life-planning-profile/test/` |
| A provider schema, route or evaluator | `packages/tasq-reference-extension/test/` |
| A new service function | `packages/tasq-service/test/` (existing file or new) |
| A new status transition rule | `packages/tasq-service/test/state-machines.test.ts` |
| A new CLI command | `packages/tasq-cli/test/e2e.test.ts` |
| A new inspector route or view | `packages/tasq-inspector/test/` plus `browser/*.pw.ts` |
| A public-site claim or consumer journey | `apps/site/test/` plus `apps/site/browser/` |
| A hosted identity, authorization or route slice | `packages/tasq-evals/hosted-tenancy-design.test.ts` plus the real adapter's cross-workspace, revocation, rotation, surface-parity and injected-clock tests |
| A product shape, consumption path or public support claim | `../concepts/PRODUCT_SURFACE_MATRIX.json`, its spec and `packages/tasq-evals/product-consumption-design.test.ts` |
| A new agent-facing capability | `packages/tasq-evals/` (new `*.test.ts` file) |

## What "100% functional" means here

“100% functional” means the public behaviors and high-risk invariants have executable evidence, not that a line-count ratio reached a magic number. If you ship new behavior without a test, it has not earned its place.
