# TQ-811 — Hosted human actions

> **Status:** implementation complete; exact published Server image gate remains
> **Date:** 2026-07-24
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

## Evidence and remaining gate

Repository tests prove real Core mutations, exact operation routing, durable
receipts, evidence trust, completion proposals and a second-principal
validation decision. Runtime tests exercise the real browser session and
Console create path.

The candidate is not publicly shipped until the TQ-807/TQ-808 immutable
multi-architecture image and external browser replay gates close. No managed
Cloud or anonymous mutation claim is made.
