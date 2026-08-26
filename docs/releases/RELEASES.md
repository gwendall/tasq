# Tasq release policy

`../decisions/ADR-008_PUBLIC_RELEASE_GOVERNANCE.md` and
`PUBLIC_RELEASE_POLICY.json` are authoritative.

Before a tag is pushed, `scripts/release/verify-release-preflight.ts` must
accept the version. It refuses while any version-pinned policy block still
names an older release: the authorization block, the TQ-616 signed-statement
program, and the public comparison contract. This exists because the
certification workflow reads those blocks from the immutable tagged commit, so
a block left naming the previous release cannot be corrected afterwards. That
is how `v0.4.1` shipped byte-verified but only partially certified.

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
seven original packages. The separately bootstrapped client identity followed
the same fail-closed handoff. Current `v0.4.0` and all eight packages are
published; the post-release workflow certifies their complete lifecycle
without a repository checkout on both supported targets. TQ-607 remains the
retained-data gate for stable graduation, not for the explicitly labeled
pre-1.0 alpha.

ADR-010 added `@tasq-run/client` as the eighth public package. Its protected
bootstrap, trusted-publisher binding, `v0.4.0` publication and Node/Bun
clean-room replay are complete.

## `v0.4.0` public-alpha checkpoint

Protected run
[31447846496](https://github.com/gwendall/tasq/actions/runs/31447846496)
attestation-verifies the exact public `v0.2.0` and `v0.3.0` inputs and passes
their format-32 migration/restore matrix on both supported targets, bound to
commit `e27451d3510c71a9f875a48991eb2fd80496bfdb`. The source-candidate data-safety
gate passed before publication.

Immutable tag `v0.4.0` binds source commit
`47408faccaad5638ab7d1da94c37eda6ba1dc3c1`. Protected run
[31497848901](https://github.com/gwendall/tasq/actions/runs/31497848901)
published all eight npm packages and both native targets on 2026-08-11.
Downloaded-byte lifecycle, migration, interactive-runtime and client replay
passed on both supported targets in run
[31625205138](https://github.com/gwendall/tasq/actions/runs/31625205138).

Protected runs
[31613501777](https://github.com/gwendall/tasq/actions/runs/31613501777) and
[31518219329](https://github.com/gwendall/tasq/actions/runs/31518219329)
published the multi-architecture Server image and `tasq-remote==0.4.0`.
Their exact downloaded artifacts passed the Server and Python certification
workflows. The separately governed Fly private beta runs one writer from the
exact Server digest; this is not a managed Cloud or SLA claim.

Independent adoption and retained dogfood are nonblocking for this alpha and
remain required for later usability and stable-graduation claims. Remote
effects remain disabled.

Because npm requires the package identity to exist before its trusted publisher
can be configured, `bootstrap-npm-client.yml` is the one-shot protected
bootstrap for **only** `@tasq-run/client`. It is separately fail-closed in
`PUBLIC_RELEASE_POLICY.json`, publishes only byte-verified
`0.1.0-alpha.0` under `alpha-bootstrap`, and uses a dedicated revocable
`NPM_CLIENT_BOOTSTRAP_TOKEN`. The bootstrap coordinate grants no support claim.
The completed run unexpectedly left that bootstrap on `latest`; protected
`v0.4.0` publication replaced it with the supported client. TQ-633 records the
anonymous registry proof that `latest=0.4.0` while
`alpha-bootstrap=0.1.0-alpha.0`. See
[`../contracts/TQ-633_NPM_DEFAULT_TAG_SAFETY.md`](../contracts/TQ-633_NPM_DEFAULT_TAG_SAFETY.md).

The tag workflow now consumes the exact package list returned by release
authorization. It published seven packages for `v0.3.0` and all eight for
`v0.4.0`, including `@tasq-run/client` only when its separate authorization
matched the exact version. The policy cannot contain the hash of the commit
that contains the policy itself. Instead it declares
`protected_immutable_version_tag_runtime_commit`; protected workflows bind the
runtime commit by requiring `v<version>^{commit}`, checked-out `HEAD` and the
explicit `source_commit` input to be identical under the `release`
environment.

Protected Server and Python publication entrypoints live in
`publish-server.yml` and `publish-python.yml`, with separate exact-artifact
certification workflows. All four require the `release` environment, immutable
tag/source identity and candidate-specific authorization. Their exact `v0.4.0`
GHCR image and PyPI wheel are published and replay-certified; future versions
still receive no support claim from authorization alone.

Both candidate publication workflows are fail-closed and idempotent after a
partial successful run. Server reuse requires matching version/source tags,
exact digest identity, protected source provenance and packaged replay before
creating only a missing tag. Python reuse requires the exact deterministic
wheel bytes, PyPI SHA-256 and protected tagged-source provenance before
continuing only missing release metadata. Registry lookup, authentication,
duplicate-asset or identity ambiguity is an error, never an implicit
`skip-existing`.

`compatibility` in `PUBLIC_RELEASE_POLICY.json` is scoped to
`publishedRelease`. It now records format 32 for published `v0.4.0`;
`sourceCandidateCompatibility` matches that release and grants published
support. Future schema work must separate source-candidate compatibility again
until exact new release bytes pass post-publication certification.

The implemented candidate builder is:

```bash
bun scripts/release/build-public-release.ts \
  --version 0.4.0 \
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
