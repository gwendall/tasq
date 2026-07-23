# TQ-601/TQ-602 — Open-source productization specification

> **Status:** protected public alpha `v0.1.0` published — 2026-07-23
> **Current truth:** canonical source, seven `@tasq-run/*@0.1.0` packages and
> attested macOS-arm64/Linux-x64 release artifacts are public
> **Product contract:** `../concepts/PRODUCT_CONSUMPTION_SPEC.md`
> **Binding decision:** `../decisions/ADR-008_PUBLIC_RELEASE_GOVERNANCE.md` and
> `PUBLIC_RELEASE_POLICY.json`

## 1. Goal

Turn the proven Tasq Local composition and embeddable Core into an installable,
inspectable and maintainable open-source product without overstating Server or
Cloud. Open source is not achieved by making a repository visible: an unknown
person and an unknown agent must be able to obtain a versioned artifact,
verify it, start safely, upgrade it and understand its support boundary.

## 1.1 Public alpha plus retained-data dogfood

Open-source engineering discipline begins before source visibility. TQ-607
keeps the standalone repository, public/private package boundary, DCO, CI,
documentation, deterministic artifacts and machine truth at public quality
before and after source visibility. It requires at least 30 days of retained-data
operation through the personal life-pilot, Kami Robotics and an interactive
agent runtime.

TQ-607 closes only with real upgrade/recovery/onboarding evidence and an
explicit `go`, `extend` or `no_go` decision. Source visibility was separately
authorized on 2026-07-22. On 2026-07-23 the maintainer authorized a pre-1.0
public package alpha so real adopters can provide feedback before the full
30-day program closes. TQ-607 therefore remains mandatory for stable
graduation, not for `v0.1.0`. TQ-321 is passed. TQ-603 has closed npm scope,
package-bootstrap, trusted-publishing and first protected-release gates. The
TQ-608 source candidate is passed and awaits its multi-target protected-byte
replay.

## 2. Decisions required before release

TQ-602 and ADR-008 freeze:

- the license and copyright ownership;
- public repository topology and security-reporting channel;
- package namespace, executable name and ownership of those names;
- which packages are public API versus implementation detail;
- supported platforms/runtimes and support window;
- SemVer, schema migration and deprecation policy;
- maintainer/governance model and contribution boundary;
- release signing, provenance, vulnerability and incident policy.

**Selected license:** Apache-2.0 because it is permissive and includes an
explicit patent grant. `LICENSE` applies to the Tasq subtree, not
to unrelated sibling products in the private monorepo. Contributions use
DCO-1.1 sign-off.

## 3. Proposed public package boundary

The public namespace is `@tasq-run/*`. Control of the `tasq-run` npm
organization was authenticated on 2026-07-23. The seven `0.1.0-alpha.0`
identities were published from protected CI under the non-default
`alpha-bootstrap` tag and bound to `gwendall/tasq`, `release.yml` and the
`release` environment through npm trusted publishing. The short-lived
bootstrap token and GitHub secret were then removed. Supported `0.1.0` was
later published through OIDC on the default `latest` tag. Current `@kami/*`
coordinates remain private implementation
names and are not aliases. The unscoped npm package `tasq` belongs to an
unrelated project; only the executable uses that unscoped name.

| Public package | Source today | Contract |
|---|---|---|
| `@tasq-run/schema` | `tasq-schema` | Versioned DTOs, IDs, digests and protocol envelopes |
| `@tasq-run/core` | `packages/tasq-core` | Profile-neutral kernel with injected store, identity and `Clock` |
| `@tasq-run/cli` | `tasq-cli` | Supported Local CLI and `tasq` binary |
| `@tasq-run/mcp` | `tasq-mcp` | Local stdio and embeddable factory with capability closure |
| `@tasq-run/console` | `tasq-inspector` | Read-only local operator surface |
| `@tasq-run/extension-sdk` | `tasq-extension-sdk` | Manifest/runtime and connector-conformance contracts |
| `@tasq-run/protocol-adapters` | `tasq-protocol-adapters` | Pure MCP Tasks/A2A mappings, no transport authority |
| No first-release package | watcher/reference/profile packages | Repository examples without provider support promises |
| No public package | eval harnesses/fixtures | Repository and release tooling |

Public APIs must have explicit entrypoints. Deep imports, migration internals,
test fixtures and monorepo aliases are not compatibility promises.

## 4. Distribution contract

The first public release supports macOS and Linux through:

1. checksummed, versioned GitHub release artifacts for the `tasq` executable;
2. a documented npm/Bun package path for embedders and adapter authors;
3. a deterministic source build from the tagged commit.

