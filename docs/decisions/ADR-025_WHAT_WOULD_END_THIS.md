# ADR-025 — What would end this

- **Status:** Proposed - 2026-08-28
- **Decision owner:** @gwendall
- **Written:** before the evidence, deliberately. A criterion authored after the
  data arrives is a rationalisation, and one held only in someone's head is
  renegotiated the first time sunk cost speaks.
- **Changes published support:** no. It changes nothing in the product and
  commits its author to reading a number.

## 1. Why this exists at all

Tasq is well built. Two hundred and sixteen commitments have been closed
through it, it is published, its release chain is gated in five places that did
not exist a week ago, and every package's tests typecheck.

**It has no users.**

That combination is the dangerous one. Continuing to build is pleasant,
measurable, and answers none of the open questions, so the project can stay
healthy-looking indefinitely while the thing that matters goes untested. The
purpose of this document is to make one specific outcome mean *stop*, before
anybody has an interest in it meaning something else.

## 2. The claim being tested

Tasq's thesis, stated so it can fail:

> When several agents share one repository, they collide. A claim ledger with
> an expiring, exclusive lease prevents those collisions, and the prevention is
> worth adopting a tool for.

Three things have to be true. Collisions **happen**. Tasq **prevents** them.
And someone **cares** that it did.

The first two are now measurable. `tasq contention` counts every refusal, and
`tasq fleet` shows who is holding what. Before store format 35 the ledger
recorded everything it allowed and nothing it prevented, which made this
document impossible to write honestly.

## 3. The criterion

**After twenty days of real multi-agent work on a Tasq ledger, if
`tasq contention` reports fewer than five standoffs, stop.**

Not pivot. Stop.

Five is a deliberate floor rather than a calculation. One is noise. Twenty days
of genuine parallel work producing four or fewer moments where the ledger had
to turn somebody away means the collisions the product exists to prevent are
rare enough that nobody needs a product for them. A dependency on the exact
number is a sign the answer was close enough not to matter.

The count must come from work that would have happened anyway. Contrived
collisions prove the code works, which is what the tests are for, and prove
nothing about whether anybody needs it.

## 4. The second criterion, which is softer and matters as much

**If five practitioners already running multi-agent flows are asked the
diagnostic questions and none reports having been bitten by a collision or by
an agent that died without anyone noticing, stop.**

Softer because five people is a small sample and because "bitten" is a
judgement. It matters as much because it is the only test that involves
somebody who is not us, and because a maintainer's own ledger will always
produce collisions if the maintainer wants it to.

The questions are asked **before** showing anything. Showing the product first
converts an interview into a demo and the answers into politeness.

*"The sidebar is fine"* is a valid and useful answer. It must be recorded as
faithfully as enthusiasm.

## 5. What does NOT count as passing

- A collision I created on purpose to see the refusal.
- Somebody saying the idea is interesting. Interest is not adoption.
- A large `attempts` count with a small `situations` count. One agent politely
  retrying is a small problem; two agents each convinced the work is theirs is
  a large one, and only the second is evidence.
- The product being well engineered. It already is, and that is not the
  question.

## 6. What stopping means

Stop building. The code is published, permissively licensed and will keep
working for whoever has it. The ledger, the ADRs and the launch drafts stay up
as a record of what was tried and what the answer was.

It does not mean the reasoning was wrong. It means the wedge - two vendors'
agents on one repository, which no harness will serve because no vendor makes a
competitor a first-class peer - was real and too small, or too early. Both are
worth knowing, and neither is worth another six months to find out slowly.

## 7. When this is evaluated

At twenty days of dogfood, or when the fifth practitioner has answered,
whichever comes first. The date goes here when the count starts.

**Counting started:** _not yet_

If either criterion is met and the decision is to continue anyway, that is
allowed - and it must be written into this file, with the reason, on the day it
is taken. An unwritten override is how a criterion quietly stops existing.
