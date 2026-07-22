# Developing Tasq

This is the practical onboarding guide for a human or coding agent arriving in
the repository for the first time. Product truth lives in the linked contracts;
this document explains how to find the right work, change the right layer and
prove the result.

## 1. Verify the checkout

The only current source authority is the standalone repository at
`https://github.com/gwendall/tasq`. An older private monorepo once contained a
`products/tasq` subtree; that path is historical export provenance, not a place
to make current changes.

```bash
git rev-parse --show-toplevel
git remote get-url origin
git status --short --branch
```

The root should contain `package.json`, `pnpm-workspace.yaml`, `AGENTS.md`,
`SKILL.md`, `CURRENT_STATE.md`, `BACKLOG.json`, `packages/` and `apps/`.
Preserve unrelated local changes if the worktree is not clean. Run the
machine-readable preflight after verifying the remote:

```bash
pnpm --silent agent:preflight --json
```

## 2. Bootstrap and verify the baseline

Requirements: Bun 1.3 or newer, Node.js 22 or newer and pnpm 10.29 or newer.

```bash
pnpm install --frozen-lockfile
pnpm docs:check
pnpm typecheck
pnpm test
```

`pnpm test` runs workspace suites sequentially because the CLI and eval suites
build real artifacts, open SQLite databases and exercise process teardown. Run
focused tests while iterating, but run all four root commands before handoff.
Browser certification is separate and is required when changing the Console or
public site:

```bash
pnpm --filter @tasq/console test:browser
pnpm --filter @tasq-internal/site test:browser
```

Never test against a live ledger. Use a temporary `TASQ_HOME` or explicit
temporary database URL. Never delete a user ledger to obtain a clean test.

## 3. Build a correct mental model

Read in this order:

1. [README.md](README.md) — product summary, current entrypoints and source
   build.
2. [CURRENT_STATE.md](CURRENT_STATE.md) — authoritative implemented versus
   unimplemented boundary.
3. [PRODUCT_CONSUMPTION_SPEC.md](PRODUCT_CONSUMPTION_SPEC.md) and
   [PRODUCT_SURFACE_MATRIX.json](PRODUCT_SURFACE_MATRIX.json) — product shapes,
   consumers and machine-readable support truth.
4. [ARCHITECTURE.md](ARCHITECTURE.md) — layers, dependencies and invariants.
5. [BACKLOG.md](BACKLOG.md) and [BACKLOG.json](BACKLOG.json) — ordered work and
   external gates.
6. [SECURITY.md](SECURITY.md) — trust boundaries and vulnerability handling.

Read the owning ADR or TQ contract before changing a specific subsystem. The
TQ and ADR documents are engineering contracts and evidence, not the default
product learning path. Historical export provenance is preserved in
[PUBLIC_SOURCE_MANIFEST.json](PUBLIC_SOURCE_MANIFEST.json) and
[TQ-603_PUBLIC_REPOSITORY_CONTRACT.md](TQ-603_PUBLIC_REPOSITORY_CONTRACT.md);
it does not override the current repository or current product truth.

## 4. Choose work without inventing authority

- Use `BACKLOG.json` for order, dependencies and status.
- Use `PRODUCT_SURFACE_MATRIX.json` for current support claims.
- Treat `planned` or `candidate` as non-shipped until its stated evidence gate
  passes.
- Do not start a broader public-contract change merely because nearby code can
  support it. Confirm the owning backlog item and accepted contract first.
- External gates stay external: local code cannot prove npm ownership, a
  protected published artifact, a deployment or an independent human trial.
- Do not publish, tag, deploy, change repository visibility or configure an
  external registry unless the maintainer explicitly authorizes that action.

When the requested work is ambiguous, prefer a read-only audit and report the
exact owning contract or missing decision rather than silently widening scope.

## 5. Repository map and change routing

