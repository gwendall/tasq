# `@tasq-internal/reference-extension`

Private compatibility extension containing the bundled Gmail, GitHub,
Mercury, HTTP and filesystem condition/observation modules.

These modules freeze exact manifest, parser, route and deterministic evaluator
identities behind `@tasq-run/extension-sdk`. They contain no credentials, provider
client or I/O and are examples/compatibility behavior rather than universal
Core ontology.

```bash
pnpm --filter @tasq-internal/reference-extension typecheck
pnpm --filter @tasq-internal/reference-extension test
```

New provider-specific schemas belong here or in another extension, never in
`@tasq-run/core` or `@tasq-run/schema` merely because one adopter needs them.
