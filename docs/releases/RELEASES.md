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
seven packages. Current `v0.3.0` and all seven packages are published; the
post-release workflow certifies their complete lifecycle without a repository checkout on both
supported targets. TQ-607 remains the retained-data gate for stable graduation,
not for the explicitly labeled pre-1.0 alpha.

ADR-010 adds `@tasq-run/client` as an eighth deterministic candidate.
Maintainer authorization now targets `v0.4.0`; the client is not part of
`v0.3.0` and receives no npm support claim until the protected bootstrap,
trusted-publisher binding, publication and clean-room replay finish.

## `v0.4.0` public-alpha checkpoint

Protected run
[31447846496](https://github.com/gwendall/tasq/actions/runs/31447846496)
attestation-verifies the exact public `v0.2.0` and `v0.3.0` inputs and passes
their format-32 migration/restore matrix on both supported targets, bound to
commit `e27451d3510c71a9f875a48991eb2fd80496bfdb`. The source-candidate data-safety
gate is therefore passed; exact published `v0.4.0` bytes remain a separate
post-publication gate.

`v0.4.0` is authorized but not published. No tag or release coordinate should
be created before this ordered activation sequence:

1. verify the completed protected `@tasq-run/client@0.1.0-alpha.0` bootstrap
   from run `31012709417` and configure its release trusted publisher;
2. `release.yml`/`release` npm trusted-publisher binding, followed immediately
   by secret deletion and token revocation;
3. PyPI pending trusted publisher for `tasq-remote` using
   `publish-python.yml` and environment `release`;
4. immutable `v0.4.0` tag and protected eight-package/native release;
5. protected Server GHCR and Python PyPI publication, followed by every exact
   downloaded-byte certification;
6. experimental GCP deployment only from the resulting exact image digests.

Independent adoption and retained dogfood are nonblocking for this alpha and
remain required for later usability and stable-graduation claims. Remote
effects remain disabled.

Because npm requires the package identity to exist before its trusted publisher
can be configured, `bootstrap-npm-client.yml` is the one-shot protected
bootstrap for **only** `@tasq-run/client`. It is separately fail-closed in
`PUBLIC_RELEASE_POLICY.json`, publishes only byte-verified
`0.1.0-alpha.0` under `alpha-bootstrap`, and uses a dedicated revocable
`NPM_CLIENT_BOOTSTRAP_TOKEN`. After the protected run, configure and verify the
`release.yml:release` trusted-publisher binding, then immediately delete the
environment secret and revoke the token. The bootstrap coordinate grants no
support claim.

The tag workflow now consumes the exact package list returned by release
authorization. It therefore continues to publish seven packages for `v0.3.0`
and includes `@tasq-run/client` only when its separate candidate authorization
matches the exact next version. The policy cannot contain the hash of the
commit that contains the policy itself. Instead it declares
`protected_immutable_version_tag_runtime_commit`; protected workflows bind the
runtime commit by requiring `v<version>^{commit}`, checked-out `HEAD` and the
explicit `source_commit` input to be identical under the `release`
environment.

Protected Server and Python publication entrypoints are prepared in
`publish-server.yml` and `publish-python.yml`, with separate exact-artifact
certification workflows. All four require the `release` environment, immutable
tag/source identity and candidate-specific authorization. The maintainer has
authorized their exact `v0.4.0` public-alpha coordinates. Authorization is not
publication evidence: no GHCR image or PyPI wheel is claimed until the
protected workflows publish and replay the downloaded bytes.

Both candidate publication workflows are fail-closed and idempotent after a
partial successful run. Server reuse requires matching version/source tags,
exact digest identity, protected source provenance and packaged replay before
creating only a missing tag. Python reuse requires the exact deterministic
wheel bytes, PyPI SHA-256 and protected tagged-source provenance before
continuing only missing release metadata. Registry lookup, authentication,
duplicate-asset or identity ambiguity is an error, never an implicit
`skip-existing`.

`compatibility` in `PUBLIC_RELEASE_POLICY.json` is scoped to
`publishedRelease`, so it truthfully remains format 26 while `v0.3.0` is the
published release. `sourceCandidateCompatibility` separately records repository
format 32 with `publishedSupportGranted: false`. The published block advances
to 32 only in the post-release certification change; this separation is not a
claim that candidate bytes have shipped.

The implemented candidate builder is:

```bash
bun scripts/release/build-public-release.ts \
  --version 0.3.0 \
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
