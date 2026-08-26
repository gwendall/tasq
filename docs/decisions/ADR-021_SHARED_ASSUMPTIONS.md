# ADR-021 — Shared assumptions are a separate, cheap primitive

- **Status:** Proposed - 2026-08-26
- **Decision owner:** Tasq kernel ontology and agent-facing surfaces
- **Depends on:** ADR-020 (discovery capture), UNIVERSAL_KERNEL_SPEC P10
- **Supersedes in the backlog:** the three tickets that proposed teaching the
  existing premise protocol as the everyday path (see §7)
- **Changes published support:** yes. One new table, store format 33, one
  migration. No existing record type changes.

## 1. Context

Capture (ADR-020) answered *I found something new*. Its mirror is *something we
believed turned out to be false*, and at multiple agents working one ledger that
mirror is the dominant failure mode: agent 4 builds diligently on an assumption
agent 2 refuted two hours earlier. Claims prevent two agents writing the same
commitment. Nothing prevents many agents executing correctly against a belief
that has already died.

The obvious answer was that Tasq already has premises and merely fails to teach
them. Three open tickets said exactly that.

That answer is wrong, and verifying it is what produced this ADR.

## 2. The premise protocol is adjudication, not motivation

Read against `packages/tasq-core/src/service/premises.ts`, creating a
premise-backed task requires:

- an `observationId` that already exists, whose `kind` is one of five hardcoded
  connector types, plus a digest binding the premise to those exact bytes;
- `eligibleValidatorPrincipalIds`, at least one, each an enabled principal;
- optional adjudicators and an `allowSelfValidation` switch.

Retracting one requires task evidence, then `premise propose --verdict refute`,
then `premise decide --outcome accepted` issued **by a different principal**
unless self-validation was enabled at creation, each with its own idempotency
key. Four record types, and the effect reaches exactly one commitment.

That is a well-built **dispute-resolution protocol between distinct parties**.
Validators, challenges and adjudicators exist because the design anticipates
that someone will contest the claim. It is correct for what it is.

It cannot be the everyday *because*. A maintainer running agents has no second
enabled principal to name as validator, has no connector observation for "we
think list is slow", and will not run a two-principal adjudication to withdraw a
guess. The evidence is direct: **zero of this repository's own 97 commitments
carries a premise**, after the team that built the protocol ran a full chantier
through it.

So the adoption failure is not pedagogical. Teaching harder would produce
ceremony nobody follows, or worse, `--premise-allow-self` everywhere, which
turns an adjudication protocol into a rubber stamp and destroys the property it
exists to provide.

## 3. Decision

Add `assumption` as a distinct kernel record, and leave the premise protocol
exactly as it is.

The two are not competitors and must not be merged:

| | assumption | premise |
|---|---|---|
| answers | why does this work exist | is this contested claim true |
| founded on | a sentence | an observation, digest-bound |
| shape | shared by many commitments | attached to exactly one |
| withdrawal | unilateral, with a reason | proposal, optional challenge, decision by another principal |
| when | always available, never required | escalation when withdrawal is disputed |

An assumption is not a weaker premise. It is the thing a premise presupposes:
premises adjudicate propositions people disagree about, assumptions record what
work rests on so that a change of mind reaches the work.

## 4. Specification

**Record.** Tenant-scoped, append-only, one new table `assumption`:

- `id`, `tenantId`
- `text` - one line, trimmed, 1..200 characters, **immutable**
- `status` - `standing` | `withdrawn`
- `statedByPrincipalId`, `statedAt`
- `withdrawnByPrincipalId`, `withdrawnAt`, `withdrawalReason` (1..2000),
  `withdrawalEvidenceIds` (0..128, optional)

Link table `assumptionLink` binds an assumption to a commitment, many-to-many,
with `linkedByPrincipalId` and `linkedAt`. Unlinking is a row status change, not
a delete.

**Identity.** Two assumptions with the same normalised text in one tenant are
the same assumption. Normalisation is trim plus internal whitespace collapse
plus casefold. This is what makes them shared without asking anyone to look up
an id.

**Withdrawal.** Unilateral. Requires `withdrawalReason`; evidence is accepted
and encouraged but **not required**, because requiring it reproduces exactly the
adoption failure this ADR exists to fix. The record always names who withdrew it
and when, so an unwitnessed withdrawal is visible as such rather than forbidden.

**Effect, and its three limits.** When an assumption is withdrawn, every open
commitment linked to it is marked `assumption withdrawn` and stops being
offered. Three deliberate limits:

1. **One hop.** The effect reaches directly linked commitments only. It does not
   traverse `depends_on` or `parent_of`. A cascade that pauses twenty
   commitments because one sentence fell is unpredictable, and a coordination
   tool people are afraid of is a coordination tool nobody runs.
