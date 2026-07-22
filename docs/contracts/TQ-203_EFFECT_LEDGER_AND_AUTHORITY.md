# TQ-203/TQ-204 — Effect ledger and exact authority

> **Status:** implemented (2026-07-16)  
> **Scope:** durable pre-dispatch intent and authority. This milestone does not
> expose connector execution or accept provider success.

## Why this exists

An attempt says that a runtime tried to do work. It does not identify one exact
external write or prove that the write was authorized. An `effect` is the
durable occurrence of that external-write intent. An `effect_approval` is an
immutable authority decision over the effect's exact request digest.

This keeps five facts separate:

1. the commitment somebody wants fulfilled;
2. the runtime attempt doing work;
3. the exact external side effect proposed;
4. who authorized that exact request, within which limits and time window;
5. the provider-grounded outcome, which TQ-206 records from a verified receipt.

## Implemented records

Migration `0014_effect_ledger.sql` adds:

- `effect`: canonical request and digest, intentional occurrence ID, stable
  dispatch idempotency key, extension type identity, connector binding,
  lifecycle, claim/fence binding, correction/compensation links, revision and
  timestamps;
- `effect_approval`: append-only approved/denied/revoked decisions bound to the
  exact effect digest, approver principal, scope, limits, validity interval and
  honest verification provenance.

The effect lifecycle is:

```text
proposed ──> authorized ──> executing ──> committed
    │             │              ├─────> failed
    │             │              └─────> indeterminate ──> committed/failed
    └─────────────┴──────> cancelled
```

TQ-203/TQ-204 expose `proposed`, `authorized` and pre-dispatch `cancelled`.
TQ-205 subsequently opened `executing` only through its authenticated connector
gate. TQ-206 now grounds terminal and indeterminate transitions in immutable
verified receipts.

## Embedded API

The strict `@tasq/core` entrypoint exports:

- `proposeEffect`, `getEffect`, `listEffects`;
- `recordEffectApproval`, `getEffectApproval`, `listEffectApprovals`,
  `getEffectiveEffectApproval`;
- `authorizeEffect` and `cancelEffect`.

These are trusted embedded APIs, not CLI, REST or MCP commands. Proposal
requires an installed extension type whose `recordKind` is `effect`.
`tasq.inspect.v1` includes the effects and complete approval history associated
with a commitment.

## Enforced invariants

- The canonical request, request digest, effect ID and dispatch identity are
  distinct and immutable under ADR-002.
- A proposal binds workspace, effect type/version, connector operation/version,
  connector contract digest, connector instance, binding digest, parameters
  and versioned secret references. It never stores raw credentials.
- One effect is one intentional occurrence. A retry reuses its dispatch key; a
  correction or compensation creates a new effect ID and dispatch key.
- Authority history is one immutable linear chain. A new decision must
  supersede the current leaf; branches, updates and deletion fail closed.
- Authorization accepts only the current `approved` leaf for the exact request
  digest. Denied, revoked, future or expired authority cannot authorize.
- Adding a superseding decision withdraws an authorized-but-not-dispatched
  effect back to `proposed` atomically.
- Optimistic effect revisions prevent stale state transitions.
- Corrections may only supersede a cancelled occurrence on the same
  commitment. Compensation may only reference an already committed effect and
  never rewrites the original.
- Effect creation and authority mutations emit task-scoped ordered audit
  events in the same transaction.
- `doctor` independently recomputes canonical request/digest/dispatch identity,
  validates lifecycle and authority JSON, and checks record ownership plus the
  approval graph even if SQL guards were removed.

The service and SQLite triggers both enforce the cross-row boundaries. The
Zod output schemas are a third defensive layer for lifecycle chronology and
authority validity.

## Clock and race contract

Every operation snapshots `Clock.now()` through `serviceNow`, or uses an
explicit injected `now`. No effect code reads the device clock. Validity uses
an exclusive expiry boundary: authority is valid while `now < expiresAt`.
The same injected snapshot drives UUIDv7 generation, rows, validity checks and
events.

Proposal and approval creation support durable request-bound idempotency keys.
Authorization/cancellation require `expectedRevision`. SQL uniqueness and
triggers remain the final arbiter under concurrent writers.

## Deliberate boundary of this milestone

This milestone does **not** yet:

- validate connector-specific scope/limit semantics or execute network writes;
- itself expose the later dispatch and receipt methods;
- itself claim that a provider accepted, rejected or applied an effect;
- turn a committed effect into commitment completion;
- authenticate a remote approver merely because a stable principal exists.

The extension registry freezes the declared effect JSON Schema. TQ-205 now
requires the connector-side executable parser and scope/limit policy to
revalidate the request through an authenticated permit. No provider adapter
should consume an authorized effect outside that gate.

## Executable evidence

- `packages/tasq-schema/test/effects.test.ts`: canonical identity and mutation
  vectors;
- `packages/tasq-service/test/effects.test.ts`: proposal, retry, immutable
  approval, expiry, revocation, correction, workspace/type failures and doctor
  corruption detection;
- `packages/tasq-service/test/inspection.test.ts`: complete inspection graph;
- `packages/tasq-service/test/migrations-events.test.ts`: additive migration,
  triggers and historical-store compatibility;
- `packages/tasq-cli/test/universal-inventory.test.ts`: exact table, field,
  event and inspection classification;
- `packages/tasq-cli/test/extension-boundary.test.ts`: ambient-clock ban.

## Subsequent gates

TQ-205 supplies the authenticated connector enforcement contract described in
`TQ-205_CONNECTOR_DISPATCH_GATE.md`. TQ-206/TQ-207 now supply verified receipts,
indeterminate recovery and compensation as described in
`TQ-206_EFFECT_RECEIPTS_AND_COMPENSATION.md`. TQ-208 attacks the whole boundary.