Homebrew or another package manager can follow once artifact lifecycle is
stable. A repository-relative `scripts/install-cli.sh` is a development tool,
not a sufficient public installation channel.

Each release includes:

- immutable tag, changelog and compatibility/support matrix;
- SHA-256 checksums, signatures, SBOM and build provenance;
- exact platform/architecture/runtime requirements;
- schema migration behavior and backup/rollback instructions;
- install, upgrade, uninstall and data-location documentation;
- a machine-readable version/discovery response;
- evidence from Linux and macOS clean-room certification.

No install step silently edits shell startup files, changes global identity,
opens a network listener or migrates an unrelated/live store.

## 5. Lifecycle and compatibility

- Semantic versions describe public package and CLI compatibility.
- Persisted schema changes are forward-migrated, backed up and recovery-tested.
- Machine JSON uses explicit contract versions; additive changes follow the
  existing compatibility rules.
- Removed behavior requires a documented deprecation window selected in
  ADR-008.
- A release declares the oldest version from which direct upgrade is tested.
- Downgrade is never implied; rollback means restoring the matching verified
  snapshot and binary under documented constraints.
- Support status is evidence-based using `../concepts/PRODUCT_SURFACE_MATRIX.json`.

## 6. Repository and community baseline

The selected repository is `https://github.com/gwendall/tasq`, a dedicated
monorepo initially exported from the private `products/tasq` subtree. The
source-authority cutover is complete: this public alpha repository is the
source, tag, issue and security authority. The private monorepo may consume releases
or a one-way generated mirror, never a permanent bidirectional fork.

At public-source launch the chosen repository contains, at minimum:

- `LICENSE`, `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY` and
  governance/maintainer policy;
- architecture, threat boundaries, release process and compatibility policy;
- issue templates that distinguish bug, security, proposal and support;
- reproducible developer setup and the same lint/type/test commands as CI;
- a changelog and machine-readable release metadata;
- explicit ownership for review, disclosure and releases.

Versioned repository documents are the source of truth. A website may render
or summarize them, but a wiki must not become a divergent private truth.

## 7. Supply-chain, privacy and safety gates

- Pin and audit release dependencies; scan artifacts and generated SBOMs.
- Build releases in clean CI from a tag, never from a maintainer workstation.
- Sign artifacts and publish provenance beside independent checksums.
- Test archives for path traversal, wrong native binding and architecture mix.
- Fixtures contain no user ledger, credentials, provider bodies or live IDs.
- Examples default to an isolated temporary home/workspace.
- Security documentation explains local attribution versus authentication,
  MCP host responsibility, effect authority and the unsupported remote path.
- Public logs and support bundles are secret-minimized and previewable.

## 8. Clean-room release gate

On every supported platform, an evaluator with no repository checkout must:

1. discover the official artifact and verify checksum/signature;
2. install and run `tasq version` from the documented shell;
3. create an isolated workspace and run autonomous onboarding;
4. coordinate two independently configured agents through contention/recovery;
5. open the Local Console and inspect the same ledger;
6. backup, upgrade, verify, restore and uninstall without losing user data;
7. reproduce the source build or validate published provenance;
8. confirm no undocumented remote listener, credential or device-clock
   authority was introduced.

Failures block release. Repository-local success is not a substitute.

## 9. Sequencing

| Item | Outcome |
|---|---|
| TQ-321 | DONE — zero-context Codex/Claude integration with native discovery, MCP/CLI fallback and two-process blind certification |
| TQ-608 | SOURCE CANDIDATE PASSED — data-preserving migration envelope, verified backup/doctor, real process-kill recovery and portable import; protected-byte/N-2 replay pending |
| TQ-607 | Three-consumer retained-data dogfood and explicit stable-graduation decision; non-blocking for the labeled pre-1.0 alpha |
| TQ-602 / ADR-008 | Legal, identity, package, governance and support decisions |
| TQ-603 | After exact maintainer alpha authorization and external registry control, reproducible public artifacts and package publication; first bytes replay TQ-608 |
| TQ-604 | Clean-room install/upgrade/rollback/uninstall/backup certification |
| TQ-605 | DONE — versioned static public docs and product app; deployed from public `main` at `tasq.run` |
| TQ-606 | CANDIDATE — automated human path plus blind agent pass; published bytes and independent human pending |

Tasq Server and Cloud are later products. Their absence does not block a useful
local open-source release, and open-sourcing Core/Local does not make those
network products implemented.
