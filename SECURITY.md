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

## Repository automation

All external GitHub Actions are pinned to full commit SHAs. Workflow permissions
default to none and each job requests only the repository, OIDC or attestation
capabilities it uses. CI fetches complete history and scans it with a
checksum-pinned Gitleaks binary; findings are fully redacted in logs.

## Trust boundaries

- Tasq Local is a single-host product. Actor labels are attribution, not
  authentication.
- Local MCP capabilities are selected and enforced by its host.
- The Local Console is loopback-only and read-only; it is not safe to expose
  through a generic reverse proxy.
- The public product/docs app at <https://tasq.run> is a static, ledger-free
  build. It imports no Console/Core runtime and exposes only versioned product
  truth. Its deployment does not create a Tasq Server, hosted Console or agent
  API.
- Console registration proves a specific foreground loopback listener is live;
  its local descriptor and instance ID are discovery metadata, not credentials
  or authorization. Install creates no listener or daemon.
- Host-integrated authenticated read, registered-mutation REST and stateless
  remote-MCP handlers plus a daemon/container candidate exist, but no public
  REST/MCP endpoint, protected Tasq Server image or Tasq Cloud service is
  shipped.
- The internal TQ-801 authority evaluator is deny-by-default and
  injected-clock-only, but it trusts that an upstream adapter already verified
  credentials and that the TQ-802 authority store supplied a current snapshot.
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
  type, lifetime, key and sender-binding verification. The TQ-807 candidate
  supplies static RS256 JWT and digest-only opaque-credential verifiers; other
  verifier profiles remain host-owned.
- TQ-804 accepts only host-registered operation/action mappings and requires a
  caller-scoped idempotency key. Its authority `BEGIN IMMEDIATE` gate remains
  held through the host's durable domain callback, so concurrent revocation
  either commits first or receives typed `authority_busy`; it cannot cross the
  admitted write. Separate databases are not claimed as ACID. A lost or
  corrupt post-commit receipt is `mutation_outcome_unknown` and must be retried
  with the same key.
- TQ-805 authenticates every MCP HTTP request for the exact resource and URL,
  discards the raw credential before tool dispatch and projects reads and
  mutations through the same TQ-803/TQ-804 handler. Tool visibility and OAuth
  scopes are never live grants; every call reaches the ADR-004 guard. V1 is
  stateless and uses Tasq event cursors rather than MCP session authority.
- TQ-809 enrollment codes are expiring, one-use and pre-bound to an existing
  principal, issuer/subject binding, exact action upper bound and credential
  expiry. The control plane stores only host-peppered HMAC digests of bootstrap
  and access tokens. Redemption, logout or possession of a profile never
  grants authority beyond the next live ADR-004 decision. CLI profile files
  are `0600` inside a `0700` directory; logout does not revoke the Server
  credential, so device loss requires explicit credential/binding/grant
  revocation.
- Connectors own credentials and must enforce permits, fences and receipts at
  the final I/O boundary.
- Runtime/provider success never grants commitment-completion authority.
- Ledger prose is untrusted data and cannot widen tool or effect authority.
- Content digests alone prove byte identity, not principal authorship. The
  TQ-613–TQ-615 source candidate adds purpose-bound Ed25519 statements,
  authority-owned credential lifecycle and append-only verification bindings.
  It accepts only configured trust roots and fails closed on purpose, digest,
  routing, lifecycle, nonce or signature drift. It is not in published
  `v0.3.0`; TQ-616 protected-artifact evidence remains open. Existing connector
  permits and release attestations retain narrower trust domains.
- Signed statements do not prove semantic
  truth, prevent deletion/full-ledger rollback or protect a software key that
  every distrusted same-user process can read. Those guarantees require
  independent validation, signer isolation and external checkpointing where
  policy demands them.
- Authenticated offline replication binds a replica generation to one
  principal and one signed-origin proof per operation. It deliberately cannot
  carry live claims, leases, approvals or effect authority.
- The Cloud source candidate stores HMACed identity subjects and session
  tokens, uses opaque provider/secret-manager references, tenant/device/recovery
  epochs, exact Origin plus CSRF, and tenant-scoped support grants. This does
  not certify a real provider or make Cloud available.
- Server reports remote effects disabled and Cloud denies every `/effects`
  route. A signature, completion decision, tenant session, support grant or
  billing record never grants effect authority; TQ-906 requires independent
  review and deployed connector evidence.
- Kernel time is host-injected. Raw device time is isolated to the system
  clock adapter and cannot decide replicated ordering or authority by itself.

See the [effect threat model](docs/contracts/TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md),
[hosted-tenancy decision](docs/decisions/ADR-004_AUTHENTICATED_HOSTED_TENANCY.md),
and [current state](docs/concepts/CURRENT_STATE.md) for the exact implemented
and unimplemented boundaries.
