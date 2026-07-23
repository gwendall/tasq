# TQ-320 — interactive agent-runtime consumer conformance

> **Status:** complete; candidate and exact protected `0.1.0` package replays
> pass on both supported targets
> **Proposed contract:** `tasq.interactive-runtime-consumer.v1`
> **Motivating consumer:** Denshin-style machine, terminal and agent-session
> control planes

## Outcome

Prove that an external interactive agent runtime can consume one Tasq
commitment without becoming its source of truth. The runtime may launch or
resume a durable conversation, expose multiple execution runs, pause for human
input and publish bounded outputs. Tasq continues to own the commitment,
assignment, cross-runtime claim, attempt history, evidence and explicit
completion basis.

This item is a consumer contract and black-box conformance gate first. It does
not authorize a new kernel entity, a Denshin dependency, a prompt builder or an
agent scheduler.

## Candidate result

The pre-public candidate now passes from generated npm tarballs installed in a
clean directory. The fixture accepts an assignment, deduplicates a lost
external launch and lost attempt-start response, pauses and resumes one attempt
through `input_required`, survives claim expiry with a higher-fence reclaim,
exits the first adapter process, recovers in a second process from a persisted
event sequence plus runtime lookup, and runs another attempt in the same
conversation. The protected dispatch gate rejects both the expired claim and
the stale fence. Attempt success leaves the commitment open; a digest-bound
artifact remains distinct from evidence and completion remains an explicit
evidence-aware transition.

The trial required no new record or assignment packet. It did expose a Local
agent ergonomics gap: autonomous onboarding did not advertise retry-safe
attempt transitions or exact event-cursor resume. Additive recipes now cover
attempt start/pause/resume/success, attempt-bound evidence and `audit.resume`;
the established claim/start/complete recipes remain the surrounding lifecycle.
The CLI transitions themselves also accept caller-stable retry identity and
compare-and-swap revisions. Frozen compatibility JSON continues to omit
revisions; canonical `commitment.inspect` supplies every CAS revision.

Machine, session and conversation identities remain opaque references. The
fixture contains no Denshin dependency, credentials, transcript content,
terminal bytes or device-clock authority. Machine evidence is recorded in
`TQ-320_INTERACTIVE_RUNTIME_CERTIFICATION.json`.

## Why TQ-304 is not the complete proof

TQ-304 proves reconciliation with Temporal, Restate and LangGraph. Those
runtimes expose durable workflow identities and authoritative execution state.
An interactive agent control plane adds a different identity shape:

```text
machine -> execution environment -> conversation/session -> run
```

One conversation may survive several runs. A run may pause for input, finish
without satisfying the commitment, or be replaced by a later attempt in the
same conversation. The conformance gate must prove those distinctions without
copying machine, terminal or conversation ownership into Tasq.

## Ownership boundary

| Concern | Tasq owns | Interactive runtime owns |
|---|---|---|
| Desired outcome | commitment and success criteria | no |
| Delegation | assignment | provider/runtime routing policy |
| Cross-runtime exclusivity | claim, expiry and fence | local worker scheduling |
| Execution history | attempt identity and coarse lifecycle | conversation, checkpoints, transcript and streaming |
| Runtime location | external references only | machine, environment, terminal and session lifecycle |
| Output | immutable artifact/evidence references | raw files, messages and provider-native results |
| Human interruption | optional `input_required` attempt state | native question/permission interaction |
| Completion | explicit evidence-aware transition | never implicit from run success |

An adapter may render Tasq state in the runtime's UI. It may not treat a
runtime task, provider todo or terminal exit as a Tasq commitment unless an
explicit import policy creates one.

## Identity mapping

The adapter chooses stable identities before launching work:

| Tasq field | Interactive runtime mapping |
|---|---|
| `principal` | authenticated or explicitly local agent/runtime identity |
| `runtime` | versioned runtime family, never a hostname or PID |
| `externalId` | one stable run/execution identity |
| `contextId` | stable resumable conversation or session identity |
| `external_ref` | canonical machine, environment, session, repository or change identity |
| `idempotencyKey` | deterministic identity for each retriable ledger mutation |

Machine and session identities remain opaque external references. Generic
metadata must not become a shadow machine schema. Credentials, prompts,
transcripts, terminal bytes and provider payloads stay outside Tasq.

## Required handoff loop

The black-box scenario must exercise this sequence through existing public
surfaces before proposing new storage:

```text
read bounded Tasq context
-> inspect one commitment
-> accept assignment
-> acquire claim and retain fence
-> launch or resume one external conversation
-> start one Tasq attempt with stable run and context identities
-> reconcile running <-> input_required -> terminal
-> append digest-bound artifact or verified evidence
-> release claim
-> complete explicitly, or leave the commitment open
```

Starting another run in the same conversation creates another attempt with the
same `contextId` and a new `externalId`. Resuming the same non-terminal run
reuses the existing attempt and idempotency identity.

## Adversarial acceptance

The conformance harness must prove:

1. a lost launch or attempt-start response cannot create a duplicate external
   run or a duplicate Tasq attempt;
2. stale claims and fences cannot authorize protected effects;
3. an expired claim does not rewrite an attempt that is still executing;
4. `input_required` resumes the same attempt instead of fabricating another;
5. terminal runtime state is immutable and out-of-order observations converge;
6. run success leaves the commitment open until explicit completion;
7. artifacts remain distinct from evidence;
8. one conversation can contain multiple sequential attempts without identity
   collision;
9. machine/session references reveal no credentials or raw terminal content;
10. an adapter crash can recover from Tasq cursors and runtime lookup alone.

The repository fixture may use Denshin-shaped identities and lifecycle states,
but Tasq must not import Denshin packages or add Denshin-specific enums.

## Possible projection, not an approved primitive

The first implementation must try `buildContextPacket` plus
`inspectCommitment`. If those surfaces force every consumer to assemble an
unsafe or unbounded handoff, TQ-320 may propose a read-only
`tasq.assignment-packet.v1` projection containing only:

- commitment and success criteria;
- assignment and current claim/fence;
- blocking relations;
- bounded external context references;
- inspection coordinates and audit cursor.

It must not synthesize a prompt, retrieve external memory or grant execution or
effect authority. No packet API enters Core until the conformance evidence
demonstrates the concrete gap in at least one second unrelated runtime shape.

## Dependencies and order

TQ-320 depends on the completed TQ-304 runtime recipes and TQ-501 bounded
context contract. Candidate execution was deliberately completed before
TQ-603 from deterministic installable package tarballs. Protected run
[30015923266](https://github.com/gwendall/tasq/actions/runs/30015923266)
then consumed the exact `@tasq-run/*@0.1.0` registry tarballs on both supported
targets and closed the publication gate. TQ-320 does not block internal TQ-805
Server work.

TQ-607 first ran the same identity/lifecycle shape as a private dogfood
consumer to discover product friction. The stricter package-independent and
protected public-package proofs now both pass.

## Definition of done

- the human and machine product contracts describe the interactive-runtime
  consumer and its irreducible inputs;
- one package-independent black-box fixture passes launch, resume,
  `input_required`, multi-run and crash/retry scenarios;
- the fixture uses existing Core, CLI, MCP or guarded REST contracts without a
  provider-specific kernel change;
- any newly required projection or mutation is justified by recorded failure,
  versioned and bounded;
- product truth remains `implemented_integration_required` until an external
  adapter and release-byte journey pass;
- Denshin, or another real consumer with the same shape, keeps Machine,
  terminal, conversation and runtime execution ownership.
