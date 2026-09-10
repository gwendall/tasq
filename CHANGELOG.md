# Changelog

Public releases are listed below, newest first. Each entry links to its GitHub
release, which carries the exact artifacts, checksums and attestations.
Pre-release implementation checkpoints are recorded in
[`docs/roadmap/BACKLOG.md`](docs/roadmap/BACKLOG.md); this file is the public
release history selected by ADR-008.

## Unreleased

## v0.6.8 - 2026-09-10

The CLI refused --space, the word its own setup command, guides and agent contract teach, on every command of the loop those documents describe next; a missing required flag answered with a raw schema dump; and a flag value beginning with a dash was silently dropped.

### Fixed

- **The documented loop refused the word the documents teach.** `tasq setup`
  and `tasq onboard` take `--space`, and so does every guide, contract and
  AGENTS.md block. The next line those same instructions tell a new user to run
  answered `Unknown flag: --space`: `claim`, `attempt`, `evidence`, `done`,
  `whoami`, `add` and `list` read `--tenant` only. The two are one flag now,
  whichever a command reads, and passing both with different values is refused
  rather than resolved to a guess about whose ledger to write to. `onboard`
  still teaches `--space` alone.
- **A flag value that begins with a dash was silently dropped.** Any token
  starting with `-` was taken for the next flag, so `--summary "--space is
  refused everywhere"` set `--summary` to true and then reported the sentence
  itself as an unknown flag. Filing evidence about a flag is exactly where that
  bites. A flag is one word; a sentence is not, and is now read as the value.
- **A missing required flag answered with a raw schema dump.** A first
  `tasq agent install claude-code` printed a zod `invalid_type` array that
  named neither the flag that was missing nor the command that wanted it. It
  now names the flag and the usage line, on `agent install`, `agent
  instructions`, `mcp` and `web`.
- **The npm publish job was cancelled mid-release.** Its 20 minute budget had
  to cover install, build, attestation and then a serial publish loop that
  waits for the registry to serve each package as `latest` before starting the
  next one. npm took over two minutes on one package during v0.6.7, the job
  hit its timeout with a package still unpublished, and the GitHub release was
  skipped. The budget now covers the whole loop.

## v0.6.7 - 2026-09-10

Fixes found by installing 0.6.6 from the public installer and using it as a new adopter: the MCP handshake reported the wrong version, mcp refused --space, agent install refused its own contract's host id, backup wrote a database into a mistyped subcommand, and an unknown command named nothing to try.

### Fixed

- **`tasq backup list` wrote a 1.4 MB database into a file named `list`.**
  Every other noun in this CLI takes `list`, so that is what a new user types;
  `backup` takes a bare path, so it took the word as the path, wrote the file
  into whatever directory they were standing in, and reported success. A
  backup nobody asked for, in a repository somebody may commit. A target that
  is really a mistyped subcommand is now refused, and `--target list` or
  `./list` still means the file.
- **An unknown command named nothing to try.** `unknown command: tasks` and
  `run tasq help for usage` is not something a first-time user can act on, and
  `tasks`, `claime` and `evidenc` are exactly what someone types before
  reading the help. The nearest command is now suggested when there is an
  obvious one, and nothing is guessed when there is not.
- **Every MCP host logged `0.1.0` whichever release it was talking to.** The
  handshake is the only place a host learns which Tasq is on the other end,
  and the version it reported was the workspace package version, hardcoded.
  So the one field that would say what actually runs where said the same
  thing everywhere, forever. It is now the version the same binary reports
  for `--version`, proven against the built artifact.
- **`tasq mcp` refused `--space`.** Every other command that names a space
  takes `--space`; this one took `--tenant` only, which its own help calls
  the rare override. Both work now. The space is still required and never
  inferred from the working directory, which the agent contract forbids on
  purpose: a server that guesses its space guesses whose ledger an agent
  writes to.
