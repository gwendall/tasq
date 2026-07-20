# `@tasq-internal/reference-connectors`

Reference implementations of the provider boundary defined by
`tasq.connector-conformance.v1`. The package contains no database, kernel,
MCP server, workflow engine or provider credential store.

It deliberately models one small external system: versioned work items that
can be read and commented on.

- `createReferenceWorkItemReadConnector` turns one authenticated provider
  snapshot into a bounded, replay-stable observation. It hashes the title
  instead of copying it into Tasq and pins the raw reference to the configured
  provider origin.
- `createReferenceWorkItemEffectConnector` accepts only an authenticated Tasq
  dispatch permit for one exact comment. It resolves digest-bound content,
  sends the Tasq dispatch identity as the provider idempotency key, treats
  unproved POST outcomes as indeterminate, supports lookup without redispatch,
  and verifies a complete provider receipt.
- `createFetchWorkItemProviderClient` is the concrete HTTPS transport. It
  resolves a credential reference at the last moment, never returns the raw
  credential, bounds JSON responses, pins requests/references to one origin
  and uses manual redirects so authorization is never forwarded.

The work-item protocol is intentionally specific. This is an executable
authoring example for GitHub, Gmail, a robot controller or another provider,
not a generic arbitrary-HTTP write tool.

All authority and ledger state remain in Tasq. A committed provider receipt
creates evidence but does not complete the parent commitment.

See `../../TQ-306_REFERENCE_CONNECTORS.md` for the trust model, flow and honest
limits.
