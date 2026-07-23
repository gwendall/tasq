# TQ-601 — Tasq product and consumption contract

> **Status:** accepted product contract — 2026-07-20
> **Implementation claim:** only the rows marked implemented in
> `PRODUCT_SURFACE_MATRIX.json` exist today
> **Purpose:** make Tasq understandable as a product without confusing its
> kernel, current local composition, future server or managed operation

## 1. Canonical product definition

Tasq is a **local-first commitment coordination system for humans, agents and
the runtimes around them**. It preserves desired outcomes, temporary
ownership, executions, evidence, external waits, effects and audit without
becoming an agent runtime, provider client, policy engine or memory store.

The shortest honest description of the current product is:

> Tasq is an embedded coordination kernel delivered today through a local Bun
> CLI, a capability-scoped local MCP server and a read-only local web console,
> all using one LibSQL ledger.

Tasq is therefore not merely a CLI. The CLI is the most complete current
composition. Nor is Tasq currently a REST service, hosted SaaS or deployable
multi-user server.

## 2. One product, four operating shapes

The product has four explicit shapes. A shape is supported only when its own
release gate passes; implementation of an inner layer does not certify an
outer one.

### 2.1 Tasq Core

The profile-neutral embedded TypeScript kernel:

- schemas, migrations and deterministic service operations;
- commitments, collaboration, claims, attempts, evidence, waits and effects;
- resource leases, idempotency, audit, delivery and explicit replication;
- extension, connector and protocol adapter contracts;
- caller-supplied store, identity and `Clock`.

Core owns no network listener, login, browser session, provider credential,
workflow runtime, human policy or hosted control plane.

**Current state:** implemented in the canonical standalone repository; the
seven `@tasq-run/*` packages are release candidates, not yet a published public
SDK distribution.

### 2.2 Tasq Local

The single-host reference product:

```text
tasq CLI + local stdio MCP + Local Console
                         |
                         v
                 one local LibSQL ledger
```

Agents use JSON CLI or MCP. Humans mutate through the CLI and inspect through
CLI, Markdown or the local console. Multiple processes rendezvous only when
they use the same store and exact workspace. Actor labels are attribution, not
authentication.

**Current state:** behavior and candidate install/upgrade/uninstall are
certified on Linux/macOS, including foreground Console discovery from the
installed artifact, and TQ-321 zero-context Codex/Claude integration is
certified. The seven `@tasq-run/*@0.1.0` packages and the attested native
macOS-arm64/Linux-x64 assets are published from protected OIDC CI at immutable
tag `v0.1.0`; the historical non-default bootstrap tag is not a supported
install channel. TQ-608 is certified from the exact published release on both
supported targets.
TQ-607 continues as the stable-graduation gate.

### 2.3 Tasq Server

The future self-hostable network composition:

```text
authenticated REST + remote MCP + event stream + hosted console BFF
                              |
                              v
                 identity/binding/authorization guard
                              |
                              v
                          Tasq Core
```

It is an adapter and operations layer, not another kernel. Every surface must
share the ADR-004 authentication, workspace routing and live authorization
guard. A server is not created by binding the current inspector or stdio MCP
to a public interface.

**Current product state:** not implemented as a runnable product. TQ-801 and
TQ-802 provide its private authority evaluator, durable control plane and
opaque workspace router. TQ-803 provides a host-integrated Fetch handler for
authenticated read-only REST. An integrator must still supply a conforming
credential verifier, workspace reader, HTTPS listener and operations. This
entrypoint therefore does not make Server a usable or self-hostable release.
TQ-804 also supplies the registered mutation protocol and authority/domain
serialization gate; the integrator supplies each durable idempotent operation
implementation.

### 2.4 Tasq Cloud

A possible managed operation of Tasq Server. Cloud adds tenant lifecycle,
service operations, billing/support and managed identity configuration. It
does not create a proprietary domain model or alternate protocol truth.

**Current state:** not implemented and not required for the open-source local
product to be useful.

## 3. Current deliverables

