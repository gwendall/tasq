# `@tasq-internal/filesystem-watcher`

Private read-only reference connector that turns one explicitly configured
filesystem observation into a bounded, secret-minimized Tasq envelope.

It demonstrates the connector boundary without importing a database, service
or kernel. It does not watch arbitrary paths autonomously, mutate the source
artifact or grant completion authority. The CLI entrypoint is
`tasq-watch-filesystem`; callers must provide the source and authority time
explicitly.

This package is repository-only and must not be published.

```bash
pnpm --filter @tasq-internal/filesystem-watcher typecheck
pnpm --filter @tasq-internal/filesystem-watcher test
```

See [`../../WATCHER_RECIPES.md`](../../docs/reference/WATCHER_RECIPES.md) for executable
fixture flows and [`../../TQ-305_CONNECTOR_CONFORMANCE.md`](../../docs/contracts/TQ-305_CONNECTOR_CONFORMANCE.md)
for the reusable contract.
