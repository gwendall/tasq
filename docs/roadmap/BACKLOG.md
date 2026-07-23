# Tasq backlog

This is the canonical ordered execution backlog for Tasq. The machine-readable
form is [`BACKLOG.json`](BACKLOG.json). Product claims remain authoritative in
[`../concepts/PRODUCT_SURFACE_MATRIX.json`](../concepts/PRODUCT_SURFACE_MATRIX.json); a backlog item
never turns planned work into shipped behavior.

**Updated:** 2026-07-23

**Current product:** Tasq Core + Tasq Local  
**Current priority:** finish the verified acquisition and universal agent
entrypoint (TQ-610), then rerun the independent blind-human adoption session.
Continue retained-data dogfood in parallel as the stable-graduation gate.
After that short repair, build the online central Server path without waiting
for optional offline replication.

The detailed task inventory, acceptance criteria and verification routes for
public adoption through Server and Cloud are in
[`PUBLIC_ADOPTION_TO_CLOUD_EXECUTION_PLAN.md`](PUBLIC_ADOPTION_TO_CLOUD_EXECUTION_PLAN.md).

## What is already proven

The universal kernel, local CLI, local stdio MCP, extension and connector
boundaries, protocol adapters, transactional delivery, explicit replication,
autonomous onboarding, bounded context, external context links and current
read-only loopback Console are implemented and covered by the repository's
tests and evals. TQ-601 froze the product shapes; TQ-602 froze the public legal,
package and governance boundary.

The repository also contains the TQ-605 static public product/docs app. Its
rendered support states and `/product-truth.json` are generated from canonical
machine contracts. It is repository-certified and deployed from public `main`
at <https://tasq.run>. This URL is not a package-release claim.

