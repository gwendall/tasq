# TQ-610 - Acquisition lifecycle and universal agent entrypoint

**Status:** complete; protected `v0.1.1` publication, downloaded-byte
certification and native agent certification passed

## Outcome

Tasq now has a progressive adoption path that does not require repository
knowledge:

1. `bunx @tasq-run/cli@0.1.1 version` and the equivalent pinned `npm exec`
   command prove the package identity without persistent installation.
2. `https://tasq.run/install-v0.1.1.sh` is a repository-owned, inspectable
   lifecycle bootstrap. It selects only a certified host target, authenticates
   the release checksum manifest against a digest pinned in source, verifies
   every downloaded asset and delegates atomic side-by-side activation to the
   certified release installer.
3. `tasq setup --space <id> --actor <label>` persists one explicit human Local
   context so the simple `add`, `list`, `done` journey needs no advanced
   coordination vocabulary.
4. `tasq demo` runs the same assertion-mode journey under a temporary
   `TASQ_HOME`, removes it afterwards and never opens the configured live
   ledger.
5. `tasq agent install codex|claude|generic` previews a deterministic,
   host-bound MCP registration. Host mutation requires `--apply`; generic
   output requires an explicit absolute, non-existing target and is never
   overwritten.
6. Stable public `/SKILL.md`, `/agents/`, `/llms.txt`, `/integration.json`,
   installer and rendezvous-schema routes are generated from repository
   sources.

The public Codex MCP recipe follows the official
[Codex MCP configuration](https://developers.openai.com/codex/mcp/) contract.
The Claude Code recipe follows Anthropic's official
[local stdio MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
argument boundary.

## Safety invariants

- No acquisition route uses the unrelated unscoped `tasq` npm package.
- Persistent installation never edits shell startup files.
- Uninstall owns program bytes only; it never reads or removes `TASQ_HOME`,
  a ledger, journal or backup.
- Setup still requires explicit space and actor. It does not infer either from
  cwd, a descriptor or ledger prose.
- A project rendezvous descriptor is a non-secret pointer. It cannot contain
  actor identity, credentials, grants or effect authority, and no Tasq command
  scans for or activates it from cwd.
- MCP capability lists remain host parameters and do not grant effect
  authority.
- The simple assertion-mode journey creates no claim, attempt or evidence
  record.

## Evidence

- `apps/site/test/public-commands.test.ts` executes both public package runners
  and the downloaded native install/uninstall lifecycle while preserving a
  live-data marker.
- `packages/tasq-cli/test/e2e.test.ts` proves explicit setup, simple todo,
  assertion-mode minimality, isolated demo and fail-closed generic host
  installation.
- `packages/tasq-evals/agent-plugin-integration.test.ts` freezes public
  entrypoints, exact host recipes and the non-authoritative rendezvous
  descriptor.
- `apps/site/browser/site.pw.ts` verifies discoverability and responsive public
  rendering.
- `TQ-610_AGENT_ENTRYPOINT_CERTIFICATION.json` binds integration `0.1.2` to
  public `main` commit `bbab02d`, the exact behavioral-evidence digest and
  zero-intervention native Codex/Claude trials.

## Release evidence

Protected workflow run
[`30037044905`](https://github.com/gwendall/tasq/actions/runs/30037044905)
published the immutable `v0.1.1` npm/native release from source commit
`1005f16642c23f3a470838055ea2d701c1eaa395`. Post-release run
[`30037272412`](https://github.com/gwendall/tasq/actions/runs/30037272412)
matched every registry tarball and replayed attestations, lifecycle, migration,
public adoption and interactive runtime on both supported targets. Public
machine truth therefore labels `setup`, `demo` and `agent install`
`implemented_certified`. The exact release coordinates, checksum-manifest
digests and zero-remaining-work assertion are frozen in
`TQ-610_RELEASE_CERTIFICATION.json`.
