# Tasq release policy

`../decisions/ADR-008_PUBLIC_RELEASE_GOVERNANCE.md` and
`PUBLIC_RELEASE_POLICY.json` are authoritative.

Version-pinned material falls into two groups, and confusing them breaks
releases in opposite directions.

**Advanced before the tag**, because a workflow reads them from the immutable
tagged commit and they cannot be corrected afterwards: the release
authorization block and the TQ-616 signed-statement program.
`scripts/release/verify-release-preflight.ts` refuses a tag while either still
names an older release, and the release workflow runs it before authorization.
This exists because the TQ-616 block was missed for `v0.4.1`, which therefore
shipped byte-verified but only partially certified, permanently.

**Advanced after publication**, because they describe what is already public
and the site deploys continuously from the default branch: `publishedRelease`,
the generated site truth, the versioned installer, and the public comparison
contract. Advancing these early makes the repository claim a release that does
not exist yet. `scripts/release/verify-publication-recorded.ts` is the mirror of
the preflight and runs in the ordinary test suite: it refuses a tree where the
recorded published release still has surfaces describing an older one, or where
the installer its own documentation points at does not exist.

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
the same fail-closed handoff. Current `v0.6.1` is published, carrying the seven packages that changed;
`@tasq-run/client` stays at the version it was last published at; the post-release workflow certifies their complete lifecycle
without a repository checkout on both supported targets. TQ-607 remains the
retained-data gate for stable graduation, not for the explicitly labeled
pre-1.0 alpha.

ADR-010 added `@tasq-run/client` as the eighth public package. Its protected
bootstrap, trusted-publisher binding, `v0.4.0` publication and Node/Bun
clean-room replay are complete.

## `v0.6.1` current release

Published 2026-09-02T10:06:47Z from tag `v0.6.1`, protected run
[33617532379](https://github.com/gwendall/tasq/actions/runs/33617532379).

A patch at store format 35 carrying what USING v0.6.0 revealed rather than what
reasoning about it suggested. Its versioned installer is the first one
GENERATED from the published SHA256SUMS rather than copied from its
predecessor, which is how v0.6.0's shipped pinning the previous release's
digests and refusing to install.

## `v0.6.0`

Published 2026-08-28T19:41:42Z from tag `v0.6.0`, protected run
[33204772421](https://github.com/gwendall/tasq/actions/runs/33204772421).

It is the first release tagged after `pnpm verify:release-rehearsal` existed:
the whole certification loop - build a real artifact, install it, drive all
three replays through it - ran on the tagged commit BEFORE the tag, which is
what the previous two releases each needed and neither had.

Both version-pinned `state` fields were guarded this time. After `v0.5.1`
shipped partially certified on `tq616SignedStatements.state`, the preflight was
taught to guard that field on that block only; `releaseAuthorization` kept the
state of the release it had already been consumed by while naming the next one,
and a test caught it during preparation. Applying a lesson to half of an
identical pair is precisely how `v0.5.1` repeated `v0.4.1`.

## `v0.5.1` partially certified

Published 2026-08-26T23:23:29Z from tag `v0.5.1`. Its byte-verified binaries and
npm packages are out, and **its post-release certification could not complete.**

Two independent reasons, both worth recording rather than smoothing over.

**The TQ-616 program block was `published_certified` at the tagged commit**,
carried over from v0.4.2, while `verify-tq616-release-eligibility` refuses
anything but `authorized`. That check reads the policy from the immutable tag,
so no re-run can complete it. This is exactly what happened to `v0.4.1`, one
field over: the preflight added after that release guarded
`tq616SignedStatements.version` and not `.state`. It now guards both.

**The migration replay was refused by the release's own new safety gate.**
v0.5.1 ships `tasq store upgrade`, which makes crossing a store format a
decision rather than a side effect of any command, and the certification's
replay drives the binary directly - so a published binary correctly refused to
auto-migrate a populated format-5 ledger. The certification represents an
operator upgrading, and an operator now types the verb; the replay has to say so
too.

Neither affects what the release does for a user who installs it. Both are
recorded here because a release whose certification is partial must say so
plainly, and because the next release fixes them at the tag rather than after.

## `v0.5.0` is retired, never published

Its tag was pushed while `verify-release-preflight.ts` imported `@tasq-run/core`.
The release workflow's identity job runs that gate before `pnpm install`, on
purpose - a gate that needs dependencies installed is a gate an install failure
can skip - so the job failed on `Cannot find module '@tasq-run/schema'`. Identity
is the first job; `cli`, `npm` and `github-release` were all skipped, so nothing
was published under the tag.

Tag protection correctly refuses to delete it. An immutable tag stays immutable
even when it shipped nothing, so the version is retired rather than reused, and
the line continues at `v0.5.1`. The preflight now reads the store format from
the migration filenames and a test asserts it imports only `node:` specifiers.

## `v0.4.2`

Published 2026-08-26 from tag `v0.4.2`. Its post-release certification passed
on both supported targets in protected run
[32941390312](https://github.com/gwendall/tasq/actions/runs/32941390312).

`v0.4.1`, published a day earlier, is byte-verified but only partially
certified: its TQ-616 program block still named an older version at the tagged
commit, and that stage reads the policy from the immutable tag, so no re-run
can complete it. `v0.4.2` carries the preflight that makes the omission
impossible to repeat, which is why it exists.

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
