# `@tasq-internal/server`

Private implementation foundation for future Tasq Server. It currently
provides:

- an authority-owned SQLite control-plane schema and checksum-pinned migration;
- CAS/idempotent principal, binding, permission, grant, delegation and
  eligibility mutations with append-only audit;
- live TQ-801 authorization snapshot loading and durable decisions;
- an opaque host-configured router that opens a workspace ledger only after an
  allow.
- a TQ-803 Fetch-compatible authenticated read-only handler with RFC 9728
  discovery, bounded commitment reads and payload-free event metadata.

It exports no listener, concrete credential verifier, session, mutation route,
remote MCP surface or deployable server. The host must integrate the handler,
verified-identity adapter and workspace reader. Host storage bindings are
opaque IDs; workspace input never becomes a filename, URL or credential.
