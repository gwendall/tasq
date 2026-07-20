# TQ-205 — Authenticated connector dispatch gate

> **Status:** implemented (2026-07-16)
> **Scope:** the only sanctioned transition from pre-dispatch authority to an
> external connector handoff. Provider outcomes are handled by the subsequent
> TQ-206 receipt boundary.

## Safety boundary

No connector receives a free-form tool request. Dispatch requires the exact
effect occurrence that was proposed and approved. The transition has two
checks around one authenticated permit:

```text
ledger transaction                         connector boundary
──────────────────                         ──────────────────
current approved leaf                      authenticate entire permit
exclusive injected time                    recompute request/digest/key
exact effect revision                      recheck expiry + claim lease
running attempt                            reload exact connector policy
live claim ID + fence             ──────>  parse parameters without changes
same worker principal                      re-evaluate scope + limits
connector policy allows                    only then perform provider I/O
enter executing + sign permit
```

The atomic transition to `executing` is the point of no return. A revocation or
cancellation serialized before it wins and prevents dispatch. A later
revocation cannot pretend the dispatch intent never existed; the connector
must finish or recover it through TQ-206's verified receipt path.

## Implemented APIs

`@tasq/core` exports `beginEffectExecution`. It requires:

- effect ID and optimistic `expectedRevision`;
- exact claim ID and fencing token;
- the principal holding that claim;
- a synchronous, side-effect-free `EffectConnectorPolicy`;
- an injected `EffectPermitIssuer`;
- an injected `Clock` or explicit operation time.

It rejects effects without a running attached attempt, a matching live claim,
the current exact approved leaf or connector policy acceptance. On success it
atomically enters `executing`, increments the revision, emits
`effect_execution_started` and returns `tasq.effect-dispatch-permit.v1`.

`@tasq/extension-sdk` exports:

- `assertEffectAuthority` for the pure in-transaction policy decision;
- `enforceEffectDispatch` for the final connector-side check;
- `EffectConnectorPolicy`, `EffectPermitIssuer` and `EffectPermitVerifier`;
- `createHmacEffectPermitAuthenticator` as a local composition-root
  convenience. Hosts can replace it with an asymmetric signer/verifier.

The generic machine discovery document now advertises the `effects` capability
and maps every operation to an actual strict-kernel export.

## Authenticated permit

The signed payload binds all authority-significant data:

- workspace, effect, revision, commitment and attempt IDs;
- canonical request, digest and provider idempotency key;
- effect type plus exact connector operation/contract/instance/binding;
- approval ID, digest, approver, scope, limits, validity and verification;
- claim ID, fence, principal and lease expiry;
- the injected execution timestamp.

Changing a request field, connector binding, approval scope/limit, fence,
revision or timestamp invalidates permit authentication. The kernel never
persists the signing key. The HMAC convenience requires at least 32 bytes and
uses constant-time signature comparison. A remotely transported permit still
requires host authentication and an appropriate asymmetric trust setup; HMAC
is not a remote identity protocol.

## Connector policy contract

The adapter supplies exact expected effect/operation/version/digest/instance
identities, a strict parameter parser and a pure authority evaluator. The
parser must return byte-equivalent canonical parameters: defaults, coercion,
field stripping and injected fields are rejected after approval. The evaluator
receives the exact parameters, versioned secret references, scope, limits,
approver verification and injected time. It returns an auditable allow/deny
reason.

The helper deliberately returns secret references, not credentials. Secret
resolution and least-privilege provider credentials remain connector-host
responsibilities after the gate and immediately before I/O.

## Defense in depth

Migration `0015_effect_dispatch_gate.sql` adds a direct-SQL trigger requiring a
live nonterminal commitment and a running attempt bound to the same
principal/claim/fence. Migration `0014` already rechecks the current approval,
exclusive expiry and claim lease. Service validation, the authenticated permit,
connector policy and `doctor` independently cover the same identities.

All time comes from an injected snapshot. The final boundary refuses to run if
neither `now` nor `Clock` is supplied, rejects a reversed clock, and treats
approval/claim expiry as exclusive.

## Deliberately not implemented here

- provider network calls or retries;
- raw secret storage or a universal credential resolver;
- claims that `executing` means the provider received anything;
- committed/failed/indeterminate outcomes without receipts;
- blind retry after a crash or timeout;
- commitment completion from an effect status.

## Executable evidence

- `packages/tasq-extension-sdk/test/effects.test.ts`: valid handoff plus request,
  scope/limit, connector, parser, clock and signature attacks;
- `packages/tasq-service/test/effects.test.ts`: active attempt/claim/fence,
  policy denial, authenticated permit, transition/event and no-cancel-after-
  dispatch behavior;
- `packages/tasq-service/test/migrations-events.test.ts`: trigger installation
  and historical migration compatibility;
- `packages/tasq-service/test/discovery.test.ts`: discoverable implementation
  mapping;
- `packages/tasq-cli/test/extension-boundary.test.ts`: ambient-clock ban.

## Subsequent gate

TQ-206 now persists immutable connector reports and verified provider receipts,
derives linked evidence, represents uncertainty without guessing and allows a
new provider lookup receipt to resolve `indeterminate`. See
`TQ-206_EFFECT_RECEIPTS_AND_COMPENSATION.md`. TQ-208 is the remaining
adversarial acceptance gate.