- **`tasq agent install claude-code` was refused, by the id the machine
  contract itself uses.** `AGENT_INTEGRATIONS.json` names that host
  `claude-code`, so that is what an agent has in hand when it reaches for the
  deterministic fallback, and the CLI took `claude` only. The refusal now
  also names what is accepted.
- **One refusal could make `tasq usage` unreadable.** A command called with no
  arguments answers with its whole usage banner, and the journal stored it
  whole, so the report reprinted a dozen lines of argument syntax inside an
  indented column and the counts were lost in it. Only the first line is
  recorded now, and the reader repairs anything older, because records
  already on disk would otherwise break the report forever.
- **A release stopped dead when PyPI certified a wheel it had just published.**
  PyPI serves two indexes that do not update together: the JSON API carries a
  new release before the simple index `pip` resolves against does. v0.6.6 read
  the wheel digest from the JSON API, dispatched the certification two minutes
  later, and the certifier's `pip download` failed with `from versions: 0.4.0,
  0.6.3, 0.6.4, 0.6.5` - the wheel was published, and the index it installs
  from had not caught up. The release now waits until the simple index lists
  the exact file the certifier will ask for.
- **A failed certification forced the rest of the release to be done by hand.**
  No registry accepts a version twice, so a rerun of `release:publish-surfaces`
  failed on the publication step it had already completed, and the only way
  forward was dispatching the remaining workflows one by one - which is how
  v0.6.2 shipped without two of its surfaces. Publication is now decided by
  the registry rather than by rerunning it, so a resumed release re-certifies
  and continues.

## v0.6.6 - 2026-09-10

Ships the private command journal and tasq usage, the first read of how the CLI is actually used across projects, plus the acquisition-manifest gate and nine reads that no longer print nothing on a first run.

### Added

- **A private local record of what every `tasq` command was asked to do.**
  The ledger records mutations that SUCCEED. A read left no trace and a
  refusal left none at all, so the two signals that say whether the product
  fits the hand using it were invisible: both defects found on 2026-09-09
  existed in the ledger as nothing whatsoever. `~/.tasq/commands.jsonl` now
  takes one line per invocation, successes included, and `tasq usage
  [--since 30d] [--all]` reports refusals, reads, harnesses and versions, and
  every space on this machine at once. The file is `0600`, bounded, and
  leaves the machine only when someone runs `tasq feedback push`. It records
  the SHAPE of a command - verb, allowlisted subcommand, flag NAMES - and
  never a positional, a flag value or an actor label.
- **Agents are told where to send what the tool got wrong.** The managed
  `AGENTS.md` block now names `tasq feedback`, and says how it differs from a
  capture: a capture belongs to the project's work, feedback belongs to the
  tool. Blocks written before this are version 1.
- **`tasq doctor` says when this project's managed block is older than the
  executable.** Upgrading the binary does not touch a block a project already
  carries, so an adopted project kept teaching its agents the previous
  release's rules, and nothing announced the drift. Reported and never fatal:
  failing `doctor` in every project that has not re-run `setup` would turn a
  routine upgrade into an outage.

### Fixed

- **`tasq capture` refused every commitment carrying a planning scope.** 97
  of 100 live commitments could not take a capture, because a discovery
  copied its source's area, goal and project into the kernel, which refuses
  planning vocabulary without an injected planning-profile policy. Inherited
  scope is now dropped rather than refused: the kernel still owns no planning
  vocabulary, and the observation is still filed.

- **`release:publish-surfaces` dispatched on the tag by default, and no
  certifier could accept what that built.** Every provenance verification in
  the server, Python and Fly workflows expects `refs/heads/main`, and a
  workflow's provenance names the ref it was dispatched on. v0.6.4 passed only
  because it was run with `--workflow-ref main` by hand; v0.6.5 failed on the
  default. The default is now `main`; the bytes stay bound to the tag by
  `source_commit`.
- **A publish dispatched on the release tag deadlocked the release.** Every
  certifier demands `refs/heads/main`, and provenance names the ref a run was
  dispatched on, so a tag-dispatched build produced an image no certifier
  could ever accept, which `ensure-oci-tag.sh` then pinned to the release tag
  where no rerun could replace it. v0.6.5 hit exactly this and only a
  registry deletion broke it. Both publish workflows now refuse that dispatch
  before anything is pushed, and the reuse refusal names the deletion that is
  the only exit rather than reading as a transient registry error.
- **Every Dependabot pull request failed on its first step.** With no
  configuration, Dependabot rewrote `apps/site/package.json` alone while the
  pnpm lockfile sits at the workspace root, so all seven jobs died on
  `ERR_PNPM_OUTDATED_LOCKFILE`. The npm ecosystem is now pointed at the
  workspace root.
- **The manifests agent hosts read to acquire Tasq pinned v0.4.0.** Nothing
  advanced `AGENT_INTEGRATIONS.json`, its Markdown companion or the mirrored
  `integration.json` at release time, so a host following the documented
  "Executable acquisition" path installed a CLI two releases old and never
  learned anything newer existed. Recording a release now advances them, and
  the publication gate refuses a repository where they name anything but the
  published version.
- **`tasq usage` could not see a read that lives under a verb.** `attempt
  list` and `evidence list` are reads, a read leaves no ledger event, and the
  journal was the only place they could be counted - but the counter matched
  on the top-level verb alone, so both were invisible. Reads are now keyed by
  the shape actually invoked.
- **Two agents rotating the command journal at once could lose records.**
  Rotation read the whole file and renamed a rewritten copy over it, so the
  second rename dropped whatever the first had appended. Rotation now takes an
  exclusive lock and skips rather than races; the record is appended either
  way. The lock names its holder's pid, so a writer killed mid-rotation is
  reclaimed rather than wedging it forever - an expiry would need a clock, and
  only `systemClock` may read the host clock.
- **The CLI JSON contract described a `tasq demo` output that no longer
  existed.** It documented `tasq.isolated-demo.v1` with a `before` key while
  `demo` had moved to v2 with `claimed`, `refusals` and `evidence`, and
  `CommitmentInspectionV1` omitted `signedStatementProofs`. Nothing read that
  reference, which is why it drifted; `docs:check` now does.
- **The README stated a recipe count `tasq onboard` does not return** (45,
  against 47) and its `setup` transcript omitted the global-default line the
  command prints. Both are now checked against the running CLI.
- **Five reads printed nothing at all on an empty space.** `attempt list`,
  `evidence list`, `wait list`, `observation list` and `signature bindings`
  exited 0 with no output, which is indistinguishable from a command that
  silently failed - and an empty space is exactly what a first-time user has.
  They now say what is missing and how to create the first one, while `--json`
  still returns `[]`.
- **`tasq usage --all` could not tell a real project from test residue.** It
  listed every space in the store, and on a working machine 16 of 18 were left
  by tests, so the first cross-project read was mostly noise. Each space now
  reports `boundDirectories`, and the human report says how many spaces no
  directory is bound to.
- **House punctuation is the plain hyphen everywhere.** 851 em-dashes and
  en-dashes had accumulated across 219 files; `pnpm docs:check` now refuses
  them. Applied migrations are exempt and must be: their bytes are checksummed,
  so editing a comment in one makes every existing store refuse to open.

## v0.6.5 - 2026-09-08

The managed AGENTS.md block failed at its fifth step as written, and setup taught Codex while Claude Code read nothing; both fixed in #230 and only a published release puts them in an installation

The onboarding path, walked as a stranger: install from tasq.run into an empty home, `tasq setup` in a fresh project, then the AGENTS.md block executed line by line. Two defects, both fixed (#230).

### Fixed

- **The managed AGENTS.md block failed at its fifth step as written.** It
  prescribed `attempt succeed <task-id>` and the command wanted an attempt
  id, so every agent following the block hit `attempt not found`. No test
  executed the block; they read its prose. A task id now resolves to the
  task's single open attempt, ambiguity and absence are both named, and a
  test runs the block's own lines in order and fails without the fix.
- **`tasq setup` taught Codex and left Claude Code blind.** Claude Code reads
  `CLAUDE.md` and not `AGENTS.md`, so the block setup wrote was never loaded
  by a Claude Code session. Setup now writes a `CLAUDE.md` that imports the
  block, the recipe the Claude Code documentation gives, appends the
  `@AGENTS.md` line once to an existing file, and leaves a symlink alone.

## v0.6.4 - 2026-09-06

Ship the server image: publish-server can now pass the handoff on a tagged commit (#223), which 0.6.3 could not by construction. Also carries the README release pin into the record step so the front page stops advertising a stale release.

### Fixed

- **The server image could not be published for a fresh tag.** `publish-server`
  runs the full handoff on the tagged commit, and the publication record there
  necessarily still names the previous release, so the record check refused
  it. The window between a tag and its record is what the policy calls a
  release in state `authorized`: the check now reports that tag as `inFlight`
  instead of a lag, and refuses again once the release is recorded and a newer
  tag appears. A surface published without its certification is recorded as
  `published`, never as certified.

## v0.6.3 - 2026-09-06

Every surface catches up with the CLI: the server image, the Python wheel and the TypeScript client are published, certified and deployed with this release. The pipeline that made v0.6.2 stop after its first npm package now waits for the registry, the two hand-done halves of a release are commands, tasq usage measures the ritual, and a context link is found from the thing it points at.

### Added

- **A context link is found from the thing it points at.** `tasq context-link
  list --system … --resource-type … --external-id …` lists every commitment an
  external thing is linked to across the space, and `--purpose` narrows a
  listing to one purpose. This is how "has this message already become a
  commitment" and "who reported it" are answered. The chat-provenance
  vocabulary is documented in `docs/guides/CHAT_PROVENANCE.md`.
- **`tasq usage` counts what actors actually do.** Per actor and per event
  type over a window, mapped onto the ritual the managed `AGENTS.md` block
  prescribes, with the commands nobody ran named. The block prescribed ten
  commands; this project's own ledger used five. Reads that leave no event are
  reported as unobservable, never as zero. Contract `tasq.usage-report.v1`.
- **The two hand-done halves of a release are commands.** `release:prepare`
  advances the release authorization, the TQ-616 program and every candidate
  surface to the version about to be tagged and opens the changelog entry;
  `release:publish-surfaces` publishes and certifies the server image and the
  Python wheel and deploys the Fly private beta; `release:record` advances
  every public surface from what is actually public and verifies the record.
  Every surface ships by default: v0.6.2 went out without its server image
  and Python wheel because nobody had authorized them before the tag.

### Fixed

- **A release stopped after its first npm package.** npm now acknowledges a
  publish before the version is readable ("Your package is being processed
  and may take a few minutes to become available"). The verification asked
  for the version in the same second, got 404 and failed the job, with six
  packages unpublished and the GitHub release skipped. It now waits for the
  registry, with backoff up to a deadline (`--wait-seconds`, ten minutes by
  default); the pre-check that expects "missing" still answers at once.

## v0.6.2 - 2026-09-06

Store format 35, unchanged. A patch carrying the root-cause fixes behind the
2026-09-02 loss of this project's own directory binding, each found by reading
the private config that broke rather than by reasoning about it.

### Added

- **`tasq doctor` reads the configuration, not only the store.** A new
  `config` section, also available alone as `tasq doctor --config` without
  opening any store, reports `binding_drift` (the `AGENTS.md` block names a
  space commands here would not use), `dangling_binding` and
  `temporary_binding`, `default_space_unbound` and
  `projection_outside_bound_tree`, each with the command that repairs it.
  `--prune-bindings` removes bindings to directories that no longer exist and
  journals the removal. `pnpm agent:preflight` runs the check and stops on
  drift. Contract `tasq.config-doctor.v1`.

### Fixed

- **`tasq-dev` refused every git worktree.** The shim written by `pnpm dev:link`
  tested for a `.git` directory, and a worktree's `.git` is a file, so a dev
  build linked from a worktree was reported as a checkout that is gone. The
  shim now tests that the checkout exists, whichever shape git gave it.
- **A fresh machine wrote into one person's ledger.** The CLI's built-in
  defaults named a personal space and actor, so any command run before
  `tasq setup` on any machine landed in that person's space. A machine with no
  config file now has no space: an unbound directory refuses with the two
  commands that fix it, `tasq init` creates a neutral `local/default` space
  and writes it to the file, and the default actor is the account name. The
  same personal name was the implicit workspace in more than a hundred kernel
  and service fallbacks; it is now one named constant,
  `LEGACY_DEFAULT_WORKSPACE_ID`, documented as a defect to remove by requiring
  the workspace everywhere. Column defaults in the store are unchanged.
- **One projection file rendered whichever space was effective.** The global
  `projectionTarget` was written after every mutation with the effective
  space, so a life instance's `TASKS.md` received a software project's
  backlog. A directory binding now renders only its own projection, registered
  with `tasq use <space> --project-to <file>` and required to live inside the
  bound directory; the global target renders only the global default space.
  `tasq doctor --config` reports `global_projection_ignored_here` when the
  global target is set but the directory in effect renders nothing.
- **`tasq setup` rewrote the global default on every run.** Setting up one
  project made its space the fallback for every unbound directory on the
  machine, so an agent setting up a scratch project redirected every other
  checkout. The global default now moves only with `--default`, or when no
  config existed yet; `setup` in an already bound directory is set up again for
  its own space (`spaceSource: inherited-from-directory`). The result contract
  is `tasq.human-setup.v3` and reports `globalDefault {space, changed, source}`.
- **A config write could drop bindings another session had made.** Every
  writer saved its own copy of `config.json` whole. Writes now merge directory
  bindings with the file on disk, remove a binding only when the command names
  the directory it unbinds, and append a `tasq.config-change.v1` record to
  `~/.tasq/config-journal.jsonl` saying which command changed what.
- **A repository's managed block could name a space no command used.** The
  block in `AGENTS.md` is digest-bound, so its text could not drift; its
  binding could, silently. `tasq use --json` now reports `managedBlock` and
  `drift`, and `tasq use --from-instructions` binds the project as its
  repository declares.

## v0.6.1 - 2026-09-02

Store format 35, unchanged. Everything here was found by USING v0.6.0 rather
than by reasoning about it, which is why it is a patch and not a feature
release.

### Fixed

- **The refusal suggestion could not be pasted.** Refusing a completion printed
  the resolved `.local/lib/tasq/0.6.0/darwin-arm64/index.js` path. It is
  meant to be copy-pasted, and it pasted the versioned internal layout instead
  of the `tasq` on PATH, which stops working the moment the managed symlink
  moves. The onboard recipes deliberately keep the absolute path for the
  opposite reason: an agent executes the returned vector verbatim.
- **The Console had a live feed and asked a human to press a button.** Genuine
  SSE, an `EventSource` held open, cursor pagination and recovery, and then a
  badge reading "Changes available" beside a Refresh button. Somebody watching
  their agents work saw a static page. It re-fetches and swaps the record list
  now, keeping the filter that was typed, and still degrades to the badge for a
  history gap where a reload genuinely is required.
- **The installer refused after creating things, not before.** Installing over
  a pre-existing unmanaged `bin/tasq` extracted the archive and wrote the
  install record first, leaving two directories behind; the next run then
  failed with a raw `EEXIST`. The check happens before the network is touched,
  `--dry-run` reports `BLOCKED` and exits non-zero instead of printing a
  successful plan for the command that would refuse, and an error reaches a
  human as prose before the contract document.
- **The migration receipt did not record who performed the migration.** It
  captured the source path identity, the format, the cursor and the snapshot
  digest, and not the writer. When a source-only dev build migrated a live
  ledger to a format no published binary writes, that was invisible afterwards
  and had to be inferred. `writtenBy` now carries the version, whether it was a
  source build, the executable and the pid.

### Added

- **`pnpm dev:link`** puts a working-tree build on PATH as `tasq-dev`, beside
  the published `tasq`, so your own build never displaces the one that answers
  "does this work for somebody who installed it". It refuses to replace a
  `tasq-dev` it did not write.

### Documentation

- **A getting started that matches the product.** The README taught
  `tasq onboard`, which is the agent bootstrap, and never mentioned the command
  that puts Tasq in a project. It also named `v0.4.2` in five places, including
  the `npx` line that is the first command anyone runs.
- **A skill that can set a project up.** An agent handed `SKILL.md` could join
  an existing space and could not put Tasq in a project at all: the skill
  correctly forbade inferring the space and offered no path from "nothing here
  yet" to "working". Proposing an id and having a human confirm it once is not
  inferring, and the difference is load-bearing.
- **[ADR-025](docs/decisions/ADR-025_WHAT_WOULD_END_THIS.md)** states what
  evidence would end this project, written before that evidence exists.

### Release machinery

- The publication record is measured against the newest release tag rather than
  against itself, and a tag that published nothing must be recorded as retired
  with a reason. It failed the moment v0.6.0 published, which is the gate
  working.
- Both version-pinned `state` fields are guarded. After v0.5.1 shipped
  partially certified on one of them, the guard was applied to that block only;
  the other kept the state of the release it had already been consumed by.
- Two vendors on one ledger is an eval that runs in CI, so the claim stays true
  rather than being made once.

## v0.6.0 - 2026-08-28

Store format 35. Every 0.5.x store migrates forward once, irreversibly, and
`tasq store upgrade` makes that a decision rather than a side effect.

This release closes the half of the product that was named and missing.
[ADR-022](docs/decisions/ADR-022_WHAT_TASQ_IS.md) states that Tasq is the claim
ledger with a live human surface; `tasq fleet` is the first of that surface.
[ADR-024](docs/decisions/ADR-024_THE_DEFAULT_DOOR.md) makes the CLI the default
door for a local agent, and the recipe set now carries everything the MCP tool
set does, so choosing the default is not a downgrade.

### Added

- **`tasq contention`.** What the ledger refused. Thirty-one event types and a
  hundred and thirty-four claims acquired, and until now nothing recorded a
  single refusal: the ledger kept a complete account of everything it ALLOWED
  and no trace of anything it PREVENTED. The refusal is the product - `tasq
  demo` exists to show three of them - and nobody could answer "how many
  collisions did this stop for me last week". All four refusals a second worker
  can hit are counted, and a contention is a SITUATION rather than an instant:
  a polling agent turned away four hundred times is one record with a count of
  four hundred. A refusal is never a mutation - no event, no revision, no claim
  change - because everything downstream of the event journal describes work
  that happened, and a refusal is work that did not.
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

## v0.3.0 - 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.3.0) · store format 26

### Added

- Opt-in independent completion resolution across Core, embedded client, CLI,
  local MCP and Console: frozen policies, proposals, challenges and explicit
  decisions. Validated tasks can no longer be completed by evidence alone.
- Append-only evidence trust, proposal, challenge and validation records.

## v0.2.0 - 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.2.0)

### Added

- `createLocalTasq`, the embedded TypeScript client, published as compiled ESM
  with declarations and certified on Node 22 and Bun.

## v0.1.1 - 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.1.1)

### Added

- Public acquisition and universal-agent entrypoints: the versioned installer,
  `setup`, `demo` and the deterministic `agent install` helper.

### Changed

- Made the public adoption examples executable rather than illustrative.

## v0.1.0 - 2026-07-23

[Release](https://github.com/gwendall/tasq/releases/tag/v0.1.0) · first public alpha

### Added

- First published `@tasq-run/*` packages and checksummed native assets for
  macOS arm64 and Linux x64, built from protected GitHub Actions OIDC with npm
  provenance.
