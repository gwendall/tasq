# Tasq backlog

This is the canonical ordered execution backlog for Tasq. The machine-readable
form is [`BACKLOG.json`](BACKLOG.json). Product claims remain authoritative in
[`PRODUCT_SURFACE_MATRIX.json`](PRODUCT_SURFACE_MATRIX.json); a backlog item
never turns planned work into shipped behavior.

**Updated:** 2026-07-22

**Current product:** Tasq Core + Tasq Local  
**Current priority:** keep the canonical source private and operate Tasq for at
least 30 days across the personal life-pilot, Kami Robotics and an interactive
agent runtime. Make the public-launch decision from that evidence before
publishing packages or expanding remote products.

## What is already proven

The universal kernel, local CLI, local stdio MCP, extension and connector
boundaries, protocol adapters, transactional delivery, explicit replication,
autonomous onboarding, bounded context, external context links and current
read-only loopback Console are implemented and covered by the repository's
tests and evals. TQ-601 froze the product shapes; TQ-602 froze the public legal,
package and governance boundary.

The repository also contains the TQ-605 static public product/docs app. Its
rendered support states and `/product-truth.json` are generated from canonical
machine contracts. It is repository-certified but not deployed, and therefore
does not create a public URL or release claim.

The dedicated canonical repository and Linux/macOS CI are live. The repository
is intentionally private before launch; repository visibility is not release
evidence and must change only after explicit authorization. GitHub branch and
tag protections are unavailable for this private repository on the current
plan, so they must be restored and verified at launch or after a plan upgrade.
Release archives and seven `@tasq/*` package candidates are deterministic and
clean-room tested. PR [#5](https://github.com/gwendall/tasq/pull/5) added and
certified the candidate install/upgrade/restore/uninstall lifecycle on both
native targets.

The repository follows open-source engineering discipline while remaining
private: standalone source authority, public/private package boundaries, DCO,
reproducible setup, Linux/macOS CI, complete onboarding and versioned machine
truth. TQ-607 separates that engineering readiness from product readiness. The
next proof is repeated useful operation through three real adopters, not more
repository-only architecture.

## Current gates

- **TQ-607 — in progress, private multi-application dogfood.** The program must
  span at least 30 calendar days, including at least 20 active personal-use
  days, real Kami resource contention/fence/reclaim, and a Denshin-shaped or
  equivalent interactive-runtime lifecycle. It also requires two retained-data
  upgrades, backup/restore, replacement-agent recovery, cold onboarding and an
  explicit `go`, `extend` or `no_go` decision. See
  `TQ-607_PRIVATE_DOGFOOD_GATE.md` and `TQ-607_DOGFOOD_STATUS.json`.
- **TQ-603 — paused behind TQ-607, then external registry gate.**
  `@tasq/schema` is not published. A TQ-607 `go` permits a separate launch
  authorization; it does not grant it automatically. The authorized registry
  operator must then verify scope/package control, bind the release workflow
  through npm OIDC, restore repository protections and create the first
  immutable protected SemVer tag. Workstation publishing, implicit visibility
  changes and long-lived npm tokens remain forbidden.
- **TQ-604 — candidate complete, published-byte gate.** The complete lifecycle
  passes from generated release assets on macOS arm64 and Linux x64. Final
  closure requires downloading the first protected release, verifying every
  GitHub attestation, and rerunning the same journey from those exact bytes.

During TQ-607, fixes discovered by real adopters are in scope. New Server/Cloud
breadth is intentionally lower priority even when technically unblocked.

## Ordered checkpoints

### 1. Prove private product value

- **TQ-607:** run the three-consumer dogfood program, preserve real ledgers,
  classify every material workaround, complete the cross-cutting recovery
  drills and record the launch decision. Passing repository tests without
  repeated useful operation is insufficient.

### 2. Finish Local distribution

- **TQ-603:** only after a TQ-607 `go`, obtain explicit source-launch
  authorization, restore repository protections, verify npm scope control,
  configure repository-bound trusted publishing, then publish and attest the
  first release.
- **TQ-604:** certify the downloaded release on both supported targets and
  record release URL, version, commit and digests in the lifecycle certificate.

### 3. Complete the Local Console

- **TQ-701 — done:** the audited inspector now shares bounded canonical JSON
  read models for active commitments, actors, claims, resources, waits,
  effects, redacted audit and honest operational health. Pages use scoped
  keyset cursors and every read has one injected time snapshot. See
  `TQ-701_CONSOLE_READ_MODELS.md`.
- **TQ-702 — done:** cursor-driven loopback SSE and bounded polling now share a
  redacted event-batch contract with exclusive reconnect, typed gap/ahead
  recovery, one-frame backpressure and exact overflow continuation. It creates
  no second truth and injects both authority time and transport scheduling. See
  `TQ-702_CONSOLE_LIVE_TRANSPORT.md`.
- **TQ-703 — done:** the server-rendered operator Console now provides
  accessible responsive navigation, bounded page filters, an audit timeline,
  explicit live/stale states and a preview-before-download redacted support
  bundle. It stays read-only and unauthenticated only because it stays on
  loopback. See `TQ-703_OPERATOR_CONSOLE.md`.
- **TQ-704 — candidate complete, published-byte gate:** installed Tasq Local
  now starts one explicit foreground Console, emits a versioned machine
  announcement, proves live discovery with `web status`, cleans crash-safe
  private registration, and preserves same-ledger Console behavior through
  upgrade and uninstall. Standalone and npm candidates load the full UI without
  checkout-relative assets or hidden listeners. See
  `TQ-704_INSTALLED_CONSOLE_LIFECYCLE.md`; downloaded-byte confirmation waits
  for TQ-603.

### 4. Explain and validate the public product

- **TQ-605 — done:** the distinct static Next.js + TypeScript + Tailwind +
  shadcn/ui product/docs app covers every current consumer journey, renders
  support and release gates from versioned repository truth, exports the same
  machine JSON and uses only synthetic illustrations. It is not deployed. See
  `TQ-605_PUBLIC_SITE.md`.
- **TQ-606 — candidate complete, external gates:** `/adopt.json` now closes the
  machine path before the executable. Package-independent Python/Node consumers
  install candidate bytes outside the checkout, onboard two actors, recover
  typed contention with a higher fence, complete with evidence and inspect the
  same ledger through installed Console. Final closure requires the first
  published bytes and one independent unbriefed human session; see
  `TQ-606_PUBLIC_ADOPTION.md`.
- **TQ-705 — done:** fixed-clock, process-isolated empty, mature, hostile,
  corrupt and 2,501-commitment fixtures now run through the production Console
  in real Chromium on Linux and macOS. The gate proves safe corruption failure,
  escaping/redaction, bounded keyset pages, responsive operation and HTTP
  read-only behavior; see `TQ-705_CONSOLE_BROWSER_CERTIFICATION.md`.

### 5. Certify external interactive runtimes

- **TQ-320 — pending after TQ-603:** certify a Denshin-shaped interactive
  runtime consumer without adding Machine, terminal, conversation or provider
  ontology to Core. The gate must cover stable conversation/run identity,
  assignment, claim/fence, attempt lifecycle, `input_required`, multi-run
  resume, artifacts/evidence, explicit completion and crash-safe retry through
  existing public surfaces first. See
  `TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md`.

  TQ-607 first exercises this shape privately to discover friction. TQ-320 is
  the stricter public-byte, package-independent conformance claim; private
  dogfood does not complete it.

### 6. Build self-hosted Tasq Server

- **TQ-801 — done:** strict verified-identity/binding/grant/decision contracts,
  16 digest-bound actions and one pure injected-clock evaluator implement the
  inner ADR-004 guard without claiming a remote surface. See
  `TQ-801_HOSTED_AUTHORITY_FOUNDATION.md`.
- **TQ-802 — done:** a checksum-migrated authority control plane now owns
  revisioned/idempotent bindings, grants, delegation, eligibility, decisions
  and append-only audit. The host-configured opaque router opens no workspace
  ledger before an allow; see `TQ-802_AUTHORITY_STORE_ROUTER.md`.
- **TQ-803 — done:** host-integrated Fetch REST handler with RFC 9728
  discovery, strict verifier boundary, live authorization, bounded commitment
  reads and payload-free event metadata. It has no listener or concrete
  credential adapter; see `TQ-803_HOSTED_READ_REST.md`.
- **TQ-804 — done:** registered mutation REST now requires caller-scoped
  idempotency and holds the live authority writer gate through the host's
  durable domain commit. Cross-database loss becomes typed exact recovery, not
  fake ACID; see `TQ-804_GUARDED_MUTATION_REST.md`.
- **TQ-805:** remote MCP behind the identical guard, with REST/MCP parity.
- **TQ-806:** authenticated replication transport, enrollment, recovery and
  authority rotation.
- **TQ-807:** deployable server artifact/image with explicit configuration,
  health, backup, restore and upgrade contracts.
- **TQ-808:** hostile multi-surface certification across issuers, workspaces,
  revocation races and clean-room self-hosting.

Server is not the Local loopback inspector exposed on a public interface. It
must implement the complete ADR-004 trust chain first.

### 7. Build managed Tasq Cloud

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
revocation and retention before high-stakes automatic completion or remote
effects can be accepted. It does not block Local read-only product work.

## Explicit non-goals

- no generic editable todo UI that bypasses canonical services;
- no public binding of the unauthenticated Local Console;
- no custom workflow engine, vector memory or provider credential store;
- no actor label treated as authentication or permission;
- no device-clock last-write-wins or hidden wall-clock authority;
- no Server/Cloud claim based only on an ADR, inner kernel or website mockup.
