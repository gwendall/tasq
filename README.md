# Tasq

Tasq is a local-first coordination kernel for humans, agents, and their
runtimes. It keeps desired outcomes, delegation, temporary ownership,
execution attempts, evidence, external waits, effects, and audit history in
one durable ledger.

Tasq does not run your agents and does not make provider calls for them. It
gives independent actors a shared, inspectable answer to: what are we trying
to achieve, who currently owns the work or resource, what happened, and what
evidence justifies completion?

## Start here

| You are… | Read or run first |
|---|---|
| Evaluating the product | This README, then [CURRENT_STATE.md](CURRENT_STATE.md) and [PRODUCT_CONSUMPTION_SPEC.md](PRODUCT_CONSUMPTION_SPEC.md) |
| Building from source | [DEVELOPMENT.md](DEVELOPMENT.md), then the root verification commands below |
| A coding agent | [AGENTS.md](AGENTS.md), which routes into the same development contract |
| An agent operating a Tasq ledger | [SKILL.md](SKILL.md), then `tasq onboard --space <id> --actor <label> --json` |
| Installing Tasq into Codex or Claude Code | [AGENT_INTEGRATIONS.md](AGENT_INTEGRATIONS.md) |
| Integrating Core, MCP, an extension or connector | The matching package README, then [ARCHITECTURE.md](ARCHITECTURE.md) |
| Operating or securing Local | [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md) and [TESTING.md](TESTING.md) |
| Backing up, upgrading or transferring a ledger | [DATA_SAFETY.md](DATA_SAFETY.md) |
| Looking for the next task | [BACKLOG.md](BACKLOG.md) or machine-readable [BACKLOG.json](BACKLOG.json) |

The compact [documentation map](DOCS.md) separates active product truth,
contributor guidance and subsystem evidence.

This standalone repository is the canonical source authority. References to a
former `products/tasq` subtree describe export history only; current changes
belong here.

## What exists

- **Tasq Core** — an embeddable, profile-neutral TypeScript/Bun kernel.
- **Tasq Local** — the `tasq` CLI, a capability-scoped local stdio MCP server,
  and a read-only loopback Console.
- Extension and connector contracts for domain-specific logic and external
  effects.

Tasq Server, remote MCP, and Tasq Cloud are roadmap products, not shipped
surfaces. The first Server building block exists as the private
`@tasq-internal/authority` package: strict identity/authority contracts and a
pure injected-clock decision evaluator. TQ-802 adds a private durable authority
control plane and opaque isolated-ledger router in `@tasq-internal/server`.
TQ-803 additionally exports a host-integrated authenticated read-only REST
handler with RFC 9728 discovery. It is neither a credential verifier nor a
network endpoint: a host must supply both, plus the workspace reader. See
[TQ-801_HOSTED_AUTHORITY_FOUNDATION.md](TQ-801_HOSTED_AUTHORITY_FOUNDATION.md)
and [TQ-802_AUTHORITY_STORE_ROUTER.md](TQ-802_AUTHORITY_STORE_ROUTER.md), then
[TQ-803_HOSTED_READ_REST.md](TQ-803_HOSTED_READ_REST.md).

TQ-804 extends that composition with host-registered mutation operations,
mandatory durable idempotency and a live authority writer gate held through
the workspace commit. It does not pretend separate authority/workspace
databases are one ACID transaction; unknown commit boundaries require an exact
same-key retry. See
[TQ-804_GUARDED_MUTATION_REST.md](TQ-804_GUARDED_MUTATION_REST.md).

The canonical repository is now public alpha source at
`https://github.com/gwendall/tasq`. npm packages and downloadable releases are
not published; repository visibility alone is not a release or compatibility
attestation.

The current product-hardening priority is TQ-607: operate Tasq for at least 30 days
across the personal life-pilot, Kami Robotics and an interactive agent runtime
while accepting early source users and feedback. A recorded `go` decision
from that evidence is still required before TQ-603 package publication; see
[TQ-607_PRIVATE_DOGFOOD_GATE.md](TQ-607_PRIVATE_DOGFOOD_GATE.md).

```bash
pnpm --silent dogfood status --json
```

That command is the authoritative progress summary and gives the next
evidence-producing action. Do not infer completion from repository tests or
edit the dogfood status by hand.

## Public site and docs

The separate static product/docs app lives in `apps/site`. It renders support
and release state from `PRODUCT_SURFACE_MATRIX.json`, `BACKLOG.json` and
`PUBLIC_RELEASE_POLICY.json`, and exports the identical machine snapshot at
`/product-truth.json`. It has no ledger access or API routes and is not the
Local Console. The app is implemented and tested but not deployed.

```bash
pnpm build:site
```

The static output is written to `apps/site/out`.

Machine consumers can start at `/adopt.json`. It gives the current acquisition
steps as argv arrays and then hands off to `tasq onboard`; it never asks an
agent to reconstruct a shell command. Because no protected release exists yet,
the current contract says `source_build`, marks `main` mutable and refuses to
claim release attestations. See [TQ-606_PUBLIC_ADOPTION.md](TQ-606_PUBLIC_ADOPTION.md).

## Agent entrypoint

Once the `tasq` executable is installed, an agent can create or join a local
coordination space without an integration-specific wrapper:

```bash
tasq onboard --space robotics/team-a --actor agent:planner --json
```

