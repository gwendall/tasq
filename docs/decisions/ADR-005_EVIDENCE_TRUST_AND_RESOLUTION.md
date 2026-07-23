# ADR-005 — Evidence trust, authenticity and commitment resolution

- **Status:** Accepted — 2026-07-23
- **Implements:** decision prerequisite for TQ-612
- **Unlocks:** independently validated completion and the future TQ-906 remote-effect review
- **Depends on:** ADR-UK-EXT extension identity, ADR-UK-006 collaboration records,
  ADR-004 for every remote authority claim
- **Does not authorize:** remote authentication, effect execution, provider
  credentials, financial bonds, token voting or automatic reopening

## 1. Problem

Tasq currently records attributable evidence and an immutable completion basis.
For an `evidence` commitment, the service proves that named evidence belongs to
the commitment and is not superseded; the completing principal still decides
whether it satisfies the success criteria.

That is intentionally sufficient for simple todos, but insufficient when a
different principal or deterministic evaluator must decide the outcome. A
single `validated` flag would collapse provenance, policy, uncertainty,
challenge and finality, and would make later corrections destructive.

## 2. Decision

Independently validated completion is one append-only resolution chain:

```text
resolution contract
  └── completion proposal ── evidence + effective trust records
        ├── challenge(s)
        └── validation decision
              └── completion record ── commitment transition to done
```

The existing `assertion` and `evidence` completion modes remain explicit
low-assurance compatibility policies. An additive `validationRequired` policy
bit requires this chain without invalidating the closed completion-mode enum.
A successful attempt, an evidence row, a proposal or a challenge never
completes a commitment.

### 2.1 Frozen resolution contract

A resolution contract is immutable and binds:

- one commitment plus the exact task revision at which it was created;
- a canonical snapshot and digest of the success criteria relevant to
  resolution, so ordinary lifecycle revisions do not move the goalposts;
- stable criterion identifiers and their required evidence kinds, source
  allowlist, minimum authenticity, freshness and retention constraints;
- one policy kind: `deterministic`, `attestation`, `optimistic` or
  `adjudicated`;
- exact policy URI, positive version and implementation digest;
- eligibility time, challenge window, self-validation rule, eligible
  validators and adjudicators;
- fail-closed behavior for unavailable, stale, contradictory and revoked
  inputs.

Changing success criteria or policy creates a new contract. Existing proposals
keep their original meaning. Explanatory prose may clarify but cannot weaken
the canonical criteria snapshot.

### 2.2 Evidence trust is scoped provenance, not a universal score

Trust records attest to one exact evidence row and use four non-interchangeable
authenticity classes:

| Class | Meaning |
|---|---|
| `unverified` | Actor-attributed assertion; no authenticated source claim |
| `authenticated_principal` | An authenticated surface bound the attesting principal |
| `authenticated_source` | A connector authenticated the named source/account and preserved provenance |
| `provider_verified` | A provider, receipt verifier or cryptographic mechanism verified the reported outcome |

The ordering above is the default minimum-threshold ordering only. A resolution
contract may additionally require exact kinds or sources; a higher class from
the wrong source does not satisfy it. Content digests prove byte identity, not
truth or publisher authority.

Trust is an append-only chain. An `attest` record names its authority method,
verification time, optional validity end and retention end. A `revoke` record
supersedes the current trust leaf and states why. Evidence correction continues
to use the existing evidence-supersession chain. Validators resolve both chains
at decision time and fail closed on forks, missing parents, expiry or
revocation.

The kernel retains evidence metadata, digests, trust records and resolution
records indefinitely. External content may be retained elsewhere; when a
contract requires that content through a deadline, unavailability is
`indeterminate`, never accepted.

### 2.3 Proposals, challenges and decisions

A completion proposal maps every criterion ID to explicit evidence IDs and is
bound to the resolution-contract digest. Proposal prose is data, never policy
or executable control.

A challenge is immutable, reasoned, optionally references counter-evidence and
must arrive before the contract deadline unless an adjudicated policy
explicitly accepts late review. It does not overwrite the proposal.

A validation decision has exactly one outcome:

- `accepted`
- `rejected`
- `too_early`
- `indeterminate`
- `challenged`

Only `accepted` may be referenced by a new completion record. `too_early` and
`indeterminate` keep the obligation visible. A challenged optimistic proposal
requires an adjudicated decision before acceptance. Correction creates a
decision that supersedes the current decision leaf; history is never edited.

### 2.4 Policy execution

- **Deterministic:** trusted process code crosses a completion-evaluator seam.
  Its URI, version and implementation digest must exactly match the frozen
  contract. The kernel supplies canonical criteria, proposal, evidence and
  effective trust; the evaluator returns a typed outcome and reason. Database
  policy documents are never executable code.
- **Attestation:** one eligible enabled principal explicitly decides. When
  self-validation is false, proposer and validator must differ.
- **Optimistic:** the proposal is accepted only after the injected-clock
  challenge deadline and only if no eligible challenge exists.
- **Adjudicated:** one eligible enabled adjudicator decides after inspecting the
  proposal and challenges. Tasq does not invent a universal jury.

Clock authority is injected. Lost responses retry through durable idempotency.
Device time, actor prose and metadata cannot make a proposal eligible.

## 3. Authority and revocation

Local principal labels remain attribution, not authentication. Local
attestation therefore proves separation of ledger identities and auditability,
not hostile-process security. An authenticated remote surface must satisfy
ADR-004 before it may assert principal identity or a trust class above
`unverified`.

Principal disablement or trust revocation before a decision makes the relevant
input ineligible. Later revocation never rewrites a historical completion.
Policy may append a finding and a human may explicitly reopen the commitment;
automatic reopening would hide an external side effect behind retrospective
policy.

TQ-906 must add an independent authority guard before any resolution decision
can authorize a remote effect. Completion authority and effect authority remain
separate.

## 4. Storage and interface consequences

TQ-612 adds append-only `resolution_contract`, `evidence_trust_record`,
`completion_proposal`, `completion_challenge` and `validation_decision`
records. The completion record gains nullable links to the accepted decision
and contract. SQLite guards enforce tenant/task consistency, immutable rows,
single trust/decision supersession leaves and accepted-only completion.

Core owns one deep resolution module. CLI and MCP call that module; inspection
and Console project the same chain. Connector, provider and organization policy
stay outside Core. Financial bonds and marketplace incentives may only be
extensions.

## 5. Rejected alternatives

- **One `validated` task flag:** rejected because it erases who proposed,
  checked or disputed which evidence under which policy.
- **Treat evidence presence as proof:** rejected because artifact existence and
  semantic satisfaction are different facts.
- **One scalar reputation score:** rejected because source suitability,
  authenticity, freshness and semantic validation are independent.
- **Mutable proposal/decision status:** rejected because correction and
  revocation would destroy the audit basis of earlier completion.
- **Run predicates stored in SQL/JSON/prose:** rejected because ledger data
  would become remote code or prompt authority.
- **Make optimistic voting or financial bonds universal:** rejected because
  most team coordination needs identity, separation of duties and explicit
  adjudication rather than market incentives.

## 6. Acceptance

TQ-612 must prove criterion-change rejection, self-validation rejection,
disabled or colluding validator constraints, stale/unavailable/contradictory
evidence, trust revocation, too-early evaluation, timely and late challenges,
adjudicated escalation, exact evaluator identity, lost-response retries and
accepted-only finalization. All records must survive restart and appear in the
canonical commitment inspection.
