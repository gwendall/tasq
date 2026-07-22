# Tasq security policy

## Reporting a vulnerability

Do not open an issue for a suspected vulnerability. Use the repository's
private vulnerability reporting flow to open a private GitHub Security
Advisory; if that is unavailable, email `gwendall@metahood.xyz`.

Include the affected version or commit, entrypoint, reproduction, impact and
whether secrets or a real ledger were involved. Do not include live
credentials or private ledger contents unless the maintainer explicitly asks
for a safe transfer method.

No response-time or bounty SLA is promised. The maintainer will publish scope,
mitigation and compatibility impact with a coordinated advisory when the
report is confirmed.

## Supported versions

Before the first public release, only the latest `main` is maintained. After
publication, the latest minor receives normal fixes and the previous minor
receives critical security and data-loss fixes for 90 days after supersession.
Release metadata is authoritative if it narrows that window.

## Trust boundaries

- Tasq Local is a single-host product. Actor labels are attribution, not
  authentication.
- Local MCP capabilities are selected and enforced by its host.
- The Local Console is loopback-only and read-only; it is not safe to expose
  through a generic reverse proxy.
- The public product/docs app candidate is a static, ledger-free build. It
  imports no Console/Core runtime and exposes only versioned product truth. It
  is implemented but no production deployment or domain is currently claimed.
- Console registration proves a specific foreground loopback listener is live;
  its local descriptor and instance ID are discovery metadata, not credentials
  or authorization. Install creates no listener or daemon.
- Host-integrated authenticated read and registered-mutation REST handlers
  exist, but no REST endpoint, remote MCP, Tasq Server release or Tasq Cloud
  service is shipped.
- The internal TQ-801 authority evaluator is deny-by-default and
  injected-clock-only, but it trusts that an upstream adapter already verified
  credentials and that a future authority store supplied a current snapshot.
  Calling it does not authenticate a request or create a safe remote route.
- TQ-802's private control plane stores authority records and audit, not
  credentials. Its router accepts only host-configured opaque storage binding
  IDs and invokes no workspace opener before an allow. It is still not a safe
  public listener. TQ-804 now holds that live authority writer gate through a
  durable idempotent domain mutation without falsely claiming cross-database
  ACID.
- TQ-803 accepts identity only from an injected verifier, rejects malformed
  inputs before that verifier or any workspace opener, and uses the live
  TQ-802 guard. The host is responsible for correct issuer, audience, token
  type, lifetime, key and sender-binding verification; Tasq currently ships no
  concrete verifier adapter.
- TQ-804 accepts only host-registered operation/action mappings and requires a
  caller-scoped idempotency key. Its authority `BEGIN IMMEDIATE` gate remains
  held through the host's durable domain callback, so concurrent revocation
  either commits first or receives typed `authority_busy`; it cannot cross the
  admitted write. Separate databases are not claimed as ACID. A lost or
  corrupt post-commit receipt is `mutation_outcome_unknown` and must be retried
  with the same key.
- Connectors own credentials and must enforce permits, fences and receipts at
  the final I/O boundary.
- Runtime/provider success never grants commitment-completion authority.
- Ledger prose is untrusted data and cannot widen tool or effect authority.
- Kernel time is host-injected. Raw device time is isolated to the system
  clock adapter and cannot decide replicated ordering or authority by itself.

See the [effect threat model](docs/contracts/TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md),
[hosted-tenancy decision](docs/decisions/ADR-004_AUTHENTICATED_HOSTED_TENANCY.md),
and [current state](docs/concepts/CURRENT_STATE.md) for the exact implemented
and unimplemented boundaries.
