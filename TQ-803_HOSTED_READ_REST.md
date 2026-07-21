# TQ-803 — Authenticated hosted read REST

> **Status:** implemented and repository-certified — 2026-07-21  
> **Machine certificate:** `TQ-803_READ_REST_CERTIFICATION.json`  
> **Deployable Server status:** not implemented

## Outcome

Tasq now exports a host-integrated Fetch `Request` → `Response` handler for
authenticated, read-only hosted access. It publishes OAuth protected-resource
metadata, verifies credentials through an explicit host adapter, calls the
live TQ-802 authority guard, and opens only the exact authorized workspace
binding.

This is the first remote-protocol implementation, but it is not yet a runnable
Tasq Server. There is deliberately no listener, TLS stack, concrete
OIDC/JWKS/introspection implementation, mutation route, remote MCP transport,
deployment image or operational lifecycle.

## Host contract

The host must provide four things:

1. a canonical HTTPS protected-resource identifier and authorization issuer;
2. an injected clock;
3. a credential verifier that validates the credential, issuer, audience,
   validity, key/binding and token type before producing strict
   `VerifiedIdentity`;
4. the TQ-802 isolated router whose opaque binding opens a
   `HostedReadWorkspace`.

The verifier is a trust boundary, not a convenience callback. The handler
never derives authority from a bearer string, email, actor label, query
parameter or workspace path.

## Protocol

Discovery follows RFC 9728. For a protected resource
`https://host.example/tasq`, metadata is available at
`/.well-known/oauth-protected-resource/tasq`. An unauthenticated protected
request receives a typed `401` and a `WWW-Authenticate` challenge with the
exact `resource_metadata` URL.

The implemented reads are:

- `GET /v1/workspaces/{workspace}/commitments`;
- `GET /v1/workspaces/{workspace}/commitments/{commitment}`;
- `GET /v1/workspaces/{workspace}/events`.

The routes are relative to the protected-resource path. Workspace identifiers
occupy one percent-encoded path segment, so an opaque ID such as
`robotics/team-a` is addressed as `robotics%2Fteam-a`. Literal slashes remain
route boundaries. Commitment and cursor values are strict and bounded.

Event responses expose only ordering and identity metadata. Domain event
payloads, credentials, storage bindings and authority internals are never part
of the REST contract.

## Request ordering and time

Every request captures exactly one value from the injected clock. The same
timestamp is supplied to credential verification, live authorization,
decision evidence and response metadata. No domain or handler path reads the
device clock directly.

Processing order is intentionally strict:

1. validate origin, route, method and bounded query;
2. verify the credential for the exact protected-resource audience;
3. evaluate the live issuer/subject binding and grants;
4. open the exact opaque workspace binding only on allow;
5. validate bounded host output before serialization.

Malformed input therefore cannot consume verifier, authority or ledger work.
A foreign workspace probe and a request after grant revocation cannot open the
workspace reader. Host contract corruption fails closed.

## Evidence

Package tests exercise RFC discovery, typed challenges, verifier outage,
issuer/subject collision, complex workspace IDs, invalid inputs, exact and
paginated reads, payload redaction, foreign workspace isolation, immediate
revocation, strict output validation and one request-wide clock snapshot.

The independent clean-room eval composes a fresh SQLite authority store, a
host verifier and an opaque workspace reader. It runs discovery through a
valid agent read, cross-workspace probe and live revocation without importing
test fixtures.

## Honest next boundary

TQ-804 adds mutation REST. It must couple live authority preconditions,
idempotency and domain mutation so a revocation race cannot turn an old allow
into a write. TQ-805 adds remote MCP through the same guard. TQ-807 is the
first checkpoint allowed to claim a deployable Server product.
