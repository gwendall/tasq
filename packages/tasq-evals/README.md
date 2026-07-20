# tasq evals

> **Realistic agent-flow scenarios.** Not unit or integration tests — these
> simulate the way a real agent (Hermes, Claude Code, or any MCP/CLI
> consumer) would interact with tasq across a full session, and assert that
> the resulting state + projection + prioritization are correct.

## Why evals (distinct from tests)

| | Unit / integration tests | Evals |
|---|---|---|
| Question answered | "does function X behave correctly?" | "is the agent's experience good?" |
| Failure | code bug | UX / ergonomics / output quality issue |
| Lifetime | run on every commit | run on every meaningful surface change |
| Scope | one function / one command | full session of an imagined agent |

Tests catch correctness regressions. Evals catch design regressions.

## Structure

```
packages/tasq-evals/
├── README.md (this file)
├── hermes-daily-brief.test.ts    scenario: morning daily brief
├── agentic-resilience.test.ts    scenario: crash/retry/stale-lease recovery
├── universal-collaboration.test.ts scenario: runtime-neutral delegation, output and completion
├── cross-domain-conformance.test.ts scenario: UK-007 software/research/operations on one schema
├── readiness-gate.test.ts          scenario: UK-008 registry/compatibility/cursor/doctor gate
├── read-only-watchers.test.ts      scenario: TQ-108 five-domain normalized watcher fixtures
├── life-filesystem-loop.test.ts    scenario: TQ-109 real adapter boundary and explicit completion
├── machine-onboarding.test.ts      scenario: UK-009 package-independent discovery client
├── autonomous-onboarding-matrix.test.ts scenario: TQ-314 zero-integrator shell/Python/JS/raw-MCP + process chaos
├── blind-agent-harness.test.ts scenario: TQ-315 real-runtime transcript observer and clock/command judge
├── cold-start-configuration-matrix.test.ts scenario: TQ-316 built artifact + TQ-317 pairwise/platform certification
├── agent-first-onboarding.test.ts scenario: TQ-318 executable support matrix + content-addressed semantic certificate
├── universal-from-scratch-onboarding.test.ts scenario: TQ-319 selection without recipe IDs + CLI/MCP peer interop
├── hosted-tenancy-design.test.ts scenario: ADR-004/TQ-505 machine guard for future authenticated hosting
├── product-consumption-design.test.ts scenario: TQ-601 product shapes, consumers and honest support states
├── external-context-links.test.ts scenario: TQ-503 reusable external context without memory import
├── protocol-interoperability.test.ts scenario: UK-010 MCP/A2A execution without implicit completion
├── universal-kernel-acceptance.test.ts scenario: UK-011 unfamiliar extension, two runtimes and cursor restart
├── effect-authority-adversarial.test.ts scenario: TQ-208 protected writes, races, crash recovery and hostile receipts
├── connector-conformance.test.ts scenario: TQ-305 real read connector against the reusable universal gate
├── reference-connectors.test.ts scenario: TQ-306 read + authorized provider write against the kernel
├── surface-compatibility.test.ts scenario: TQ-307 one ledger through CLI, MCP and A2A
├── runtime-reconciliation-recipes.test.ts scenario: TQ-304 Temporal/Restate/LangGraph attempts
├── delivery-crash-recovery.test.ts scenario: TQ-401 commit-before-delivery process loss
├── outbox-drain-recovery.test.ts scenario: TQ-402 effect-before-ack deduplication and poison repair
├── durable-idempotency-recovery.test.ts scenario: TQ-403 caller scope, lost CAS response and retention
├── replica-conflict-contract.test.ts scenario: TQ-404 oracle retained beside TQ-405 real multi-store tests
├── sync-chaos-recovery.test.ts scenario: TQ-406 real SIGKILL boundaries, hostile sync and authority restore
├── long-project-with-subtasks.test.ts scenario: decomposition + progress/ETA
├── markdown-snapshot.test.ts     snapshot tests on projection output
└── prioritizer-quality.test.ts   realistic dataset ranked correctly
```

Note: files use `.test.ts` (not `.eval.ts`) because Bun's test runner
matches on the `.test.` suffix. The folder distinguishes evals from
unit/integration tests, not the extension.

## Running

```bash
# From the tasq product root (needs evals package to resolve workspace deps)
cd packages/tasq-evals && bun test

# Or from monorepo root
bun test packages/tasq-evals/

# Real Codex + Claude Code gate (requires both authenticated CLIs)
bun scripts/run-blind-agent-trials.ts --batch <id>
bun scripts/run-blind-agent-trials.ts --batch <crash-id> --crash-only
pnpm --filter @tasq/cli build
bun scripts/run-agent-first-onboarding-trials.ts --batch <id> --family all
bun scripts/run-universal-onboarding-trials.ts --batch <id> --family all --repetitions 3
```

The TQ-318 real-model runner separates MCP-only and shell-only policies, records
actual tool calls plus state oracles, and retains failed pilots. Ordinary CI
verifies the checked-in certificate and deterministic support matrix without
requiring authenticated model clients.

The TQ-319 gate adds a third host family and separates contract, selection,
composition, interoperability, recovery and semantic evidence. Deterministic
clients receive operation metadata and parameter values but no recipe or MCP
tool name. The blind runner receives only the pointer plus ordinary task
intent; every pass still requires transcript and ledger oracles, the exact
producer argv or a host-frozen pointer to that same artifact, zero human
intervention and no device-clock authority. Failed evaluator
or model pilots remain content-addressed evidence.

The release-artifact certification also runs on Linux and macOS in
`.github/workflows/tasq-onboarding-certification.yml`. A platform is not a
supported cold-start target merely because the TypeScript compiles there.

The hosted-tenancy design guard is intentionally not a runtime certification.
It keeps REST, remote MCP and hosted web marked `planned` while freezing the
cross-workspace, revocation, delegation, key-rotation, sender-proof and
injected-clock scenarios that a future adapter must execute before support is
advertised.

The TQ-601 product-consumption guard keeps Core, Local, Server and Cloud
separate, requires an explicit path or missing dependency for every consumer,
and prevents public installation, REST, remote MCP or self-hosting from being
claimed merely because their inner kernel or design exists.

## Adding a new eval

A good eval :

1. **Simulates a real session** — multiple CLI calls in sequence, with realistic data
2. **Asserts on observable agent outputs** — what JSON the agent sees, what markdown it reads, what next-action it computes — not internal DB state
3. **Has a clear failure narrative** — when it fails, the failure message tells you what's broken about the agent experience

Avoid : single-command tests (that's `packages/tasq-cli/test/e2e.test.ts`), schema invariant tests (that's `packages/tasq-schema/test/`), service unit tests (that's `packages/tasq-service/test/`).
