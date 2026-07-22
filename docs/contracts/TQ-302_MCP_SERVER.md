# TQ-302 — capability-separated MCP server

> Implemented 2026-07-18. This describes the shipped local MCP transport, not
> hosted authentication or remote tenancy.

## Outcome

`@tasq/mcp` is a thin Model Context Protocol adapter over
`@tasq/core`. Any MCP client can discover Tasq tools and
resources, then use the same commitment, claim, attempt, evidence and effect
state machines as an embedded caller. The package adds no domain ontology,
planning policy, provider schema, credential store or alternate write path.

This differs from `@tasq/protocol-adapters`: that package imports remote
MCP Tasks/A2A snapshots into attempts. `@tasq/mcp` lets an MCP client
operate Tasq itself.

## Authority model

The host constructs one server with an immutable capability set:

| Capability | Meaning | Representative tools |
|---|---|---|
| `read` | Inspect and onboard without mutation | discovery, onboarding, commitment/effect/event/resource reads |
| `propose` | Create or revise internal intent without external dispatch | commitment create/update, effect proposal |
| `coordinate` | Claim work and record execution/proof | transitions, claims, attempts, evidence, generic resource leases/fences |
| `effect` | Cross the guarded pre-dispatch lifecycle | effect authorize/begin/cancel |

Separation happens at registration time, not by prompt convention. A tool
outside the granted set is absent from `tools/list` and has no handler. A
read-only client cannot reach mutations through tool confusion.

The host injects `workspaceId`, `actor`, optional authenticated `principalId`,
capabilities, database and clock. Client arguments cannot select another
workspace or actor. Attribution still does not grant authority.

`effect` additionally requires a trusted in-process
`resolveDispatchAuthority` callback. It supplies connector policy and permit
signing material after the request reaches the host; neither crosses MCP. The
generic stdio executable refuses `effect`. Approval decisions and provider
receipts stay on separate trusted channels: a model cannot self-approve, forge
a provider outcome or inject connector credentials through this server.

## Surface

The local stdio server exposes bounded tools with accurate annotations,
`tasq://discovery`, and digest-verified `tasq://schemas/{resourceId}` resources.
Tool results contain structured JSON and text fallback; service failures become
MCP tool errors without stack traces. Generic resource contention preserves the
full `tasq.resource-problem.v1` holder/fence/expiry guidance on MCP rather than
collapsing it to prose.

It intentionally publishes no prompts. Triage, prioritization, daily review
and life-pilot behavior are replaceable policy above the universal kernel.

Every handler passes the injected `Clock`; production stdio injects the sole
`systemClock` adapter and tests/replay inject a controlled clock. Most handlers
freeze one observation at entry. Resource mutations intentionally sample once
inside SQLite's serialized transaction so a process waiting on a writer cannot
carry an older pre-lock timestamp into the ledger. This package contains no raw
device-clock read.

## Run locally

The executable migrates the strict kernel schema without installing the
bundled reference extension. Identity is mandatory:

```bash
tasq mcp --tenant robotics-lab --actor agent:planner \
  --capabilities read,propose,coordinate
```

This exact argv is emitted by the autonomous onboarding document. The legacy
package-level composition is also available to explicit hosts:

```bash
TASQ_MCP_WORKSPACE=robotics-lab \
TASQ_MCP_ACTOR=agent:planner \
TASQ_MCP_CAPABILITIES=read,propose,coordinate \
TASQ_DB_URL=file:/absolute/path/tasq.sqlite \
bun run packages/tasq-mcp/src/stdio.ts
```

`TASQ_MCP_PRINCIPAL_ID` is optional and must identify an enabled principal in
the workspace. Stdout is reserved for JSON-RPC; diagnostics use stderr.

## Executable evidence

Black-box tests use the official MCP client to prove exact read-only tool
visibility, absence of hidden mutation handlers, fail-closed effect setup,
unknown-capability rejection, injected identity/time, generic resource
coordination and a complete create/start/claim/attempt flow whose successful
attempt does not complete its commitment. TQ-314 also drives stdio through a
raw JSON-RPC client with no MCP SDK or Tasq import.

## Deliberate limits

- The shipped transport is local stdio. Streamable HTTP, remote auth, session
  binding, rate limits and hosted tenancy are not implemented.
- Tool annotations are usability metadata; closed registration and service
  invariants are the security controls.
- Effect begin returns a permit but performs no provider I/O. A conformant
  connector verifies it, dispatches and reports a verified receipt.
- No MCP tool changes kernel schema or loads executable extension code.
