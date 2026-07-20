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
surfaces.

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
[SECURITY.md](SECURITY.md). See [TESTING.md](TESTING.md) for the verification
layers and [SUPPORT.md](SUPPORT.md) for current support claims.

## License

Apache-2.0. Contributions use DCO 1.1 sign-off; see
[CONTRIBUTING.md](CONTRIBUTING.md).
