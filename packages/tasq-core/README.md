# `@tasq-run/core`

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

## Local client

`createLocalTasq` is the normal application seam. It opens one explicit store,
runs checksum-pinned compatible migrations, bootstraps the explicit
coordination space and binds the actor and authoritative clock to every
operation. It never reads the CLI config, cwd or ambient credentials.

```js
import { createLocalTasq, systemClock } from "@tasq-run/core";

const url = process.env.TASQ_DB_URL;
if (!url) throw new Error("Set TASQ_DB_URL=file:/absolute/path/to/db.sqlite");

const tasq = await createLocalTasq({
  url,
  workspaceId: "example/team",
  actor: "app:example",
  clock: systemClock,
});

try {
  let [commitment] = await tasq.commitments.list({ limit: 1 });
  if (!commitment) {
    commitment = await tasq.commitments.create(
      { title: "Ship the embedded Tasq loop" },
      { idempotencyKey: "example:create" },
    );
    commitment = await tasq.commitments.start(commitment.id, {
      expectedRevision: commitment.revision,
      idempotencyKey: "example:start",
    });
    commitment = await tasq.commitments.complete(commitment.id, {
      expectedRevision: commitment.revision,
      idempotencyKey: "example:complete",
    });
  }
  console.log(JSON.stringify({ id: commitment.id, status: commitment.status }));
} finally {
  await tasq.close();
}
```

The example is sourced from `examples/local-client.mjs` and executed against
fresh candidate tarballs under both Bun and Node, twice against the same
ledger. Lower-level exports remain available for trusted integrations that
need to own transaction composition directly.

```bash
pnpm --filter @tasq-run/core test
pnpm --filter @tasq-run/core typecheck
```

Kernel behavior is exercised primarily through the service, surface and eval
suites in the root `pnpm test` run. See
[`../../UNIVERSAL_KERNEL_SPEC.md`](../../docs/concepts/UNIVERSAL_KERNEL_SPEC.md) and
[`../../ARCHITECTURE.md`](../../docs/concepts/ARCHITECTURE.md).
