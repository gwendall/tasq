# TQ-603 public release contract

**Status:** artifact, package and standalone repository candidates implemented; external publication remains gated
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
`@tasq/schema`, `@tasq/core`, `@tasq/cli`, `@tasq/mcp`,
`@tasq/extension-sdk`, `@tasq/protocol-adapters` and `@tasq/console`. Their
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
output digest and executable bit in `PUBLIC_SOURCE_MANIFEST.json`. That
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

The package candidate test builds the complete set twice and compares every
byte. It extracts every tarball, rejects private coordinates, workspace
dependencies and checkout paths, and installs all seven tarballs together in
a new directory. From that installation it imports every package entrypoint,
boots `@tasq/core` with a mutable injected clock, completes a robotics
commitment at exact controlled timestamps, verifies the CLI version and runs
real autonomous onboarding. `@tasq/core` contains only the strict kernel
entrypoint graph: the life-planning policy and its area/goal/project service
modules are absent.

## Publication gates

The pipeline must refuse a public release until all of these facts are true:

1. the workflow runs from `gwendall/tasq`, not the private monorepo;
2. the immutable tag exactly matches the declared version;
3. the `@tasq` npm scope and every intended package are controlled;
4. npm trusted publishing names the canonical repository, workflow and
   protected environment;
5. macOS arm64 and Linux x64 clean-room jobs pass;
6. package manifests and executable source contain no `@kami/*`, workspace
   dependency or private path (immutable historical SQL comments may retain an
   old internal identifier without creating a dependency);
7. every shipped component has a declared license and SBOM identity.
8. public source launch and repository visibility have been explicitly
   authorized.

The canonical private repository and both clean-room CI targets now satisfy
gates 1 and 5. The tag-scoped release environment exists, but GitHub branch and
ruleset enforcement is unavailable for this private repository under the
current plan. Repository protections must be restored and verified alongside
gates 3, 4 and 8 before release. Those gates remain blocked until npm `@tasq`
scope control, trusted publishing and explicit launch authorization are
observed directly. Therefore this checkpoint does not claim that Tasq source
or artifacts are public.
