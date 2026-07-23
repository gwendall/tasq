# Tasq product and documentation site

Static, ledger-free Next.js application that explains Tasq and publishes the
same versioned product truth to machine consumers.

`scripts/generate-truth.ts` derives application/public snapshots from the
canonical root contracts. The app has no API routes, Core/Console runtime,
ledger access or install authority. It is deployed from public `main` at
<https://tasq.run>; local or preview builds must not be described as that
production deployment.

```bash
pnpm --filter @tasq-internal/site typecheck
pnpm --filter @tasq-internal/site test
pnpm --filter @tasq-internal/site build
pnpm --filter @tasq-internal/site test:browser
```

Generated truth must be refreshed through the generator, not edited by hand.
See [`../../TQ-605_PUBLIC_SITE.md`](../../docs/contracts/TQ-605_PUBLIC_SITE.md) and
[`../../PRODUCT_CONSUMPTION_SPEC.md`](../../docs/concepts/PRODUCT_CONSUMPTION_SPEC.md).
