# TQ-804 — Guarded mutation REST

> **Status:** implemented and repository-certified — 2026-07-21
> **Machine certificate:** `TQ-804_MUTATION_REST_CERTIFICATION.json`
> **Deployable Server status:** not implemented

## Outcome

Tasq now exports a combined host-integrated HTTP handler for TQ-803 reads and
registered TQ-804 mutations. A host declares exact operation identities and
input-contract digests; clients discover that state-free catalog, submit a
bounded command with a mandatory idempotency key, authenticate, pass the live
authority guard, and reach only the exact opaque workspace binding.

Tasq intentionally bundles no domain operation adapter at this checkpoint.
The protocol and safety mechanism are universal; a host maps a registered
operation to its own durable workspace implementation. A concrete Tasq Core
composition, listener, verifier and deployable artifact remain later work.

## Why this is not called a cross-database ACID transaction

Authority and workspace ledgers are deliberately separate databases. Without
a shared transaction manager, claiming one ACID commit across both would be
false. The reference protocol instead preserves the security property that
matters:

1. the authority store begins a SQLite `BEGIN IMMEDIATE` transaction;
2. it evaluates the current binding, grant, action and resource;
3. only on allow, the opaque router opens the workspace;
4. the host performs and durably commits an exactly idempotent mutation;
5. the authority decision/audit commits and releases its writer gate.

A concurrent revocation or authority change cannot commit between steps 2 and
4. With native libSQL, a competing writer may receive typed `authority_busy`
instead of waiting; it retries the same authority operation after the admitted
mutation releases the gate. If revocation commits first, the mutation is
denied without opening the workspace.

The two database commits can still be separated by process loss. Therefore a
missing, corrupt or lost workspace outcome is never reported as failure or
success: the client receives `mutation_outcome_unknown` and must retry the
same semantic request with the same idempotency key. The workspace ledger then
returns its durable result without repeating the effect, and a fresh live
authority decision records the recovery if access remains valid.

## Operation and request contract

The state-free catalog lives at the protected-resource-relative
`/v1/operations`. Each operation freezes:

- one stable operation ID;
- one registered, versioned, digest-bound TQ-801 action;
- the action's allowed resource kinds and privilege requirements;
- immutable input/output contract URIs, versions and implementation digests;
- whether optimistic concurrency requires an `expectedRevision`.

The client never supplies its own action identity. It calls:

```text
POST /v1/workspaces/{workspace}/operations/{operation}
Authorization: Bearer …
Idempotency-Key: …
Content-Type: application/json
```

with `tasq.hosted-mutation-request.v1`: exact resource, optional expected
domain revision and portable input. Bodies and results are bounded to 256 KiB,
32 levels and 10,000 JSON nodes. Numbers must be safe integers.

The idempotency identity is scoped to workspace, external subject, delegated
actor, action and caller key. The raw key reaches the workspace adapter but is
never returned or placed in authority decisions/audit. A separate semantic
request digest detects conflicting reuse.

## Host workspace contract

`HostedMutationWorkspace.executeMutation` runs while the authority writer gate
is held. It receives the verified operation, resource, caller-scoped key and
digest, single injected timestamp, authority revision and complete decision.
It must:

- commit the domain result and durable idempotency record together;
- return the exact prior result for an exact replay;
- reject the same key with a different request digest;
- bind its strict outcome to workspace, operation, request and key digests;
- never interpret transport actor text as authority.

The handler validates that receipt before serialization. A receipt for another
request becomes an indeterminate outcome, never a successful response.

## Evidence

Package tests use two real SQLite databases plus two independent authority
connections. They prove catalog honesty, input bounds, one request-wide clock,
single commit and replay, conflicting key refusal, foreign-workspace
isolation, `authority_busy` revocation serialization, post-revocation denial,
unknown-outcome recovery, strict receipt binding and key redaction.

The independent clean-room eval discovers `commitment.propose` by action URI,
commits it through a host adapter, closes and reopens the domain store, replays
the lost response exactly, revokes the grant and observes denial without a
second write.

## Honest next boundary

TQ-805 exposes the same registered operation catalog through remote MCP and
must prove REST/MCP decision and idempotency parity. TQ-806 handles replication
authority separately. TQ-807 remains the first checkpoint allowed to claim a
listener, configuration lifecycle or deployable Tasq Server.
