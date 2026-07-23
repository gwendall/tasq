# TQ-603 public release contract

**Status:** public source alpha; `v0.1.0` authorized as an alpha but paused behind external npm registry gates; TQ-321 and the TQ-608 source candidate passed
**Contracts:** `tasq.public-release.v1`, `tasq.public-packages.v1`, `tasq.public-source-export.v1`

## Outcome

A Tasq Local release is a verifiable set of immutable files, not an npm tag or
a directory copied from a maintainer laptop. For every supported target the
clean CI build emits:

- `tasq-v<version>-<target>.tar.gz`, a deterministic archive containing the
  executable Bun bundle, native SQLite binding, migrations, Apache-2.0 license,
  generated third-party notices and the matching SBOM;
- `tasq-v<version>-<target>.cdx.json`, a deterministic CycloneDX 1.6 SBOM;
- `tasq-v<version>-<target>.install.ts`, the standalone checksummed lifecycle
  tool for explicit-prefix install, activation and data-preserving uninstall;
- `tasq-v<version>-<target>.release.json`, the source commit, target, runtime,
  compatibility, file digests and provenance policy;
- `tasq-v<version>-<target>.SHA256SUMS`, independent SHA-256 checksums.

The same explicit inputs also produce seven public npm candidates:
`@tasq-run/schema`, `@tasq-run/core`, `@tasq-run/cli`, `@tasq-run/mcp`,
`@tasq-run/extension-sdk`, `@tasq-run/protocol-adapters` and `@tasq-run/console`. Their
tarballs are accompanied by `tasq.public-packages.v1` release metadata, a
CycloneDX 1.6 dependency graph and a shared checksum file. The internal
`@kami/*` manifests are never republished.

The build receives `version`, `sourceCommit` and `target` explicitly. It omits
wall-clock metadata. Release tooling is covered by the same architecture test
that rejects ambient device time outside `systemClock`.

The private bootstrap exporter created the complete standalone source
candidate for `gwendall/tasq`. It used an explicit allowlist, rewrote
public/internal package coordinates, materialized strict Core, included a
frozen lockfile and protected CI/release workflows, and recorded every initial
output digest and executable bit in `../releases/PUBLIC_SOURCE_MANIFEST.json`. That
manifest is historical cutover evidence, not a live manifest for later public
commits. See `TQ-603_PUBLIC_REPOSITORY_CONTRACT.md`.

## Reproducibility and authority

The tar writer fixes entry order, ownership, permissions and modification time;
gzip output is deterministic. Two builds with identical sources, lockfile, Bun
version, target and explicit inputs must be byte-identical. The release test
builds twice, compares every file, extracts the archive outside the checkout,
and performs real autonomous onboarding.

The lifecycle candidate extends that clean-room gate through side-by-side
install, two-agent contention/recovery, Console inspection, backup, upgrade,
snapshot-and-binary rollback and data-preserving uninstall. See
`TQ-604_LIFECYCLE_CERTIFICATION.md`. Published-byte certification remains
pending because no public release exists yet.

A local output is always an **unpublishable candidate**. Only the protected tag
workflow in the canonical repository may attach GitHub/Sigstore build
provenance and publish it. The attestation binds the artifact digest to the
repository, workflow and commit; it does not assert that the software is bug
free. Consumers must verify both checksums and attestation.

The npm job pins npm CLI 11.18.0, the first pinned client used by this repository
that supports both OIDC trusted publishing and the `npm trust` management
command, and fails before building packages if that exact client is not active.
The job receives `id-token: write` only from the protected workflow and does not
use a long-lived npm publish token.

The package candidate test builds the complete set twice and compares every
byte. It extracts every tarball, rejects private coordinates, workspace
dependencies and checkout paths, and installs all seven tarballs together in
a new directory. From that installation it imports every package entrypoint,
boots `@tasq-run/core` with a mutable injected clock, completes a robotics
commitment at exact controlled timestamps, verifies the CLI version and runs
real autonomous onboarding. `@tasq-run/core` contains only the strict kernel
entrypoint graph: the life-planning policy and its area/goal/project service
modules are absent.

## Publication gates

The pipeline must refuse a public release until all of these facts are true:

1. the maintainer records an exact version, alpha channel, `go` decision and
   rationale in `PUBLIC_RELEASE_POLICY.json`;
2. the workflow runs from `gwendall/tasq`, not the private monorepo;
3. the immutable tag exactly matches the declared version;
4. the `@tasq-run` npm scope and every intended package are controlled;
5. npm trusted publishing names the canonical repository, workflow and
   protected environment;
6. macOS arm64 and Linux x64 clean-room jobs pass;
7. package manifests and executable source contain no `@kami/*`, workspace
   dependency or private path (immutable historical SQL comments may retain an
   old internal identifier without creating a dependency);
8. every shipped component has a declared license and SBOM identity;
9. public source launch and repository visibility have been explicitly
   authorized;
10. TQ-321 zero-context agent integration is certified and the TQ-608 source
    candidate is passed; its published-byte replay remains part of the first
    protected lifecycle certificate.

The public canonical repository and both clean-room CI targets satisfy gates 2,
6 and 9. Pull requests, required Linux/macOS checks, linear history, immutable
`v*` tags, the tag-scoped release environment, secret scanning, push protection
and private vulnerability reporting are active. Gate 1, TQ-321 and the TQ-608
source candidate are passed. npm `@tasq-run` scope control and trusted publishing
remain external blockers. Therefore source is public alpha, while packages and
downloadable artifacts are not published.

### First-package bootstrap

npm requires a package to exist before a trusted publisher can be configured.
The one-time `bootstrap-npm.yml` workflow closes that circular dependency
without publishing laptop-built bytes:

1. create or verify the npm organization `tasq-run` and enable account-level 2FA;
2. create a short-lived granular bootstrap token with write access to the
   `@tasq-run` scope and place it only in the protected `release` environment as
   `NPM_BOOTSTRAP_TOKEN`;
3. dispatch the workflow from `main` with the exact current 40-character commit
   and the literal confirmation `bootstrap-seven-packages`;
4. let protected CI run the entire handoff suite, build deterministic
   `0.1.0-alpha.0` candidates, attest them, and publish them only under the
   non-default `alpha-bootstrap` dist-tag;
5. configure all seven packages with `npm trust github`, repository
   `gwendall/tasq`, workflow `release.yml`, environment `release`, and
   `--allow-publish`;
6. verify every trust record, then immediately delete the GitHub environment
   secret and revoke the bootstrap token.

The bootstrap is resumable after a partial registry failure: an existing
version is skipped only when its SHA-512 integrity, `gitHead`, version, package
name and canonical repository exactly match the rebuilt candidate. Any drift
fails closed. The protected stable tag workflow never reads the bootstrap
secret and publishes `0.1.0` only through OIDC.

TQ-607 is deliberately not an alpha-publication blocker after the maintainer's
2026-07-23 strategy decision. It continues unchanged as retained-data evidence
and blocks stable graduation. The first alpha is explicitly pre-1.0, documents
its migration/backup boundary and must be replayed from published bytes before
the release truth can advance beyond candidate evidence.

The tag workflow executes
`scripts/release/verify-release-authorization.ts` before any artifact job. That
gate binds the tag version, canonical repository, seven-package boundary,
maintainer decision and channel-specific external gates. A pending npm gate,
version drift or package-source drift stops the workflow before publication.
