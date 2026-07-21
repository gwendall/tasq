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
- a TQ-804 combined handler with a state-free registered-operation catalog,
  mandatory durable idempotency and a live authority writer gate held through
  the host workspace commit.

It exports no listener, concrete credential verifier, session, bundled domain
operation, remote MCP surface or deployable server. The host must integrate
the handler, verified-identity adapter and durable workspace operations. Host
storage bindings are opaque IDs; workspace input never becomes a filename,
URL or credential.
