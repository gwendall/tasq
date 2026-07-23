# TQ-611 — Deep local TypeScript client

> **Status:** implementation and source-candidate certification passed;
> protected `v0.2.0` publication and published-byte replay remain
> **Package seam:** `@tasq-run/core`
> **Machine evidence:** `TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.json`

## Decision

The high-level local client belongs in `@tasq-run/core`, not a new
`@tasq-run/client` package. It composes the same local kernel, store and
migrations and introduces no alternate transport, authentication model or
remote implementation. A separate package would be a shallow pass-through
whose dependency and versioning cost would reappear for every consumer.

`createLocalTasq({ url, workspaceId, actor, clock })` is the supported normal
seam. It hides database opening, checksum-pinned migrations, transaction
composition and coordination-space/principal bootstrap. The four rendezvous
inputs remain mandatory and explicit. The client never infers a store from
cwd, reads CLI configuration or treats actor attribution as authority.

The lower-level Core exports remain public for advanced trusted embedders.
Deep imports, migration files and implementation modules remain unsupported.

## Interface

The returned client binds one store, workspace, actor, principal and clock and
exposes:

- `commitments`: create, read, list, update and explicit state transitions;
- `claims`: acquire, inspect, list and revision-guarded release;
- `attempts`: start, inspect, list and revision-guarded transition;
- `evidence`: append, inspect and list;
- `resources`: acquire, renew, release, verify and inspect;
- `inspect(commitmentId)`: the canonical complete commitment graph;
- `events` and `cursors`: ordered event reads plus exclusive event/resource
  resume watermarks;
- `close()`: explicit connection lifecycle.

Mutations retain idempotency and optimistic-concurrency inputs. Attempt success
does not complete a commitment. Resource I/O still requires a freshly verified
lease and fence.

## Distribution and runtime

The protected package builder emits compiled ESM and `.d.ts` declarations for
`@tasq-run/core` and its runtime dependency closure
(`@tasq-run/schema`, `@tasq-run/extension-sdk`). Package exports point only at
`dist/`; raw TypeScript is not the Node execution path. Migrations are copied
beside the compiled migration loader and retain their immutable checksums.

The source candidate is certified on:

- Bun 1.3.11 or newer;
- Node.js 22 or newer.

Other public packages retain their existing Bun-only boundary until each is
independently compiled and certified. This work does not make the CLI, MCP,
Console or protocol-adapter package Node-supported.

## Executable documentation and acceptance

`packages/tasq-core/examples/local-client.mjs` is the single documentation
source. The package builder embeds that exact program into the generated npm
README. The clean-room package test installs only generated tarballs, copies
the same program, and executes it twice under Node and twice under Bun against
separate persistent ledgers. Both second runs observe the first commitment
instead of recreating or losing it.

The Core interface test additionally exercises claims, attempts, evidence,
resource fences, inspection, event cursors and process restart only through
`createLocalTasq`.
The post-publication workflow downloads and verifies all seven registry
tarballs, then `published-embedded-client.test.ts` installs the exact released
Core dependency closure and repeats the two-run journey under Node 22 and Bun.

Acceptance evidence:

```bash
pnpm --filter @tasq-run/core test
bun test packages/tasq-cli/test/public-packages.test.ts
pnpm --filter @tasq-run/core typecheck
```

## Remaining publication boundary

The published `@tasq-run/core@0.1.1` remains the prior low-level Bun-oriented
surface. No website or current-release manifest may claim `createLocalTasq` or
Node support until protected `v0.2.0` bytes publish and the exact npm tarballs
pass the post-publication Node/Bun restart replay. The closeout must then update
the site, package/runtime matrix, release certificate and canonical backlog.
