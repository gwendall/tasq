# `@tasq-internal/server`

Private implementation and deployable source composition for Tasq Server. It
currently provides:

- an authority-owned SQLite control-plane schema and checksum-pinned migration;
- CAS/idempotent principal, binding, permission, grant, delegation and
  eligibility mutations with append-only audit;
- live TQ-801 authorization snapshot loading and durable decisions;
- an opaque host-configured router that opens a workspace ledger only after an
  allow.
- a TQ-803 Fetch-compatible authenticated read-only handler with RFC 9728
  discovery, bounded commitment reads and payload-free event metadata.
- a TQ-804 combined handler with a state-free registered-operation catalog,
  mandatory durable idempotency and a live authority writer gate held through
  the host workspace commit.
- a TQ-805 stateless Streamable HTTP MCP adapter that authenticates the exact
  request, discards raw credentials and projects every tool through those same
  TQ-803/TQ-804 handlers and the live ADR-004 guard.
- TQ-809 one-use human-device/workload enrollment, digest-only opaque access
  credentials, live introspection/revocation and a Fetch redemption handler.
- TQ-807 strict config/bootstrap contracts, RS256 access-JWT verification,
  real Core operations, immutable remote mutation receipts, a Bun daemon,
  authenticated Console BFF with a deliberately small guarded human action
  surface, operational endpoints and
  checksum-bound backup/restore.
- TQ-614/TQ-615 authority-owned Ed25519 public-credential lifecycle plus
  configured-trust-root, purpose-bound signed-statement verification and
  append-only proof persistence. Private keys remain host-owned.
- TQ-806 principal-bound replica enrollment, signed-origin push and
  authenticated pull. Live claims, leases, approvals and effects are excluded
  from offline authority.

The supported source deployment lives in `deploy/server/`. The local container
candidate passes real bootstrap and listener smoke tests but is not yet
published as an immutable provenance-bearing image. Host storage bindings are
opaque IDs; workspace input never becomes a filename, URL or credential.
The Console translates bounded same-origin forms for create, claim, block,
evidence, unverified attribution, completion proposal and approval into the
same registered REST operations and live authority guard. It is not a second
domain service. Stateful MCP sessions, provider connectors, remote effects and
managed tenancy remain outside this package; the private Cloud composition is
a sibling in `packages/tasq-cloud-control-plane`.
