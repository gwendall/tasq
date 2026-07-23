# Prediction-market resolution patterns for Tasq

> Research note, 2026-07-23. Sources are limited to first-party protocol
> documentation and source repositories. This is product input, not an accepted
> Tasq contract or implementation claim.

## Executive conclusion

Tasq should borrow the **resolution protocol** used by optimistic oracles, not
their blockchain, token or voting machinery:

1. freeze precise success criteria and permitted sources before work starts;
2. let a worker or observer propose that the criteria were met;
3. accept immediately when a deterministic validator proves the result;
4. otherwise allow a risk-proportional challenge window;
5. escalate contested claims to an explicitly named reviewer or policy;
6. represent `too_early`, `indeterminate` and `rejected` instead of forcing
   `done`;
7. preserve the proposal, evidence, dispute and decision as separate immutable
   records.

Tasq already separates attempts, evidence and completion records, but its
current `evidence-required` policy checks structural validity only: supplied
evidence must belong to the commitment and must not have been superseded. The
actor completing the commitment still makes the semantic decision. Therefore
Tasq can accurately say **evidence-backed completion**, but not yet
**independently validated completion**.

## What the protocols actually do

### UMA Optimistic Oracle

UMA treats a claim as true optimistically when nobody disputes it during a
predefined liveness period. The asserter posts a bond; a disputer can challenge
during that period; a disputed assertion escalates to UMA's Data Verification
Mechanism (DVM). UMA describes the Optimistic Oracle as an escalation game, not
as an objective data feed
([UMA, “How does UMA's Oracle work?”](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)).

Bond size and liveness are parameters of the request. UMA recommends increasing
them for complex claims or claims controlling more value, because the bond
rewards detection of invalid proposals and the longer window gives reviewers
time to inspect them
([UMA, “Setting Custom Bond and Liveness Parameters”](https://docs.uma.xyz/developers/setting-custom-bond-and-liveness-parameters)).

UMA V3 also permits an integration-specific escalation manager. It can restrict
who may assert or dispute, choose whether the DVM or the integration arbitrates,
and store a custom arbitration result
([UMA, “Escalation Managers”](https://docs.uma.xyz/developers/optimistic-oracle-v3/escalation-managers)).
This is especially relevant to Tasq: “who decides?” is a policy choice attached
to the commitment, not a universal kernel answer.

UMA's data-asserter example makes two further boundaries explicit:

- the claim must be human- and machine-readable enough for off-chain verifiers
  to assess it;
- sufficient bond and liveness increase confidence that somebody has an
  incentive and enough time to verify it.

The claim itself is emitted for verification; it is not equivalent to proof
([UMA, “Data Asserter”](https://docs.uma.xyz/developers/optimistic-oracle-v3/data-asserter)).

### Polymarket

Polymarket applies this mechanism to a concrete product. Its market rules define
the resolution source, end date and edge-case handling before resolution. The
title is only a summary; the rules control the result. A proposer posts a bond,
there is a two-hour challenge period, and repeated disagreement escalates to a
DVM vote. Polymarket explicitly supports `Too Early` and `Unknown/50-50`
outcomes
([Polymarket, “Resolution”](https://docs.polymarket.com/concepts/resolution)).

The current Polymarket documentation also constrains post-launch clarification:
additional context may guide resolution but cannot change the fundamental
intent of the original question. This is a useful anti-goalpost-moving rule for
Tasq success criteria
([Polymarket, “Resolution — Clarifications”](https://docs.polymarket.com/concepts/resolution#clarifications)).

The official UMA CTF adapter shows the operational escalation in code-level
architecture: an undisputed answer becomes available after liveness, the first
dispute resets the request, a second dispute reaches the DVM, and anyone can
settle after resolution
([Polymarket `uma-ctf-adapter`](https://github.com/Polymarket/uma-ctf-adapter)).

### Objective data feeds are a different tool

For facts that can be reduced to a typed observation from an authoritative
source, a deterministic feed is better than social arbitration. Chainlink Data
Feeds aggregate multiple sources and publish a typed value; its own guidance
still requires consumers to check freshness, acceptable bounds and failure
modes
([Chainlink, “Data Feeds”](https://docs.chain.link/data-feeds)).

The design lesson is not that Tasq needs Chainlink. It is that an automated
validator must record:

- exact source and source version;
- observed value and observation time;
- freshness window;
- expected bounds or predicate;
- response digest or immutable provider identity;
- what happens when the source is stale, unavailable or contradictory.

An API response without those constraints is evidence provenance, not a
validated outcome.

## Comparison

| Concern | UMA / Polymarket | Tasq analogue |
|---|---|---|
| Question | Claim or market resolution rules | Success criteria at a specific commitment revision |
| Proposal | Bonded assertion of an outcome | Completion proposal referencing evidence |
| Liveness | Time in which anyone may dispute | Optional review/challenge deadline |
| Objective input | Off-chain sources named in rules | Observation, effect receipt, artifact digest, CI/provider result |
| Dispute | Counter-bond and challenge | Typed challenge with reason and counter-evidence |
| Escalation | DVM or custom escalation manager | Named human, quorum, extension evaluator or organizational policy |
| Finality | Settled oracle outcome | Immutable validation decision plus completion record |
| Too early | Explicit non-winning resolution | Keep commitment open or blocked until eligible |
| Unknown | Explicit 50/50 market settlement | `indeterminate`; do not silently complete |
| Incentive | Bonds and voter rewards | Usually role separation, audit and accountability; optional bonds only in marketplace extensions |

## Proposed Tasq model

### 1. Fix a resolution contract before execution

Evidence-mode work should be able to declare a versioned completion policy with:

- criterion identifiers and observable predicates;
- accepted evidence types and sources;
- earliest resolution time or deadline where relevant;
- validator identity or validator profile;
- whether the worker may validate their own result;
- challenge duration, including zero for deterministic checks;
- escalation route;
- behavior for unavailable, stale, conflicting, too-early and indeterminate
  evidence.

Changing these terms after work starts should create a new commitment revision.
As with Polymarket clarifications, explanatory context may remove ambiguity but
must not silently weaken the original success condition.

### 2. Separate four records

The kernel should not collapse these concepts:

1. **Evidence** — an immutable observation or artifact with provenance.
2. **Completion proposal** — a claim that named criteria are satisfied by
   specific evidence.
3. **Validation decision** — accepted, rejected, challenged, too early or
   indeterminate, with policy identity and reason.
4. **Completion record** — the durable transition to `done`, referencing the
   accepted decision and evidence.

This preserves Tasq's existing rule that successful execution is not commitment
completion. It also prevents “an evidence row exists” from becoming “the
evidence proves the claim.”

### 3. Use a validation ladder

Tasq should select the cheapest policy that matches the risk:

#### A. Deterministic validation

Examples: tests passed for a named commit; deployment health endpoint returned
the expected version; payment provider reported a settled transaction; a file
digest matches; a robot sensor reported the required pose.

An extension evaluates a typed predicate over immutable or source-versioned
evidence. Acceptance can be immediate. Stale or unavailable inputs return
`indeterminate`, not success.

#### B. Explicit attestation

Examples: an editor accepts an article; a customer confirms delivery; a
maintainer approves a design.

The policy names the eligible validator, requires their distinct principal
identity, and records the attestation. For sensitive work, the worker cannot be
the sole validator.

#### C. Optimistic validation

Examples: routine low-risk operational work with several observers and cheap
reversal.

The worker proposes completion with evidence. If no eligible actor challenges
before the deadline, the proposal is accepted. A challenge must name a reason
and may add counter-evidence.

#### D. Adjudicated validation

Examples: ambiguous research claims, disputed deliverables, insurance-like
outcomes or high-stakes external actions.

A dispute routes to a named reviewer, quorum or domain extension. The decision
must be reasoned and append-only. Tasq should not invent a universal jury.

### 4. Make uncertainty first-class

For commitments, Polymarket's economic `50/50` settlement is usually the wrong
semantic result. Tasq should distinguish:

- `accepted` — criteria proved under the declared policy;
- `rejected` — criteria not met;
- `too_early` — outcome is not yet eligible to evaluate;
- `indeterminate` — allowed sources cannot establish the result;
- `challenged` — decision awaits escalation.

Only `accepted` may authorize `done`. `too_early` and `indeterminate` keep the
obligation visible, normally open or blocked. Policy may later permit a human
to cancel or revise it, but uncertainty must not masquerade as completion.

### 5. Do not make financial bonds the default

UMA's bonds work because public, adversarial participants need an economic
reason to inspect claims. Most Tasq work happens inside a team, where identity,
separation of duties, auditability, access control and organizational
accountability are cheaper and more legible incentives.

Bonds could be useful in a future open labor or agent marketplace, but they
belong in an extension or product policy. They must not enter the universal
commitment kernel.

## Product implications

This model applies well beyond coding:

- **software:** test, review, merge and deployment evidence;
- **operations:** delivery receipts, inventory counts, service health;
- **finance:** provider-settled receipt plus independent authorization;
- **research:** source bundle followed by named human acceptance;
- **sales/support:** customer reply or CRM transition from an allowed account;
- **robotics:** sensor observation, run receipt and safety-controller
  attestation;
- **personal administration:** official confirmation, calendar occurrence or
  document receipt.

The common abstraction is not “a task with an attachment.” It is:

> a durable obligation, explicit success criteria, observable evidence, a
> declared decision policy and an inspectable resolution.

## What to build — and what not to claim

Candidate future work, subject to the normal Tasq backlog/ADR process:

1. specify a versioned completion-policy and validator-extension contract;
2. add completion proposals, challenges and validation decisions as append-only
   records;
3. ship deterministic validators first: artifact digest, test/CI result,
   effect receipt and typed observation predicate;
4. add independent-principal attestation;
5. add optional optimistic challenge windows and explicit escalation;
6. test stale data, source outage, conflicting evidence, self-validation,
   criterion changes, late challenges and indeterminate outcomes adversarially;
7. expose the full resolution chain in CLI, Console, MCP and Server.

Until those gates pass, public copy should distinguish:

- **current:** Tasq records evidence and an immutable, attributable completion
  decision;
- **future:** Tasq can independently evaluate or optimistically adjudicate
  whether the evidence satisfies the commitment.

## Primary sources

- [UMA — How does UMA's Oracle work?](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
- [UMA — Setting Custom Bond and Liveness Parameters](https://docs.uma.xyz/developers/setting-custom-bond-and-liveness-parameters)
- [UMA — Escalation Managers](https://docs.uma.xyz/developers/optimistic-oracle-v3/escalation-managers)
- [UMA — Data Asserter](https://docs.uma.xyz/developers/optimistic-oracle-v3/data-asserter)
- [UMA — Prediction Market example](https://docs.uma.xyz/developers/optimistic-oracle-v3/prediction-market)
- [Polymarket — Resolution](https://docs.polymarket.com/concepts/resolution)
- [Polymarket — `uma-ctf-adapter`](https://github.com/Polymarket/uma-ctf-adapter)
- [Chainlink — Data Feeds](https://docs.chain.link/data-feeds)