| Deliverable | Current entrypoint | Current support | Important limit |
|---|---|---|---|
| Local CLI | `tasq ...` | Published public alpha | Bun 1.3+; macOS arm64 and Linux x64 |
| Autonomous bootstrap | `tasq onboard --space <id> --actor <label> --json` | Certified after executable handoff | Cannot discover or install Tasq without a causal pointer |
| Local MCP | `tasq mcp --tenant <id> --actor <label> --capabilities ...` | Implemented stdio | Host configuration required; no remote MCP |
| Embedded Core | `@tasq-run/core@0.1.0` | Published public alpha | Trusted in-process integration; no runtime ownership |
| Local Console | `tasq web --tenant <id>`; `tasq web status --tenant <id> --json` | Implemented read-only with live invalidation and proof-of-life discovery | Explicit foreground loopback process, no mutation |
| Public product/docs site | `https://tasq.run`; `/product-truth.json`; `/adopt.json` | Implemented, certified and deployed | Static and ledger-free; no agent API |
| Markdown | `tasq projection` | Implemented projection | Never a write surface |
| Protocol adapters | `@tasq-run/protocol-adapters@0.1.0` | Published public alpha | Mapping only; no transport or completion authority |
| Extension SDK | `@tasq-run/extension-sdk@0.1.0` | Published public alpha | Trusted in-process code; no provider authority |
| Reference connectors | `@tasq-internal/reference-connectors` | Reference implementation | Not a supported first-party connector catalog |
| Replication kernel | embedded service API | Implemented neutral projection | No packaged network transport or enrollment service |
| Server authority foundation | `@tasq-internal/authority`, `@tasq-internal/server` | Implemented internally | No concrete verifier or deployable artifact |
| REST handlers | `@tasq-internal/server` `createHostedReadHandler`, `createHostedHttpHandler` | Implemented; host integration required | Host supplies verifier, listener, readers and durable registered mutations |
| Self-hosted server | none | Not implemented | No daemon, image, auth or operator contract |
| Managed service | none | Not implemented | ADR-004 is design, not deployment |

`PRODUCT_SURFACE_MATRIX.json` is the machine-readable version of this table.

## 4. Consumer contracts

### 4.1 Unknown local shell agent

**Need:** discover state and coordinate work without repository knowledge.

**Irreducible input:** an executable pointer, explicit workspace, stable actor
label, requested capability envelope and task intent.

**Path:** execute `tasq onboard`, validate the versioned response, then execute
only returned argument-array recipes. Read before mutation. Persist returned
IDs and event cursors.

**Support:** certified across Python, Node, POSIX+jq, Codex, Claude Code and
OpenCode configurations.

**Non-claim:** certification does not install the executable, authenticate the
local actor or bridge an isolated store.

### 4.2 MCP-capable local agent

**Need:** structured tools and resources selected by the host.

**Path:** the MCP host launches the discovered stdio command with immutable
workspace, actor and capabilities. The agent discovers only the tools its host
registered.

**Support:** implemented for read, propose and coordinate; effect capability
requires a trusted embedded authority resolver and is absent from generic
stdio.

**Non-claim:** an MCP client cannot choose another workspace, grant itself a
capability, self-approve an effect or use the current transport remotely.

### 4.3 Human local user

**Need:** create and update desired outcomes, understand current work and audit
agent activity.

**Path:** mutate with the CLI; use human CLI output, Markdown projection and
Local Console for inspection.

**Support:** complete for technical users, incomplete for users who require a
form-based task manager or mobile UI.

### 4.4 Human operator

**Need:** identify stuck work, active holders, failed attempts, uncertain
effects, corrupt state and recovery points.

**Path:** `tasq web`, proof-of-life `tasq web status --json`, `tasq inspect`,
event cursors, `doctor`, backup and journal commands.

**Support:** the Local Console provides live/stale workspace overview, bounded
operational health, seven canonical views and previewable redacted support
bundles. Its empty, mature, hostile, corrupt and large-ledger browser paths are
certified in Chromium on Linux and macOS with injected authority time.
Cross-workspace fleet health and remediation workflows are not implemented.

### 4.5 TypeScript application or runtime integrator

**Need:** embed durable coordination while retaining control of execution and
identity.

