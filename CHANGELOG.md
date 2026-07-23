# Changelog

Tasq has not made a public release. Historical implementation checkpoints are
recorded in [`docs/roadmap/BACKLOG.md`](docs/roadmap/BACKLOG.md); this file begins the public release history selected
by ADR-008.

## Unreleased

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
