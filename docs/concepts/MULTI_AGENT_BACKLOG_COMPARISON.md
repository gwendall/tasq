# What happens when several agents work the same backlog?

**Checked:** 2026-08-11  
**Machine source:** [`TQ-621_MULTI_AGENT_COMPARISON.json`](../contracts/TQ-621_MULTI_AGENT_COMPARISON.json)  
**Public page:** <https://tasq.run/compare/>

## Short answer

Parallel-agent products solve three different problems that are often bundled
together:

1. **execution isolation** — separate worktrees, branches, VMs or sandboxes;
2. **team orchestration** — one lead splits work among its own subagents;
3. **durable backlog coordination** — independent runtimes agree who currently
   owns a commitment, what execution happened and what proves completion.

Codex, Cursor and GitHub document strong execution isolation and review
handoffs. GitHub Fleet orchestrates subagents inside one parent workflow.
Claude Code agent teams go further: their experimental shared task list has
dependencies and file-lock-backed task claiming. Tasq is therefore not unique
because it can run agents in parallel or because it has a task list.

Tasq's narrower distinction is a runtime-neutral durable boundary between a
commitment, an expiring claim, each execution attempt, evidence and an optional
independent completion decision. Its published limit matters just as much:
Tasq Local v0.3.0 shares one user-owned ledger among local CLI/MCP consumers on
one machine; a public remote Server is not shipped.

## Evidence matrix

| System | Same-backlog behavior | Collision boundary | Completion boundary |
|---|---|---|---|
| **Tasq Local v0.3.0** | A live expiring claim removes a commitment from another actor's default next-work selection; expiry permits higher-fence reclaim without rewriting attempts. | Coordinates work ownership, not Git files or merges. | Runtime success remains an attempt; evidence and configured independent validation are separate. [Primitives](https://github.com/gwendall/tasq/blob/main/docs/concepts/AGENTIC_PRIMITIVES.md), [runtime contract](https://github.com/gwendall/tasq/blob/main/docs/contracts/TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md), [published release](https://github.com/gwendall/tasq/releases/tag/v0.3.0). |
| **Claude Code agent teams** | A team-local shared list has three states, dependencies, lead assignment and self-claim; file locking arbitrates racing claims. | Teammates are not worktree-isolated, so Anthropic advises file ownership to avoid overwrites. | `TaskCompleted` hooks can block completion, while status lag is a documented experimental limitation. [Agent teams](https://code.claude.com/docs/en/agent-teams), [parallel approaches](https://code.claude.com/docs/en/agents). |
| **GitHub Copilot agents** | Issue assignment or an Agents prompt starts a session; GitHub documents parallel sessions and worktree/cloud-sandbox isolation. | Branches, worktrees and GitHub merge/review reconcile code. | The documented handoff is a pull request reviewed and iterated by a human. [Agent walkthrough](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview), [third-party agent apps](https://docs.github.com/en/copilot/concepts/agents/agent-apps). |
| **GitHub Copilot CLI `/fleet`** | A main agent decomposes one request, evaluates dependencies and runs suitable subtasks in parallel. | Coordination belongs to the parent Copilot workflow. | The main agent manages dependencies and integrates results. [Fleet](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet). |
| **OpenAI Codex app** | Agents run in separate project threads and built-in worktrees isolate parallel copies of the repository. | Worktrees isolate checkouts; the user reviews and adopts each diff. | The cited page documents diff review and checkout, not a shared commitment/evidence state machine. [Codex app](https://openai.com/index/introducing-the-codex-app/). |
| **Cursor Background Agents** | An asynchronous agent runs in an isolated Ubuntu machine, clones the repo and works on a separate branch. | VM and branch isolation, with pushed-change handoff. | The cited page documents status, follow-up and takeover, not independent completion validation. [Background Agents](https://docs.cursor.com/background-agent). |
| **MCP Tasks / A2A Tasks** | Unique task IDs expose asynchronous execution status, polling/streaming, interruption and results/artifacts. | The normative models do not define an exclusive claim over an external shared backlog item. | `completed` is an execution-protocol state, not a separate organizational commitment decision. This row is an inference from the [MCP Tasks specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) and [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md). |

## What is actually differentiated

Tasq has a credible seam when several **independent runtimes or vendors** need
to share durable coordination truth without moving their conversation,
worktree, execution engine or provider state into the tracker. The useful
primitive is not `spawn_agent`; it is:

```text
commitment -> exclusive expiring claim -> execution attempt -> evidence -> decision
```

That seam is meaningful because the alternatives cited above mostly bind
coordination to a vendor team, parent session, issue/PR workflow, worktree or
protocol execution ID. Claude Code agent teams are the closest direct overlap
and disprove any broad claim that Tasq invented atomic task claiming.

## What Tasq must not claim

- Tasq does not make code edits conflict-free; use worktrees and merge tooling.
- Tasq Local does not coordinate machines through a hosted service.
- Tasq does not replace GitHub issues/PR review or a vendor's internal agent
  orchestration.
- MCP/A2A `completed` never becomes Tasq commitment completion implicitly.
- Main-branch candidates added after v0.3.0 are excluded from the public
  comparison until exact published artifacts contain them.

## Method

Only first-party product documentation, normative protocol specifications and
Tasq's published repository/release contracts were used. “The cited page does
not document X” is deliberately narrower than “the product has no X.”
Inference-marked rows classify the documented primitives; they are not claims
about unpublished internals.
