# ADR-024 — The CLI is the default door; MCP is the remote one

- **Status:** Proposed - 2026-08-27
- **Decision owner:** Product surface
- **Unblocks:** first-run copy and project setup, which cannot be written while
  it is unclear what a newcomer is being onboarded *to*
- **Changes published support:** no. Nothing is removed. One path becomes the
  documented default and the other gains a stated purpose.

## 1. Context

Tasq sells MCP as the front door. `tasq agent install codex|claude|generic`
writes an MCP server config, and the public `/agents` page leads with a
one-command MCP install. Meanwhile the CLI is the surface every operation
actually goes through.

That ordering is backwards, and the evidence is this repository's own use:
**across a full night of building and operating Tasq with Tasq, every single
ledger operation went through the CLI. The MCP server - the flagship
integration - was not used once.**

That is not an argument that MCP is worthless. It is an argument that nobody
has named the default, so the more prominent path is the one that got built
first rather than the one that gets used.

## 2. The capability lattice is a boundary, not a wall - locally

MCP's capability lattice (`read`, `propose`, `coordinate`, `direction`,
`effect`) is a real security model. It is worth being precise about *where*.

**An agent that can run `tasq` in a shell can run any shell command.** The
lattice constrains what that agent does *through Tasq*; it does not constrain
what it can do to the machine. Locally, an agent already holds a strictly
larger authority than any Tasq capability can take away.

So locally the lattice buys **structure** - a smaller, clearer surface, and a
declared intent that shows up in the ledger - and it should be sold as
structure, not as safety.

Remotely and hosted the situation inverts. There is no local binary, the
transport is the only path in, and the lattice *is* the security model. That is
the case MCP serves, and it is a good one.

The vocabulary is not an MCP feature either. `tasq onboard --json` already
returns 41 executable argv recipes carrying the same capability labels: 16
`read`, 2 `propose`, 23 `coordinate`. The same intent is declarable on the CLI
path.

## 3. The tool-list tax is real and one-directional

An MCP server puts its whole tool list in the model's context on **every**
request. Tasq registers 56 tools. An agent touches the ledger a handful of
times in a session, so that is a fixed cost paid continuously for an
occasional need.

An instruction block or a skill costs tokens **when it is relevant**. For a
local agent that already has a shell, that is the better trade.

## 4. Decision

**The CLI is the default door for a local agent. MCP is the door for remote,
hosted and sandboxed agents that have no local binary.**

Concretely:

- First-run and project setup teach the CLI path plus the managed instruction
  block. That is what makes an agent a participant.
- `/agents` and the docs present MCP as the remote and sandboxed path, with the
  reason stated, rather than as the recommended local install.
- `tasq agent install` stays. It is the right command for the case it serves,
  and it stops being the headline for the case it does not.

## 5. Choosing the default must not be a downgrade

The gap this ADR was opened to fix has since closed in one direction and opened
in the other, which is worth recording because it is easy to assume it went the
way it started.

**When this was written down, MCP had no hierarchy and no relation tools at
all** - no way to create a sub-commitment, place work, read a tree, or add a
dependency edge. ADR-023 and the work that followed fixed that:
`tasq_commitment_tree`, `tasq_relation_add`, `tasq_relation_end`,
`tasq_relation_list`, and `parentCommitmentId` on create.

**The gap now runs the other way.** Of the 41 recipes `tasq onboard` returns,
none carries decomposition or relations. An agent handed the recipe list - the
CLI's own machine-readable contract - cannot discover that a commitment can
have a parent, while an agent on MCP can.

That is a defect in the door this ADR is making the default, so it is a
condition of the decision rather than a footnote: **the recipe surface must
carry every operation the tool surface carries.** Filed as its own ticket.

## 6. What this does not decide

- It does not deprecate MCP or reduce its tool surface.
- It does not claim MCP is less capable in general; remotely it is the only
  capable option.
- It does not settle whether the instruction block should also be published as
  a vendor-specific skill format. That is a packaging question, and the
  managed-block digest is what makes any of them safe to rewrite.
