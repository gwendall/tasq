# Tasq

[![CI](https://github.com/gwendall/tasq/actions/workflows/ci.yml/badge.svg)](https://github.com/gwendall/tasq/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Durable coordination for humans and agents.**

Tasq gives independent agents, runtimes, and people one local ledger for the
work that must survive a chat, process, or retry. It records the commitment,
who is working on it, each execution attempt, the evidence produced, and the
decision that made it complete.

Tasq is not another agent runtime. It does not launch agents or call providers.
It gives the tools you already use a shared, inspectable coordination layer.

> **Public source alpha:** the repository is open for early use and feedback.
> npm packages and downloadable releases are not published yet, and no stable
> compatibility promise applies before the first protected release.

## Why Tasq

Agent-native work breaks down when durable commitments are mixed with temporary
todo lists or runtime state:

- two agents start the same work;
- a successful run is mistaken for a completed outcome;
- ownership survives after a worker has crashed;
- external actions are retried without knowing whether they happened;
- context disappears when a session is replaced.

Tasq separates those concerns. Claims coordinate active ownership, attempts
record executions, evidence justifies completion, and monotone event cursors
let replacement agents resume without replay gaps.

## What is available today

- **Tasq Core** — an embeddable, profile-neutral TypeScript/Bun coordination
  kernel.
- **Tasq Local** — a JSON-first CLI, capability-scoped local stdio MCP, and a
  read-only loopback Console over one LibSQL ledger.
- **Integration contracts** — extension, connector, MCP Tasks, and A2A adapter
  boundaries that keep provider policy and runtime state outside Core.
- **Data safety** — verified pre-migration snapshots, doctor checks, backups,
  bounded export/import, and explicit store compatibility metadata.

Tasq Server, remote MCP, hosted Console, and Tasq Cloud are roadmap products.
The repository contains internal foundations for them, but no deployable remote
service is shipped.

## The five concepts

| Concept | Meaning |
|---|---|
| Commitment | A durable outcome that must become true |
| Claim | An exclusive, expiring right to work on it |
| Attempt | One execution, successful or not |
| Evidence | An observable receipt used to justify completion |
| Resource lease | Fenced ownership of a non-task resource such as a robot, file, or deployment slot |

An attempt succeeding never completes its commitment automatically.

## Try the source alpha

Requirements: Bun 1.3+, Node.js 22+, and pnpm 10.29+.

```bash
git clone https://github.com/gwendall/tasq.git
cd tasq
pnpm install --frozen-lockfile
pnpm build:cli

# Keep this evaluation isolated from any existing Tasq ledger.
export TASQ_HOME="$PWD/.tasq"

./dist/cli/index.js onboard \
  --space demo/local \
  --actor demo:user \
  --capabilities read,propose,coordinate \
  --json
```

Read the returned `guide`, then execute its argument-array recipes exactly as
returned. The executable stores data in `$TASQ_HOME/db.sqlite`; do not edit that
database directly. See the [data safety guide](docs/guides/DATA_SAFETY.md)
before using a long-lived ledger.

The current machine-readable acquisition contract is
[`apps/site/public/adopt.json`](apps/site/public/adopt.json). It deliberately
declares a mutable source build until protected release artifacts exist.

## Give Tasq to an agent

Once the executable is available, a new agent needs only an explicit space,
stable actor label, and capability envelope:

```bash
tasq onboard \
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

The intended public packages are `@tasq/schema`, `@tasq/core`, `@tasq/cli`,
`@tasq/mcp`, `@tasq/extension-sdk`, `@tasq/protocol-adapters`, and
`@tasq/console`. Their source is visible, but they are not available on npm
until the protected publication gate passes.

## Status and feedback

The current support boundary is maintained in
[`docs/concepts/PRODUCT_SURFACE_MATRIX.json`](docs/concepts/PRODUCT_SURFACE_MATRIX.json). The
ordered work is in [`docs/roadmap/BACKLOG.md`](docs/roadmap/BACKLOG.md), with
[`docs/roadmap/BACKLOG.json`](docs/roadmap/BACKLOG.json) as machine authority.

Open a GitHub issue for a reproducible bug, onboarding friction, or a bounded
feature proposal. Report vulnerabilities through the private process in
[`SECURITY.md`](SECURITY.md).

## License

Apache-2.0. Contributions use DCO 1.1 sign-off; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).
