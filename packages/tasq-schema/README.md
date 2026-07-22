# `@tasq/schema`

Portable data and validation foundation for Tasq: Zod schemas, TypeScript
types, identifiers, canonical clock contracts and Drizzle table definitions.

The package contains no database connection, service operation, host clock
composition, provider policy or transport. Its public subpath exports are
declared in `package.json`; compatibility changes require tests and review of
the owning public contract.

Only `src/clock.ts` may provide the `systemClock` adapter that reads host time.
All authoritative code consumes an injected `Clock` or explicit timestamp.

```bash
pnpm --filter @tasq/schema typecheck
pnpm --filter @tasq/schema test
```
