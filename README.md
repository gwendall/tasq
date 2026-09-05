# Tasq

[![CI](https://github.com/gwendall/tasq/actions/workflows/ci.yml/badge.svg)](https://github.com/gwendall/tasq/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**The project tracker you share with your agents.**

Website and documentation: [tasq.run](https://tasq.run)

```bash
npx @tasq-run/cli@0.6.1 demo    # fifteen seconds, no install, touches no data
```

## For you

A real tracker, not a scratchpad. Areas, goals, projects and tasks, with due
dates, recurrences and dependencies.

```bash
tasq add "Renew the domain" --due 2026-09-01 --priority 2
tasq next
tasq done <id>
```

One SQLite file you own. No account, no cloud, no telemetry.

## For your agents

Point Claude Code, Codex or any MCP client at the same ledger:

```bash
tasq agent install claude --space my/project --actor claude:main --apply
```

Without `--apply` the command prints the exact registration it would make and
changes nothing, so you can read it first.

Now they see your real work and take it with an expiring claim: while that
claim is live, nobody else closes the task. Work they propose has to say what
done looks like, and closes only against a receipt you can inspect.

## Why this exists

Anyone running coding agents on a serious project ends up hand-maintaining a
`PLAN.md` or a `TODO.md` so the agent keeps the thread between sessions. It
works badly: the file drifts, two agents overwrite each other, nobody knows
what is genuinely finished, and every context compaction costs another
re-explanation.

Tasq is the serious version of that file:

- two agents never start the same task, because claims are exclusive and expire;
- a successful run is never mistaken for a finished outcome;
- ownership does not survive a crashed worker;
- a replacement agent picks up exactly where the last one stopped, instead of
  replaying your chat history.

Tasq is not an agent runtime. It does not launch agents or call providers. It
gives the tools you already use one shared, inspectable place to agree on what
is done.

> **Public alpha:** `v0.6.1` is available from npm and as an attested GitHub
> release for macOS arm64 and Linux x64. The Server image and Python client are
> also published and exact-artifact certified. This is an
> intentionally early pre-1.0 line: keep backups of retained ledgers and expect
> documented migrations as the contracts evolve.

## What is available today

- **Tasq Core** - the embeddable TypeScript library behind the CLI, with no
  opinion about your domain. `@tasq-run/core@0.6.1` exposes the high-level `createLocalTasq`
  interface as compiled ESM with declarations, certified on Node 22 and Bun.
- **Tasq Local** — a JSON-first CLI, capability-scoped local stdio MCP, and a
  read-only loopback Console over one LibSQL ledger.
- **Integration contracts** — extension, connector, MCP Tasks, and A2A adapter
  boundaries that keep provider policy and runtime state outside Core.
- **Data safety** — verified pre-migration snapshots, doctor checks, backups,
  bounded export/import, and explicit store compatibility metadata.

Tasq Server ships as an exact-digest-certified multi-architecture image with
remote REST/MCP, enrollment and a hosted Console whose small human action
surface reuses the same live authorization guard. Authenticated offline
replication, `@tasq-run/client`, the remote CLI and `tasq-remote==0.4.0` are
published and exact-artifact certified. A private-beta Server runs at
`api.tasq.run`.

The private provider-neutral Cloud control-plane/BFF also has a bounded Fly
experiment. Its Basic-gated reference identity and control runtimes passed a
protected hardened three-engine browser replay on 2026-08-20. It is not an
available managed service or SLA: real identity, region recovery, independent
review and human operations gates remain. Remote effects remain disabled
pending independent review.

## The core concepts

| Concept | Meaning |
|---|---|
| Commitment | A durable outcome that must become true |
| Claim | An exclusive, expiring right to work on it |
| Attempt | One execution, successful or not |
| Evidence | An observable receipt used to justify completion |
| Resolution | A frozen policy, proposal, optional challenge, and explicit decision about whether evidence satisfies the commitment |
| Resource lease | Fenced ownership of a non-task resource such as a robot, file, or deployment slot |

An attempt succeeding never completes its commitment automatically.
Validated commitments also cannot be completed by evidence alone.

Published `v0.6.1` implements opt-in independent completion resolution across
Core, embedded client, CLI, local MCP and Console. Ordinary commitments retain
the short evidence-backed path; validated commitments use frozen policies,
proposals, challenges and explicit decisions. See the
[completion-resolution contract](docs/contracts/TQ-612_INDEPENDENT_COMPLETION_RESOLUTION.md).

## Get started

Requirements: Node 22+, Bun 1.3+, and npm 10+.

### 1. See what it does, without installing anything

```bash
npx @tasq-run/cli@0.6.1 demo
```

Two agents, one task, in a throwaway home. It shows you three refusals in a
row: a second agent claiming held work, a non-holder closing it, and the holder
closing it with no receipt. That is the whole product in about fifteen seconds,
and it reads and changes nothing you already have.

### 2. Install it

```bash
curl -fsSLo /tmp/tasq-install.sh https://tasq.run/install.sh
sh /tmp/tasq-install.sh --dry-run          # prints the plan, changes nothing
sh /tmp/tasq-install.sh
```

The dry run predicts what would block the install rather than only describing
success. Nothing is created until the real run, no shell startup file is
edited, and `TASQ_HOME` is never read or removed by the installer.

### 3. Put it in a project

One command, from inside the project:

```bash
cd ~/Code/my-api
tasq setup --space kami/my-api --actor gwendall
```

```
✓ Created kami/my-api as gwendall.
  this installation signs as 9aadf4704e67 - see `tasq whoami`
✓ Bound ~/Code/my-api and everything under it to this space.
✓ Wrote the managed Tasq block into AGENTS.md, so agents here know the rules.
```

It does three things and says which. It joins or creates the space, binds this
directory **and everything under it** so later commands need no flags, and
writes the digest-bound managed block into `AGENTS.md` so agents working here
are told the rules. `--no-bind` and `--no-instructions` skip either half, and it
refuses to set a project up in your home directory or at the filesystem root.

**Repeat it per project.** Each directory gets its own space, so work stays
separated without you passing `--tenant` anywhere:

```bash
cd ~/Code/my-api  && tasq list   # only my-api's work
cd ~/Code/my-site && tasq list   # only my-site's work
```

### 4. Give it to your agents

```bash
tasq agent install claude --space kami/my-api --actor claude:main --apply
```

Or nothing at all: an agent with a shell reads the `AGENTS.md` block that
`setup` already wrote, and `tasq onboard --json` hands it 45 executable argv
recipes carrying the same capability labels the MCP surface uses. ADR-024
records why the CLI is the default door for a local agent and MCP is the door
for remote and sandboxed ones.

### 5. Watch it

```bash
tasq fleet         # who is holding what, right now, with the lease counting down
tasq contention    # what the ledger refused: the collisions it prevented
tasq whoami        # the actor, its principal, and this installation's device key
```

`tasq fleet` works because a claim is an expiring lease rather than a flag: an
agent that dies stops appearing when its lease lapses, with no daemon watching
processes. `tasq contention` answers the question a tracker cannot, because a
tracker records what it allowed and never what it prevented.

### Before you rely on it

The store is one SQLite file at `$TASQ_HOME/db.sqlite`; do not edit it
directly. Read the [data safety guide](docs/guides/DATA_SAFETY.md) before a
long-lived ledger, and note that crossing a store format is deliberate:
`tasq store upgrade` is the consent, `tasq store clone --to <dir>` rehearses it
first, and `tasq store restore` rolls it back against a verified snapshot.

To evaluate without touching an existing ledger, point `TASQ_HOME` somewhere
else for the session:

```bash
TASQ_HOME="$PWD/.tasq" tasq setup --space demo/local --actor you
```

### Building on Tasq yourself

`pnpm build:cli && pnpm dev:link` puts a working-tree build on PATH as
`tasq-dev`, beside the published `tasq`, so your own build never displaces the
one that answers "does this work for somebody who installed it". See the
[development guide](docs/guides/DEVELOPMENT.md).

The current machine-readable acquisition contract is available at
[`tasq.run/adopt.json`](https://tasq.run/adopt.json) and versioned in
[`apps/site/public/adopt.json`](apps/site/public/adopt.json). It names the
immutable published npm and GitHub release coordinates, the supported targets,
the explicit install prefix, and the exact onboarding argument vector.
The generic agent entrypoints are
[`tasq.run/SKILL.md`](https://tasq.run/SKILL.md),
[`tasq.run/agents`](https://tasq.run/agents/) and
[`tasq.run/integration.json`](https://tasq.run/integration.json).

## Give Tasq to an agent

Once the executable is available, a new agent needs only an explicit space,
stable actor label, and capability envelope:

```bash
"$HOME/.local/bin/tasq" onboard \
  --space robotics/team-a \
  --actor codex:gwendall \
  --capabilities read,propose,coordinate \
  --json
```

The response contains the exact versioned recipes supported by that binary.
Agents should use those recipes instead of reconstructing commands from prose.
Codex and Claude Code can also install the shared native skill described in the
[agent integration guide](docs/integrations/AGENT_INTEGRATIONS.md).

## Repository map

| Path | Purpose |
|---|---|
| [`docs/`](docs/README.md) | Product concepts, guides, contracts, ADRs, roadmap, and release policy |
| [`packages/`](packages) | Core, Local, integrations, adapters, examples, and executable evals |
| [`apps/site/`](apps/site) | Static public product/docs site; no ledger access |
| [`plugins/`](plugins) | Host-native Codex and Claude Code integration source |
| [`evidence/`](evidence) | Retained certification and dogfood evidence |
| [`AGENTS.md`](AGENTS.md) | Coding-agent entrypoint for this repository |
| [`SKILL.md`](SKILL.md) | Short contract for agents operating a Tasq ledger |

Start with the [documentation map](docs/README.md). Contributors should read
the [development guide](docs/guides/DEVELOPMENT.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Packages

The public packages are `@tasq-run/schema`, `@tasq-run/core`, `@tasq-run/cli`,
`@tasq-run/mcp`, `@tasq-run/extension-sdk`, `@tasq-run/protocol-adapters`,
`@tasq-run/console`, and `@tasq-run/client`. Version `0.6.1` is published from
protected GitHub Actions
OIDC with npm provenance; native assets, checksums, SBOMs and attestations are
on the [`v0.6.1` release](https://github.com/gwendall/tasq/releases/tag/v0.6.1).
A package that carries no change in a release is not republished, so
`@tasq-run/client` remains at the version it was last published at.
The exact registry and release bytes pass the published lifecycle, migration,
adoption and interactive-runtime matrix on macOS ARM64 and Linux x64. The
compiled Core dependency closure additionally passes the same fresh-install
and same-ledger restart program under Node 22 and Bun.

ADR-010 defines `@tasq-run/client` as the eighth public package. It and the
TQ-807 Server container are published and protected-artifact certified; the
exact self-hosting runbook is in
[`deploy/server/README.md`](deploy/server/README.md).
The published dependency-free Python client source is in
[`clients/python`](clients/python), and the private experimental managed-service
composition is in
[`packages/tasq-cloud-control-plane`](packages/tasq-cloud-control-plane);
Cloud itself remains unpublished and unavailable as a managed product.

## Status and feedback

The current support boundary is maintained in
[`docs/concepts/PRODUCT_SURFACE_MATRIX.json`](docs/concepts/PRODUCT_SURFACE_MATRIX.json). The
versioned release scope, dependencies and external gates are in
[`docs/roadmap/BACKLOG.md`](docs/roadmap/BACKLOG.md), with
[`docs/roadmap/BACKLOG.json`](docs/roadmap/BACKLOG.json) as machine authority.
That backlog is not a live ownership queue. A repository using Tasq names its
live ledger space in the managed `AGENTS.md` block; claims and attempts there
determine who is executing work now.

Capture a reproducible bug or onboarding friction without leaving the terminal
with `tasq feedback "summary"`; it remains private and offline until an explicit
`tasq feedback push --repo owner/name`. GitHub issue activity remains an
observation and never completes a Tasq commitment. Report vulnerabilities
through the private process in
[`SECURITY.md`](SECURITY.md).

## License

Apache-2.0. Contributions use DCO 1.1 sign-off; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).