2. **Never terminal.** Commitments are paused, never cancelled. The system
   surfaces a decision; it does not make one. Recovery is `tasq resume <id>`,
   which unlinks that commitment from the withdrawn assumption and records why.
3. **Never required.** A commitment with no assumption behaves exactly as it
   does today, byte for byte. Zero cost when unused is the condition on which
   this primitive is admitted at all.

**Actionability.** Copy the two-layer pattern the premise path already uses,
because it is right: `pickNext` filters commitments carrying an invalidation ref
out of selection, and `acquireTaskClaim` independently refuses them through
`assertTaskPremiseActionable`. Selection is advisory and a caller holding a
stale list can still reach claim, so neither layer is redundant. Assumption
withdrawal must do both.

> **Correction, 2026-08-26.** An earlier revision of this ADR claimed the
> premise gate was missing at selection, from grepping `assertTaskPremiseActionable`
> and finding one caller. That was wrong: `pickNext`
> (`packages/tasq-service/src/prioritizer.ts`) enforces the same rule by a
> different mechanism, filtering on `TASK_PREMISE_INVALIDATION_URI` directly.
> The error is kept here rather than erased, because it is the exact failure
> this ADR addresses: a conclusion drawn from one search, never restated as a
> checkable belief, propagated into a filed ticket and into this specification
> before anyone tested it.

**Surface.** One flag and two verbs:

```
tasq add "make list paginate" --because "list times out past 10k tasks"
tasq wrong "list times out past 10k tasks" --reason "measured 10k in 240ms" --evidence ev_7c2a
tasq why 41
```

`tasq why` is the read surface the backlog already asks for separately: it walks
the assumption, the `discovered_from` provenance edge and any premise decisions
in one view. MCP gains `tasq_assumption_state` under `read` and
`tasq_assumption_withdraw` under `propose`, matching capture's placement, since
withdrawal proposes a re-examination rather than exercising authority.

**Vocabulary.** The kernel noun is `assumption`. The user-facing words are
`because`, `wrong` and `why`. Documentation never says "truth maintenance",
"justification" or "premise" for this path. The concept a user must hold is: *a
because behaves like a tag that can be declared false.*

## 5. Non-goals

Rejected explicitly, because each is where this design would rot:

- **Editing an assumption.** Immutable one-liners cannot drift into a wiki. A
  changed belief is a new assumption plus a withdrawal of the old one.
- **A description or body field.** Same reason.
- **Requiring an assumption on every commitment.** It would produce filler
  ("because we need it") that costs attention and carries nothing.
- **Automatic escalation to the premise protocol.** Disputed withdrawal is a
  real case and the escalation path is natural, but it is phase 2 and must not
  gate phase 1.
- **A generic `agent.finding` observation kind.** Unchanged from the P5
  analysis: an observation is a fact with a verification level, an agent's
  conclusion is an inference. Assumptions give inferences their own home, which
  removes the pressure that made that idea tempting.

## 6. P10: demonstrated, not asserted

**Software.** During this chantier a fix was twice marked done that had not
held, and a release chain was found broken by its own success in eight places.
Each invalidated the reason other queued work existed. Every one was handled by
hand, in a chat transcript, and the queue was corrected from memory.

**Clinical coordination.** A treatment plan rests on a working diagnosis. A lab
result refuting it must reach every order placed because of it, without deleting
those orders or their history. Cancellation records that someone chose not to
treat, which is a different and dangerous fact.

**Construction.** Foundation design rests on a soil survey. A revised survey
must reach the dependent work packages. Today that reaches them through a
meeting, or it does not reach them.

The failure prevented is identical and domain-independent: **work continues
correctly against a belief that has already been abandoned, because the belief
was never written where the work could see it.**

## 7. Consequences

**Accepted.** Store format 33 and a migration. This is the first new table since
settlement, and the release machinery treats format bumps seriously and
correctly.

**Accepted.** Two things in the ledger now answer "why", assumption and premise,
and the difference must be taught once, clearly, or it will confuse. §3's table
is that teaching.

**Accepted.** Unilateral withdrawal means one agent can pause several
commitments. Bounded by pause-not-cancel, by one hop, and by `tasq resume`.

**Backlog effect.** Three tickets are superseded rather than done, because their
premise was that the existing protocol needed teaching:

- *Teach premise-backed creation, keep its strictness*
- *Teach refutation instead of cancellation in the agent loop*
- *Give retraction the same reach as discovery*

*Make the reasoning chain readable from inspect* survives and becomes `tasq why`.
The P5 observation-kind ticket survives at lower urgency, since assumptions
remove the pressure that motivated it.
