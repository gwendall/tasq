# Tasq documentation

The root [`README`](../README.md) explains the product and gets an evaluator to
a first local run. This directory contains the deeper product truth,
contributor guides, and executable engineering contracts.

## Choose your path

| You want to… | Start here |
|---|---|
| Understand what Tasq is | [Current state](concepts/CURRENT_STATE.md) → [product shapes](concepts/PRODUCT_CONSUMPTION_SPEC.md) |
| Build or change the repository | [Development](guides/DEVELOPMENT.md) → owning package README |
| Operate or recover a ledger | [Data safety](guides/DATA_SAFETY.md) → [testing](guides/TESTING.md) |
| Install Tasq for Codex or Claude Code | [Agent integrations](integrations/AGENT_INTEGRATIONS.md) |
| Embed Core or write a connector | [Embedded TypeScript client](contracts/TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.md) → [independent completion](contracts/TQ-612_INDEPENDENT_COMPLETION_RESOLUTION.md) → [architecture](concepts/ARCHITECTURE.md) → [extension SDK](integrations/EXTENSION_SDK.md) |
| Evaluate signed statements | [Signed-statement architecture](contracts/TQ-613_SIGNED_STATEMENT_ARCHITECTURE.md) → [integration](contracts/TQ-615_SIGNED_STATEMENT_INTEGRATION.md) → [hostile certificate](contracts/TQ-616_SIGNED_STATEMENT_CERTIFICATION.md) |
| Self-host or integrate remotely | [Deployable Server](contracts/TQ-807_DEPLOYABLE_SERVER.md) → [hostile Server proof](contracts/TQ-808_SELF_HOSTED_HOSTILE_CERTIFICATION.md) → [remote client](contracts/TQ-809_REMOTE_CLIENT_AND_ENROLLMENT.md) → [Python SDK](contracts/TQ-810_REMOTE_SDKS.md) |
| Evaluate managed Cloud source | [Cloud control plane](contracts/TQ-901_MANAGED_CLOUD_CONTROL_PLANE.md) → [hostile source proof](contracts/TQ-905_MANAGED_CLOUD_HOSTILE_CERTIFICATION.md) → [remote-effects gate](contracts/TQ-906_REMOTE_EFFECTS_REVIEW_GATE.md) |
| Understand JSON compatibility | [CLI JSON contract](reference/CLI_JSON_CONTRACT.md) |
| See versioned release scope and blockers | [Roadmap](roadmap/BACKLOG.md) |
| Compare same-backlog multi-agent behavior | [Multi-agent comparison](concepts/MULTI_AGENT_BACKLOG_COMPARISON.md) → [machine matrix](contracts/TQ-621_MULTI_AGENT_COMPARISON.json) |
| Evaluate public support claims | [Product surface matrix](concepts/PRODUCT_SURFACE_MATRIX.json) |
| Understand release policy | [Release overview](releases/RELEASES.md) |

Coding agents start at [`AGENTS.md`](../AGENTS.md). Agents operating a Tasq
ledger start at [`SKILL.md`](../SKILL.md) and then use the recipes returned by
`tasq onboard`.

## Directory map

| Directory | Contents | Audience |
|---|---|---|
| [`concepts/`](concepts) | Current state, product shapes, architecture, kernel model, Console boundary, support matrix | Evaluators and implementers |
| [`guides/`](guides) | Development, testing, migration, backup, restore, and portability | Contributors and operators |
| [`integrations/`](integrations) | Codex/Claude setup, extension SDK, and machine integration contract | Agent and connector authors |
| [`reference/`](reference) | Stable CLI JSON and runtime/watcher recipes | Integrators |
| [`decisions/`](decisions) | Accepted architecture decision records (`ADR-*`) | Maintainers changing a cross-cutting boundary |
| [`contracts/`](contracts) | Feature acceptance contracts and certificates (`TQ-*`) | Maintainers working on one subsystem |
| [`roadmap/`](roadmap) | Human roadmap and machine-readable release scope, dependencies and external gates | Contributors planning releases |
| [`releases/`](releases) | Distribution, governance, lifecycle, and historical export provenance | Release maintainers |

## Source of truth

Different questions have different authorities:

- Implemented versus unimplemented product behavior:
  [`concepts/CURRENT_STATE.md`](concepts/CURRENT_STATE.md).
- Supported product surfaces:
  [`concepts/PRODUCT_SURFACE_MATRIX.json`](concepts/PRODUCT_SURFACE_MATRIX.json).
- Versioned release order, dependencies and external gates:
  [`roadmap/BACKLOG.json`](roadmap/BACKLOG.json). It is not a live claim queue;
  a managed `AGENTS.md` block names the Tasq ledger when live work uses one.
- Release ownership and gates:
  [`releases/PUBLIC_RELEASE_POLICY.json`](releases/PUBLIC_RELEASE_POLICY.json).
- Stable agent-facing CLI shapes:
  [`reference/CLI_JSON_CONTRACT.md`](reference/CLI_JSON_CONTRACT.md).

Planned work does not override current support truth. A green source build does
not prove that a package or release artifact has been published.

## Engineering contracts

Files under `decisions/` and `contracts/` are intentionally detailed. An ADR
records a cross-cutting decision. A TQ contract records one implementation or
acceptance boundary, often with a machine-readable certificate beside it.
They are evidence and maintenance tools, not the default learning path.

Historical paths inside
[`releases/PUBLIC_SOURCE_MANIFEST.json`](releases/PUBLIC_SOURCE_MANIFEST.json) describe
the initial standalone export. They are frozen provenance, not the current
repository layout.