The versioned response describes implemented capabilities and returns bounded
argv recipes. Actor labels are attribution, not authentication or authority.
The repository [SKILL.md](SKILL.md) is deliberately short and delegates exact
syntax to that machine response so it cannot become a second command manual.
For a zero-context Codex or Claude Code session, install the shared native
plugin using [AGENT_INTEGRATIONS.md](AGENT_INTEGRATIONS.md), then provide an
explicit space, stable actor label and capability set.

## Packages

| Package | Purpose |
|---|---|
| `@tasq/schema` | Portable schemas, identifiers, digests, and clock contracts |
| `@tasq/core` | Profile-neutral coordination kernel, migrations and trusted manifest registry |
| `@tasq/cli` | Tasq Local CLI and `tasq` executable |
| `@tasq/mcp` | Capability-scoped local stdio MCP transport |
| `@tasq/extension-sdk` | Extension runtime and connector conformance contracts |
| `@tasq/protocol-adapters` | Pure MCP Tasks and A2A execution mappings |
| `@tasq/console` | Read-only loopback Local Console |

The packages are source-visible release candidates until the first protected, attested public
release is published. Do not infer npm availability from this source tree.

Interactive agent control planes can map conversations and runs to Tasq
attempts and external references. TQ-320 now candidate-certifies that shape
through a package-independent clean-room runtime fixture; replay from the first
protected published packages remains. This integration does not add machine or
terminal ownership to Core.

The release-candidate lifecycle is implemented: target artifacts include a
checksummed standalone installer, side-by-side activation and data-preserving
uninstall. The complete install/upgrade/restore contract and its executable
clean-room evidence are documented in
[TQ-604_LIFECYCLE_CERTIFICATION.md](TQ-604_LIFECYCLE_CERTIFICATION.md). No
download command is advertised until protected artifacts actually exist.

Tasq declares its executable store compatibility through `tasq version
--json`. Existing-store upgrades create a verified private snapshot and durable
receipt before schema mutation, fail closed on newer or ambiguous history, and
run post-migration doctor checks. `tasq export` and create-only `tasq import`
provide bounded workspace portability without being confused with recovery
backups. Exact recovery and rollback rules are in
[DATA_SAFETY.md](DATA_SAFETY.md).

The Local Console source exposes bounded, versioned JSON read models at
`/api/console/overview`, `/api/console/health` and
`/api/console/{section}`. Lossless live invalidation is available through
`/api/console/events` polling and `/api/console/stream` SSE. All are
loopback-only, read-only, cursor-driven, redacted and use injected authority
time; SSE cadence has a separate scheduler injection. See
[TQ-701_CONSOLE_READ_MODELS.md](TQ-701_CONSOLE_READ_MODELS.md) and
[TQ-702_CONSOLE_LIVE_TRANSPORT.md](TQ-702_CONSOLE_LIVE_TRANSPORT.md). The
server-rendered TQ-703 operator UI adds responsive section navigation, bounded
filters, audit timelines, visible live/stale states and preview-before-download
redacted support bundles; see
[TQ-703_OPERATOR_CONSOLE.md](TQ-703_OPERATOR_CONSOLE.md). Installed Tasq Local
starts it as one explicit foreground process; `tasq web ... --json` emits a
versioned listener announcement and `tasq web status ... --json` proves the
saved identity against the live `/api/console/runtime` endpoint. The UI footer
shows the installed version. Upgrade and uninstall
create no hidden listener and preserve ledger data; see
[TQ-704_INSTALLED_CONSOLE_LIFECYCLE.md](TQ-704_INSTALLED_CONSOLE_LIFECYCLE.md).
The browser surface is additionally certified with fixed injected time over
empty, mature, hostile, corrupt and 2,501-commitment stores in real Chromium
on Linux and macOS; see
[TQ-705_CONSOLE_BROWSER_CERTIFICATION.md](TQ-705_CONSOLE_BROWSER_CERTIFICATION.md).

## Build from source

Requirements: Bun 1.3+, Node.js 22+, and pnpm 10.29+.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:cli
```

The generated CLI is written to `dist/cli`. Development builds and local
package tarballs are never publication authority; public releases come only
from the protected tag workflow.

## Design boundaries

- SQLite/LibSQL is the local source of truth; mutations and audit events commit
  atomically.
- Domain ontologies, prioritization, provider credentials, and provider I/O
  remain outside Core.
- Runtime success does not complete a commitment. Completion remains an
  explicit, evidence-aware decision.
- External effects require exact proposal, authority, fence, dispatch, and
  receipt boundaries.
- Authority time is injectable. Raw device time is isolated to the explicit
  `systemClock` adapter.

Start with [CURRENT_STATE.md](CURRENT_STATE.md),
[PRODUCT_CONSUMPTION_SPEC.md](PRODUCT_CONSUMPTION_SPEC.md),
[UNIVERSAL_KERNEL_SPEC.md](UNIVERSAL_KERNEL_SPEC.md), and
[BACKLOG.md](BACKLOG.md). Contributors should use
[DEVELOPMENT.md](DEVELOPMENT.md). See [SECURITY.md](SECURITY.md) for trust boundaries,
[TESTING.md](TESTING.md) for the verification
layers and [SUPPORT.md](SUPPORT.md) for current support claims.

## License

Apache-2.0. Contributions use DCO 1.1 sign-off; see
[CONTRIBUTING.md](CONTRIBUTING.md).
