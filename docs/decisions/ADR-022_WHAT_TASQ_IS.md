# ADR-022 — What Tasq is, and what it shows first

- **Status:** Proposed - 2026-08-27
- **Decision owner:** Product shape and adoption
- **Supersedes nothing.** It states, for the first time in this repository, who
  Tasq serves and what they see in the first minute. Everything else here is
  mechanism, and mechanism has never been the missing piece.

## 1. The admission

This repository can describe its kernel precisely: commitments, exclusive
leases with monotone fences, attempts, evidence, resolutions, shared
assumptions, a relation graph. It has over a hundred open tickets and the
overwhelming majority are mechanism.

It cannot describe, with the same precision, who installs Tasq on day one, what
they see in the first sixty seconds, and what makes them keep it.

A backlog is not a product. This ADR exists because that gap was the most
expensive thing found in a night of dogfooding, and it was found by being
asked, not by building.

## 2. The market has split in two, and neither half is whole

Surveyed 2026-08-27 across roughly 190 tracked orchestrators. Star counts are
verified against the GitHub API on that date and will age.

**The runtime camp** owns agent processes and shows you what they are doing.
herdr (32.6k, Rust, Apache-2.0) marks every pane blocked / working / done /
idle, where "done" means finished-and-you-have-not-looked-yet. T3 Code (20.6k)
carries the richest session identity in the field - thread, project, workspace
root, branch, worktree, provider instance, machine - and drives agents over ACP
and JSON-RPC rather than a PTY. Omnigent, Happy, VibeTunnel, CodeMote and
Shepherd sit here too.

**None of them has coordination semantics.** No task aggregate, no queue, no
claim. herdr coordinates by blocking; T3 Code's threads never see each other.

**The ledger camp** lets agents claim work and has almost nothing to look at.
Beads (26.6k) has `bd update --claim` and is a bare CLI with no UI. paperclip
(79.4k) has atomic checkout with execution locks and a dashboard, but frames
itself as running a company of AI employees, with org charts and budgets.
agent-kanban (455) is the closest design to this one - atomic claims, Ed25519
agent identity, a deliberately read-only human board with live updates - and is
nearly unknown. Gas Town (17.8k) looks like a ledger and is push dispatch.

Three gaps are unfilled by anyone: **atomic claiming combined with lease
renewal**, **claim semantics that survive across machines**, and **any claim
ledger with a real mobile surface**.

Tasq already holds the first. `tasq claim <id> --for 30m`, repeated to
heartbeat, with a monotone fence and an expiry, is not a feature anybody else
shipped.

## 3. The decision

**Tasq is the claim ledger with a live human surface.**

Not a coordination kernel. Not an orchestrator. The kernel is why the surface
can be trusted; it is not what anyone is shopping for.

The felt value, in the order a user feels it:

1. **I can see which agent is doing what.**
2. **They stop colliding.**
3. **They stop redoing work.**

This project built 2 and 3 exhaustively and has almost none of 1. That
inversion is the finding, and correcting it is this ADR's only instruction.

## 4. Why the lease is the product, not just a primitive

The runtime camp needs to own a process to know whether an agent is stuck.
That is why those tools are daemons, and why they are large.

An expiring lease answers the same question without owning anything. If the
agent is alive it renews; if it dies the lease lapses and the work returns to
the pool. The panel does not ask "is the process running", which is the wrong
question - it asks "does anyone still own this work", which is the right one,
and it is answered by a row that heals itself.

That is the whole argument for why this product can show you your fleet without
becoming a terminal multiplexer.

## 5. What the first minute must look like

No configuration beyond pointing one agent at the ledger:

```
Claude Code 2.1.246 · ~/Code/foo · 4m ago
  ● fix the parser              held, lease 26m left
Codex 0.150.0 · ~/Code/foo · just now
  ● add tests                   held, lease 30m left
  ⊘ fix the parser              refused, already held
```

That last line is the product. Everything above it is why it is true.

Two things stand between here and that screen, and only two:

**The agent must be identifiable without the user configuring anything.** Today
it is not: the MCP context is a closure over install-time options, `clientInfo`
from the initialize handshake is discarded, and `tasq agent install
codex|claude|generic` emits a byte-identical invocation for all three hosts. Two
agents installed with the same actor label are indistinguishable in every row.

**The fleet view does not exist.** The Console shows commitments, actors and
claims in seven sections, and does not update itself - it renders a badge
reading "Changes available" and waits for a human to press Refresh.

## 6. Attribution, not authentication - and the layer that is already built

A local process cannot prove it is Claude Code rather than something imitating
it: any secret it holds is readable on the same machine. This repository
already says so, recording `actorAuthentication: "local_process_self_asserted"`
and documenting `localAlias` as "never authentication/authority". That stays
true and stays visible.

But the threat model here is not impersonation on your own laptop. It is "I am
running three agents and cannot tell them apart", and for that, observation is
sufficient. Three signals are available at claim time, all host-attested, none
chosen by the model, none requiring user action:

- **the MCP `initialize` handshake**, whose `clientInfo` is set by the client
  library;
- **the parent process**, since the MCP server is spawned by the agent host -
  verified on the maintainer's machine, where `ps -p $PPID` resolves to the
  `claude` binary;
- **the inherited environment and working directory** - the same machine
  exposes `AI_AGENT`, `CLAUDE_CODE_ENTRYPOINT` and a session identifier.

Record them as attribution, label them as self-asserted, and never call them
identity.

When Tasq becomes genuinely multi-party - a shared ledger where strangers'
agents write - the right layer already exists: signed statements, with the
TQ-616 certification behind them. agent-kanban's Ed25519-signed agent JWTs show
the shape is real. It is the wrong tool for a laptop.

## 7. Consequences

**Accepted.** The backlog reorders. Automatic agent identity and the fleet view
become the highest-priority work, ahead of graph traversal, hierarchy over MCP
and the assumption follow-ups. None of those becomes wrong; they stop being
first while nothing is visible.

**Accepted.** The first TUI iteration is a fleet table, not a graph browser.
The graph is the truth and the list is the interface, so the list ships first.

**Accepted.** The demo is the two-agent collision, not add-list-done. That demo
already exists in the CLI.

**Rejected alternative: build the control panel by owning the processes.** That
means PTYs, worktrees, sandboxing and crash recovery, and it makes this a much
larger product competing with several better-funded ones. Tasq shows and hands
off; it does not spawn. The seam a runner must satisfy is an attempt with a
runtime, an external id, a status lifecycle and evidence - a shape, never a
named runner.

**Rejected alternative: lead with the kernel.** Nobody is shopping for a
coordination kernel. Beads has a real claim ledger, no UI, and 26.6k stars,
which proves the demand exists; agent-kanban has the best design in the field
and 455 stars, which proves design alone does not reach anyone.
