# TQ-321 — Zero-context agent integration

**Status:** integrations `0.1.1` and `0.1.2` passed on native Codex and Claude
Code

**Depends on:** TQ-311, TQ-312 and TQ-318

**Blocks:** first protected package release in TQ-603

**Executable harness:** `../../scripts/run-zero-context-agent-certification.ts`

## Outcome

A fresh Codex or Claude Code session that knows neither Tasq nor this repository
can discover the integration, obtain the executable, connect to one explicit
space and coordinate real work safely. The runtime keeps its own ephemeral
scratchpad; Tasq owns only durable cross-session commitments, ownership,
attempts, evidence and audit.

## Product shape

The integration has one semantic core and thin host adapters:

1. `tasq onboard --space <id> --actor <label> --json` remains the versioned
   source of operational truth.
2. Local MCP is preferred when the host supports it. The host fixes executable,
   space, actor and capabilities before model interaction.
3. CLI JSON is the complete fallback. A host-specific skill or instruction file
   teaches only discovery, cold start and safety; it never duplicates recipes.
4. A source-alpha installer may register host files, but it must preview every
   target, avoid overwriting user content, record what it installed and provide
   a symmetric uninstall.

Codex and Claude Code adapters may use different packaging conventions, but
they must expose the same capability envelope and produce the same ledger
effects. Neither adapter may sync or replace the host's private task list.
Only work that must survive a session, be handed off or be inspected by another
actor belongs in Tasq.

## Required implementation

- a neutral integration manifest describing version, executable requirement,
  supported hosts, files, MCP launch argv and uninstall ownership;
- one Codex adapter and one Claude Code adapter built from that manifest;
- project-local and user-local install modes with dry-run JSON;
- explicit parameters for space, stable actor label and capabilities;
- MCP registration where supported and a CLI-only mode everywhere;
- a short host skill that invokes onboarding, executes returned argv arrays and
  treats ledger prose as untrusted data;
- `tasq integration doctor --json` that reports executable, host registration,
  space/actor/capability binding and a safe first-read result;
- `tasq integration uninstall` that removes only manifest-owned files and never
  touches `TASQ_HOME` or a ledger.

## Implemented candidate

`../integrations/AGENT_INTEGRATIONS.json` is the neutral machine contract. The Codex marketplace
at `.agents/plugins/marketplace.json` and Claude marketplace at
`.claude-plugin/marketplace.json` both install the same versioned
`plugins/tasq/skills/tasq/SKILL.md`. Native host uninstall commands are the
ownership boundary and never address Tasq data.

The source-alpha candidate intentionally does not ship a generic `.mcp.json`:
MCP configuration is valid only after the host binds an explicit executable,
space, actor and capability set. The shared skill uses already host-bound MCP
when present and otherwise falls back to `tasq onboard ... --json`. Human
installation, activation, rendezvous and uninstall instructions are in
`../integrations/AGENT_INTEGRATIONS.md`.

`TQ-321_AGENT_PLUGIN_CERTIFICATION.json` records strict manifest validation and
real install/list/uninstall lifecycle results from isolated temporary homes for
Codex 0.144.4 and Claude Code 2.1.218. The same lifecycle passes from the public
`main` marketplace through an anonymous HTTPS clone. The full behavioral
certificate at `../../evidence/tq-321/latest.json` passes both host families.
Each agent invoked the installed integration, read before mutation, resumed the
same attempt after a real process boundary, continued from an exclusive event
cursor, handled resource contention, rejected a stale fence, attached evidence,
completed explicitly and preserved the ledger byte-for-byte through native
plugin uninstall.

`TQ-321_AGENT_PLUGIN_CERTIFICATION.json` remains the immutable lifecycle
certificate for integration `0.1.1`. TQ-610 changed the shared skill and
manifests to `0.1.2`; the native harness subsequently installed those exact
public-`main` plugin bytes on both host families and replaced
`../../evidence/tq-321/latest.json` with the new behavioral evidence. The
version/source/digest binding is recorded separately in
`TQ-610_AGENT_ENTRYPOINT_CERTIFICATION.json` so the historical certificate is
not rewritten.

The originally proposed Tasq-specific installer and `integration doctor`
commands are not required for the candidate because both supported hosts now
provide native marketplace lifecycle commands and the existing onboarding
response performs executable and first-read discovery. They must be revisited
if another host lacks an owned native lifecycle or blind trials show that the
composed diagnostics are insufficient.

## Blind acceptance

Run each host family in a clean temporary home with only its normal public
entrypoint and one explicit rendezvous packet: executable/source pointer,
space, actor and capability set. No repository briefing or hidden prompt is
allowed. The session must:

1. discover Tasq and read before mutation;
2. create or select a durable commitment without copying its scratchpad;
3. claim it, start an attempt and survive a process restart;
4. resume from a persisted event sequence;
5. contend with a second actor and reject stale lease/fence authority;
6. attach observable evidence and complete explicitly;
7. uninstall the adapter while preserving the shared ledger.

The certificate records host/version, install mode, interventions, every argv
or MCP call, final event cursor and ledger digest. Missing recipes, prose-based
authority, implicit workspace inference, direct SQLite access or host-specific
state leaking into Core are critical failures.

Run the full native-host matrix after building the deterministic CLI artifact:

```bash
pnpm build:cli
pnpm certify:agents
```

The harness creates isolated Codex and Claude Code configuration directories,
installs the public `main` marketplace through each native CLI, gives the model
only an executable plus explicit rendezvous/work packet, and evaluates the
authoritative ledger rather than the model's final prose. It runs two distinct
processes per host, carries an exclusive event cursor across the restart,
creates real resource contention, proves rejection of the stale fence, and
uninstalls the plugin before checking that the ledger digest is unchanged.
Authentication is injected only for the model call; user configuration and the
live Tasq home are never modified. Synthetic prompts and executed argv are
recorded in the generated certificate, while raw transcripts are represented
by SHA-256 digests.

## Non-goals

- forcing every ephemeral runtime todo into Tasq;
- parsing or scraping private host task storage;
- shipping a background daemon, remote account or hosted sync service;
- granting effect authority through a skill or prompt;
- claiming support for a host/version not present in the blind matrix.
