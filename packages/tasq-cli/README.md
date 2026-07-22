# `@tasq/cli`

Tasq Local's Bun executable. It composes the local service, capability-scoped
stdio MCP transport and read-only loopback Console into the `tasq` command.

Cold agents should start with an explicit space and stable actor label:

```bash
tasq onboard --space robotics/team-a --actor agent:planner --json
```

The returned versioned contract contains argument-array recipes. Consumers
should execute those arrays without reconstructing shell strings, persist IDs
and event cursors, and read before mutating. Actor labels provide attribution,
not authentication.

## Boundary

- Command handlers parse input and delegate mutations to
  `@tasq-internal/local-service`; they do not write SQL directly.
- `runtime.ts` owns the Local composition, database open/migration and injected
  `systemClock` boundary.
- Stable agent JSON follows
  [`../../CLI_JSON_CONTRACT.md`](../../docs/reference/CLI_JSON_CONTRACT.md).
- `tasq web` is explicit foreground loopback inspection, not a daemon or hosted
  service.
- Source and candidate artifacts are not published-release authority.

## Develop

```bash
pnpm --filter @tasq/cli typecheck
pnpm --filter @tasq/cli test
pnpm --filter @tasq/cli build
```

Add commands under `src/commands/`, route them from `src/index.ts`, update
usage/discovery where relevant and add a subprocess E2E test.
