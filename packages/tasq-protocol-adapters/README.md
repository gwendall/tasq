# `@tasq-run/protocol-adapters`

Pure outward adapters that map MCP Tasks and A2A Tasks onto Tasq execution
records.

Remote task/run success maps to an attempt; protocol output maps to an
artifact. Neither becomes completion evidence automatically, and neither may
complete the durable commitment. The package owns no transport, listener,
credentials, database or hosted service.

```bash
pnpm --filter @tasq-run/protocol-adapters typecheck
pnpm --filter @tasq-run/protocol-adapters test
```

See [`../../ADR-007_PROTOCOL_TASK_ADAPTERS.md`](../../docs/decisions/ADR-007_PROTOCOL_TASK_ADAPTERS.md)
and [`../../TQ-307_SURFACE_COMPATIBILITY.md`](../../docs/contracts/TQ-307_SURFACE_COMPATIBILITY.md).
