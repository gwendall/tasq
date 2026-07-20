# TQ-603 public repository contract

**Status:** canonical public repository live and protected; npm publication still gated
**Contract:** `tasq.public-source-export.v1`

## Purpose

The public Tasq repository must be a real standalone source tree, not a subtree
dump, a history filter, or a checkout that silently depends on the private
monorepo. It must let an unknown contributor or agent understand, install,
typecheck, test, build and inspect Tasq from that repository alone.

## One-way cutover

Before cutover, `products/tasq` is the source authority and
`scripts/release/export-public-repository.ts` creates a reviewed candidate.
The exporter accepts only an explicit 40-character source commit and output
directory. It does not read wall time or device time.

The reviewed candidate was committed to `gwendall/tasq` as
`ce8070e066ab0c4df15bbcacd98ad871d9cd8db3`; that public repository is now
canonical. Further work lands here first. The private
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

Every output file is recorded in `PUBLIC_SOURCE_MANIFEST.json` with its SHA-256
digest and executable bit. The manifest binds the candidate to the explicit
private source commit and states that it is non-authoritative until reviewed
and committed in the destination repository.

## Standalone gate

`public-repository-export.test.ts` builds the repository twice and requires
identical bytes and modes. It then verifies the allowlist and package boundary,
performs a frozen install, runs kernel/MCP/boundary smoke tests, and builds all
seven public package candidates from the exported tree itself.

The public repository CI independently runs the full recursive typecheck and
test suite on Linux and macOS. A green private export test is necessary but is
not a substitute for green destination-repository CI.

## Repository protection

The destination is public and has:

1. `main` protected against deletion and non-fast-forward updates;
2. pull requests and both Linux/macOS CI checks required before merge;
3. mutable release tags prohibited;
4. a protected `release` environment;
5. artifact attestations and npm OIDC trusted publishing limited to
   `.github/workflows/release.yml` in `gwendall/tasq`;
6. no long-lived npm token in repository or environment secrets;
7. private vulnerability reporting and the published `SECURITY.md` route.

The release workflow independently verifies repository identity, exact
`vX.Y.Z` tag-to-commit identity, explicit version, checksums, SBOMs and build
provenance before publication.

## Observed cutover state

The canonical repository, required Linux/macOS checks, pull-request rule,
non-deletable/non-fast-forward `main`, immutable `v*` tags, tag-scoped
`release` environment, dependency alerts, secret scanning and private
vulnerability reporting are active. The destination CI runs the complete 697
test suite in isolated package processes and rejects an install that mutates
tracked source.

The remaining external blockers are npm `@tasq` scope control and trusted
publisher configuration. No local artifact and no untagged GitHub build is
publishable authority.
