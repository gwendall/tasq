# `@tasq/core`

Profile-neutral embedded commitment-coordination kernel for Tasq.

Core owns canonical commitments, collaboration, claims, attempts, evidence,
effects, resources, idempotency, audit, replication, bounded context and
checksum-pinned migrations. Embedders supply an explicit workspace, actor,
store and `Clock`. The package has no network listener, provider credentials,
agent runtime, workflow engine, human prioritization policy or hosted control
plane.

This directory is canonical source, not a generated mirror. It was
materialized during the completed standalone-repository cutover and all
current neutral changes land only here. The private Local service imports Core
and keeps exact forwarding modules solely for compatibility with its existing
internal paths. Compatibility-only life planning and bundled provider types
remain in private sibling packages.

```bash
pnpm --filter @tasq/core typecheck
```

Kernel behavior is exercised primarily through the service, surface and eval
suites in the root `pnpm test` run. See
[`../../UNIVERSAL_KERNEL_SPEC.md`](../../UNIVERSAL_KERNEL_SPEC.md) and
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).
