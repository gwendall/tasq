# TQ-808 — Hostile self-hosted Server certification

> **Status:** protected image and clean-client matrix certified; unbriefed-operator gate remains
> **Date:** 2026-08-12
> **Machine certificate:** `TQ-808_SERVER_HOSTILE_CERTIFICATION.json`

## Tested boundary

The acceptance fixture starts the production Bun daemon as a separate network
process with:

- two independent RS256 issuers and keys;
- two separately bound workspaces and databases;
- one opaque CLI-enrolled agent;
- real REST, official MCP and CLI clients;
- the production authority store, Core adapter and receipt store.

It proves both issuers can operate only their own bound workspace. A credential
from issuer A cannot probe workspace B, even though audience and action scope
are otherwise valid. Expired, wrong-audience, malformed and signature-tampered
credentials fail before domain reads.

## Race and recovery evidence

The fixture creates durable work through REST, reads the exact record through
official MCP and an independently enrolled CLI profile, then kills the daemon
with `SIGKILL`. Restart preserves the domain record and the exact mutation
receipt; repeating the same JWT, request ID and idempotency key returns the
same outcome with `replayed=true`.

A grant revocation races a real mutation through a second operator process.
Authority serialization permits at most the operation admitted before the
revocation commit. The next request is always denied. This test exposed and
fixed a production identity-stability defect: `authenticatedAt` had been
sampled per request, causing a legitimate same-request retry to conflict after
restart. JWT and opaque identities now bind `authenticatedAt` to credential
issuance while authorization time remains the separately injected request
clock.

The backup suite also restores an older completed recovery point after newer
work exists. The restored server contains exactly the selected point and
preserves its credential and receipt; it does not silently merge newer bytes.

## Support and cursor boundary

Authenticated `/v1/workspaces/{id}/support-bundle` re-enters guarded REST and
contains only version, health, workspace identity and explicit redaction
metadata. Tokens, claims, subjects, database paths, commitment content and
event payloads are absent.

Event pages are bounded and resume with an exclusive sequence. The current
self-host profile retains the append-only event history indefinitely, so a
valid past cursor does not expire. TQ-809 already freezes typed HTTP 410
recovery for a host that configures finite retention; this deployment makes no
finite-retention claim and therefore cannot manufacture an expiry event.

## External release gate

The protected multi-architecture image, SBOM, checksums and provenance were
published in run `31613501777`; exact-digest Server lifecycle and hosted
Console certification passed in run `31619011510`.

The macOS ARM64 and Linux x64 GNU clean-client matrix passed on 2026-08-13
against `api.tasq.run`, which resolves to the exact published manifest's
Linux/amd64 child digest. A package-only macOS client created a commitment and
a package-only Linux client replayed the same idempotency key, received the
same result with `replayed=true`, then read the exact record. The redacted
machine evidence is
[`../../evidence/tq-808/clean-client-matrix-2026-08-13.json`](../../evidence/tq-808/clean-client-matrix-2026-08-13.json).

The remaining evidence cannot be created by an in-repository unit test:

- record one previously unbriefed operator following only
  `deploy/server/README.md`.

The protected publish and exact-digest lifecycle entrypoints live in
`.github/workflows/publish-server.yml` and
`.github/workflows/certify-published-server.yml`. Their policy authorization is
closed to the protected release environment. The certification entrypoint verifies GitHub provenance,
pulls by digest and replays the packaged Server lifecycle. The clean-client
gate is now passed; the unbriefed operator remains external.

Server is a shipped public-alpha artifact. TQ-808 remains open only for the
unbriefed-operator observation above; it is not a managed-service SLA.
