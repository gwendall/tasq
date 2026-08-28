# Changelog

Public releases are listed below, newest first. Each entry links to its GitHub
release, which carries the exact artifacts, checksums and attestations.
Pre-release implementation checkpoints are recorded in
[`docs/roadmap/BACKLOG.md`](docs/roadmap/BACKLOG.md); this file is the public
release history selected by ADR-008.

## Unreleased

## v0.6.0 - 2026-08-28

Store format 34. Every 0.5.x store migrates forward once, irreversibly, and
`tasq store upgrade` makes that a decision rather than a side effect.

This release closes the half of the product that was named and missing.
[ADR-022](docs/decisions/ADR-022_WHAT_TASQ_IS.md) states that Tasq is the claim
ledger with a live human surface; `tasq fleet` is the first of that surface.
[ADR-024](docs/decisions/ADR-024_THE_DEFAULT_DOOR.md) makes the CLI the default
door for a local agent, and the recipe set now carries everything the MCP tool
set does, so choosing the default is not a downgrade.

### Added

- **`tasq fleet`.** Who is holding what, right now. The expiring lease is what
  makes this possible without owning any process: a holder that dies stops
  appearing when its claim lapses. Live claims are grouped by client identity
  AND working directory, because one label on two machines is not one worker.
- **`tasq whoami`.** The actor, the principal it resolves to, this
  installation's device key, and any OTHER device that has written under the
  same actor label here. It authenticates nobody and says so, in the prose and
  in the JSON contract: an identity printed without what it proves reads as
  authentication.
- **Device identity.** Each installation gets an Ed25519 key it did not choose,
  written `0600` on first `setup`. Every domain mutation records the device
  behind it. The principal is derived from (space, alias), so two machines
  using one label were ONE principal and the ledger merged them without a word;
  on a shared store that silence is the whole problem, and it cannot be
  reconstructed after the fact.
- **Decomposition in the kernel.** `tasq add --parent`, `tasq tree`,
  `parentCommitmentId` on MCP create, and `tasq_commitment_tree`. Decomposition
  answers what a commitment is MADE OF; it is a column, not a relation, and it
  gates nothing. See
  [ADR-023](docs/decisions/ADR-023_DECOMPOSITION_IS_A_COLUMN.md).
- **Relations over MCP.** `tasq_relation_add`, `tasq_relation_end` and
  `tasq_relation_list` serve the capability the server already advertised and
  never implemented.
- **Four argv recipes** for decomposition and relations, and a
  `decompose-and-sequence` journey, so an agent on the CLI can discover what an
  agent on MCP can.
- **What a completion just opened.** Finishing a commitment reports the work it
  unblocked, so the next agent does not have to poll for it.

### Changed

- **`tasq setup` is one command.** Bringing Tasq into a project took three -
  `setup`, `use`, `agent instructions --write` - and `setup` mentioned neither
  of the other two. It now joins the space, binds this directory and its
  descendants, writes the managed AGENTS.md block, and says which of the three
  it did. `--no-bind` and `--no-instructions` skip either half. It refuses to
  set a project up in the home directory or at the filesystem root.
- **The first run teaches the agent path.** It printed `add`, `list`, `done` -
  a single-player todo app, under a headline promising a tracker you share with
  your agents. It now points at `tasq fleet` and `tasq demo`.
- `RELATION_TYPES` drops `parent_of` and `supersedes`. Nothing ever wrote
  either, and two ways to say one thing is how a ledger starts disagreeing with
  itself.

### Fixed

- **A space bound to another project is refused**, naming the directory that
  owns it. Inheriting a space silently is how work lands in somebody else's
  ledger.
- **Claiming a commitment with unresolved blockers is refused**, naming them,
  with `--force` for a deliberate override.
- `tasq_discovery_capture` on the MCP surface, under the `propose` capability.
  An agent working over MCP could not report a bug, a missing capability or an
  inconsistency at all. Capturing never widens, renews or releases the caller's
  claim, so it is safe mid-task. See
  [ADR-020](docs/decisions/ADR-020_KERNEL_DISCOVERY_CAPTURE.md).
