# Tasq coordination context

Tasq names durable obligations and the independent records needed to coordinate
their ownership, execution and resolution. The language deliberately separates
what is owed from who works, what ran, what happened in the world and who
decided the outcome.

## Intent and state

**Commitment**:
A durable desired outcome that remains owed until explicitly completed or
cancelled.
_Avoid_: Todo, job, invocation

**Commitment proposal**:
A suggested outcome that has not yet been accepted as owed work.
_Avoid_: Open commitment, generated task

**Lifecycle state**:
The explicit declared state of a commitment: open, in progress, blocked, done
or cancelled.
_Avoid_: Readiness, execution status

**Actionability**:
A derived answer to whether work may usefully start now, based on lifecycle,
time, dependencies, claims, resources and policy.
_Avoid_: Status, priority

**Success criterion**:
An observable condition that defines what would satisfy a commitment.
_Avoid_: Output, attempt success

## Structure and time

**Relation**:
A typed, directed connection between commitments, such as decomposition,
dependency, duplication or supersession.
_Avoid_: Generic link, metadata edge

**Dependency**:
A relation stating that one commitment is not actionable until another
commitment reaches the required resolution.
_Avoid_: Blocked status

**Eligibility time**:
The earliest time at which a commitment may become actionable.
_Avoid_: Deadline, reminder

**Deadline**:
A time constraint after which lateness or a fallback policy may apply.
_Avoid_: Eligibility time, execution timer

**Recurrence rule**:
A policy that generates distinct commitment instances on a cadence.
_Avoid_: Reopening one eternal commitment

**Commitment instance**:
One independently completable occurrence produced by a recurrence rule or
template.
_Avoid_: Recurrence rule

**Condition**:
A typed external-world fact that a commitment is waiting to observe.
_Avoid_: Dependency, blocked state

## Collaboration and execution

**Principal**:
A stable reference to a human, agent, service or runtime participating in a
workspace.
_Avoid_: Actor label as authority

**Assignment**:
A durable record of responsibility or delegation for a commitment.
_Avoid_: Claim, permission

**Claim**:
An exclusive, expiring and fenced right to actively work on a commitment.
_Avoid_: Assignment, ownership forever

**Resource lease**:
An exclusive, expiring and fenced right to use an opaque non-commitment
resource.
_Avoid_: Claim, assignment

**Attempt**:
One concrete execution toward a commitment, with its own terminal history.
_Avoid_: Commitment, workflow definition

**Artifact**:
An immutable output produced or referenced by an attempt.
_Avoid_: Evidence

## Observation and resolution

**Observation**:
An immutable, source-attributed fact reported from the external world.
_Avoid_: Interpretation, completion command

**Reconciliation**:
The immutable result of applying one versioned evaluator to a condition and an
observation.
_Avoid_: Observation, completion

**Evidence**:
An immutable binding that explains why an artifact, observation or receipt
supports a success criterion.
_Avoid_: Any output, validator decision

**Evidence trust record**:
An immutable, authority-attributed statement about the authenticity, validity
and retention of one exact evidence record; correction or revocation appends a
new trust record.
_Avoid_: Reputation score, evidence content

**Resolution contract**:
An immutable policy snapshot that freezes criteria, evidence constraints,
validator eligibility, uncertainty behavior and challenge rules for completion.
_Avoid_: Task status, mutable checklist

**Completion proposal**:
A claim that named criteria are satisfied by specific evidence.
_Avoid_: Completion record

**Completion challenge**:
An immutable reasoned objection to one completion proposal, optionally with
counter-evidence.
_Avoid_: Rejected task, mutable comment

**Validation decision**:
An immutable accepted, rejected, challenged, too-early or indeterminate
decision under one versioned completion policy.
_Avoid_: Evidence, effect approval

**Completion record**:
The immutable basis of one successful transition of a commitment to done.
_Avoid_: Attempt success, validation proposal

## External action and composition

**Effect**:
An exact proposed external side effect with distinct authorization, execution
and receipt records.
_Avoid_: Mutation, tool call

**Extension**:
Versioned domain schemas and deterministic evaluators composed with the
kernel.
_Avoid_: Connector, policy

**Policy**:
Replaceable interpretation or choice over kernel state, such as ranking,
recurrence, validation or assignment selection.
_Avoid_: Kernel invariant

**Connector**:
An adapter that owns provider credentials, I/O and authentic observations or
receipts.
_Avoid_: Extension, kernel

**Runtime**:
The system that owns execution, checkpoints, timers and retries for attempts.
_Avoid_: Tasq commitment ledger

**Surface**:
A human or machine interaction path over the same coordination truth.
_Avoid_: Second state model
