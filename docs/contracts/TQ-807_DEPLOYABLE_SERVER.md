# TQ-807 — Deployable Tasq Server

> **Status:** protected multi-architecture image published and exact-digest certified — 2026-08-12
> **Distribution status:** `ghcr.io/gwendall/tasq-server:0.4.0` at immutable
> `sha256:35ef0553dd370b6c7731152cb0fcc56775a9ddd926a1b3999c43bccc20f38452`
> **Machine certificate:** `TQ-807_SERVER_CERTIFICATION.json` (the original
> TQ-807 digest/image block is frozen historical evidence; its
> `currentCombinedHostedConsole` block delegates current Console truth to the
> TQ-811 certificate)
> **Operator runbook:** `../../deploy/server/README.md`

The `v0.4.0` image was published by protected run
[31613501777](https://github.com/gwendall/tasq/actions/runs/31613501777).
Exact-digest container and Chromium replay passed in run
[31619011510](https://github.com/gwendall/tasq/actions/runs/31619011510).
The same digest runs the private-beta endpoint at `api.tasq.run`; this is not a
managed multi-tenant Cloud, public SLA or remote-effects claim.

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
    ├── authenticated bounded-action Console BFF
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

The original TQ-807 slice was read-only. TQ-811 now adds seven bounded human
actions without adding a second domain service: every form re-enters the
registered REST operation and live authority guard. CSP, no-store,
same-origin referrer confinement, frame-denial, output escaping and bounded
inputs are enforced.

## Operations and lifecycle

The runtime provides state-free liveness, readiness, version and support
metadata. Prometheus text metrics contain only process-wide counters—no
workspace IDs, titles, principals or credentials. Readiness is reached only
after every configured Core and receipt binding has migrated successfully.

Initial authority bootstrap is deterministic and replayable from an immutable
manifest. Non-loopback binding requires an explicit TLS-proxy acknowledgement;
the configured public origin is always canonical HTTPS. The reference Compose
deployment terminates TLS with Caddy, drops Linux capabilities and uses a
dedicated durable volume. Both the Bun Server base image and the Caddy
reverse-proxy image are pinned to immutable multi-architecture OCI digests.
The Server image records its canonical source, Apache-2.0 license, explicit
release version and exact source commit in OCI labels supplied by the protected
builder.

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

The protected publication builder must additionally pass `TASQ_VERSION` and
`TASQ_SOURCE_COMMIT` build arguments. The smoke test rejects an image that
omits the canonical source or license labels; a local image still does not
become publishable evidence.

Protected automation is now prepared in
`.github/workflows/publish-server.yml`. It requires an explicit version, exact
tagged source commit, typed confirmation, the protected `release` environment
and a separate matching authorization in `PUBLIC_RELEASE_POLICY.json`. The
policy now authorizes the exact `v0.4.0` public-alpha coordinate. The workflow
still fails closed for any other version, tag or source identity. It builds
Linux amd64/arm64, attaches SBOM and provenance, records the immutable digest
and replays the container lifecycle from that digest.

The publication is restartable after a partial protected run without treating
mutable tags as authority. Before building, the workflow resolves the exact
version and `sha-<source-commit>` anchors. It builds only when both lookups
return an explicit missing-manifest response. If either anchor exists, both
must resolve to the same digest when present, and that digest must pass the
multi-platform/attached-attestation checks, protected GitHub provenance bound
to this workflow, tag and source commit, and the two packaged smoke replays.
Only then may the workflow verify an existing exact tag or create the missing
source anchor followed by the missing version tag. Digest drift, duplicate
release assets, or an ambiguous registry/GitHub error stops the run; no
`skip-existing` or overwrite path exists.

`.github/workflows/certify-published-server.yml` is the exact-digest
post-publication entrypoint. It also invokes the real Chromium hosted-Console
certifier and preserves its exact-image evidence without turning the run into
an automatic public support claim. The successful protected runs above satisfy
the TQ-807 publication gate.

## Honest release boundary

The source and the historical TQ-807 local Linux image are certified. The
machine certificate deliberately does not relabel that old image ID or source
digest as evidence for the later TQ-811 surface. Current combined Console truth
and its local candidate browser replay live in
`TQ-811_HOSTED_HUMAN_ACTIONS_CERTIFICATION.json`. TQ-807 is shipped for
public-alpha self-hosting: the immutable multi-architecture image, SBOM,
checksums and provenance are published and its exact digest is certified. No
managed multi-tenant Cloud, provider connector, remote effect executor,
offline authority or support-access mechanism is claimed.

TQ-808 owns hostile multi-issuer/cross-workspace packaged certification and the
previously unbriefed operator deployment. TQ-811 supersedes the historical
read-only TQ-807 Console slice with the guarded bounded-action surface; its
exact published-image browser gate passed in run 31619011510.
