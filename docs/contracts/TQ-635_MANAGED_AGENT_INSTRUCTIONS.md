# TQ-635 — Managed agent instructions and work-authority split

Status: published and protected-byte certified in `v0.4.0`.

## Problem and primitive

Agents need a durable declaration that a project uses Tasq, which space to
join and how to close work. Hand-authored copies drift and can accidentally
turn ledger prose into repository instructions. Separately, a release backlog
and a live ledger can both be described as authoritative while answering
different questions.

`tasq agent instructions --space <id>` renders one static protocol block. With
`--write`, it inserts or updates the block in `AGENTS.md` by default. The marker
binds block version, validated space and a full SHA-256 of the exact content.
The write is atomic and byte-idempotent.

`--check` returns distinct automation results:

| State | Exit |
|---|---:|
| current | 0 |
| missing | 10 |
| stale but internally intact | 11 |
| hand-edited or digest-invalid | 12 |

A hand-edited block is never overwritten by ordinary `--write`; the command
shows a bounded difference and requires reviewed `--force`. Symlink targets,
duplicate blocks and unmatched markers fail closed.

## Authority model

- The Tasq ledger is the live execution queue. Claims, attempts and completion
  evidence answer who owns and executed work now.
- `docs/roadmap/BACKLOG.json` owns versioned release scope, ordering,
  dependencies and external gates.
- `PRODUCT_SURFACE_MATRIX.json` owns current support truth.
- None of those authorities silently upgrades another.

The generator never opens a ledger. Its only variable input is a
schema-validated coordination-space identifier; all protocol prose is static.
Task titles, descriptions, evidence and other actor data can therefore never
be injected into an instructions file through this command.

## Evidence

- `packages/tasq-cli/src/commands/agent-instructions.ts`
- `packages/tasq-cli/test/local-workflow.test.ts`
- `packages/tasq-evals/documentation-contract.test.ts`
- root `AGENTS.md` generated block
- `docs/contracts/TQ-635_MANAGED_AGENT_INSTRUCTIONS.json`