- `captureCommitmentDiscovery` exported from `@tasq-run/core`.

### Release machinery

Three checks in this repository were measuring themselves against the thing
they were checking. Each is now measured against something outside it, because
that is the only difference between a check and a claim.

- **The publication record** answered `ok: true` while it named a release one
  version behind reality and the documented installer 404'd. It is now measured
  against the newest release tag, which the commit that gets it wrong cannot
  edit. A tag that published nothing must be recorded in
  `policy.retiredReleases` with a reason - v0.5.0 is the first entry.
- **That gate had never run against this repository.** Every case built its own
  tree, so it was fully covered and never looked at the thing it protects.
- **`pnpm verify:release-rehearsal`** builds a real installable release from the
  working commit and runs every replay the certification job runs, before a tag
  exists. The last two releases were each broken by something only observable
  after tagging, and tag protection means a version number does not come back.
- **The certification replay** proves the refusal first, then upgrades through
  `tasq store upgrade`. v0.5.1's own consent gate correctly refused to migrate
  unasked, and the test was describing behaviour that release removed.
- **Every package's tests typecheck**, and the debt list is empty. A test could
  call an API that does not exist and pass; 66 errors were hiding there,
  including six input types published as parsed types, a type no value could
  satisfy, a fixture missing five fields, and four more silently dropped keys.

## v0.5.1 - 2026-08-27

Store format 33. Every 0.4.x store migrates forward once, irreversibly, and
`tasq store upgrade` makes that a decision rather than a side effect of any
command.

`v0.5.0` is retired and published nothing: its tag failed at the first job
because the release preflight had begun importing `@tasq-run/core`, which the
identity job cannot resolve since it deliberately runs before `pnpm install`.
Tag protection correctly refuses to delete an immutable tag, so the version is
retired rather than reused.

### Added

- **Shared assumptions.** One immutable sentence that work rests on, shared by
  every commitment that depends on it and matched by its normalised text, so two
  agents phrasing the same belief differently land on one record. Withdrawing it
  pauses the open commitments resting on it. Three limits are load-bearing and
  tested: **one hop** - the effect never traverses `depends_on` or `parent_of`;
  **never terminal** - paused, never cancelled, and `tasq resume` recovers;
  **never required** - a commitment with no assumption behaves exactly as
  before. `tasq add --because`, `wrong`, `why`, `resume`, `because list|attach`,
  and four MCP tools. See
  [ADR-021](docs/decisions/ADR-021_SHARED_ASSUMPTIONS.md).
- **A store safety envelope.** `tasq store status`, `upgrade`,
  `recovery-points`, `restore` and `clone`. The rollback rule
  `restore-matching-verified-pre-migration-snapshot-and-binary` was named in
  three places in the release policy and had no command behind it; now it has
  one, refusing a snapshot whose bytes no longer hash to its receipt and
  refusing to discard work written after a recovery point unless forced.
  `tasq store clone` uses `VACUUM INTO` and rewrites every path inside the
  clone, because copying `db.sqlite` by hand is wrong twice: wrong paths, and
  silently empty when the content is still in the WAL.

### Changed

- Crossing a store format is a decision on **every** build, not only on
  unreleased ones. Tasq is a shared ledger, so two machines on one store with
  different versions means whoever runs first silently locks the others out.
  `tasq store upgrade` is the consent: typing the verb is the decision, so there
  is no prompt to script around and no flag to set blindly.
- A diagnosis no longer mutates what it diagnoses. `tasq doctor` inspects the
  store format first and stops with an actionable report instead of applying an
  irreversible upgrade.
- Claiming a commitment with unresolved blockers is refused, naming them, with
  `--force` for a deliberate override. Blocking previously lived in the
  prioritizer alone, so a blocked commitment could be claimed, started and
  completed by asking for it directly.

### Fixed

- `TASQ_HOME` can no longer be overridden by an absolute `dbPath` in the config
  it loads. Copying a Tasq home to rehearse a migration on it drove the
  original instead, which cost this project's own ledger a store-format
  migration under a binary the operator never intended to run there.

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
