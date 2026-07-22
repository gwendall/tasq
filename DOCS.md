# Tasq documentation map

Use this page when the repository root feels like a wall of contracts. It
routes readers by purpose; it does not replace the authoritative documents.

## Start here

| Need | Read first |
|---|---|
| Understand the product | `README.md` → `CURRENT_STATE.md` → `PRODUCT_CONSUMPTION_SPEC.md` |
| Modify the repository | `AGENTS.md` → `DEVELOPMENT.md` → owning package README |
| Operate a ledger as an agent | `SKILL.md` → `tasq onboard ... --json` |
| Install into Codex or Claude Code | `AGENT_INTEGRATIONS.md` → `AGENT_INTEGRATIONS.json` |
| Find current work | `BACKLOG.json` for machine order; `BACKLOG.md` for explanation |
| Evaluate support | `PRODUCT_SURFACE_MATRIX.json` and `PUBLIC_RELEASE_POLICY.json` |
| Report a security issue | `SECURITY.md` |
| Back up, upgrade, restore or transfer data | `DATA_SAFETY.md` → `TQ-608_MIGRATION_AND_DATA_SAFETY.md` |

## Active product contracts

- `CURRENT_STATE.md` — implemented and unimplemented truth.
- `PRODUCT_CONSUMPTION_SPEC.md` — Core, Local, Server and Cloud shapes.
- `PRODUCT_SURFACE_MATRIX.json` — machine-readable support status.
- `ARCHITECTURE.md` — source ownership, layers and dependency direction.
- `CLI_JSON_CONTRACT.md` — stable agent-facing JSON.
- `LOCAL_CONSOLE_SPEC.md` — read-only Local Console boundary.
- `UNIVERSAL_KERNEL_SPEC.md` — neutral-kernel target and exclusions.

## Current execution and release

- `TQ-607_PRIVATE_DOGFOOD_GATE.md` and `TQ-607_DOGFOOD_STATUS.json` — current
  private product-learning program.
- `TQ-321_ZERO_CONTEXT_AGENT_INTEGRATION.md` — next Codex/Claude discovery,
  install, MCP/CLI and blind-agent contract.
- `DATA_SAFETY.md` and `TQ-608_MIGRATION_AND_DATA_SAFETY.md` — implemented
  store compatibility, verified receipts, recovery and portable export, plus
  the remaining protected-release replay boundary.
- `BACKLOG.md` and `BACKLOG.json` — ordered checkpoints and dependencies.
- `OPEN_SOURCE_PRODUCTIZATION_SPEC.md`, `RELEASES.md` and
  `PUBLIC_RELEASE_POLICY.json` — public distribution gates.
- `TQ-603_RELEASE_CONTRACT.md` and `TQ-604_LIFECYCLE_CERTIFICATION.md` — release
  production and published-byte lifecycle.
- `TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md` and its JSON certificate —
  clean-room interactive-runtime candidate and remaining published-byte gate.

## Engineering contracts and evidence

Files prefixed `ADR-` record accepted cross-cutting decisions. Files prefixed
`TQ-` record one implemented or planned acceptance boundary. Read an ADR/TQ
only when changing its subsystem; they are not the default onboarding path.

Machine certificates beside a TQ are evidence snapshots. Historical export
evidence in `PUBLIC_SOURCE_MANIFEST.json` describes the initial standalone
cutover and is not a live file manifest.
