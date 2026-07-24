# TQ-616 — Signed-statement adversarial certification

> **Status:** implementation candidate complete; protected artifact gate open
> **Date:** 2026-07-24
> **Machine certificate:** `TQ-616_SIGNED_STATEMENT_CERTIFICATION.json`

The source candidate passes the critical local and hosted threat matrix:
altered and ambiguously encoded payloads, signature wrapping, routing and trust
root drift, purpose replay, statement/nonce replay, credential lifecycle
boundaries, unauthorized enrollment, direct SQL mutation, private-key leakage
and ambiguous Console assurance.

The authority concurrency test uses the same `BEGIN IMMEDIATE` authority gate
as REST and remote MCP. A credential revocation racing an admitted statement
cannot commit inside the acceptance window: it fails closed with contention,
then succeeds after the admitted transaction and blocks the next acceptance.

Migration tests kill real processes at every safety boundary and resume from
verified snapshots. Signed proof, public credential snapshots and checkpoints
round-trip through portable export/import. Python independently rebuilds the
DSSE-style PAE and verifies the Ed25519 vector.

This is not yet a shipped support claim. The remaining gate must run against
the exact protected, downloaded release bytes on every supported platform and
runtime. It cannot be truthfully completed by a workstation source checkout.
