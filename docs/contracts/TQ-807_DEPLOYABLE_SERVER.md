# TQ-807 — Deployable Tasq Server

> **Status:** implementation and local packaged certification complete — 2026-07-24
> **Distribution status:** container candidate; no immutable public image yet
> **Machine certificate:** `TQ-807_SERVER_CERTIFICATION.json`
> **Operator runbook:** `../../deploy/server/README.md`

## Outcome

The former host-integrated Fetch handlers now compose into one deployable
Server runtime:

```text
Caddy HTTPS
    │
Tasq daemon
    ├── RS256 at+jwt / opaque enrollment credential verification
    ├── live ADR-004 authority guard
    ├── guarded REST and stateless remote MCP
    ├── authenticated read-only Console BFF
    └── explicit workspace binding
          ├── Core ledger
          └── immutable remote mutation receipts
```

The daemon exposes `serve`, `check`, `bootstrap`, `enroll`,
`revoke-credential`, `revoke-grant`, `backup` and `restore`. Configuration is strict,
versioned and available both as Zod runtime contracts and JSON Schemas:

- `TASQ_SERVER_CONFIG.schema.json`;
- `TASQ_SERVER_BOOTSTRAP.schema.json`.

Every database URL and storage binding is host-owned. No request path,
workspace text, actor label or token claim can derive a filesystem path.

## Credential boundary

The concrete verifier accepts:

- signed OAuth access JWTs with `typ=at+jwt`, `alg=RS256`, exact configured
  `kid`, issuer, audience, time bounds, unique scopes and public RSA JWK;
- Tasq opaque access credentials created through the one-use TQ-809
  enrollment ceremony.

JWT scope profiles are an upper bound only. Successful verification produces a
strict `VerifiedIdentity`; the live authority store must still find the exact
subject binding, enabled principal and grant. JWT actor text is ignored.
Malformed, expired, wrong-audience, unknown-scope, unknown-key and DPoP inputs
fail closed. Private signing keys remain with the external issuer.

## Domain and idempotency composition

`createHostedCoreWorkspace` is the single Server-owned domain adapter. It
opens `createLocalTasq` with the authorized principal, maps each registered
operation to one Core service and normalizes typed conflicts. Reads paginate
by the stable exclusive `(updatedAt, id)` cursor.

The separate immutable receipt store keys exact results by workspace and the
TQ-804 caller/action-scoped idempotency digest. A retry after a lost response
returns the same result with `replayed=true`; reusing the key for a different
semantic request is a conflict. Core's own durable idempotency remains the
recovery layer if a process dies after the domain commit but before receipt
publication. This is explicit recovery across two stores, not a false
cross-database ACID claim.

## Hosted Console

`/console` is not the Local loopback Console exposed remotely. It is a
same-origin BFF:

1. the browser posts workspace plus access token over HTTPS;
2. the BFF probes the guarded REST read route;
3. success creates a `Secure; HttpOnly; SameSite=Strict` cookie;
4. every rendered page re-enters the guarded REST handler;
5. logout expires the cookie.

It is read-only and contains no second domain service. CSP, no-store,
frame-denial, output escaping and bounded inputs are enforced.

## Operations and lifecycle

The runtime provides state-free liveness, readiness, version and support
metadata. Prometheus text metrics contain only process-wide counters—no
workspace IDs, titles, principals or credentials. Readiness is reached only
after every configured Core and receipt binding has migrated successfully.

Initial authority bootstrap is deterministic and replayable from an immutable
manifest. Non-loopback binding requires an explicit TLS-proxy acknowledgement;
the configured public origin is always canonical HTTPS. The reference Compose
deployment terminates TLS with Caddy, drops Linux capabilities and uses a
dedicated durable volume.

Online backup snapshots authority, Core and receipt databases using SQLite
`VACUUM INTO`, locks file permissions to `0600`, records sizes and SHA-256
digests and writes a completion marker last. Restore verifies the exact config,
topology, every digest and absent destinations before create-only copies. It
never overwrites live state.

## Executable evidence

Repository tests cover:

- concrete RS256 verification and hostile token vectors;
- concurrent one-use enrollment;
- real Core operations, claim/resource contention and stable cursor paging;
- durable receipt replay across adapter restart;
- daemon bootstrap/check/enroll/listener process lifecycle;
- same-origin Console API and browser form sessions;
- online backup, destructive-loss simulation in an isolated fixture, full
  restore, credential survival and exact mutation replay;
- a real Linux container build, declarative bootstrap and health probe.

Run:

```bash
pnpm --filter @tasq-internal/server test
docker build -f deploy/server/Dockerfile -t tasq-server:tq807 .
bun scripts/server-container-smoke.ts tasq-server:tq807
```

## Honest release boundary

The source and local Linux image are certified. TQ-807 remains
`candidate_done_external_gate` until an immutable multi-architecture image,
SBOM, checksums and build provenance are published from protected CI. No public
Server endpoint, managed tenancy, provider connector, remote effect executor,
offline authority or support-access mechanism is claimed.

TQ-808 owns hostile multi-issuer/cross-workspace packaged certification and the
previously unbriefed operator deployment. TQ-811 owns the small human mutation
surface; the TQ-807 Console intentionally remains read-only.
