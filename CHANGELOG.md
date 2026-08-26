# Changelog

Public releases are listed below, newest first. Each entry links to its GitHub
release, which carries the exact artifacts, checksums and attestations.
Pre-release implementation checkpoints are recorded in
[`docs/roadmap/BACKLOG.md`](docs/roadmap/BACKLOG.md); this file is the public
release history selected by ADR-008.

## Unreleased

### Added

- `tasq_discovery_capture` on the MCP surface, under the `propose` capability.
  An agent working over MCP could not report a bug, a missing capability or an
  inconsistency at all: the flagship integration exposed 44 tools and none of
  them recorded a finding. Capturing never widens, renews or releases the
  caller's claim, so it is safe mid-task. See
  [ADR-020](docs/decisions/ADR-020_KERNEL_DISCOVERY_CAPTURE.md).
- `captureCommitmentDiscovery` exported from `@tasq-run/core`. The relation
  table and the `discovered_from` type were already kernel, but no kernel API
  wrote a relation of any type, so this closes a gap rather than widening the
  ontology. The CLI behaviour and its tests are unchanged, which is the
  evidence that this is a move rather than a redesign.

## v0.4.2 - 2026-08-26

### Added

- A release preflight refuses a tag while any version-pinned policy block
  still names an older release. Publishing v0.4.0 left several blocks naming
  v0.4.0, and each only failed when the next release reached it; the one that
  escaped review could not be fixed afterwards, because the certification
  workflow reads the policy from the immutable tagged commit. That is why
  v0.4.1 shipped byte-verified but only partially certified.
- ADR-020 proposes discovery capture as a kernel operation reachable from
  every agent surface. The relation table is already kernel storage and
  `discovered_from` is already a first-party relation type, but no kernel API
  writes a relation, so MCP clients cannot report a defect at all.

### Changed

- No product behaviour changes from v0.4.1. This release exists so the
  published line ends on a version whose certification is complete rather
  than partial. Store format 32 is unchanged.

## v0.4.1 - 2026-08-25

### Changed

- **Behaviour change.** A terminal transition (`done`, `cancel`) by an actor
  other than the one holding an active claim is now refused, naming the holder
  and the expiry. Previously the exclusivity guard existed on `claim` and
  `attempt` but not on completion, so a third actor could close a claimed task
  and silently force-release the holder's claim at the decisive moment. Expiry
  still ends ownership, and `--force` records a deliberate takeover, exactly
  like `release --force`. Unclaimed tasks are unaffected.
- **Behaviour change.** An explicit task `--priority` now replaces the
  importance inherited from its area or goal, in both directions. Importance
  previously acted as a floor, so `priority` could only raise it: every task in
  an important area scored identically and `tasq next` silently degraded to
  creation order. Tasks with no explicit priority are unaffected and still
  inherit importance. Existing ledgers will see `tasq next` reorder where a
  deliberately low priority was being discarded.
- `tasq doctor` no longer reports healthy ledgers as missing completion
  records. The check required a receipt whose revision equalled the task's
  CURRENT revision, so any edit after closing orphaned it: on a real ledger all
  twelve findings were false positives. It now requires one receipt per
  completion, which still catches a reopen and re-close that produced none.
- Under `--json`, every non-zero exit now writes a `tasq.command-problem.v1`
  envelope to stdout alongside the existing stderr message, so an agent-driven
  caller can act on a refusal instead of receiving an empty machine channel.
  See [`docs/reference/CLI_JSON_CONTRACT.md`](docs/reference/CLI_JSON_CONTRACT.md).
- Per-command help (`tasq help <cmd>` and `tasq <cmd> --help`) now lists the
  flags accepted by every command, including `--actor`. Argument-error output
  is unchanged.

### Added

- `tasq mcp --completion assertion|evidence` sets the completion policy for
  commitments that MCP server creates when the caller states none, and
  `tasq agent install` now registers `--completion evidence`. Work an agent
  proposes through the documented integration therefore states what done looks
  like and closes only against an inspectable receipt. An explicit
  `completionPolicy` on the call always wins, and creating an evidence-backed
  commitment without `successCriteria` is refused rather than silently
  downgraded.
- `tasq list --priority 1-5` and `tasq next --priority 1-5` filter by explicit
  priority. Filtering happens in the query rather than after the limit, so a
  match beyond the limit is never hidden.
- `tasq evidence add` prints a note when the filing actor differs from the
  actor holding the active claim, naming the `--actor` value that would
  attribute the receipt to the holder.

## v0.4.0 - 2026-08-11

### Changed


- Use the controlled product-aligned `@tasq-run/*` namespace for every public
  package, workspace import, release artifact and SBOM identity; explicitly
  prohibit the unrelated `tasq` package and `@tasq/*` scope.
- Make `https://tasq.run` the canonical public website, documentation and
  pre-executable agent-acquisition entrypoint while retaining
  `https://github.com/gwendall/tasq` as the source authority.

### Fixed

- Keep the autonomous onboarding `audit.list` recipe unfiltered across the
  workspace. `event list --actor` is an event-producer filter, so the recipe
  now omits it and preserves lossless multi-actor cursor resume.

### Added

- Add private directory-scoped space selection with `tasq use`, preserving
  explicit flag/environment precedence and the operator's global defaults.
