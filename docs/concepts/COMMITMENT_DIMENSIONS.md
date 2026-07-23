# Commitment dimensions and compositional model

**Status:** accepted clarification of the existing universal-kernel boundary

**Updated:** 2026-07-23

**Language:** [`CONTEXT.md`](CONTEXT.md)

**Normative kernel contract:** [`UNIVERSAL_KERNEL_SPEC.md`](UNIVERSAL_KERNEL_SPEC.md)

## 1. Decision

Tasq does not grow by adding every useful property to one `task` record.
It uses a small commitment nucleus plus orthogonal first-class records whose
invariants compose.

The nucleus answers:

```text
What outcome is owed?
What observable criteria mean satisfied?
What is its explicit lifecycle state?
When may it start, and when is it due?
```

Independent records answer:

```text
How is it related to other commitments?
Who is responsible?
Who may work right now?
What execution occurred?
What did it produce?
What happened in the external world?
What evidence supports completion?
Who or what validated that evidence?
What external effect was authorized?
```

This is a pyramid of semantics, not a flat feature list and not a single
all-knowing task object.

## 2. Composition pyramid

```text
surfaces       CLI · MCP · Console · REST · SDK
policies       ranking · recurrence · validation · assignment · reminders
adapters       extensions · connectors · protocols · runtimes
kernel         commitments · relations · coordination · execution · evidence
durability     revisions · idempotency · audit · cursors · workspace isolation
```

Each layer has a different reason to change:

- **durability** preserves correctness across retries, crashes and replicas;
- **kernel** owns cross-domain coordination invariants;
- **adapters** translate domain facts and execution without changing meaning;
- **policies** make replaceable choices;
- **surfaces** present journeys without becoming another source of truth.

The public interface should still be deep. A caller should use an atomic
journey such as claim-and-start, submit-evidence or validate-completion without
manually coordinating every row. The records stay separate inside the module
because their invariants, lifetimes and authority differ.

## 3. Dimension inventory

| Dimension | Canonical model | Layer | Current state |
|---|---|---|---|
| Desired outcome | `commitment` | Kernel | Implemented as task-compatible commitment |
| Lifecycle | commitment status | Kernel | Implemented |
| Success meaning | criteria + completion policy | Kernel/policy seam | Assertion and evidence-required implemented; independent validation is TQ-612 |
| Earliest useful start | `not_before` | Kernel | Implemented through `scheduled_at` compatibility |
| Due time | `due_at` | Kernel | Implemented |
| Recurrence | rule/template generating instances | Scheduling profile | Implemented compatibility materializer; conceptually outside minimal kernel |
| Decomposition | `parent_of` relation | Kernel | Implemented; historical parent field remains compatible |
| Sequence | acyclic `depends_on` graph | Kernel | Implemented |
| Explicit impediment | `blocked` lifecycle state | Kernel | Implemented |
| External wait | condition → observation → reconciliation | Kernel + extension | Implemented |
| Responsibility | assignment | Kernel | Implemented |
| Active ownership | expiring claim + fence | Kernel | Implemented |
| Shared scarce thing | resource lease + fence | Kernel | Implemented |
| Execution | attempt | Kernel/runtime seam | Implemented |
| Output | artifact | Kernel | Implemented |
| Proof | evidence | Kernel | Implemented |
| Validation | proposal → decision → completion | Kernel/policy seam | Completion record exists; proposal/decision/challenge are TQ-612 |
| External action | effect → approval → receipt | Kernel/connector seam | Implemented locally; remote effects remain disabled |
| Provenance | principal, event, external reference | Kernel | Implemented |
| Recovery | revision, idempotency, cursor, backup | Durability | Implemented locally |
| Priority and urgency | policy projection | Planning profile | Implemented in bundled life-planning policy, not universal |
| Estimate, cost and value | policy/profile data | Policy | Compatibility fields exist; no universal meaning |
| Capability matching | assignment policy over principal references | Policy/extension | Deliberately not kernel-owned |
| Visibility and permission | authenticated workspace authority | Server composition | Local attribution exists; Server work remains planned |
| Reminder and notification | delivery/runtime behavior | Runtime/connector | Deliberately outside kernel |
| Conversation and memory | external context references | Runtime/external system | Tasq stores pointers, not bodies |

## 4. Time is several different concepts

One timestamp field cannot safely represent every temporal meaning.

### Eligibility

`not_before` means “do not consider this commitment actionable before this
instant.” It does not mean overdue, scheduled execution or reminder delivery.

