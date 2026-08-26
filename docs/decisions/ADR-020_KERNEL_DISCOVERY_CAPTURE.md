# ADR-020 — Discovery capture belongs to the kernel

- **Status:** Proposed — 2026-08-26
- **Decision owner:** Tasq kernel ontology and agent-facing surfaces
- **Depends on:** ADR-UK-006 (collaboration records), UNIVERSAL_KERNEL_SPEC P10
- **Implementation:** none yet; TQ ticket tracked in the `tasq/dev` ledger
- **Does not change published support:** `v0.4.1` behaviour is unchanged. This
  proposes a kernel API, not a new record type or store format.

## 1. Context

An agent executing a commitment notices something outside that commitment: a
bug, a missing capability, an inconsistency between two surfaces, a refusal it
could not act on. Recording it is part of the work. Losing it costs the
observation permanently, because an agent's context window ends.

`tasq capture` exists for exactly this. It creates a follow-up commitment and a
`discovered_from` relation to the commitment whose execution exposed it, in one
writer transaction, without widening, renewing or releasing the caller's claim.

It is unreachable from MCP.

`captureDiscovery` lives in `packages/tasq-service/src/service/discoveries.ts`.
The MCP server consumes `@tasq-run/core`. So the flagship integration — *point
Claude Code, Codex or any MCP client at the same ledger* — exposes 44 tools and
none of them can report a defect. The agents best placed to notice one have no
way to record it without leaving their task and shelling out to a CLI.

## 2. This is a gap in the kernel, not an expansion of it

The tempting framing is "should discovery capture be promoted into the kernel".
That framing is wrong, and it is worth stating plainly because it changes the
burden of proof.

- `commitmentRelation` is defined in `packages/tasq-schema/src/tables.ts`. The
  relation table is kernel storage.
- `discovered_from` is a **first-party relation type named in
  UNIVERSAL_KERNEL_SPEC §Relation types**: *"informational provenance from newly
  captured work to the commitment whose execution exposed it; never affects
  actionability"*.
- `packages/tasq-core` exposes **no API that writes a relation of any type**.

So the kernel already owns the table and already names the semantics. What is
missing is any kernel operation to write one. Capture is not a new concept
asking for admission; it is an existing kernel concept with no kernel verb.

That also explains why this was invisible: nothing looked absent. The vocabulary
was complete, the storage was complete, and the CLI worked.

## 3. P10: universality is demonstrated, not asserted

The spec admits a primitive only if it prevents a concrete failure in at least
two unrelated domains. Discovery capture does:

**Software.** During the 2026-08-25 review, an agent driving a real backlog
recorded 35 findings that ten independent code reviewers had not produced,
including two fixes previously marked done that had not held, and a release
chain broken by its own success in seven places. Every one was noticed while
executing an unrelated commitment. Without capture, each would have ended in a
chat transcript.

**Physical verification.** A robot runtime holding a claim observes a fixture
out of tolerance, or a calibration drift that is not the commitment it is
executing. Its choices without capture are to abandon the claim in order to
report, or to drop the observation. Both are wrong: releasing ownership to file
a note is precisely the coupling claims exist to prevent.

**Research.** A research runtime finds a source contradiction outside the scope
of the report it was asked to produce. The same shape.

The failure prevented is identical across all three and independent of domain:
**an observation made during execution, about something other than the work
being executed, has nowhere durable to go, and is lost when the executing
context ends.** That is a coordination failure, which is what the kernel is for.

## 4. Decision

Expose discovery capture from `@tasq-run/core` as a kernel operation, and
project it onto the MCP surface under the `propose` capability.

Specifically:

1. Move `captureDiscovery` into `packages/tasq-core`, alongside the commitment
   API it already composes. `tasq-service` keeps a forwarding export so the CLI
   is unaffected.
2. The operation stays exactly what it is today: create one commitment, write
   one `discovered_from` relation, in one writer transaction, reading the source
   commitment and any active claim **read-only**. Capture MUST NOT widen, renew,
   release or otherwise mutate execution authority. This is the property that
   makes it safe to call mid-task, and it is the reason it can be offered under
   `propose` rather than `coordinate`.
3. Add a `tasq_discovery_capture` MCP tool requiring `propose`. Its description
   must state that capture never touches the caller's claim, and that most
   defects are visible while commands succeed, so the agent does not wait for an
   error to justify recording one.
4. Keep the 16 KiB bounded context and the existing idempotency identity.

## 5. Consequences

**Accepted.** The kernel gains its first relation-writing verb. That is a real
widening of the kernel's write surface and should be understood as such: a
future relation API for `depends_on` or `supersedes` will look like a natural
extension of this precedent, and each must still pass P10 on its own.

**Accepted.** Discovery capture becomes available to every MCP host, including
hosts whose agents Tasq does not control. Capture creates commitments, so an
adversarial or malfunctioning agent can create many. This is bounded by the
existing idempotency identity and by `propose` being a capability the host
grants deliberately, and it is the same exposure `tasq_commitment_create`
already carries.

**Rejected alternative: leave it in the profile.** Then the MCP surface stays
unable to report, and the shared-ledger direction cannot work: a commons where
users' agents publish findings requires that agents can file at all.

**Rejected alternative: a thin MCP-only wrapper calling the service.** It would
invert the dependency the architecture is built on — the MCP server would reach
past `@tasq-run/core` into a profile package — for the sake of avoiding a kernel
decision that P10 supports.

## 6. Verification

- Cross-domain conformance gains a capture step in the software and physical
  narratives, proving the claim is untouched across it.
- An MCP test proves the tool is absent under read-only capabilities and present
  under `propose`, matching the existing capability-boundary tests.
- The CLI keeps its current behaviour and tests unchanged, which is the evidence
  that this is a move rather than a redesign.