| Change | Primary location | Required companion work |
|---|---|---|
| Portable records, validation, IDs or clock contracts | `packages/tasq-schema/` | Schema tests; compatibility review |
| Profile-neutral kernel operation or migration | `packages/tasq-core/` only | State, migration, retry and audit tests; Local neutral paths forward here |
| Local compatibility service or planning behavior | `packages/tasq-service/` | Service tests; keep profile policy out of Core and never copy neutral modules |
| CLI command or JSON shape | `packages/tasq-cli/src/commands/` | Route/usage update, E2E test, `CLI_JSON_CONTRACT.md` if stable JSON changes |
| Local MCP tool | `packages/tasq-mcp/` | One declared capability, MCP tests and discovery/onboarding truth |
| Read-only Console projection or UI | `packages/tasq-inspector/` | Unit/integration tests and browser certification when user-visible |
| Generic extension/connector primitive | `packages/tasq-extension-sdk/` | SDK tests plus one real eval adapter |
| Bundled domain compatibility type/evaluator | `packages/tasq-reference-extension/` | Manifest/runtime parity tests |
| Reference provider connector | `packages/tasq-reference-connectors/` | Conformance and kernel-composition eval |
| MCP Tasks or A2A mapping | `packages/tasq-protocol-adapters/` | Protocol tests; no implicit commitment completion |
| Future Server authority/HTTP foundation | `packages/tasq-authority/`, `packages/tasq-server/` | ADR-004 guard, hostile cross-workspace/revocation evals |
| Public product/docs site | `apps/site/` | Generated truth check, static build and browser test |
| Agent journey or cross-layer product proof | `packages/tasq-evals/` | Observable black-box assertions, not implementation shortcuts |
| Public support or release claim | Root human contract plus matching JSON truth | Clean-room evidence and release-policy gate |

Each workspace has a local README describing its boundary and focused commands.
Follow dependency direction: schemas and Core never import Local, Console,
Server, adopters or provider-specific policy.

## 6. Invariants every change preserves

- The state rows are authoritative; the append-only event log provides audit,
  ordering and recovery evidence. Tasq is not event-sourced.
- All mutations flow through the owning service transaction and audit path.
- Retry identity, canonical request digest, workspace and actor are explicit.
- Claims and resource leases use current revisions and fences at the final I/O
  boundary.
- Runtime or provider success never completes a commitment by itself.
- Actor and ledger prose are attribution/data, not authentication or authority.
- Provider policy, credentials and I/O remain outside Core.
- Authority time is injected; only `systemClock` reads the host clock.
- Local Console is loopback-only and read-only. The static public site has no
  ledger access. Neither implies a hosted product.
- `@tasq-internal/*` packages are private composition and never publication
  candidates.

## 7. Testing and documentation workflow

During implementation, run the focused workspace command:

```bash
pnpm --filter <package-name> typecheck
pnpm --filter <package-name> test
```

Then update all affected layers of truth:

1. behavior and tests;
2. the owning ADR/TQ or compatibility contract;
3. `CURRENT_STATE.md` when implemented boundaries change;
4. `PRODUCT_SURFACE_MATRIX.json` and its human companion when support changes;
5. `BACKLOG.json` and `BACKLOG.md` when execution status changes;
6. README, package README, CLI JSON or security docs when their audience is
   affected.

Run `pnpm docs:check` after documentation changes. It verifies links,
workspace READMEs, canonical commands, package metadata and onboarding
guardrails. See [TESTING.md](TESTING.md) for the complete test ownership map.

## 8. Handoff and pull request checklist

- Diff contains only intended changes and preserves pre-existing work.
- New behavior has state-based tests; trust/concurrency/recovery changes have
  adversarial coverage.
- Human and machine product truth agree and non-claims remain explicit.
- `pnpm docs:check`, `pnpm typecheck` and `pnpm test` pass.
- `pnpm verify:handoff` runs that complete root gate plus diff-integrity checks.
- Relevant browser suites pass for Console/site changes.
- No secrets, private ledger data, private transcripts, generated caches,
  absolute workstation paths or unrelated artifacts are included.
- Commits use `git commit -s` for DCO sign-off.
- The handoff names the changed contracts, checks run and any genuinely
  external/unresolved gate.

Release artifacts are created only by the protected tag workflow described in
[RELEASES.md](RELEASES.md). A source build, local tarball or green test run is
never authority to publish.
