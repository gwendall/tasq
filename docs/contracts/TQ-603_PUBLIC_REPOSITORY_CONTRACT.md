# TQ-603 public repository contract

**Status:** canonical repository public with enforced protections; package publication gated
**Contract:** `tasq.public-source-export.v1`

## Purpose

The intended public Tasq repository must be a real standalone source tree, not a subtree
dump, a history filter, or a checkout that silently depends on the private
monorepo. It must let an unknown contributor or agent understand, install,
typecheck, test, build and inspect Tasq from that repository alone.

## One-way cutover (completed bootstrap)

Before cutover, the private monorepo subtree was the source authority and a
private exporter created a reviewed candidate from an explicit 40-character
source commit. That bootstrap-only exporter and its private evidence are not
part of the standalone repository; their output contract and digests are
preserved in `../releases/PUBLIC_SOURCE_MANIFEST.json`.

The reviewed candidate was committed to `gwendall/tasq` as
`ce8070e066ab0c4df15bbcacd98ad871d9cd8db3`; that repository is now canonical.
Public visibility was explicitly authorized on 2026-07-22. Further work lands
here first. The private
monorepo may consume releases or a one-way generated mirror; bidirectional
source synchronization is forbidden because it creates two competing truths.

## Export boundary

The export is allowlist-first:

- public architecture, product, security, contribution and release contracts
  are copied explicitly;
- package source and tests are copied with public `@tasq/*` coordinates;
- compatibility packages use `@tasq-internal/*`, remain `private: true`, and
  cannot enter the release set;
- the strict `@tasq/core` source is materialized from the kernel import graph,
  not from the broader compatibility service;
- repository workflows, issue forms, root tooling and a frozen lockfile are
  generated into the standalone tree;
- evidence transcripts, dogfood records, maintainer handoffs, local databases,
  credentials, caches and absolute workstation paths are not exported.

Every output file is recorded in `../releases/PUBLIC_SOURCE_MANIFEST.json` with its SHA-256
digest and executable bit. The manifest binds the candidate to the explicit
private source commit and states that it is non-authoritative until reviewed
and committed in the destination repository.

## Standalone gate

The historical bootstrap gate built the repository twice, required identical
bytes and modes, verified the allowlist/package boundary, performed a frozen
install and built all seven public package candidates from the exported tree.
That private-source test was intentionally not exported because the one-way
cutover is complete.

The canonical repository now proves autonomy directly: documentation
consistency, frozen install, full recursive typecheck/test, public-package
boundary tests and deterministic candidate builds run from this tree. CI runs
the complete suite on Linux and macOS. Historical export evidence is not a
substitute for green current-repository CI.

## Repository controls

The destination is public and the launch controls are platform-enforced:

1. `main` protected against deletion and non-fast-forward updates;
2. pull requests and both Linux/macOS CI checks required before merge;
3. mutable release tags prohibited;
4. a protected `release` environment;
5. artifact attestations and npm OIDC trusted publishing limited to
   `.github/workflows/release.yml` in `gwendall/tasq`;
6. no long-lived npm token in repository or environment secrets;
7. private vulnerability reporting and the published `SECURITY.md` route.

Today `main` requires pull requests, green Linux/macOS checks, conversation
resolution and linear history; deletion and non-fast-forward updates are
blocked. The immutable `v*` ruleset, release environment, secret scanning,
push protection and private vulnerability reporting are active.

Changing visibility was an explicit launch action. It did not authorize npm
publication, tagging or deployment; no agent may infer those authorities from
green CI or a completed artifact candidate.

The release workflow independently verifies repository identity, exact
`vX.Y.Z` tag-to-commit identity, explicit version, checksums, SBOMs and build
provenance before publication.

## Observed cutover state

The canonical repository is public, its controls are active, and destination CI
runs the complete test suite in isolated package processes while rejecting an
install that mutates tracked source. Anonymous source access is verified.

The current package-publication blockers are TQ-321, TQ-608, a TQ-607 `go`, npm
`@tasq` scope control and trusted publisher configuration. No local artifact,
source checkout or untagged GitHub build is publishable authority.