### Deadline

`due_at` means “the outcome is expected by this instant.” Lateness is derived;
the deadline does not run the work and does not automatically cancel it.

### External-world deadline

A condition may have its own deadline and deterministic fallback. For example,
“receive the reply before Friday, otherwise create a follow-up commitment.”
That condition deadline is not the commitment's general due date.

### Execution timers

Workflow retries, sleeps and polling belong to the runtime. Tasq may record
their attempt state but does not become Temporal, Restate or a cron engine.

### Recurrence

A recurrence rule is a generator:

```text
rule: every Monday
             │
             ├─ commitment instance: 2026-07-27
             ├─ commitment instance: 2026-08-03
             └─ commitment instance: 2026-08-10
```

Each occurrence has independent ownership, attempts, evidence and completion.
Tasq must not reopen one eternal commitment and erase which occurrence was
missed or completed.

The current v1 record retains recurrence fields for compatibility and the
bundled planning profile deterministically materializes the next instance.
The universal meaning remains a scheduling-profile rule producing commitments,
not a mandatory kernel ontology.

## 5. “Blocked” is three different situations

The word blocker is overloaded. Tasq keeps these cases separate.

### Explicit blocked state

A human or policy declares that progress cannot currently continue. This is a
lifecycle statement and remains visible even if no machine-readable dependency
exists.

### Structural dependency

`B depends_on A` means B is not actionable until A resolves under the declared
relation semantics. It does not silently rewrite B's lifecycle to `blocked`.

A sequence is therefore a partial-order graph:

```text
A <-depends_on- B <-depends_on- C
```

There is no universal mutable “position 2” field. A UI may project a linear
order when the graph happens to be linear.

### External condition

“Wait for the customer reply” is neither a commitment dependency nor merely a
blocked label. It is a typed condition evaluated against immutable external
observations.

Claims, resource contention and future eligibility can also make work
non-actionable without changing lifecycle state.

## 6. Generated work is not automatically owed work

An agent can generate a decomposition, but generation alone must not create
authority or silently burden the shared ledger.

The distinction is:

```text
suggested outcome --acceptance policy--> commitment
```

Today, a caller with mutation capability creates a commitment directly and its
principal/event provide provenance. Tasq does not yet expose a general durable
proposal-and-acceptance lifecycle for suggested commitments.

Until a cross-surface need proves that new kernel primitive, automated planning
should keep drafts in its policy/runtime and create Tasq commitments only after
the configured acceptance step. If durable multi-party negotiation over
suggested work becomes a demonstrated use case, a `commitment proposal` may be
admitted separately; it must not be smuggled in as `status=open`.

Templates and recurrence rules follow the same principle: they produce
commitments but are not themselves unfinished commitment instances.

## 7. What belongs in the kernel

A candidate primitive enters the kernel only when all are true:

1. it prevents a concrete coordination failure in at least two unrelated
   domains;
2. it has invariants or concurrency semantics that cannot be reconstructed
   safely from generic metadata;
3. it has an independent lifecycle, identity or audit requirement;
4. it is not derivable from existing records;
5. its meaning is stable without provider, UI or organizational policy;
6. one service-layer operation can preserve it transactionally.

Examples that pass:

- claim: prevents two workers from believing they own the same work;
- attempt: separates execution success from an owed outcome;
- evidence: preserves the immutable basis of a completion decision;
- relation: preserves direction, workspace safety and cycle rules;
- resource lease: fences non-commitment resources against stale workers.

## 8. What stays above the kernel

The following are useful but not universal coordination primitives:

- ranking formulas, urgency and “next best action”;
- story points, effort estimates, business value and cost;
- team-specific statuses, sprint membership and personal areas/goals;
- reminder channels, notification schedules and escalation messages;
- calendar availability, time-zone presentation and locale rules;
- agent capability scoring and automatic worker selection;
- domain-specific approval thresholds;
- provider credentials and API behavior;
- prompt, conversation, checkpoint and memory bodies;
- form layout, board columns and dashboard grouping.

They belong to profiles, policies, extensions, connectors, runtimes or
surfaces. When one of them drives durable coordination, its policy identity and
result may be recorded without moving the policy algorithm into Core.

## 9. Dimensions often missed

### Acceptance versus generation

Who suggested work is not the same as who accepted an obligation. Untrusted
agent decomposition must not become shared debt merely because it was emitted.

### Assignment versus active work

The responsible principal may not be the worker currently holding the claim.
Responsibility, temporary ownership and permission are independent.

