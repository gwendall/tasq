# ADR-010 — Remote client package and enrollment boundary

> **Status:** Accepted — 2026-07-24
> **Decision owner:** `@gwendall`
> **Execution:** TQ-809

## Context

The local high-level API belongs in `@tasq-run/core` because it composes the
embedded store and kernel. A remote client has the opposite trust boundary: it
must contain no database, migrations, authority cache or kernel
reimplementation. Placing both in Core would make a thin Fetch client install
the embedded database closure and blur which side owns truth.

Remote onboarding also needs a bootstrap credential. An actor label cannot
serve as authentication, and handing a client a database URL would bypass the
ADR-004 guard.

## Decision

- `@tasq-run/client` is the public package coordinate for the runtime-neutral
  remote TypeScript client. Its first source candidate is TQ-809; it is not
  published or supported from registry bytes until a protected release
  includes and certifies it.
- The client accepts an explicit HTTPS endpoint, workspace and access token.
  It uses only the guarded REST contract and exposes typed reads, exclusive
  event cursors and registered operations with caller-supplied idempotency.
- The CLI stores named remote profiles separately from Local config. A profile
  contains endpoint, workspace and opaque credential, is `0600` inside a
  `0700` directory and is never inferred from cwd.
- Enrollment codes are random, expiring, one-use bootstrap secrets. The
  authority record binds an already-existing principal, issuer/subject
  binding, exact action upper bound, client kind and access expiry before the
  code is revealed.
- The authority store persists only HMAC-SHA-256 digests under a host secret
  pepper. Redemption atomically consumes the enrollment and inserts one
  revocable opaque access credential. Raw enrollment and access tokens never
  enter the database or audit.
- The initial credential verifier is an integration-grade opaque
  introspection adapter. TQ-807 must additionally ship a standards-based
  verifier for the deployable Server; this adapter does not turn the current
  host-integrated package into a runnable Server.
- Every request is still intersected with live subject binding, action upper
  bound, grants/delegation and resource scope. Enrollment never grants rights
  by itself.
- Logout removes only local client state. Server revocation is explicit and
  separate. Rotation is create new enrollment, validate the new credential,
  revoke the old server credential, then remove/replace the old local profile.

## Consequences

There is one more intended public package, increasing the next release
candidate from seven to eight packages. Existing `v0.3.0` release metadata
must remain historically exact. Release policy, build tooling, SBOM,
provenance and clean-room tests must include `@tasq-run/client` before any
registry support claim.

Remote CLI and client source can be repository-certified before TQ-807 because
they run against the host-integrated Fetch interface. They are not a usable
public remote product until a deployable Server endpoint and operator
lifecycle pass TQ-807/TQ-808.

## Rejected alternatives

- Put remote Fetch methods in Core: shallowens both modules and drags a local
  database closure into every remote consumer.
- Use actor text or workspace ID as authentication: attribution is not
  identity.
- Store raw tokens for recovery: a control-plane database disclosure would
  immediately disclose live credentials.
- Give clients LibSQL credentials: bypasses workspace routing, live revocation
  and operation-level authority.
- Delete server data on logout: client state and durable workspace ownership
  are separate lifecycles.