**Path:** import Core, supply store/workspace/identity/clock, call canonical
services, and map external runtime tasks to attempts/artifacts rather than
completion.

**Support:** implemented and clean-room tested from candidate package bytes.
Compatibility, installation and support policy are defined, but no protected
public package release exists yet.

### 4.6 Interactive agent runtime or control-plane integrator

**Need:** accept durable work into a system that owns machines, conversations,
terminals or agent runs without creating a second commitment truth.

**Path:** read bounded context, inspect one commitment, accept assignment,
claim before autonomous work, and map each stable external run to one attempt.
Keep the resumable conversation in `contextId`, the individual run in
`externalId`, and machine/session/repository identities in `external_ref`.
Publish artifacts or evidence separately and never complete from runtime
success alone.

**Support:** the required kernel records and embedded/CLI/local-MCP integration
surfaces exist. TQ-304 certifies durable workflow runtimes; the distinct
interactive conversation/run shape is certified from clean-room candidates
and the exact published `0.1.0` package tarballs on both supported targets.

**Non-claim:** Tasq does not launch the agent, stream its terminal, own its
conversation, choose its machine or authenticate a remote control plane.

### 4.7 Connector author

**Need:** observe an external system or perform one authorized provider effect.

**Path:** implement the connector conformance contract outside Core, resolve
credentials late, enforce permits/fences immediately before I/O and return a
verified receipt or honest indeterminate outcome.

**Support:** SDK and reference examples exist. General Gmail, Mercury,
calendar, GitHub or deployment products do not.

### 4.8 Extension author

**Need:** add typed conditions, observations and deterministic evaluators for
an unfamiliar domain.

**Path:** publish an immutable manifest/runtime pair behind the extension SDK;
keep provider I/O and human policy outside the extension evaluator.

**Support:** immutable manifest installation is exposed by Embedded Core and
runtime composition is implemented by the SDK. Executable downloading,
signatures, sandboxing and a hosted public extension catalog are not
implemented.

### 4.9 Remote agent, remote human or another machine

**Need:** reach one shared authority over a network.

**Path today:** none packaged. An integrator may embed Core and replication
services, but that integration is not a supported Tasq Server.

**Support:** not implemented. Same workspace text on two isolated stores is
not rendezvous. Setting an arbitrary database URL is not a remote support
claim.

### 4.10 Prospective adopter or evaluator

**Need:** understand the product, select the correct integration path and
verify what is actually available without reading implementation chronology.

**Path:** open <https://tasq.run> or inspect its `/product-truth.json` export.
The public canonical repository remains the source authority. Follow the
consumer-specific guide to the canonical CLI, local MCP, Console or embedded
path. Check the displayed repository-contract digests when exact support
provenance matters.

**Support:** the static application and export are implemented and tested in
the public canonical repository and deployed at <https://tasq.run>.

**Non-claim:** the site is not the Local Console, a Tasq ledger API, a remote
MCP endpoint or evidence that packages have been published.

For a machine starting before it has an executable, `/adopt.json` is the
versioned causal pointer. It returns acquisition argv, working-directory and
placeholder contracts, then an onboarding argv template. The current contract
is explicitly mutable source-build guidance, not a protected-release claim.

## 5. Use-case map

| Use case | Kernel fit | Product readiness | Missing outer layer |
|---|---|---|---|
| Local coding-agent handoff | Excellent | Ready locally | Protected public release channel |
| Interactive agent control plane | Excellent | Published-package conformance complete | Runtime-specific integration and deployment |
| Multi-agent contention on one host | Excellent | Ready locally | Protected public release channel |
| Robotics resource coordination | Excellent | Kernel/CLI ready | Robot adapter and fence enforcement |
| Research with human acceptance | Excellent | Kernel ready | Domain UI and evidence policy |
| Deployment operations | Excellent | Kernel/reference connector ready | Production connector and credentials |
| Important communications | Good with effect gate | Kernel ready | Provider connector and approval UX |
| Financial action | Good only with strict authority | Adversarial kernel proof | Production connector, identity and ADR-005 |
| Long external wait | Excellent | Ready through typed extensions | Production watcher |
| Personal planning | Optional profile fit | Existing reference use | Friendly UI and packaging |
| Customer support workflow | Good | Integration required | Domain extension and connector |
| Cross-device/offline work | Good neutral projection | Kernel implemented | Authenticated transport and operator product |
| Multi-user remote team | Good target | Not implemented | Tasq Server and ADR-004 implementation |

