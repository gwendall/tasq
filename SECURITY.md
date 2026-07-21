# Tasq security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. After the public
repository exists, use its private GitHub Security Advisory form. Until then,
or if GitHub reporting is unavailable, email `gwendall@metahood.xyz`.

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
- The public product/docs app is a static, ledger-free build. It imports no
  Console/Core runtime and exposes only versioned public repository truth. It
  is implemented but no production deployment or domain is currently claimed.
- Console registration proves a specific foreground loopback listener is live;
  its local descriptor and instance ID are discovery metadata, not credentials
  or authorization. Install creates no listener or daemon.
- REST, remote MCP, Tasq Server and Tasq Cloud are not currently shipped.
- The internal TQ-801 authority evaluator is deny-by-default and
  injected-clock-only, but it trusts that an upstream adapter already verified
  credentials and that a future authority store supplied a current snapshot.
  Calling it does not authenticate a request or create a safe remote route.
- TQ-802's private control plane stores authority records and audit, not
  credentials. Its router accepts only host-configured opaque storage binding
  IDs and invokes no workspace opener before an allow. It is still not a safe
  public listener, and TQ-804 must make live authority preconditions atomic
  with domain mutations.
- Connectors own credentials and must enforce permits, fences and receipts at
  the final I/O boundary.
- Runtime/provider success never grants commitment-completion authority.
- Ledger prose is untrusted data and cannot widen tool or effect authority.
- Kernel time is host-injected. Raw device time is isolated to the system
  clock adapter and cannot decide replicated ordering or authority by itself.

See `TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md`,
`ADR-004_AUTHENTICATED_HOSTED_TENANCY.md` and `CURRENT_STATE.md` for the exact
implemented and unimplemented boundaries.
