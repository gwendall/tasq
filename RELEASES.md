# Tasq release policy

`ADR-008_PUBLIC_RELEASE_GOVERNANCE.md` and
`PUBLIC_RELEASE_POLICY.json` are authoritative.

Public releases use immutable SemVer tags and are built only by protected
GitHub Actions workflows. Each release publishes SHA-256 checksums, signatures
or attestations, CycloneDX SBOMs, SLSA-compatible provenance, compatibility
metadata, migration/rollback instructions and clean-room evidence.

Every CLI artifact and release manifest declares `tasq.store-format.v1`.
Existing-store migration creates a verified pre-migration snapshot and durable
receipt, while an unsupported newer store fails before mutation. Operator
backup, rollback and portable create-only import are documented in
`DATA_SAFETY.md`.

npm packages use trusted publishing with provenance. Long-lived maintainer
tokens and locally built release artifacts are forbidden. Published-package support does
not begin until TQ-607 records a private-dogfood `go`, TQ-603 publishes
artifacts and TQ-604 certifies their complete lifecycle without a repository
checkout.

The implemented candidate builder is:

```bash
bun scripts/release/build-public-release.ts \
  --version 0.1.0 \
  --source-commit <40-character-git-commit> \
  --target darwin-arm64 \
  --outdir ./release
```

Use `linux-x64-gnu` on the supported Linux runner. Inputs are explicit and no
build timestamp is recorded. The output is deterministic, but remains
unpublishable until the remaining package gates pass and protected CI in the
canonical repository attest it. See `TQ-603_RELEASE_CONTRACT.md` for files,
verification and refusal gates.

Each target envelope also contains a target-named `.install.ts` lifecycle
tool. It verifies itself, the manifest and archive against `SHA256SUMS`, then
installs versions side by side under an explicit prefix. It never edits shell
startup files or manages `TASQ_HOME`. Exact commands, upgrade/rollback rules
and the remaining published-byte gate are in
`TQ-604_LIFECYCLE_CERTIFICATION.md`.