### Output versus proof

A document, pull request or robot trajectory is an artifact. It becomes
evidence only when bound to a criterion with provenance.

### Evidence versus validation

Evidence can exist without proving the claim. TQ-612 adds versioned
deterministic, attested, optimistic and adjudicated validation decisions.

### World facts versus interpretation

An observation records what a connector saw. A versioned evaluator records what
that fact means for a condition. Neither silently completes the commitment.

### Risk and authority

High stakes change who may decide or execute, not the definition of a
commitment. Effect approvals, Server authorization and completion policies own
that authority.

### Uncertainty

Unavailable or contradictory evidence should produce an explicit
`indeterminate` validation outcome, not guessed success or failure.

### Correction and supersession

Completed, cancelled or mistaken work remains part of history. Revisions,
superseding evidence/relations and new completion records preserve the prior
basis instead of rewriting it.

### Privacy and tenancy

Sensitivity and access are workspace/authority concerns. A free-form metadata
flag such as `private=true` cannot replace authenticated routing and
authorization.

## 10. Stress-test scenarios

### Monthly bookkeeping

- A monthly rule produces one commitment per month.
- April can be late while May is not yet eligible.
- Each month has separate receipts and completion.

### Product release sequence

- “Deploy” depends on “merge” and “tests pass.”
- Tests passing may be a typed external condition.
- The deployment runtime's success closes its attempt only.
- Health evidence and validation complete the deployment commitment.

### Customer delivery

- A logistics actor is assigned responsibility.
- One driver holds the active claim.
- The vehicle loading bay is protected by a resource lease.
- A carrier scan is an observation; recipient confirmation may be independent
  validation.

### Agent-generated plan

- A planner proposes ten outcomes.
- Policy accepts three as commitments, rejects five and asks a human about two.
- Only the accepted three enter the actionable graph.
- The planner does not gain authority to execute consequential effects.

### Ambiguous research result

- The report is an artifact with a digest.
- The source bundle is evidence.
- The author cannot satisfy a human-acceptance policy alone.
- A disputed review remains challenged or indeterminate rather than silently
  done.

## 11. Product consequence

Tasq should expose simple journeys while retaining this internal algebra:

```text
capture outcome
  -> derive actionability
  -> assign or claim
  -> record execution
  -> bind evidence
  -> validate
  -> complete
```

The interface earns depth when it hides transactional ordering, retries,
revision checks, fences, audit and policy plumbing. It becomes shallow if every
caller must manually create and coordinate all underlying rows.

The product therefore needs both:

- **small composable primitives** for correctness and portability;
- **deep journey modules** for humans and agents to use them without learning
  the implementation graph.

## 12. Progressive disclosure and simple todo use

The existence of advanced primitives must not force advanced workflow. All
levels use the same ledger and commitment semantics; a user adopts only the
next capability needed.

### Level 0 — Simple todo

```text
add -> list -> done
```

- assertion completion;
- no claim, attempt, evidence, dependency or condition required;
- appropriate for one human or one agent with no contention;
- advanced records remain absent rather than filled with meaningless defaults.

### Level 1 — Shared coordination

```text
next -> claim -> work -> done
```

- add block/unblock and `depends_on` only when needed;
- appropriate when several humans or agents can duplicate work;
- claim expiry and fences stay behind the journey interface.

### Level 2 — Durable execution and proof

```text
claim -> attempt -> artifact/evidence -> validate -> complete
```

- appropriate across crashes, runtime changes and review boundaries;
- success criteria and evidence mode are explicit;
- replacement agents resume from durable identity and cursors.

### Level 3 — External-world coordination

```text
condition/observation -> reconciliation
effect/approval -> receipt
```

- appropriate for provider facts, robots, deployments, money or consequential
  communication;
- extensions, connectors and authority are configured deliberately.

These are usage levels, not separate database modes or editions. A simple todo
may later gain a dependency or evidence requirement without migrating to
another product.

The onboarding target is:

- one explicit human setup that chooses space and attribution, followed by bare
  `add`, `list` and `done`;
- one native-skill or machine-contract handoff for an agent, followed by the
  three core coordination verbs;
- advanced concepts absent from the first-run explanation until the user
  selects a journey that requires them.

The current v0.1 CLI already permits assertion-mode `add`, `list` and `done`,
but public setup, acquisition and command discovery do not yet meet this
progressive-disclosure target. TQ-609/TQ-610 own that product correction.
