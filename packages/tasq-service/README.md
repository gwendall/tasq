# `@tasq-internal/local-service`

Private compatibility service for Tasq Local and the only local-ledger write
path. It opens LibSQL, applies checksum-verified migrations, validates service
commands, commits state and audit atomically, and exposes compatibility
planning/projection adapters around the profile-neutral kernel.

Neutral persistence, migrations and coordination are implemented only in
`packages/tasq-core`. Matching files in this package are forwarding modules,
not a second source tree. New neutral behavior must never be copied here.

Use the `./kernel` export for the neutral embedded surface. Reference-extension
and life-planning behavior load only through the Local compatibility
composition; provider policy and credentials do not belong here. No other
package may bypass service invariants with direct SQL mutations.

```bash
pnpm --filter @tasq-internal/local-service typecheck
pnpm --filter @tasq-internal/local-service test
```

New operations need state-machine, retry/idempotency, transaction/audit and
injected-clock coverage as applicable. Migrations are additive and
checksum-pinned; never edit an applied migration in place.
