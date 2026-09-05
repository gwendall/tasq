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
`SKILL.md`, `docs/`, `packages/` and `apps/`. Product truth lives under
`docs/concepts/`; versioned release scope and dependencies live under
`docs/roadmap/`. Live ownership is separate: when the managed `AGENTS.md` block
names a Tasq space, that ledger owns current claims and attempts.
Preserve unrelated local changes if the worktree is not clean. Run the
machine-readable preflight after verifying the remote. It also runs
`tasq doctor --config`, which compares the managed block with this checkout's
private binding; when it reports `binding_drift`, `tasq use --from-instructions`
is the repair, and no work should start before it:

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
pnpm --filter @tasq-run/console test:browser
pnpm --filter @tasq-internal/site test:browser
```

Never test against a live ledger. Use a temporary `TASQ_HOME` or explicit
temporary database URL. Never delete a user ledger to obtain a clean test.

## 3. Build a correct mental model

Read in this order:

1. [README.md](../../README.md) — product summary, current entrypoints and source
   build.
2. [CURRENT_STATE.md](../concepts/CURRENT_STATE.md) — authoritative implemented versus
   unimplemented boundary.
3. [PRODUCT_CONSUMPTION_SPEC.md](../concepts/PRODUCT_CONSUMPTION_SPEC.md) and
   [PRODUCT_SURFACE_MATRIX.json](../concepts/PRODUCT_SURFACE_MATRIX.json) — product shapes,
   consumers and machine-readable support truth.
4. [ARCHITECTURE.md](../concepts/ARCHITECTURE.md) — layers, dependencies and invariants.
5. [BACKLOG.md](../roadmap/BACKLOG.md) and [BACKLOG.json](../roadmap/BACKLOG.json) — versioned
   release scope, dependencies and external gates, not live ownership.
6. [SECURITY.md](../../SECURITY.md) — trust boundaries and vulnerability handling.

Read the owning ADR or TQ contract before changing a specific subsystem. The
TQ and ADR documents are engineering contracts and evidence, not the default
product learning path. Historical export provenance is preserved in
[PUBLIC_SOURCE_MANIFEST.json](../releases/PUBLIC_SOURCE_MANIFEST.json) and
[TQ-603_PUBLIC_REPOSITORY_CONTRACT.md](../contracts/TQ-603_PUBLIC_REPOSITORY_CONTRACT.md);
it does not override the current repository or current product truth.

## 3b. Run your own build without losing the published one

`pnpm build:cli && pnpm dev:link` puts the working tree's build on PATH as
`tasq-dev`, beside the published `tasq`.

Use `tasq-dev` for anything you are changing, and keep `tasq` for the question
only it can answer: **does this work for somebody who installed it.** A dev
build that displaces the published one takes that question away, and it is the
mistake that produced a hand-written launcher on the maintainer's machine which
lived nowhere and nobody could have recreated.

The shim runs the BUILT artifact rather than source, so what you dogfood
resembles what ships, and it reports an unmistakable version:

```console
$ tasq-dev --version
0.0.0-dev+aa2931e
```

It fails with exit 3 and an actionable line if the checkout moved or the build
is missing, rather than leaking a stack trace from inside something the
operator believes is Tasq. It refuses to replace a `tasq-dev` it did not write;
inspect that file, then pass `--force`.

**The two are not interchangeable writers.** A dev build can hold a store
format no published binary knows, and doing that to a real ledger is how this
project once lost an afternoon. The migration receipt records which executable
performed the migration for exactly that reason, so "a dev build touched this
store" is a read rather than an inference.

## 4. Choose work without inventing authority

- Use [`docs/roadmap/BACKLOG.json`](../roadmap/BACKLOG.json) for versioned
  release order, dependencies and external-gate status.
- If the managed root `AGENTS.md` block names a Tasq space, use that ledger for
  the live queue: inspect, claim and record attempts there. A backlog status is
  not a claim and a ledger claim does not change public support truth.
- Use
  [`docs/concepts/PRODUCT_SURFACE_MATRIX.json`](../concepts/PRODUCT_SURFACE_MATRIX.json)
  for current support claims.
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
| CLI command or JSON shape | `packages/tasq-cli/src/commands/` | Route/usage update, E2E test, [`docs/reference/CLI_JSON_CONTRACT.md`](../reference/CLI_JSON_CONTRACT.md) if stable JSON changes |
| Local MCP tool | `packages/tasq-mcp/` | One declared capability, MCP tests and discovery/onboarding truth |
| Read-only Console projection or UI | `packages/tasq-inspector/` | Unit/integration tests and browser certification when user-visible |
| Generic extension/connector primitive | `packages/tasq-extension-sdk/` | SDK tests plus one real eval adapter |
| Bundled domain compatibility type/evaluator | `packages/tasq-reference-extension/` | Manifest/runtime parity tests |
| Reference provider connector | `packages/tasq-reference-connectors/` | Conformance and kernel-composition eval |
| MCP Tasks or A2A mapping | `packages/tasq-protocol-adapters/` | Protocol tests; no implicit commitment completion |
| Server authority/HTTP source candidate | `packages/tasq-authority/`, `packages/tasq-server/` | ADR-004 guard, hostile cross-workspace/revocation evals, deployable-candidate truth |
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
3. [`docs/concepts/CURRENT_STATE.md`](../concepts/CURRENT_STATE.md) when
   implemented boundaries change;
4. [`docs/concepts/PRODUCT_SURFACE_MATRIX.json`](../concepts/PRODUCT_SURFACE_MATRIX.json)
   and its human companion when support changes;
5. [`docs/roadmap/BACKLOG.json`](../roadmap/BACKLOG.json) and
   [`docs/roadmap/BACKLOG.md`](../roadmap/BACKLOG.md) when execution status
   changes;
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
[RELEASES.md](../releases/RELEASES.md). A source build, local tarball or green test run is
never authority to publish.
