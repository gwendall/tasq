# Tasq

Tasq is a local-first coordination kernel for humans, agents, and their
runtimes. It keeps desired outcomes, delegation, temporary ownership,
execution attempts, evidence, external waits, effects, and audit history in
one durable ledger.

Tasq does not run your agents and does not make provider calls for them. It
gives independent actors a shared, inspectable answer to: what are we trying
to achieve, who currently owns the work or resource, what happened, and what
evidence justifies completion?

## What exists

- **Tasq Core** — an embeddable, profile-neutral TypeScript/Bun kernel.
- **Tasq Local** — the `tasq` CLI, a capability-scoped local stdio MCP server,
  and a read-only loopback Console.
- Extension and connector contracts for domain-specific logic and external
  effects.

Tasq Server, remote REST/MCP, and Tasq Cloud are roadmap products, not shipped
surfaces. The first Server building block now exists as the private
`@tasq-internal/authority` package: strict identity/authority contracts and a
pure injected-clock decision evaluator. It is not a credential verifier,
database, router or network endpoint; see
[TQ-801_HOSTED_AUTHORITY_FOUNDATION.md](TQ-801_HOSTED_AUTHORITY_FOUNDATION.md).

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

## Packages

| Package | Purpose |
|---|---|
| `@tasq/schema` | Portable schemas, identifiers, digests, and clock contracts |
| `@tasq/core` | Profile-neutral coordination kernel and migrations |
| `@tasq/cli` | Tasq Local CLI and `tasq` executable |
| `@tasq/mcp` | Capability-scoped local stdio MCP transport |
| `@tasq/extension-sdk` | Extension runtime and connector conformance contracts |
| `@tasq/protocol-adapters` | Pure MCP Tasks and A2A execution mappings |
| `@tasq/console` | Read-only loopback Local Console |

The packages are release candidates until the first protected, attested public
release is published. Do not infer npm availability from this source tree.

The release-candidate lifecycle is implemented: target artifacts include a
checksummed standalone installer, side-by-side activation and data-preserving
uninstall. The complete install/upgrade/restore contract and its executable
clean-room evidence are documented in
[TQ-604_LIFECYCLE_CERTIFICATION.md](TQ-604_LIFECYCLE_CERTIFICATION.md). No
download command is advertised until protected artifacts actually exist.

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
[BACKLOG.md](BACKLOG.md). See [SECURITY.md](SECURITY.md) for trust boundaries,
[TESTING.md](TESTING.md) for the verification
layers and [SUPPORT.md](SUPPORT.md) for current support claims.

## License

Apache-2.0. Contributions use DCO 1.1 sign-off; see
[CONTRIBUTING.md](CONTRIBUTING.md).
