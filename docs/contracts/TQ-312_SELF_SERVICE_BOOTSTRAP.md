# TQ-312 — Neutral self-service bootstrap

**Status:** Implemented and executable — 2026-07-19  
**Depends on:** the completed TQ-311 autonomous-onboarding acceptance gate;
its private trial transcript was not exported to the standalone repository

**Next:** TQ-313 generic resource leases and one-shot fence verification

## Outcome

A shell actor with no Tasq state can now create or join an explicit shared
coordination context with one command:

```bash
tasq onboard --space robotics/team-a --actor agent:planner --json
```

The command creates `~/.tasq/db.sqlite` and runs migrations when needed, but it
does not create or rewrite global config and does not provision the bundled
reference-domain extension. Its strict response says whether the
space was `created` or `joined`, identifies the actor and trust boundary,
embeds `tasq.discovery.v1`, and returns executable command recipes as argument
arrays. Repeating the exact command is idempotent.

This is a new zero-integrator surface. `tasq init` remains the historical local
configuration command, but it no longer detects `~/Code/_life` or chooses a
projection based on device layout.

## First-principles decisions

### Space is durable state, not an inference

Migration `0020_coordination_space.sql` adds one immutable row per explicit
workspace. An empty space therefore exists independently of tasks, extensions,
the current directory or a mutable config default. The creator is a stable
principal and creation time comes from the injected authority clock.

Create-or-join uses two idempotent inserts rather than one deferred SQLite
transaction. This avoids cross-process read-to-write upgrade deadlocks. A kill
between inserts may leave a harmless principal but never a space without its
foreign-key-bound creator; a retry converges. Concurrent first joiners elect
exactly one creator and all return the same immutable space record.

### Context and identity are explicit

`--space` is required and accepts a bounded shell-safe identifier. Tasq does
not guess it from a repository or directory, because unrelated teams can share
a filesystem. `--actor` or `TASQ_ACTOR` is also required. Tasq does not hash the
cwd or silently use a personal default, because two agents in the same
directory would then become the same actor.

The returned authentication value is
`local_process_self_asserted`. It is attribution, not authentication. Remote
identity remains a transport responsibility.

### Recipes are executable data, not prose

Every recipe item in the versioned bootstrap envelope contains:

- a stable ID and version;
- a `read`, `propose` or `coordinate` group;
- whether it mutates;
- an `argvTemplate` array with explicit `--tenant`, `--actor` and `--json`;
- a one-to-one declaration for every placeholder; and
- the expected output contract.

Clients replace declared whole-argument placeholders and execute the result as
an argv vector. The first argument is the actual executable that produced the
bootstrap document, so an absolute pointer remains usable even when no bare
`tasq` name exists in `PATH`; clients must not rewrite it. They never need to
parse a shell string or quote values. The
initial recipes cover discovery, commitment listing/inspection/proposal,
ordered audit, commitment claims/releases and evidence.

`--capabilities read` (or a comma-separated subset) filters the recipes. This
is honest ergonomics, not access control: the response explicitly says
`capabilityEnforcement: none`. The local process has the same OS access as its
caller. No effect recipe is returned and `effectAuthority` is always
`not_granted`.

## Contracts

Success is `tasq.autonomous-bootstrap.v1` with exact top-level fields:

```text
contractVersion, disposition, space, actor, transportBoundary, authority,
recipeCapabilities, guide, discovery, recipes, warnings
```

`guide` is the additive `tasq.bootstrap-guide.v1` cold-start index. It states
the exact argv execution policy, marks argv[0] as directly executable even
with a `.js` suffix, forbids `node`/`bun` wrappers, names the first bounded read
and advertises only journeys whose constituent recipes are present. `context.read.bounded`
accepts caller-selected record and token ceilings without requiring a cold
client to reconstruct a command. A mutating autonomous capability profile must
also include `read`; `propose` or `coordinate` alone fails before storage.

Bootstrap failures requested with `--json` are
`tasq.autonomous-bootstrap-problem.v1` and exit non-zero. They include a stable
code (`invalid_input`, `config_error`, `storage_error` or `unavailable`), a
retryability decision and argv next actions. Existing CLI v1 commands preserve
their historical stderr error contract.

The public Zod schemas live in `@tasq-run/schema/bootstrap`; embedded callers
use `bootstrapCoordinationSpace` and `getCoordinationSpace` from the strict
kernel or full service entrypoint. Discovery advertises the implemented
`spaces` capability.

## Clock and trust invariants

- The space service requires an explicit `Clock` and snapshots it once.
- No device clock, filesystem timestamp or client-provided occurrence time can
  decide space identity or the creation race.
- The CLI is only a composition root and injects `systemClock`; tests inject a
  mutable clock into the service.
- Discovery capabilities describe installed implementation, not actor grants.
- Bootstrap never grants effect authority or remote authentication.
- Every returned recipe carries the exact selected space and actor, so later
  config changes cannot silently redirect it.
- Local peers meet only when they use the same store/transport and exact space;
  bootstrap states this irreducible rendezvous boundary instead of implying
  that an identical string bridges isolated homes.

## Executable evidence

The suites prove:

- schema bounds, recipe placeholder integrity, no capability over-return and
  typed problem shapes;
- controlled-clock create/join, immutable space identity and exact retry;
- a real two-connection first-create race with one creator and one joiner;
- empty-HOME CLI creation, retry, recipe execution and tenant isolation;
- read-only recipe filtering with an explicit non-enforcement warning;
- typed missing-identity, unsafe-space, bad-capability and unknown-flag errors;
- a real competing cold-process race; and
- absence of `_life` projection auto-detection.
- absence of bundled Gmail/GitHub/Mercury vocabulary even when the explicit
  space happens to equal the historical default name.

The universal compatibility inventory classifies the new table, command,
record and envelopes, so future drift fails CI.

## Boundary at TQ-312 completion (now closed)

TQ-312 made onboarding autonomous but did not yet make arbitrary resources
first-class. TQ-313 subsequently added opaque resource keys, typed contention,
world inspection and one-shot fence verification without fake tasks. TQ-314
then ran the cross-language, permission, clock, race, response-loss and crash
matrix; TQ-315/TQ-316/TQ-317 closed the blind-agent, release-artifact and
supported-platform certification gates.
