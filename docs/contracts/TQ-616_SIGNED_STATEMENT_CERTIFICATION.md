# TQ-616 — Signed-statement adversarial certification

> **Status:** implementation candidate complete; protected artifact gate open
> **Date:** 2026-07-30
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

The local release-candidate harness now accepts the deterministic
`tasq.public-packages.v1` output rather than importing workspace packages. It
checks every declared `@tasq-run/*` tarball digest, installs the exact
`@tasq-run/schema`, `@tasq-run/extension-sdk` and `@tasq-run/core` archives in
an isolated consumer, and compares every installed file byte-for-byte with the
corresponding extracted archive. Node and Bun both exercise the installed
public payload, bundle, signer, verifier and Core purpose APIs, including
rejection of altered signed bytes. A separately copied Python fixture still
rebuilds PAE and verifies the frozen Ed25519 vector without importing Tasq.
This evidence is generated-package candidate evidence only: the manifest
explicitly marks local artifacts non-publishable.

The protected published-release certification workflow is now prepared to
repeat that harness on macOS arm64 and Linux x64 against the exact npm registry
tarballs. It verifies each downloaded archive against registry identity and
integrity metadata, verifies npm signatures and provenance attestations,
reconstructs a `tasq.public-packages.v1` manifest, and retains the Node, Bun and
Python hostile-replay result as JSON workflow evidence. This wiring is not
execution evidence and does not close the protected-artifact or unbriefed-human
gate.

The replay is version-gated. Published `v0.3.0` predates the TQ-613–TQ-615
public package APIs and is explicitly registered as historical/incompatible,
so rerunning its existing post-release certification skips TQ-616 without
weakening the already certified `v0.3.0` evidence. Any other release fails
closed unless the release owner authorizes the exact version as
TQ-616-compatible in `PUBLIC_RELEASE_POLICY.json`. The containing commit cannot
truthfully contain its own hash, so the protected workflow binds the source by
requiring the immutable `v<version>` tag, checked-out `HEAD` and explicit
runtime commit to be identical. Eligibility never closes a gate. After a
protected downloaded-byte replay actually passes on one matrix target, its
emitted record removes the artifact/runtime gates and retains only the
still-external unbriefed agent/operator trial; the checked-in certificate
remains open until both platform records are accepted.

This is not yet a shipped support claim. The remaining gate must run against
the exact protected, downloaded release bytes on every supported platform and
runtime. It cannot be truthfully completed by a workstation source checkout.
