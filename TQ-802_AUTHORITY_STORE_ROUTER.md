# TQ-802 — Durable authority store and isolated workspace router

> **Status:** implemented and repository-certified — 2026-07-21
> **Machine certificate:** `TQ-802_AUTHORITY_STORE_CERTIFICATION.json`
> **Remote surface status:** not implemented

## Outcome

Tasq now has a private Server foundation that persists hosted authority
separately from domain ledgers. It loads the TQ-801 snapshot, records every
decision, and opens a workspace ledger only after an allow through an exact
host-configured opaque storage binding.

No listener, HTTP route, credential verifier, browser session, remote MCP
transport or deployable server is part of this checkpoint.

## Storage boundary

The reference composition uses one authority control-plane SQLite database and
separate workspace ledgers. The control plane owns:

- host tenants and workspace-to-opaque-storage bindings;
- principals and exact issuer/subject bindings;
- immutable permission definitions and revisioned activation;
- grants, delegations and effect eligibility;
- durable request idempotency, authorization decisions and append-only audit.

The control database stores no access token, refresh token, private key,
cookie, domain ledger contents or storage credential. A workspace ID never
becomes a path or URL. The host supplies a closed mapping from an opaque
`storageBindingId` to an opener; a missing or mismatched mapping fails closed.

## Mutation and decision invariants

Every authority mutation:

1. captures one injected timestamp;
2. checks a caller operation ID and canonical request digest;
3. checks the exact expected workspace authority revision;
4. writes the state transition, revision bump, audit event and idempotent
   result in one SQLite write transaction.

Definitions and audit/decision rows are append-only at the SQL boundary.
Principal, binding, grant, delegation and eligibility transitions are
monotone and revision-checked by triggers. Concurrent writers to one revision
produce one winner.

Authorization loads bindings, principals, active permission definitions,
grants, delegation and eligibility from one write-transaction snapshot, calls
the pure TQ-801 evaluator with the same captured clock, and appends the result
before returning. A previously allowed request can be replayed only while its
authority revision is still current; after revocation it returns a typed
revision conflict and cannot route.

## Isolation evidence

Package tests prove that:

- a valid workspace A caller opens only A's configured ledger;
- the same identity probing B is denied without invoking B's opener;
- grant revocation and permission retirement affect the next new request;
- persisted subject/actor grants and delegation preserve both identities;
- effect eligibility remains separate from a grant;
- stale CAS writes, conflicting idempotency reuse, corrupt JSON and missing
  host bindings fail closed;
- decisions and audit cannot be updated/deleted and contain no credential
  envelope.

The independent eval starts two cold migrators in separate processes, closes
and reopens the control plane, routes a robotics workspace through a binding
whose value is unrelated to its name, revokes access, restarts again and
observes the denial and audit without touching the decoy opener.

## Honest next boundary

TQ-803 adds credential-verifier output plumbing, public authentication
discovery and authenticated read-only REST around this guard. TQ-804 must add
guarded mutations with a protocol that makes the authority revision
precondition and domain write commit together or fail retryably. TQ-802 does
not claim that opening a store alone solves that later cross-boundary mutation
race.
