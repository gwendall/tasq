# ADR-019 — Bound the first experimental Cloud composition

> **Status:** accepted for the private experiment; production and managed-service gates open
> **Date:** 2026-08-20

## Decision

Run the first Cloud control-plane experiment as two private Fly applications:
`tasq-control` owns one encrypted-volume SQLite control database and
`tasq-identity` supplies a deliberately narrow single-operator OIDC adapter.
The control plane provisions the existing `tasq-api` Server deployment by its
exact protected image digest and stores only opaque secret references.

The reference identity adapter must fail closed. Its authorization endpoint is
protected by an explicit HTTP Basic gate, authorization codes are short-lived
and one-use, and client, redirect and post-logout coordinates are exact. It is
not a general identity provider and does not establish a production login,
managed Cloud, multi-tenant security or availability claim.

## Why

The experiment needs executable evidence for control-plane reconciliation,
same-origin BFF behavior, identity invalidation and provider operations. It
does not need a permanent database or identity architecture before independent
review and real operator use. Keeping these adapters outside Core preserves the
provider-neutral boundary while making the remaining risks explicit.

## Invariants

- Core owns no provider policy, credential or identity-runtime state.
- Every authoritative time decision uses an injected `Clock`.
- Browser sessions never receive the downstream Server bearer.
- Remote effects remain denied.
- Only exact Server image digests and opaque secret references may be bound.
- An anonymous request can never mint an authorization code.
- Deployment evidence is not a production, SLA or general availability claim.

## Exit gates

Before any managed-service claim, replace or independently accept the
single-volume database, integrate a real identity provider and workload secret
manager, deploy and recertify the current fail-closed identity runtime, prove
region recovery, and pass independent multi-tenant infrastructure and web
security review plus an unbriefed incident drill.
