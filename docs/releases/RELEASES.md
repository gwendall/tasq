# Tasq release policy

`../decisions/ADR-008_PUBLIC_RELEASE_GOVERNANCE.md` and
`PUBLIC_RELEASE_POLICY.json` are authoritative.

Public releases use immutable SemVer tags and are built only by protected
GitHub Actions workflows. Each release publishes SHA-256 checksums, signatures
or attestations, CycloneDX SBOMs, SLSA-compatible provenance, compatibility
metadata, migration/rollback instructions and clean-room evidence.

Every CLI artifact and release manifest declares `tasq.store-format.v1`.
Existing-store migration creates a verified pre-migration snapshot and durable
receipt, while an unsupported newer store fails before mutation. Operator
backup, rollback and portable create-only import are documented in
`../guides/DATA_SAFETY.md`.

npm packages use trusted publishing with provenance. Long-lived maintainer
tokens and locally built release artifacts are forbidden. npm's package-exists
precondition is handled once by the protected `bootstrap-npm.yml` workflow: it
uses a revocable granular environment secret to publish attested
`0.1.0-alpha.0` identities under the non-default `alpha-bootstrap` tag, then
the secret and token are removed after `release.yml` trust is verified for all
seven packages. Current `v0.1.1` and all seven packages are published; the
post-release workflow certifies their complete lifecycle without a repository checkout on both
supported targets. TQ-607 remains the retained-data gate for stable graduation,
not for the explicitly labeled pre-1.0 alpha.

The implemented candidate builder is:

```bash
bun scripts/release/build-public-release.ts \
  --version 0.1.1 \
  --source-commit <40-character-git-commit> \
  --target darwin-arm64 \
  --outdir ./release
```

Use `linux-x64-gnu` on the supported Linux runner. Inputs are explicit and no
build timestamp is recorded. Local output remains unpublishable; protected CI
in the canonical repository is the only publication authority. See
`../contracts/TQ-603_RELEASE_CONTRACT.md` for files, verification and refusal
gates.

Each target envelope also contains a target-named `.install.ts` lifecycle
tool. It verifies itself, the manifest and archive against `SHA256SUMS`, then
installs versions side by side under an explicit prefix. It never edits shell
startup files or manages `TASQ_HOME`. Exact commands, upgrade/rollback rules
and the passed published-byte certificate are in
`../contracts/TQ-604_LIFECYCLE_CERTIFICATION.md`.
