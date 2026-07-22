# `@tasq/extension-sdk`

DB-free runtime contracts for trusted in-process Tasq extensions and the
provider-neutral connector conformance profile.

Use this package to bind immutable extension manifests to exact parser, route
and evaluator identities, or to test a read/effect connector against replay,
failure, fence, idempotency and receipt rules. Extension evaluators are
deterministic coordination logic; provider credentials and I/O remain in
connectors outside Core.

Executable loading, signatures, sandboxing and a public extension registry are
not implemented. See [`../../EXTENSION_SDK.md`](../../docs/integrations/EXTENSION_SDK.md) and
[`../../TQ-305_CONNECTOR_CONFORMANCE.md`](../../docs/contracts/TQ-305_CONNECTOR_CONFORMANCE.md).

```bash
pnpm --filter @tasq/extension-sdk typecheck
pnpm --filter @tasq/extension-sdk test
```
