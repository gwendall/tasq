# Tasq backlog

This is the canonical ordered execution backlog for Tasq. The machine-readable
form is [`BACKLOG.json`](BACKLOG.json). Product claims remain authoritative in
[`PRODUCT_SURFACE_MATRIX.json`](PRODUCT_SURFACE_MATRIX.json); a backlog item
never turns planned work into shipped behavior.

**Updated:** 2026-07-21  
**Current product:** Tasq Core + Tasq Local  
**Current priority:** finish the first protected public release, then complete
the Local Console before the public website and remote products.

## What is already proven

The universal kernel, local CLI, local stdio MCP, extension and connector
boundaries, protocol adapters, transactional delivery, explicit replication,
autonomous onboarding, bounded context, external context links and current
read-only loopback inspector are implemented and covered by the repository's
tests and evals. TQ-601 froze the product shapes; TQ-602 froze the public legal,
package and governance boundary.

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

- **TQ-701:** audit the existing inspector first, then add only missing bounded
  canonical read models for active commitments, actors, claims, resources,
  waits, effects, audit and health. Every read has explicit limits/cursors and
  an injected time snapshot.
- **TQ-702:** add cursor-driven loopback SSE plus bounded polling fallback with
  reconnect, gap, overflow and backpressure semantics. It creates no second
  truth and never reads authority time implicitly.
- **TQ-703:** build accessible responsive navigation, filters and timelines,
  plus an explicit previewable redacted support bundle. The Console stays
  read-only and unauthenticated only because it stays on loopback.
- **TQ-704:** make Console start, discovery and upgrade work from the installed
  Tasq Local artifact, without checkout-relative assets or hidden listeners.

### 3. Explain and validate the public product

- **TQ-605:** build a distinct Next.js + TypeScript + Tailwind + shadcn/ui
  website from versioned repository truth. It covers each consumer journey,
  renders support states honestly, and uses only synthetic demo data.
- **TQ-606:** give an unbriefed human and agent only the public entrypoint. They
  must install, onboard two actors, survive contention/recovery and inspect the
  same ledger in Console without undocumented help.
- **TQ-705:** certify empty, mature, hostile, corrupt and large-ledger Console
  journeys in real browsers on both supported platforms.

### 4. Build self-hosted Tasq Server

- **TQ-801:** strict identity, subject binding, live authorization decision and
  action registry from ADR-004.
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