- Add digest-bound `tasq agent instructions` generation with idempotent atomic
  writes, hand-edit protection and distinct CI exits for missing, stale and
  modified blocks.
- Add offline-first `tasq feedback` capture with secret-free failure context,
  bounded private storage and explicit idempotence-marked GitHub batch push.
- Add a revision-guarded, atomic TQ-607 dogfood tracker for baselines, active
  use, consumer journeys, resilience drills, friction, critical failures and
  the final `go`, `extend` or `no_go` decision.
- Add machine-readable coding-agent preflight, one-command handoff verification,
  a documentation map, an executable onboarding eval and a safety-focused pull
  request template.
- Add a concise standalone `SKILL.md` that delegates exact agent workflows to
  the versioned `tasq onboard` guide and remove installed-help references to
  repository files that may not exist beside the executable.
- Make `packages/tasq-core` the single neutral source authority, replace the
  Local compatibility mirror with forwarding modules and build the public
  `@tasq-run/core` candidate from its real source directory.
- Add TQ-607, a machine-tracked private dogfood gate requiring at least 30
  days across the personal life-pilot, Kami Robotics and an interactive agent
  runtime before an explicit public-launch decision.
- Add standalone human/agent development onboarding, audience routing and a
  local README for every workspace, plus an executable documentation contract
  that rejects broken links, stale checkout commands, missing ownership docs
  and public/private package-metadata drift.
- Add canonical human and machine-readable public backlogs so a fresh human or
  agent can distinguish the next executable checkpoint, external publication
  gates and unimplemented remote products without private-repository context.
- Add a deterministic target release installer with side-by-side versions,
  atomic activation and data-preserving uninstall, plus a clean-room lifecycle
  certificate covering onboarding, contention, Console, backup, upgrade and
  matching snapshot/binary restore.
- Add transport-neutral bounded Console overview, work, actor, claim,
  resource, wait, effect, redacted audit and honest operational-health read
  contracts with workspace-bound keyset cursors and injected authority time.
- Add loopback polling and SSE over one redacted Console event-batch contract,
  with exclusive reconnect, typed cursor recovery, one-frame backpressure,
  deterministic overflow fallback and injected time/scheduling.
- Add the responsive, keyboard-accessible Local operator Console with seven
  canonical views, bounded filters, explicit live/stale states, audit timeline
  and preview-before-download redacted support bundles.
- Add installed Local Console lifecycle contracts: a versioned foreground
  listener announcement, proof-of-life `web status`, private crash-safe
  registration and full standalone/npm candidate upgrade coverage without
  checkout-relative assets or install-created listeners.
- Add a statically exportable Next.js public product and documentation app
  with consumer-specific guides, machine-derived support status, exact
  `/product-truth.json`, synthetic-only visuals and adversarial browser gates.
- Add the fail-closed `/adopt.json` pre-executable contract and a candidate
  human-plus-agent adoption certificate covering installed-byte onboarding,
  typed contention/recovery and same-ledger Console inspection.
- Add cross-platform Local Console browser certification for empty, mature,
  hostile, corrupt and 2,501-commitment ledgers using fixed injected time,
  bounded pages, safe errors and real Chromium on Linux and macOS.
- Add the pure hosted-authority foundation: strict verified identity, binding,
  grant, delegation and decision contracts; 16 digest-bound actions; and a
  deny-by-default injected-clock evaluator with clean-room client evals.
- Add the durable hosted-authority control plane with checksum-pinned
  migrations, CAS/idempotent lifecycle writes, append-only decisions/audit and
  a host-configured opaque router that opens no foreign ledger before allow.
- Add a host-integrated authenticated read-only REST handler with RFC 9728
  discovery, strict verifier and live-authority boundaries, bounded commitment
  reads, payload-free event metadata and one injected clock snapshot per
  request.
- Add registered guarded mutation REST with a state-free operation catalog,
  mandatory caller-scoped durable idempotency, live revocation serialization,
  bounded portable envelopes and exact recovery for unknown cross-database
  commit outcomes.

### Security

- Upgrade `drizzle-orm` to 0.45.2 for corrected SQL identifier escaping. Public
  package manifests now derive external dependency versions from their source
  manifests, and wrapped driver errors retain safe contention classification.

## v0.3.0 — 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.3.0) · store format 26

### Added

- Opt-in independent completion resolution across Core, embedded client, CLI,
  local MCP and Console: frozen policies, proposals, challenges and explicit
  decisions. Validated tasks can no longer be completed by evidence alone.
- Append-only evidence trust, proposal, challenge and validation records.

## v0.2.0 — 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.2.0)

### Added

- `createLocalTasq`, the embedded TypeScript client, published as compiled ESM
  with declarations and certified on Node 22 and Bun.

## v0.1.1 — 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.1.1)

### Added

- Public acquisition and universal-agent entrypoints: the versioned installer,
  `setup`, `demo` and the deterministic `agent install` helper.

### Changed

- Made the public adoption examples executable rather than illustrative.

## v0.1.0 — 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.1.0) · first public alpha

### Added

- First published `@tasq-run/*` packages and checksummed native assets for
  macOS arm64 and Linux x64, built from protected GitHub Actions OIDC with npm
  provenance.
