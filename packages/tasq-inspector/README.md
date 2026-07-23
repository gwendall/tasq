# `@tasq-run/console`

Read-only local web Console over canonical Tasq Core projections.

The package owns bounded HTML/JSON rendering, loopback request handling,
live-invalidation transport and operator UI assets. It owns no database,
mutation, authority policy or second source of truth. The production
composition binds only to loopback, accepts `GET`/`HEAD`, redacts sensitive
metadata and captures injected authority time per request.

Do not expose this unauthenticated Local surface through a public bind or
reverse proxy. It is not the static product site in `apps/site` and is not a
hosted Console.

```bash
pnpm --filter @tasq-run/console typecheck
pnpm --filter @tasq-run/console test
pnpm --filter @tasq-run/console test:browser
```

Start with [`../../LOCAL_CONSOLE_SPEC.md`](../../docs/concepts/LOCAL_CONSOLE_SPEC.md) and the
TQ-701 through TQ-705 contracts for read models, transport, UI and installed
lifecycle.
