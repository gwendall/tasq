# ADR-023 — Decomposition is a column, not a relation

- **Status:** Proposed - 2026-08-27
- **Decision owner:** Kernel ontology
- **Unblocks:** exposing decomposition over MCP, which cannot be designed while
  it is unclear whether a child is an edge or a field
- **Changes published support:** no. It removes two relation types that no code
  has ever written, and corrects a spec that claimed more than the
  implementation does.

## 1. Context

`RELATION_TYPES` declares six first-party types, and
UNIVERSAL_KERNEL_SPEC §Relation types documents all six. **Two of them have no
writer anywhere in the repository:**

- `parent_of` — "structural decomposition". Hierarchy actually lives in the
  `task.parentTaskId` column.
- `supersedes` — "append-only correction lineage". The `supersedes*`
  identifiers elsewhere in the codebase are unrelated scalar columns on
  evidence, decisions, summaries and context links.

A DB CHECK, a Zod enum and a published spec all agree on a vocabulary the
implementation does not produce. That is the failure this project keeps finding
in itself, and it blocks a real decision: exposing decomposition over MCP
requires knowing whether a child is an edge or a field.

## 2. Decomposition must be single-parent, and a column is what enforces that

Both are expressible. The question is which one the constraint falls out of.

A commitment has **exactly one** parent or none. That is not a preference; it
is what makes decomposition mean anything. Earlier reasoning about a shared
library ticket serving three projects reached the same place from the other
side: a commitment with three parents belongs to nobody, and the honest shape
is that the shared work lives where it belongs while the consumers hold
`depends_on` edges to it. Decomposition answers *what is this made of*;
dependency answers *who is waiting on what*. Only the second is many-to-many.

The column gets single-parent from a foreign key. A relation table would need a
partial unique index to forbid what the column cannot express, and every reader
would have to trust that the index exists.

The column also already carries the guards a relation would have to grow:
`MAX_TASK_DEPTH` checked at create and at reparent, a reparent cycle guard
running inside the write transaction, subtree-height checking, and five
`doctor` integrity checks.

**So: decomposition stays a column. `parent_of` comes out of the spec.**

## 3. Correction lineage is already per-type, and should stay there

`supersedes` was never written because what supersedes what is type-specific:
`supersedesEvidenceId` on evidence, `supersedesSummaryId` on summaries,
`supersedesLinkId` on context links, `supersedesOfferId` on agreements. Each
carries its own uniqueness rule.

A single relation type across commitments would be a *different* concept - one
commitment replacing another - which nothing has asked for and which
`duplicates` partly covers. Declaring it while nothing writes it costs a reader
their trust in the list.

**So: `supersedes` comes out of the first-party relation list.** If commitment
supersession is wanted later it can be added with a writer, on its own merits.

## 4. The consequence that actually matters

The kernel refuses decomposition today, and for the wrong reason.
`flatHierarchyPolicy` throws *"Hierarchical task scope requires an injected
planning-profile policy"* for **any** non-null `areaId`, `goalId`, `projectId`
**or `parentTaskId`**. So decomposition is bundled with the planning profile
and refused with it.

That bundling is wrong. `area`, `goal` and `project` are a life-planning
vocabulary, and the spec is right to name *"force every domain into
area/goal/project hierarchy"* as a non-goal. **Decomposition is not a
vocabulary.** A robot commitment decomposes into steps; a research commitment
decomposes into sources; a software commitment decomposes into changes. Every
domain does it, which is the P10 test.

Separating the two is what lets MCP expose child creation and tree reads
without area/goal/project entering the kernel surface. That is the follow-up
this ADR unblocks; it is not done here.

## 5. Decision

1. Remove `parent_of` and `supersedes` from `RELATION_TYPES` and from the spec's
   first-party list, with the reasoning above recorded in the spec rather than
   only here.
2. State in the spec that decomposition is `task.parentTaskId`, single-parent by
   construction, and why.
3. Split the hierarchy policy so the kernel accepts `parentTaskId` while still
   refusing `areaId`, `goalId` and `projectId` without an injected profile.

## 6. Consequences

**Accepted.** The relation vocabulary shrinks from six types to four, and every
remaining one has a writer. A reader can trust the list.

**Accepted.** Extensions may still add namespaced relation types, which is where
a domain-specific decomposition variant belongs if one is ever needed.

**Rejected alternative: write `parent_of` and keep the column too.** Two sources
of truth for the same fact, with `doctor` growing a drift check between them -
which is exactly the `task_dependency` versus `commitment_relation` situation
that already needs a `relation_compatibility_drift` check.

**Rejected alternative: leave the spec as it is and treat the types as
reserved.** A published vocabulary that no code produces is indistinguishable,
to a reader, from one that does - and this repository has now found that shape
three times: the rollback rule with no command, the relations capability with no
wire surface, and these two types.
