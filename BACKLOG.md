# Tasq backlog

This is the canonical ordered execution backlog for Tasq. The machine-readable
form is [`BACKLOG.json`](BACKLOG.json). Product claims remain authoritative in
[`PRODUCT_SURFACE_MATRIX.json`](PRODUCT_SURFACE_MATRIX.json); a backlog item
never turns planned work into shipped behavior.

**Updated:** 2026-07-21  
**Current product:** Tasq Core + Tasq Local  
**Current priority:** finish the external first-release gate while continuing
the blind adoption and hostile-browser certification before remote products.

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

The canonical public repository and protected Linux/macOS CI are live. Release
archives and seven `@tasq/*` package candidates are deterministic and clean-room
tested. PR [#5](https://github.com/gwendall/tasq/pull/5) added and certified the
candidate install/upgrade/restore/uninstall lifecycle on both native targets.

## Current gates

- **TQ-603 — in progress, external registry gate.** `@tasq/schema` is not
  published. This environment has no valid npm identity, so it cannot prove
  ownership of the `@tasq` scope or configure npm trusted publishing. The next
  authorized registry operator must verify scope/package control, bind the
  canonical release workflow through npm OIDC, then create the first immutable
  protected SemVer tag. Workstation publishing and long-lived npm tokens are
  forbidden.
- **TQ-604 — candidate complete, published-byte gate.** The complete lifecycle
  passes from generated release assets on macOS arm64 and Linux x64. Final
  closure requires downloading the first protected release, verifying every
  GitHub attestation, and rerunning the same journey from those exact bytes.

The absence of npm authentication blocks publication, not safe engineering on
later Local milestones.

## Ordered checkpoints

### 1. Finish Local distribution

- **TQ-603:** verify npm scope control, configure repository-bound trusted
  publishing, publish and attest the first release.
- **TQ-604:** certify the downloaded release on both supported targets and
  record release URL, version, commit and digests in the lifecycle certificate.

### 2. Complete the Local Console

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

### 3. Explain and validate the public product

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

### 4. Build self-hosted Tasq Server

- **TQ-801 — done:** strict verified-identity/binding/grant/decision contracts,
  16 digest-bound actions and one pure injected-clock evaluator implement the
  inner ADR-004 guard without claiming a remote surface. See
  `TQ-801_HOSTED_AUTHORITY_FOUNDATION.md`.
- **TQ-802:** subject bindings, grants, audit and isolated storage routing.
- **TQ-803:** authenticated read-only REST, discovery and event metadata.
- **TQ-804:** guarded mutation REST with idempotency, revocation and injected
  authority time.
- **TQ-805:** remote MCP behind the identical guard, with REST/MCP parity.
- **TQ-806:** authenticated replication transport, enrollment, recovery and
  authority rotation.
- **TQ-807:** deployable server artifact/image with explicit configuration,
  health, backup, restore and upgrade contracts.
- **TQ-808:** hostile multi-surface certification across issuers, workspaces,
  revocation races and clean-room self-hosting.

Server is not the Local loopback inspector exposed on a public interface. It
must implement the complete ADR-004 trust chain first.

### 5. Build managed Tasq Cloud

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
6. a DCO-signed commit, public PR, green required Linux/macOS checks and merge;
7. external evidence when the claim concerns a registry, published artifact or
   deployed service.

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
