# Current state

Tasq currently ships source for two local product shapes:

- **Core:** an embeddable, profile-neutral coordination kernel;
- **Local:** the CLI, local stdio MCP transport and read-only loopback Console.

Server, remote REST/MCP and Cloud are planned, not implemented. Provider
connectors, domain policy and agent runtimes remain outside Core.

The repository contains seven public package sources and private compatibility,
example and eval workspaces. A package is not available merely because its
source exists here; npm availability starts only after a protected attested
release.

The shortest verified loop is:

```text
commitment → claim → attempt → evidence → explicit completion
```

Typed waits, observations, reconciliation, resource leases, effects,
replication, bounded context and audit history extend that loop without making
runtime success equivalent to commitment completion.

Authority time is injectable throughout the kernel. Raw device time is allowed
only in the explicit `systemClock` composition adapter.

For orientation, read `README.md`, `PRODUCT_CONSUMPTION_SPEC.md`,
`UNIVERSAL_KERNEL_SPEC.md`, `ARCHITECTURE.md`, and `SECURITY.md`, then run
`pnpm typecheck` and `pnpm test`.
