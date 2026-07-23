# Agent integrations

Tasq ships one small, host-native skill for Codex and Claude Code. It teaches a
new session how to acquire Tasq, establish an explicit rendezvous and use the
machine onboarding contract. It does not copy the agent's private scratchpad
or transient todos into the shared ledger.

The machine-readable source for versions, paths and argv recipes is
[`AGENT_INTEGRATIONS.json`](AGENT_INTEGRATIONS.json).

Public zero-context entrypoints are stable at
[`tasq.run/SKILL.md`](https://tasq.run/SKILL.md),
[`tasq.run/agents`](https://tasq.run/agents/),
[`tasq.run/llms.txt`](https://tasq.run/llms.txt) and
[`tasq.run/integration.json`](https://tasq.run/integration.json). The public
copies are generated from this repository and cannot drift independently.

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

## Executable acquisition

Try the exact scoped package without persistent installation:

```bash
bunx @tasq-run/cli@0.1.1 version
npm exec --yes --package=@tasq-run/cli@0.1.1 -- tasq version
```

For a persistent native lifecycle, download and inspect the versioned
installer before executing it:

```bash
curl -fsSLo /tmp/tasq-install.sh https://tasq.run/install-v0.1.1.sh
less /tmp/tasq-install.sh
sh /tmp/tasq-install.sh --dry-run --version 0.1.1 --prefix "$HOME/.local"
sh /tmp/tasq-install.sh --version 0.1.1 --prefix "$HOME/.local"
```

The script selects only a certified platform, authenticates the downloaded
checksum manifest against a digest pinned in repository source, verifies each
release asset and delegates side-by-side activation to the certified lifecycle
installer. It never edits a shell startup file. `--uninstall` removes managed
program bytes while preserving `TASQ_HOME`, ledgers and backups.

## MCP registration

The plugin contains instructions, not a binary. If `tasq` is absent, the skill
reads the public
[`tasq.run/adopt.json`](https://tasq.run/adopt.json) manifest, versioned at
[`apps/site/public/adopt.json`](../../apps/site/public/adopt.json), and executes
one declared, immutable package acquisition recipe. It explicitly rejects the
unrelated unscoped npm package named `tasq`.

No ambient project `.mcp.json` is shipped. Parameterized Codex, Claude Code and
generic MCP recipes are published in `AGENT_INTEGRATIONS.json`; each requires
an explicit absolute executable, space, actor and capability set. The host
still asks for trust according to its own policy. When the host already exposes
Tasq MCP tools, the skill starts with `tasq_discover`. Otherwise it uses the
complete CLI JSON fallback:

```bash
tasq onboard --space <explicit-space> --actor <stable-label> \
  --capabilities read,propose,coordinate --json
```

To configure MCP, obtain `transport.mcp.stdio` from that onboarding response
and register its exact argv through the host's native MCP settings, or use the
equivalent parameterized host recipe. Do not reconstruct it from prose.

## Project rendezvous

[`PROJECT_RENDEZVOUS.schema.json`](PROJECT_RENDEZVOUS.schema.json) freezes one
non-secret Local pointer: `TASQ_HOME`, an exact space, the public skill URL and
requested capabilities. It has no token, credential, actor identity, grant or
effect authority. Tasq never scans the current directory for this descriptor.
A user or trusted project instruction must activate it explicitly, and the
runtime must still supply its own stable actor label.

The `setup`, `demo` and deterministic `agent install` helper are published in
`v0.1.1` and pass the protected downloaded-byte certification on both
supported targets.

## Current certification boundary

Both manifests, both native marketplace flows and the shared skill are checked
in the repository. Clean-home Codex 0.144.4 and Claude Code 2.1.218 sessions
independently pass the blind contention, restart, cursor, evidence and
uninstall matrix. The exact certificate is
`../../evidence/tq-321/latest.json`. This certifies only the host versions and
capability boundary recorded there; it is not a promise that every host
version is supported.
