# TQ-632 — Delegated-action certification and physical-verification Profile

> **Status:** source certified; private reference Profile, not a marketplace,
> provider network, hosted service or remote-effect release

## What is certified

The same provider-neutral invariant set is exercised across physical
verification, remote hands, software deployment, procurement, custody and a
compromised agent. The reusable boundary is:

```text
exact target + bounded authority + accepted terms + qualification
  -> responsibility + fenced attempt
  -> artifacts/evidence + explicit exception outcome
  -> independent resolution decision
  -> settlement/recourse and effects remain separate
  -> custody lineage only when possession/control changes
```

No test adds a provider field or domain branch to Core. Each domain composes
the TQ-622–TQ-631 Interfaces and keeps the distinctions that carry safety:
identity is not authority; assignment is not consent; runtime success is not
completion; evidence is not truth; settlement is not payment execution; a
signed observation is not custody election.

The machine-readable result is
[`TQ-632_DELEGATED_ACTION_CERTIFICATION.json`](TQ-632_DELEGATED_ACTION_CERTIFICATION.json).

## Hostile matrix

The certifier fails closed when:

- target digests drift between order, agreement, authority, attempt and
  evidence;
- denied or revoked authority opens a connector route or completes work;
- `no_access`, a partial outcome or timeout is presented as success;
- a succeeded attempt completes without an accepted decision;
- the executor self-reviews an independently validated outcome;
- restart replay is not exact, or an external effect lacks provider lookup
  before redispatch;
- Core or applicable custody portability is unverified;
- one custody state produces two successor IDs.

The compromised-agent passing case is a typed denial with zero provider route,
not a successful action.

## Recovery and independent review

The end-to-end physical-verification scenario creates a validated evidence
commitment, starts a fenced attempt, submits one target-bound artifact and
evidence set, closes and reopens the embedded client, and replays both journeys
without duplicates. The executor is denied self-review; a separately bootstrapped
reviewer accepts the exact proposal before completion. The complete workspace
then exports, imports into a new database and retains the decision and completed
commitment. Custody export/import is verified separately because TQ-631 is a
private Module store rather than Core state.

TQ-629 remains the executable evidence for provider lookup before redispatching
an indeterminate external effect. The Profile does not duplicate its runtime.

## Physical-verification reference Profile

`physical-verification/property-exterior@1` compiles one explicit order into:

- one exact TQ-622 `property_exterior` target and deterministic digest;
- distinct requester and executor principals;
- evidence completion with mandatory independent review;
- target-match, freshness and requested-fact criteria;
- a bounded capture contract with redaction and observation-age limits;
- explicit requester-site and photography-authority references;
- capability attestation purposes;
- safe-stop conditions including no access, unsafe scene, occupant objection,
  target mismatch, unclear privacy boundary, revocation and timeout.

It deliberately does not compile worker discovery, bidding, route planning,
price, insurance, access permission, identity verification or provider API
payloads. Those inputs are irreducible host/Profile/Connector responsibilities.

## Support truth

The Profile is `reference_only`, private and source-certified. It is not part of
the published `@tasq-run/*` packages, does not enable Server/Cloud effects and
does not claim that any worker or provider can be dispatched. Public Core and
Local support levels therefore do not change.

## Executable evidence

- `packages/tasq-physical-verification-profile/src/profile.ts`
- `packages/tasq-physical-verification-profile/src/certification.ts`
- `packages/tasq-physical-verification-profile/test/profile-certification.test.ts`
- `packages/tasq-delegated-runner/test/runner.test.ts`
- `packages/tasq-evidence-bundles/test/evidence-bundles.test.ts`
- `packages/tasq-custody/test/custody.test.ts`