The dedicated canonical repository is public and Linux/macOS CI is live.
Pull requests, both verification checks, linear history, immutable `v*` tags,
secret scanning, push protection and private vulnerability reporting are
platform-enforced. Repository visibility is still not release evidence.
Release archives and seven `@tasq-run/*` package candidates are deterministic and
clean-room tested. PR [#5](https://github.com/gwendall/tasq/pull/5) added and
certified the candidate install/upgrade/restore/uninstall lifecycle on both
native targets.

The repository follows open-source engineering discipline as a public alpha:
standalone source authority, public/private package boundaries, DCO,
reproducible setup, Linux/macOS CI, complete onboarding and versioned machine
truth. TQ-607 separates alpha distribution from stable product readiness. The
next two proofs are the first protected public bytes and repeated useful
operation through real adopters, not more repository-only architecture.

## Current gates

- **Public Local alpha — live.** Anonymous users can clone `main`, install all
  seven `@tasq-run/*@0.2.0` packages from npm, or download the attested
  macOS-arm64/Linux-x64 assets from the immutable
  [`v0.2.0`](https://github.com/gwendall/tasq/releases/tag/v0.2.0) release.
  The historical `alpha-bootstrap` tag is not a supported channel.
- **TQ-321 — done, zero-context agent integration.** Native Codex and Claude
  Code marketplace paths pass real isolated install, two-process behavioral and
  uninstall trials. Both hosts read before mutation, resume the same attempt
  from an exclusive cursor, reject stale resource authority, complete with
  evidence and preserve the ledger byte-for-byte through uninstall. See
  `../contracts/TQ-321_AGENT_PLUGIN_CERTIFICATION.json` and
  `../../evidence/tq-321/latest.json`.
- **TQ-608 — done for the current release.** The
  executable and release manifests declare store compatibility; existing-store
  upgrades create verified private snapshots and durable receipts, fail closed
  on ambiguous/newer history, reconcile real process kills, run post-checks and
  support bounded create-only portable import. A real file-size quota proves
  snapshot failure before schema mutation. Exact `v0.2.0` bytes migrate the
  populated format-5 fixture on both targets. Exact N-2 evidence becomes
  mandatory once three protected release lines exist.

- **TQ-607 — in progress, private multi-application dogfood.** The program must
  span at least 30 calendar days, including at least 20 active personal-use
  days, real Kami resource contention/fence/reclaim, and a Denshin-shaped or
  equivalent interactive-runtime lifecycle. It also requires two retained-data
  upgrades, backup/restore, replacement-agent recovery, cold onboarding and an
  explicit `go`, `extend` or `no_go` decision. See
  `../contracts/TQ-607_PRIVATE_DOGFOOD_GATE.md` and `../contracts/TQ-607_DOGFOOD_STATUS.json`. The
  baseline, Kami and interactive-runtime journeys, backup/restore,
  replacement-agent recovery, cold onboarding, support review and first
  forward upgrade are retained. The personal track is at 1/20 active days and
  1/3 required journeys; run `pnpm --silent dogfood status --json` for the
  authoritative live counters and next action.
- **TQ-603 — done, first protected release published.** The maintainer
  authorized `v0.1.0` as an explicitly labeled public alpha on 2026-07-23.
  The authenticated `gwendall` operator controls the `tasq-run` npm
  organization; `npm team ls tasq-run` returned its developers team on
  2026-07-23. Protected bootstrap run
  [30005833862](https://github.com/gwendall/tasq/actions/runs/30005833862)
  published and byte-verified all seven `0.1.0-alpha.0` identities under the
  non-default `alpha-bootstrap` tag. Every package now trusts
  `gwendall/tasq:.github/workflows/release.yml:release`; the bootstrap secret
  is deleted and its granular token revoked. Protected run
  [30011315256](https://github.com/gwendall/tasq/actions/runs/30011315256)
  then published all seven `0.1.0` packages through OIDC and built both native
  targets from commit `0f5357ea10e0eb9f86f143a4fc38030624238bd2`.
  The exact attested artifacts are attached to immutable tag `v0.1.0`; the
  current release certificate now tracks `v0.2.0`. The tag workflow
  fails before building unless the exact version, repository, package boundary,
  maintainer decision and channel-specific gates match. Unreviewed workstation
  builds, implicit visibility changes and long-lived automation tokens remain
  forbidden.
- **TQ-604 — done.** Protected run
  [30015923266](https://github.com/gwendall/tasq/actions/runs/30015923266)
  downloaded the exact `v0.1.0` release, verified every GitHub attestation and
  passed install, onboarding, contention, Console, backup, upgrade, restore and
  data-preserving uninstall on macOS ARM64 and Linux x64.

During alpha and TQ-607, fixes discovered by real adopters are in scope. New
Server/Cloud breadth remains behind published-byte Local certification.

## Ordered checkpoints

### 1. Harden the public alpha

- **TQ-321 — done:** the full native Codex and Claude Code two-process matrix
  passes from the public marketplace with no repository briefing.
- **TQ-608 — done for current release:** exact first-release replay passes;
  enforce exact N-2 when three protected release lines exist.

### 2. Finish Local alpha distribution

- **TQ-603 — done:** `v0.1.0`, seven npm packages and both native artifact
  sets are published with immutable coordinates and provenance.
- **TQ-604 — done:** downloaded release, target, source commit and protected
  workflow evidence are recorded in the lifecycle certificate.

### 3. Complete the Local Console

- **TQ-701 — done:** the audited inspector now shares bounded canonical JSON
  read models for active commitments, actors, claims, resources, waits,
  effects, redacted audit and honest operational health. Pages use scoped
  keyset cursors and every read has one injected time snapshot. See
  `../contracts/TQ-701_CONSOLE_READ_MODELS.md`.
- **TQ-702 — done:** cursor-driven loopback SSE and bounded polling now share a
  redacted event-batch contract with exclusive reconnect, typed gap/ahead
  recovery, one-frame backpressure and exact overflow continuation. It creates
  no second truth and injects both authority time and transport scheduling. See
  `../contracts/TQ-702_CONSOLE_LIVE_TRANSPORT.md`.
- **TQ-703 — done:** the server-rendered operator Console now provides
  accessible responsive navigation, bounded page filters, an audit timeline,
  explicit live/stale states and a preview-before-download redacted support
  bundle. It stays read-only and unauthenticated only because it stays on
  loopback. See `../contracts/TQ-703_OPERATOR_CONSOLE.md`.
- **TQ-704 — done:** installed Tasq Local
  now starts one explicit foreground Console, emits a versioned machine
  announcement, proves live discovery with `web status`, cleans crash-safe
  private registration, and preserves same-ledger Console behavior through
  upgrade and uninstall. Standalone and npm candidates load the full UI without
  checkout-relative assets or hidden listeners. See
  `../contracts/TQ-704_INSTALLED_CONSOLE_LIFECYCLE.md`; exact downloaded-byte
  confirmation passes on both supported targets.

### 4. Explain and validate the public product

- **TQ-605 — done:** the distinct static Next.js + TypeScript + Tailwind +
  shadcn/ui product/docs app covers every current consumer journey, renders
  support and release gates from versioned repository truth, exports the same
  machine JSON and uses only synthetic illustrations. It is deployed from
  public `main` at <https://tasq.run>. See
  `../contracts/TQ-605_PUBLIC_SITE.md`.
- **TQ-609 — done:** every public command, example, product promise and Local
  limitation is now exact and executable. The prefix-install/PATH mismatch,
  rendered `+` markers, illustrative onboarding JSON, nonexistent SDK API,
  stale pre-publication prose and overly architectural first explanation are
  removed. Site tests execute the displayed install, onboarding, MCP, Console,
  operations and Core examples against the published release; browser
  acceptance verifies the real Local Console evidence and Local-only boundary.
- **TQ-610 — done:**
  verified `bunx`/`npm exec` try paths, the versioned checksum-authenticating
  persistent installer, stable `/SKILL.md`, `/agents`, `/llms.txt` and
  `/integration.json` entrypoints, explicit Codex/Claude/generic MCP recipes,
  an isolated demo, the non-secret project rendezvous schema and the one-command
  human setup are published in `v0.1.1`. Integration `0.1.2` passes the
  public-main native Codex and Claude matrix with zero interventions. The
  protected npm/native release and downloaded-byte recertification pass on
  macOS ARM64 and Linux x64 GNU. See
  `../contracts/TQ-610_ACQUISITION_AND_AGENT_ENTRYPOINT.md`.
- **TQ-611 — done:**
  `createLocalTasq` now binds an explicit store, workspace, actor and clock
  behind one deep `@tasq-run/core` interface. Generated candidates contain
  compiled ESM and declarations; fresh Node 22 and Bun consumers both pass the
  same-ledger restart journey, and the npm README is generated from the
  executable example. Protected `v0.2.0` packages and native assets are
  published; exact registry tarballs pass the same Node/Bun restart journey
  and both native targets pass the full post-release replay. See
  `../contracts/TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.md`.
- **TQ-612:** after ADR-005, separate evidence, completion proposal, validation
  decision and final completion. Ship deterministic, independent-attestation,
  optimistic-challenge and adjudicated policy shapes with explicit
  `too_early`, `indeterminate` and `challenged` outcomes. Economic bonds remain
  outside the kernel. See
  [`../research/PREDICTION_MARKET_ORACLES_FOR_TASQ.md`](../research/PREDICTION_MARKET_ORACLES_FOR_TASQ.md).
- **TQ-606 — published-byte automation complete, human gate:** `/adopt.json` now closes the
  machine path before the executable. Package-independent Python/Node consumers
  install candidate bytes outside the checkout, onboard two actors, recover
  typed contention with a higher fence, complete with evidence and inspect the
  same ledger through installed Console. The first published-byte replay passes
  on both targets. Final closure requires one independent unbriefed human
  session; see
  `../contracts/TQ-606_PUBLIC_ADOPTION.md`.
- **TQ-705 — done:** fixed-clock, process-isolated empty, mature, hostile,
  corrupt and 2,501-commitment fixtures now run through the production Console
  in real Chromium on Linux and macOS. The gate proves safe corruption failure,
  escaping/redaction, bounded keyset pages, responsive operation and HTTP
  read-only behavior; see `../contracts/TQ-705_CONSOLE_BROWSER_CERTIFICATION.md`.

### 5. Certify external interactive runtimes

- **TQ-320 — done:** a clean-room runtime
  now installs generated `@tasq-run/*` tarballs and proves explicit assignment,
  lost-response retry, claim expiry and higher-fence reclaim,
  `input_required` resume on the same attempt, two runs in one conversation,
  immutable terminal state, distinct artifacts/evidence, cursor recovery and
  explicit completion. The autonomous CLI guide also exposes additive
  retry-safe attempt recipes; no Machine, terminal, conversation or provider
  ontology entered Core. The same fixture passes from exact protected
  `@tasq-run/*@0.2.0` packages on both supported targets. See
  `../contracts/TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md` and
  `../contracts/TQ-320_INTERACTIVE_RUNTIME_CERTIFICATION.json`.

  TQ-607's Denshin journey remains private product-learning evidence.

### 6. Prove retained product value for stable graduation

- **TQ-607:** continue the three-consumer dogfood program on retained ledgers,
  classify every material workaround, complete the cross-cutting recovery
  drills and record the stable-graduation decision. The remaining execution is
  repeated personal use, the open/blocked/resumed/evidence path, the
  no-direct-store-repair proof, one more forward upgrade and the minimum
  calendar duration. Passing repository tests or publishing alpha bytes cannot
  manufacture this evidence.

### 7. Build self-hosted Tasq Server

- **TQ-801 — done:** strict verified-identity/binding/grant/decision contracts,
  16 digest-bound actions and one pure injected-clock evaluator implement the
  inner ADR-004 guard without claiming a remote surface. See
  `../contracts/TQ-801_HOSTED_AUTHORITY_FOUNDATION.md`.
- **TQ-802 — done:** a checksum-migrated authority control plane now owns
  revisioned/idempotent bindings, grants, delegation, eligibility, decisions
  and append-only audit. The host-configured opaque router opens no workspace
  ledger before an allow; see `../contracts/TQ-802_AUTHORITY_STORE_ROUTER.md`.
- **TQ-803 — done:** host-integrated Fetch REST handler with RFC 9728
  discovery, strict verifier boundary, live authorization, bounded commitment
  reads and payload-free event metadata. It has no listener or concrete
  credential adapter; see `../contracts/TQ-803_HOSTED_READ_REST.md`.
- **TQ-804 — done:** registered mutation REST now requires caller-scoped
  idempotency and holds the live authority writer gate through the host's
  durable domain commit. Cross-database loss becomes typed exact recovery, not
  fake ACID; see `../contracts/TQ-804_GUARDED_MUTATION_REST.md`.
- **TQ-805:** remote MCP behind the identical guard, with REST/MCP parity.
- **TQ-809:** add the remote CLI and runtime-neutral TypeScript client with
  explicit endpoint/workspace selection, bounded enrollment, credential
  recovery/revocation and cursor-safe event resume. Online clients use one
  central Server authority and receive no direct database credential.
- **TQ-807:** deploy an online Server artifact/image with a concrete credential
  verifier, explicit configuration, same-origin authenticated read-only
  Console, health, backup, restore and upgrade contracts. TQ-806 no longer
  blocks this first online product.
- **TQ-808:** hostile multi-surface certification across issuers, workspaces,
  revocation races and clean-room self-hosting.
- **TQ-806:** after TQ-808, add optional authenticated offline replication,
  visible conflicts, recovery and authority rotation. Offline clients cannot
  retain expired claim, lease, approval or effect authority.
- **TQ-810:** after TQ-808, publish stable remote API schemas and thin
  cross-language clients beginning with Python. No language client
  reimplements kernel or migration semantics.

Server is not the Local loopback inspector exposed on a public interface. It
must implement the complete ADR-004 trust chain first.

### 8. Build managed Tasq Cloud

- **TQ-901:** tenant control plane and isolated workspace provisioning.
- **TQ-902:** same-origin hosted BFF sessions and authenticated Console.
- **TQ-903:** human-device and workload onboarding, recovery and revocation.
- **TQ-904:** quotas, retention, export/delete, incident, support and billing
  boundaries.
- **TQ-905:** multi-tenant isolation, key rotation, recovery and support-access
  certification.
- **TQ-906:** remote effects only after ADR-005 and an independent authority
  review; hosted operation remains effect-disabled by default.

## Definition of done

Every checkpoint must have:

1. a first-principles contract and explicit authority owner;
2. no provider policy, credential or runtime ownership leaking into Core;
3. an injected `Clock` for every authoritative time decision;
4. state-based tests plus adversarial evals for concurrency, trust, persistence
   or onboarding changes;
5. updated human and machine product truth with honest non-claims;
6. a DCO-signed commit, reviewed PR, green Linux/macOS CI evidence and merge;
7. external evidence when the claim concerns a registry, published artifact or
   deployed service.

TQ-607 additionally requires retained real-use evidence: a synthetic eval may
verify a fix but cannot replace the dogfood duration, adopter journeys or
maintainer launch decision.

## Decisions still required

ADR-005 must define evidence trust classes, authenticity, supersession,
revocation and retention before TQ-612 independently validated completion or
TQ-906 remote effects can be accepted. It does not block Local read-only
product work, ordinary attributable completion or the online Server.

## Explicit non-goals

- no generic editable todo UI that bypasses canonical services;
- no public binding of the unauthenticated Local Console;
- no custom workflow engine, vector memory or provider credential store;
- no actor label treated as authentication or permission;
- no device-clock last-write-wins or hidden wall-clock authority;
- no Server/Cloud claim based only on an ADR, inner kernel or website mockup.
