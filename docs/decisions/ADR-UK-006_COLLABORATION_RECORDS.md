# ADR UK-006 — Universal collaboration records

> **Status:** accepted and implemented — 2026-07-15
> **Decision:** stable principals, explicit assignments, directed commitment
> relations, immutable artifacts/external references/completion records and
> optimistic revisions.
> **Implements:** UK-006; constrains UK-007–UK-011 and ADR-004/005. ADR-004's
> hosted design is now accepted but not implemented; ADR-005 remains future.

## 1. Context

Claims and attempts already let workers coordinate execution, but an unfamiliar
runtime still could not answer several universal questions without interpreting
free-form metadata: who is this actor, who asked whom to contribute, which
external object is this record, what output was produced, which directed
relationship exists, and on what exact basis was completion accepted?

These are collaboration facts, not life-planning or provider facts. They belong
in the kernel only where deterministic invariants prevent ambiguity or lost
history. Authentication, authority, credential storage, workflow execution and
evidence trust policy remain outside this ADR.

## 2. Decision

The kernel adds six record families and a monotone revision on commitments:

```text
principal             stable workspace identity and audit attribution
assignment            proposed/accepted delegation relationship
commitment_relation   directed, typed relationship between commitments
artifact              immutable output descriptor bound to a digest
external_ref          immutable mapping to another system's identity
completion_record     immutable basis for one completed commitment revision
task.revision         optimistic concurrency token for commitment mutation
```

The strict `@tasq-run/core` entrypoint exposes these APIs without
loading a planning profile or reference provider extension.

## 3. Semantic separation

| Record | Means | Explicitly does not mean |
|---|---|---|
| Principal | Stable attribution identity in one workspace | Authenticated subject, permission or mandate |
| Assignment | One principal invites another into a named role | Exclusive execution lease or commitment state |
| Claim | Temporary exclusive right to execute, with expiry/fence | Delegation, employment or approval |
| Attempt | One execution lifecycle | Desired outcome or completion decision |
| Artifact | Immutable produced/referenced output | Evidence that success criteria are satisfied |
| Evidence | Observable basis offered to a completion policy | Artifact ownership or automatic completion |
| Completion record | Exact policy input accepted for one done revision | Claim that all future states remain valid |
| External reference | Stable identity mapping to another system | Provider truth, authorization or secret storage |

A principal may accept an assignment without claiming work. A claimed worker
may execute without having received an assignment. A successful attempt may
produce artifacts while the commitment remains open. These distinctions are
enforced by separate records and services.

## 4. Principal identity and attribution

A principal has a workspace, kind (`human`, `agent`, `service`, `runtime`),
display name, optional local alias, enabled/disabled status and revision.

- Local v1 actor strings are deterministically mapped to
  `urn:tasq:local-principal:<workspace-hex>:<actor-hex>`.
- Migration backfills every historical event, claim, attempt and evidence row.
- New service writes always persist both the compatibility actor label and the
  stable principal ID.
- Explicit principal IDs are checked against the workspace and enabled status.
- Disabling a principal prevents new collaboration actions; it does not erase
  history.

This is attribution only. A remote transport must authenticate its subject and
map that subject to a principal before calling the kernel. Authorization and key
rotation are governed by ADR-004; neither a local alias nor an advertised
capability grants authority.

## 5. Assignments

Assignments use the monotone lifecycle:

```text
proposed ── assignee ──> accepted ── assignee ──> released
    ├────── assignee ──> rejected
    └────── assigner ──> revoked
accepted ── assigner ──> revoked
```

The assigner, assignee, role, commitment and instruction reference are
immutable. Transitions require the correct caller and `expectedRevision`.
Roles are the portable core names `owner`, `contributor`, `reviewer`,
`approver`, or an absolute extension URI. A role is descriptive coordination
state, not an authorization grant.

## 6. Relations

Relations are directional and their names describe that direction:

```text
A depends_on B
A parent_of B
A relates_to B
A duplicates B
A supersedes B
```

Extensions may use absolute URI relation types. Live `depends_on` relations are
cycle-checked. Ending a relation is a revisioned tombstone; re-adding the same
meaning creates a new lifecycle rather than rewriting history.

