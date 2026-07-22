# TQ-503 — Reusable context stays external

> **Status:** implemented 2026-07-20
> **Contracts:** `tasq.external-context-link.v1`,
> `tasq.external-context-link-page.v1`
> **Surfaces:** strict embedded kernel, CLI, local capability-scoped MCP,
> canonical inspection and cold onboarding

## 1. Decision

Tasq is not a memory system. It does not store conversations, notes, runbook
bodies, embeddings, vector indexes, retrieval policy or memory credentials.
Those concerns have different truth, retention, privacy, search and
authorization owners from coordination.

Real workflows nevertheless demonstrated one missing coordination fact:

> this commitment should use that externally owned context identity.

The same robot calibration runbook, deployment procedure or research method
must be reusable by several commitments. A cold actor must be able to discover
the association, and an auditor must be able to tell which version was
referenced. TQ-503 therefore adds an append-only **external context link**, not
a memory record or memory provider.

## 2. Why the existing records were insufficient

| Candidate | Why it is wrong for reusable context |
|---|---|
| commitment/task | Turns knowledge into desired work and corrupts lifecycle/status meaning. |
| summary | Describes one terminal commitment source; it becomes stale with that source and is not reusable memory. |
| artifact | Is an immutable output owned by one commitment/attempt, not a living external knowledge identity. |
| evidence | Offers observable completion basis and may affect completion policy; a runbook is not proof of success. |
| metadata | Hides an unqueryable, mutable convention with no CAS, history or common agent contract. |
| `external_ref` | Maps one Tasq record to one external object identity. Its workspace-unique external tuple intentionally prevents ambiguous protocol imports, while knowledge reuse is many-to-many. |
| runtime-only retrieval | Can remain useful for semantic search, but leaves no shared, resumable record of the context deliberately associated with this commitment. |

Changing `external_ref` uniqueness would weaken remote task and artifact
identity. Adding a small relation with different semantics preserves both
invariants.

## 3. Contract

An external context link contains only:

- workspace and commitment identity;
- an absolute `purposeUri` (the neutral default is `reference`);
- external system URI, resource type and stable external ID;
- optional URL, content version and digest;
- append action, exact superseded link and attribution;
- derived `binding` and lifecycle `state`.

`binding` is deliberately honest:

- `pinned` — a version or digest identifies the referenced external content;
- `floating` — the external identity is known but its content can change.

Neither state claims authenticity, freshness, readability, safety or
authorization. Target fields are actor-provided data, never runtime control.
Tasq never follows the URL.

## 4. Lifecycle and concurrency

```text
attach root ──> attach correction ──> detach tombstone ──> attach again
```

Every row is immutable. A new row names the exact current leaf in
`supersedesLinkId`; a stale leaf fails. Unique root and child indexes elect one
winner under concurrent append. Detach copies the same target identity and
appends a tombstone, so history is never rewritten or lost.

The chain identity is:

```text
(workspace, commitment, purpose URI, system URI, resource type, external ID)
```

The external tuple can therefore be linked independently to any number of
commitments while each commitment has one unambiguous current chain for that
purpose and target.

Attach and detach require durable caller-scoped idempotency. Rows and audit
events use one injected clock snapshot. Database guards enforce live
same-workspace commitment, enabled same-workspace principal, matching parent
identity, append-only storage and no repeated detach.

## 5. Agent surfaces

Cold onboarding advertises read recipes to list current/history and coordinate
recipes to attach/detach. The attachment recipe asks for a version so its
default journey is pinned.

```bash
tasq context-link attach <commitment-id> \
  --system https://memory.example \
  --resource-type runbook \
  --external-id robotics/calibration/left-arm \
  --version v7 \
  --idempotency-key agent-link-7 \
  --tenant robotics --actor agent:planner --json

tasq context-link list <commitment-id> \
  --tenant robotics --actor agent:reader --json

tasq context-link list <commitment-id> --history \
  --tenant robotics --actor agent:reader --json

tasq context-link detach <current-link-id> \
  --idempotency-key agent-detach-7 \
  --tenant robotics --actor agent:planner --json
```

CLI `list` returns current active leaves by default. Empty current items do not
prove no history; `--history` returns superseded and detached records.

Read-capable MCP hosts expose `tasq_context_link_list/get`. Coordinate-capable
hosts additionally expose `tasq_context_link_attach/detach`. Capability
filtering remains fail-closed. Embedded clients use
`attachExternalContextLink`, `detachExternalContextLink`,
`getExternalContextLink` and `listExternalContextLinks`.

Discovery advertises
`https://schemas.tasq.dev/capabilities/external-context-links` and exact
operation names. Canonical `tasq.inspect.v1` includes complete link history;
`tasq.context-packet.v1` remains byte/schema compatible and continues to point
agents to inspection rather than copying external context into a bounded
packet.

## 6. Interaction with source-bound summaries

New terminal summaries record exact `externalContextLinkIds` and include links
in the canonical source digest. Adding, correcting or detaching a context link
also appends a raw task event, so a previously current summary becomes visibly
stale. Summaries written before migration `0024` remain parseable without the
new optional reference list.

A summary still cannot become memory, and a context link still cannot become
evidence or completion authority.

## 7. Security and ownership boundary

Tasq does not:

- fetch or render the linked content;
- authenticate the external system;
- store access tokens, provider payloads or note bodies;
- guarantee that URL and external ID agree;
- infer that a digest is signed or trusted;
- grant tools, effects or commitment authority from a target or purpose URI;
- perform vector retrieval or decide which memory is relevant;
- delete or update the external object when a link is detached.

The host or memory connector owns retrieval and credentials. Its policy must
still treat returned content as untrusted data. If fetched knowledge affects a
high-stakes completion, the actor must create the appropriate evidence and
authority records separately.

## 8. Replication and transport boundary

Migration `0024_external_context_links.sql` is additive. TQ-405 currently
replicates only its documented neutral commitment projection, so external
context links do not yet converge across independent authorities. They are
shared when actors use the same store/transport and exact workspace.

A hosted surface may transport these records later, but remote identity and
permission are ADR-004/TQ-505 concerns. No local actor alias proves permission
to read the external memory system.

## 9. Acceptance evidence

Executable service tests prove:

- one external knowledge identity can be reused across commitments;
- pinned versus floating is explicit;
- exact retry replays while changed retry bytes fail;
- stale CAS, cross-workspace references and repeated detach fail closed;
- update/delete are rejected directly by SQLite;
- explicit `now` wins over a forbidden clock.

CLI E2E executes the recipes returned by a fresh `onboard`, then lists,
detaches, reads history and inspects the canonical graph. MCP tests prove
read/coordinate isolation and the same flow. Cross-domain evals repeat the
contract for robotics, software and research, use unreachable external URLs to
prove there is no hidden fetch, and inspect the physical table to prove it has
no content, body, embedding, credential or authority column.

## 10. Deliberate non-goals

- no bundled memory product or preferred provider;
- no semantic search API;
- no automatic link recommendation;
- no copied memory snippets in context packets;
- no claim that floating context is reproducible;
- no promotion of actor-authored context into instructions or authority.

This closes TQ-503 by adding exactly the missing coordination relation while
keeping the memory lifecycle outside the universal kernel.
