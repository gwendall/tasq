# Current state

Tasq currently ships source for two local product shapes:

- **Core:** an embeddable, profile-neutral coordination kernel;
- **Local:** the CLI, local stdio MCP transport and read-only loopback Console.

Server, remote REST/MCP and Cloud are planned, not implemented. Provider
connectors, domain policy and agent runtimes remain outside Core.

This is the canonical public source repository. `main` requires pull requests
and green Linux/macOS CI; release tags are immutable and the `release`
environment accepts only `v*` tags. The repository contains seven public
package sources and private compatibility, example and eval workspaces. A
package is not available merely because its source exists here; npm
availability starts only after a protected attested release.

The Local release lifecycle now exists as a certified candidate. Generated
target assets can be verified and installed outside the checkout, upgraded,
paired with a matching snapshot for rollback, and uninstalled without touching
`TASQ_HOME`. This is not yet a published-download claim; see
`TQ-604_LIFECYCLE_CERTIFICATION.md` for the remaining evidence gate.

The loopback Console has canonical TQ-701 overview, actor, claim, resource,
wait, effect, redacted audit and bounded operational-health JSON contracts.
TQ-702 adds lossless polling and SSE invalidation with exclusive cursors,
typed recovery, bounded backpressure and injected time/scheduling. TQ-703 now
provides the server-rendered responsive operator UI, live/stale presentation,
bounded filters, audit timeline and previewable redacted support artifact. The
original commitment graph remains available as a deep inspection surface.

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
`UNIVERSAL_KERNEL_SPEC.md`, `BACKLOG.md`, `ARCHITECTURE.md`, and `SECURITY.md`,
then run `pnpm typecheck` and `pnpm test`.