The legacy `task_dependency` API is a compatibility adapter. `blocks` maps to
`depends_on` with direction preserved (`from` depends on `to`). Both service
surfaces update the canonical and compatibility records in one transaction;
`doctor` reports any drift. New code uses `commitment_relation`.

## 7. Artifacts, evidence and external references

Artifacts require an absolute type URI, schema version, commitment, name,
content digest, and either an absolute URI or inline-data reference. They are
append-only. An optional attempt link must belong to the same commitment.
Correction creates another artifact; content is never mutated in place.

External references bind a kernel record to
`(system URI, resource type, external ID)` with optional URL, version and
digest. That tuple is unique per workspace and records are append-only. The
target must exist when the reference is created. Metadata must be
secret-minimized; credentials never belong here.

Artifacts can become evidence only through an explicit evidence record or
policy decision. A digest establishes content identity, not authenticity or
fitness for purpose. Future ADR-005 defines trust, revocation and high-stakes
validity.

## 8. Revisions and completion records

Commitment, principal, assignment, relation, claim and attempt updates increment
a positive revision exactly once. Canonical commitment and collaboration
mutations accept `expectedRevision`; stale compare-and-swap writes fail without
partial state or events. Claims retain fencing in addition to revisions because
optimistic concurrency cannot stop a stale worker at an external effect
boundary. The v1 compatibility surface may omit revisions until an explicit v2
contract, but the database still increments them.

Every transition to `done` appends a completion record containing:

- the resulting commitment revision;
- completion policy URI/version;
- digest of the policy input;
- the exact evidence IDs considered;
- deciding principal and domain decision time.

Reopening never deletes that record; completing again creates another one.
Migration creates an explicitly named `legacy-unverified` record for each
historically completed task. It preserves inspectability without fabricating a
cryptographic or trust claim.

## 9. Time, retries and audit

- Every creation/transition takes one injected-clock snapshot. Explicit domain
  timestamps remain separate and win where documented.
- No collaboration service reads the device clock directly.
- Retriable creates use the durable workspace idempotency ledger; reusing a key
  with different canonical input fails.
- Task-scoped mutations append a principal-attributed event in the same
  transaction. External references attached to a task-owned record emit on
  that commitment; principal-only references remain administrative history.
- Immutable outputs and completion records cannot be updated or deleted even
  by direct SQL.

## 10. Migration and compatibility

Migration `0013_universal_collaboration.sql` is additive. It:

1. creates and backfills stable local principals;
2. adds nullable principal references to historical attribution rows;
3. adds revisions and strict update guards to commitments, claims and attempts;
4. migrates legacy dependencies to canonical directed relations;
5. creates assignments, artifacts, external refs and completion records;
6. backfills honest legacy completion records;
7. installs append-only, workspace, ownership and revision guards.

Existing CLI JSON v1 fields and commands do not change. Nullable migrated
principal columns remain a storage compatibility concession; `doctor` treats a
new unattributed row as invalid.

## 11. Rejected alternatives

- **Keep actors and provider IDs in metadata:** not queryable or safely
  interoperable, and no referential integrity.
- **Make assignment equal claim:** delegation outlives leases and may involve
  several non-exclusive roles.
- **Make remote task equal commitment:** protocol execution success is not proof
  that the desired outcome exists.
- **Use undirected dependency names:** direction becomes interpretation and
  breaks cross-runtime compatibility.
- **Store artifact bodies in the ledger:** duplicates blob storage, secrets and
  retention policy; the ledger stores content identity and location.
- **Overwrite completion basis on reopen:** destroys the decision history needed
  for audit, recovery and policy improvement.
- **Treat principal/capability as authority:** creates a confused-deputy path;
  effect authorization requires the later authority/effect model.

## 12. Acceptance evidence

UK-006 is accepted when migration, state-machine, stale-revision,
cross-workspace, append-only, idempotency, compatibility-adapter, doctor,
controlled-clock and agent-flow tests all pass, all package typechecks pass,
and current-state/onboarding documents describe the records without claiming
that authentication, authority or evidence trust has shipped.
