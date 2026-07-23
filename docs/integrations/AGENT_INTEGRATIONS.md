# Agent integrations

Tasq ships one small, host-native skill for Codex and Claude Code. It teaches a
new session how to acquire Tasq, establish an explicit rendezvous and use the
machine onboarding contract. It does not copy the agent's private scratchpad
or transient todos into the shared ledger.

The machine-readable source for versions, paths and argv recipes is
[`AGENT_INTEGRATIONS.json`](AGENT_INTEGRATIONS.json).

## What to give an agent

Installation alone does not identify a ledger. Give the agent this explicit
rendezvous packet in its prompt or trusted project instructions:

```text
Use Tasq space robotics/team-a.
Use actor codex:gwendall.
Use capabilities read,propose,coordinate.
```

Use a stable actor label appropriate to the host, for example
`codex:gwendall` or `claude-code:gwendall`. A space name and actor label are
coordination identifiers, not authentication. The skill refuses to infer them
from the current directory or ledger content.

## Codex

Requires Codex CLI 0.144.4 or newer.

```bash
codex plugin marketplace add gwendall/tasq --ref main
codex plugin add tasq@tasq
```

Start a new Codex session, then ask it to use `$tasq` with the rendezvous packet
above. Remove only the integration with:

```bash
codex plugin remove tasq@tasq
codex plugin marketplace remove tasq
```

## Claude Code

Requires Claude Code 2.1.217 or newer.

```bash
claude plugin marketplace add gwendall/tasq --scope user
claude plugin install tasq@tasq --scope user
```

Start a new session or run `/reload-plugins`, then invoke `/tasq:tasq` with the
rendezvous packet. Remove only the integration with:

```bash
claude plugin uninstall tasq@tasq --scope user
claude plugin marketplace remove tasq --scope user
```

Claude also supports `project` and `local` scopes. Replace `user` consistently
in both install and uninstall commands when repository-wide or private
project-local registration is preferable.

## Executable acquisition and MCP

The plugin contains instructions, not an unpublished binary. If `tasq` is
absent, the skill reads the public
[`tasq.run/adopt.json`](https://tasq.run/adopt.json) manifest, versioned at
[`apps/site/public/adopt.json`](../../apps/site/public/adopt.json), and executes
one declared source-build recipe. It explicitly rejects the unrelated unscoped
npm package named `tasq`.

No static `.mcp.json` is shipped. A valid local MCP launch is bound to an
explicit executable, space, actor and capability set, so a generic plugin
cannot choose it safely. When the host already exposes Tasq MCP tools, the
skill starts with `tasq_discover`. Otherwise it uses the complete CLI JSON
fallback:

```bash
tasq onboard --space <explicit-space> --actor <stable-label> \
  --capabilities read,propose,coordinate --json
```

To configure MCP, obtain `transport.mcp.stdio` from that onboarding response
and register its exact argv through the host's native MCP settings. Do not
reconstruct it from prose.

## Current certification boundary

Both manifests, both native marketplace flows and the shared skill are checked
in the repository. Clean-home Codex 0.144.4 and Claude Code 2.1.218 sessions
independently pass the blind contention, restart, cursor, evidence and
uninstall matrix. The exact certificate is
`../../evidence/tq-321/latest.json`. This certifies only the host versions and
capability boundary recorded there; it is not a promise that every host
version is supported.
