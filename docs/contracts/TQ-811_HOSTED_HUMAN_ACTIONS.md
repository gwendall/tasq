# TQ-811 — Hosted human actions

> **Status:** implementation complete; exact published Server image gate remains
> **Date:** 2026-07-30
> **Machine certificate:** `TQ-811_HOSTED_HUMAN_ACTIONS_CERTIFICATION.json`

## Boundary

The hosted Console is a same-origin BFF, not a second Tasq service. Its
server-rendered forms accept only bounded fields and translate them into the
registered Server operation catalog. Every request then traverses credential
verification, workspace binding, live ADR-004 authority, isolated routing,
durable idempotency and the existing Core service.

The deliberately small surface supports:

- commitment creation;
- claim acquisition;
- blocking with an expected revision;
- evidence append;
- explicit **unverified** evidence-trust attribution;
- completion proposal against a frozen resolution contract;
- independent human attestation of a proposal.

The Console never upgrades an unverified attribution to authenticated
provenance. An accepted completion still requires Core's evidence-trust,
eligible-validator and anti-self-validation rules. The proposer and validator
must be distinct when the frozen policy requires independent attestation.

## Browser controls

The access token is exchanged server-side for a `Secure`, `HttpOnly`,
`SameSite=Strict`, `__Host-` cookie. Mutation requests require the configured
public origin exactly, use no URL token, carry a per-form idempotency key and
are limited to 4 KiB. Content Security Policy restricts form submission to
same-origin. HTML output is escaped.

The Console uses `Referrer-Policy: same-origin`. A real Chromium replay found
that `no-referrer` serializes the form POST `Origin` as `null`, causing the
exact-origin guard to reject the Console's own mutation. The runtime regression
test fixes that header contract while retaining cross-origin referrer
confinement.

## Evidence and remaining gate

Repository tests prove real Core mutations, exact operation routing, durable
receipts, evidence trust, completion proposals and a second-principal
validation decision. Runtime tests exercise the real browser session and
Console create path.

`certify-hosted-console-image.ts` now proves the complete path against an
explicit local Server image: strict OCI identity inspection, isolated
read-only container bootstrap, real one-use `human_device` enrollment,
temporary HTTPS, Chromium login and `__Host-` cookie inspection, a real
Console create, exact guarded receipt replay, and 401/400 denial for missing
credentials and a foreign origin. The proof passed on a local Linux/arm64
candidate image. It emits no credentials, retains no trace/video/screenshot
and removes the container, volume, TLS material and browser input afterward.

Run it with an explicit non-`latest` reference:

```bash
bun packages/tasq-evals/scripts/certify-hosted-console-image.ts \
  --image tasq-server:tq811-browser
```

A local tag proves only the source candidate. `exactPublishedDigest` becomes
true only when the requested `name@sha256:…` is present in the inspected
image's repository digests.

The candidate is not publicly shipped until the TQ-807/TQ-808 immutable
multi-architecture image and external browser replay gates close. No managed
Cloud or anonymous mutation claim is made.

The prepared exact-image certification workflow pulls the immutable Server
digest, runs the container lifecycle, passes that exact digest to this real
Chromium certifier and preserves the machine result as a downloadable artifact.
The entrypoint alone does not claim the external gate: it remains open until an
authorized published digest is actually replayed and the evidence is accepted.