## 6. Support vocabulary

Every product claim uses exactly one of these levels:

- `implemented_certified`: shipped composition with executable release gate;
- `implemented_local_only`: shipped, but deliberately limited to one host;
- `implemented_integration_required`: code exists behind an integrator-owned
  boundary and is not a zero-integrator product;
- `reference_only`: example behavior without production support promise;
- `accepted_design_not_executed`: accepted contract, no shipped behavior;
- `not_implemented`: no supported entrypoint;
- `impossible_without_transport`: no causal path exists.

Words such as available, supported, self-hosted, hosted, live or secure may not
replace these levels without executable evidence.

## 7. Product rules

1. Core remains headless and transport-neutral.
2. Local remains useful without Server or Cloud.
3. Every surface delegates to one kernel truth; no web or protocol shadow DB.
4. Agents consume JSON/contracts, never inspector HTML.
5. Humans receive progressive projections, not raw tables by default.
6. A remote surface passes ADR-004 before advertising remote access.
7. Device time enters only through one host-injected `Clock` adapter.
8. Success from a runtime or provider never silently completes a commitment.
9. Distribution and installation are part of product correctness.
10. A clean-room user journey must prove every public support claim.

## 8. Public adoption journey

The complete intended local journey is:

```text
learn -> install -> verify -> create/join workspace -> connect first agent
      -> inspect local console -> connect second agent -> recover contention
      -> upgrade -> backup/restore -> uninstall without data loss
```

Today, behavior from `create/join workspace` onward is substantially proven,
and candidate acquisition/install/upgrade/uninstall is clean-room tested.
ADR-008 has fixed the Tasq identity, Apache-2.0 license, `@tasq-run/*` package
boundary and dedicated repository. That repository is now a public-source
alpha. TQ-607 still requires retained-data use across three real consumers and
an explicit decision before package publication resumes. Protected release
distribution and independent published-byte validation are still absent;
TQ-603–TQ-606 close that product gap after TQ-321, TQ-608 and a TQ-607 `go`.

The later server journey is:

```text
deploy -> configure issuer -> create workspace -> bind principal -> grant
       -> connect REST/MCP/web -> revoke/rotate -> backup/restore -> upgrade
```

No deployable step in that second journey is currently advertised as
implemented. TQ-801/TQ-802 implement the internal identity/authority contracts,
store and router. TQ-803/TQ-804 add read and registered mutation handlers that
a host may integrate, but do not expose deployment, concrete issuer
configuration or a running connection surface.

## 9. Documentation contract

The future public site information architecture is organized by consumer, not
implementation chronology:

```text
concepts/       commitments, execution, evidence, effects, authority
getting-started install, workspace, first agent, Local Console
agents/         CLI, MCP, cursors, contention, recovery
sdk/            Core, runtime adapters, extensions, connectors
operators/      storage, backup, monitoring, security, replication
self-hosting/   explicitly future until Tasq Server ships
reference/      contracts, CLI, schemas, ADRs and historical TQ evidence
```

In this source repository, `README.md` routes each audience,
`../guides/DEVELOPMENT.md` onboards contributors, and package READMEs own local
boundaries. The TQ/ADR documents remain engineering contracts and evidence;
they are not the default learning path for an adopter.

## 10. Acceptance of this contract

TQ-601 is complete when:

- human and machine documents agree on every current surface;
- Core, Local, Server and Cloud cannot be conflated;
- every consumer has an entrypoint or an explicit unsupported result;
- public installation is not hidden inside the cold-agent certificate;
- the Local Console is separate from the marketing/docs site;
- the backlog orders productization before hosted breadth;
- docs tests fail if REST, remote MCP, self-hosting or hosted behavior is
  falsely presented as shipped.
