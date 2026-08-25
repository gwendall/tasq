# Tasq

[![CI](https://github.com/gwendall/tasq/actions/workflows/ci.yml/badge.svg)](https://github.com/gwendall/tasq/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**The project tracker you share with your agents.**

Website and documentation: [tasq.run](https://tasq.run)

```bash
npx @tasq-run/cli@0.4.0 demo    # three seconds, no install, touches no data
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
tasq agent install claude --space my/project --actor claude:main
```

Now they see your real work, take it with an expiring claim, and cannot mark
anything done without a receipt you can inspect.

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

> **Public alpha:** `v0.4.0` is available from npm and as an attested GitHub
> release for macOS arm64 and Linux x64. The Server image and Python client are
> also published and exact-artifact certified. This is an
> intentionally early pre-1.0 line: keep backups of retained ledgers and expect
> documented migrations as the contracts evolve.

## What is available today

- **Tasq Core** - the embeddable TypeScript library behind the CLI, with no
  opinion about your domain. `@tasq-run/core@0.4.0` exposes the high-level `createLocalTasq`
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

Published `v0.4.0` implements opt-in independent completion resolution across
Core, embedded client, CLI, local MCP and Console. Ordinary commitments retain
the short evidence-backed path; validated commitments use frozen policies,
proposals, challenges and explicit decisions. See the
[completion-resolution contract](docs/contracts/TQ-612_INDEPENDENT_COMPLETION_RESOLUTION.md).

## Try the public alpha

Requirements: Node 22+, Bun 1.3+, and npm 10+.

```bash
curl -fsSLo /tmp/tasq-install.sh https://tasq.run/install-v0.4.0.sh
sh /tmp/tasq-install.sh --dry-run --version 0.4.0 --prefix "$HOME/.local"
sh /tmp/tasq-install.sh --version 0.4.0 --prefix "$HOME/.local"

# Keep this evaluation isolated from any existing Tasq ledger.
export TASQ_HOME="$PWD/.tasq"

"$HOME/.local/bin/tasq" onboard \
  --space demo/local \
  --actor demo:user \
  --capabilities read,propose,coordinate \
  --json
```

Read the returned `guide`, then execute its argument-array recipes exactly as
returned. The executable stores data in `$TASQ_HOME/db.sqlite`; do not edit that
database directly. See the [data safety guide](docs/guides/DATA_SAFETY.md)
before using a long-lived ledger.

The current machine-readable acquisition contract is available at
[`tasq.run/adopt.json`](https://tasq.run/adopt.json) and versioned in
[`apps/site/public/adopt.json`](apps/site/public/adopt.json). It names the
immutable `v0.4.0` npm and GitHub release coordinates, the supported targets,
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
`@tasq-run/console`, and `@tasq-run/client`. Version `0.4.0` is published from
protected GitHub Actions
OIDC with npm provenance; native assets, checksums, SBOMs and attestations are
on the [`v0.4.0` release](https://github.com/gwendall/tasq/releases/tag/v0.4.0).
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
