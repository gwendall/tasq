# TQ-617 — Atomic discovery capture

> **Status:** source candidate complete; TQ-608 release dependency open  
> **Date:** 2026-08-11  
> **Machine certificate:** [`TQ-617_DISCOVERY_CAPTURE.json`](TQ-617_DISCOVERY_CAPTURE.json)

## Decision

Work discovered while executing another commitment is a new commitment plus a
directed provenance relation:

```text
new commitment -[discovered_from]-> discovering commitment
```

It is not a child, blocker, claim transfer, execution attempt or automatic
scope expansion. `discovered_from` is informational: it never changes
actionability and never contributes to the unresolved-blocker count.

The universal `commitment_relation` graph is the sole storage authority. The
closed-vocabulary `task_dependency` table remains a v1 compatibility
projection for its historical three types. This adds no migration and does not
change store format 32 before the authorized v0.4 release.

## Local capture contract

```text
tasq capture <discovering-task-id> <title>
  [--next <text>]
  [--context <json-object>]
  [--source <command>]
  [--idempotency-key <key>]
```

One writer transaction:

1. validates the source commitment is live;
2. bounds machine context to 16,384 UTF-8 bytes;
3. creates an open commitment in the source's area/goal/project scope;
4. records the exact source revision and bounded context in metadata;
5. appends the `discovered_from` relation and both audit events;
6. records durable caller-scoped idempotency.

Any late relation failure rolls back the commitment, audit and idempotency row.
An exact replay returns the same commitment and relation; a changed request
under the same key fails closed.

Capture reads but never mutates the source execution state. In particular it
does not release, renew, replace or widen a task claim. It is deliberately
available only through the local CLI and local compatibility service. MCP,
REST, Server and background runtimes do not receive an automatic capture tool.

## Refusal handoff

When a task-targeted CLI command returns non-zero, the executable prints a
shell-quoted, secret-free `tasq capture` recipe on stderr. The recipe includes
only the command name, task identifier and exit code—never the original flags,
payload or error text. Executing it files linked work and leaves the source
claim intact. `capture` itself never prints another capture recipe.

## Evidence

- service tests prove universal-only storage, non-blocking semantics,
  create/link/audit rollback, context bounds, exact replay and changed-request
  denial;
- CLI E2E executes the printed shell recipe and proves the same live claim
  remains attached before and after both explicit and suggested capture;
- schema and CLI types expose `discovered_from` without a database migration;
- package isolation and surface checks keep the command out of remote/MCP
  product claims.

The implementation is not shipped until TQ-608 certifies and publishes the
authorized v0.4 artifact. Source completion does not satisfy that dependency.
