# `@tasq-internal/server`

Private implementation foundation for future Tasq Server. TQ-802 currently
provides only:

- an authority-owned SQLite control-plane schema and checksum-pinned migration;
- CAS/idempotent principal, binding, permission, grant, delegation and
  eligibility mutations with append-only audit;
- live TQ-801 authorization snapshot loading and durable decisions;
- an opaque host-configured router that opens a workspace ledger only after an
  allow.

It exports no listener, HTTP route, credential verifier, session, remote MCP
surface or deployable server. Host storage bindings are opaque IDs; workspace
input never becomes a filename, URL or credential.
