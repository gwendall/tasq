# ADR-008 — Public release, package and governance boundary

> **Status:** Accepted — 2026-07-20
> **Decision owner:** `@gwendall`
> **Machine contract:** `../releases/PUBLIC_RELEASE_POLICY.json`
> **Execution:** TQ-603 published protected `v0.1.0` after every external
> ownership and provenance precondition was verified.

## 1. Context

Tasq Core and Tasq Local originated inside a larger private monorepo. Their
standalone source now lives in the public canonical Tasq repository. Seven
bootstrap package identities exist under a non-default prerelease tag, and the
first supported packages and downloadable release are now `v0.1.0`.
Publishing directly from the original monorepo
would blur ownership, expose unrelated history and make the public build
impossible to reproduce independently.

The product name remains **Tasq** for the pre-1.0 line. The unscoped npm name
`tasq` and the `@tasq` npm scope are already controlled by unrelated parties,
so product identity and npm package identity must remain separate.

## 2. Decision

### 2.1 Identity

- Product and executable: `Tasq` / `tasq`.
- Canonical public website and documentation: `https://tasq.run`.
- Public npm namespace: `@tasq-run/*`.
- The unrelated `tasq` package and `@tasq/*` scope are prohibited publication
  targets. The `@tasq-run` namespace deliberately matches the canonical
  `tasq.run` product domain.
- Public canonical repository:
  `https://github.com/gwendall/tasq`.
- The current `@kami/*` package names are implementation coordinates, never
  public aliases or compatibility promises.
- TQ-603 must prove control of the npm scope and repository before publishing.
  An HTTP 404 for a package is not proof that the scope is owned.
- A pre-1.0 rename requires a new ADR, a package/binary migration table and at
  least one release of explicit aliases or actionable errors. At 1.0, the
  product name, binary and package coordinates become compatibility surface.

### 2.2 License and contributions

- Tasq source is licensed under Apache License 2.0. The license begins at
  `LICENSE` in the private monorepo and becomes the repository
  root license after extraction. It does not license sibling monorepo code.
- Copyright is contributor-retained with no assignment. `@gwendall` is the
  initial licensor for the existing Tasq source; each later contributor keeps
  copyright in their contribution while granting Apache-2.0 rights through
  the DCO-backed submission.
- Dependencies and copied assets retain their own licenses and must be listed
  in release notices/SBOMs.
- Contributions use Developer Certificate of Origin 1.1 sign-off. No CLA is
  required for the initial project.
- No contributor may add code, fixtures or assets whose redistribution rights
  are unknown.

Apache-2.0 is chosen over MIT because Tasq is intended to become coordination
infrastructure embedded by others and an explicit patent grant is useful. A
copyleft license is not selected because adoption by heterogeneous agent
runtimes and local products is part of the product goal.

### 2.3 Public package boundary

The first stable package set is deliberately small:

| Public package | Current source | Public contract |
|---|---|---|
| `@tasq-run/schema` | `tasq-schema` | DTOs, identities, digests and table contracts |
| `@tasq-run/core` | `tasq-service` strict `./kernel` surface | Embedded profile-neutral kernel, migrations and explicit store/identity/clock composition |
| `@tasq-run/cli` | `tasq-cli` | Tasq Local CLI and the `tasq` binary |
| `@tasq-run/mcp` | `tasq-mcp` | Local stdio transport and embeddable capability-scoped MCP factory |
| `@tasq-run/extension-sdk` | `tasq-extension-sdk` | Extension runtime plus connector conformance contracts |
| `@tasq-run/protocol-adapters` | `tasq-protocol-adapters` | Pure MCP Tasks and A2A mappings |
| `@tasq-run/console` | `tasq-inspector` | Read-only loopback Local Console |

Only explicit `exports` are public. Source paths, SQL filenames, generated
files, fixtures, deep imports and internal compatibility entrypoints are not.
The broad historical `@tasq-internal/local-service` root composition is not the public
Core API; TQ-603 must create a package boundary that cannot accidentally load
the life-planning profile or reference extensions.

The filesystem watcher, reference extension, reference connectors and
life-planning profile remain repository examples for the first release. Evals
and clean-room fixtures remain release tooling. Promotion requires independent
consumer demand, a support owner and its own compatibility gate.

### 2.4 Repository topology

The project is a dedicated monorepo rooted at the repository root, not a view
of the whole Kami monorepo and not a per-package repository fleet. It remains
private during pre-launch preparation.

The cutover has two phases:

1. Before the first public release, a deterministic export includes only the
   approved Tasq paths and proves that no unrelated history, credentials,
   private package coordinates or live ledger data entered the artifact.
2. At public source cutover, `gwendall/tasq` becomes canonical for source,
   issues, security advisories and tags. The private monorepo consumes
   tagged releases or an explicitly one-way generated mirror; it must not
   silently become a second writable source of truth.

Repository transfer to a future organization is allowed because GitHub keeps
redirects, but package scope or canonical-repository changes still require an
ADR and signed release metadata.

### 2.5 Versions, compatibility and support

- Releases use SemVer. During `0.x`, a minor may change TypeScript APIs only
  through the deprecation policy below; stable JSON contracts and persisted
  data retain their own stricter version rules.
- A normal public removal is announced for at least one minor release and 90
  days, whichever is longer. A security removal may be immediate when the
  advisory explains the break and safe migration.
- The latest minor receives normal fixes. The previous minor receives critical
  security/data-loss fixes for 90 days after supersession. Older releases are
  unsupported unless an advisory says otherwise.
- Each release declares the oldest version from which direct upgrade was
  certified. The initial policy requires the previous two minor lines; older
  stores follow documented sequential upgrades.
- Downgrade is never an in-place schema operation. Rollback restores the
  verified pre-upgrade snapshot with its matching binary.
- Public TypeScript packages require Bun `>=1.3` initially. Node.js compatibility
  is not claimed until a separate runtime matrix passes.
- CLI support attaches to exact release targets, initially candidates
  `darwin-arm64` and `linux-x64-gnu`. No architecture becomes supported merely
  because Bun can compile it.
- Wall-clock values in build or release metadata never become kernel authority.
  Shipped code preserves the injected `Clock` boundary and target certification
  reruns the static ambient-time guard.
- There is no guaranteed response SLA in the community release. Support states
  come only from `../concepts/PRODUCT_SURFACE_MATRIX.json` and release evidence.

### 2.6 Governance and security ownership

Tasq starts with maintainer-led governance. `@gwendall` is the initial
maintainer, release owner and security owner. Maintainers may delegate review
or release roles, but the role change must be committed in `GOVERNANCE.md`.

- Ordinary changes use pull requests and required CI.
- Public-contract, persistence, trust-boundary and governance changes require
  an ADR plus executable evidence.
- The maintainer may reject additions that violate the kernel boundary even if
  they are useful to one adopter.
- Vulnerabilities use private GitHub Security Advisories after repository
  creation, with `gwendall@metahood.xyz` as the fallback private channel.
- Security reports, release signing and incident coordination have named
  owners; actor labels inside Tasq never grant these repository roles.

This model is intentionally honest for a one-maintainer project. It does not
claim a fictional committee or a two-person release rule.

### 2.7 Release provenance

Every public release must be produced from a protected immutable tag in clean
GitHub Actions and contain:

- SHA-256 checksums;
- keyless Sigstore signatures or GitHub artifact attestations bound to the
  repository workflow and commit;
- a CycloneDX JSON SBOM for every binary/package closure;
- SLSA-compatible provenance identifying source, workflow, inputs and digest;
- machine-readable release metadata, compatibility/support matrix and
  migration range;
- license and third-party notices;
- Linux and macOS clean-room evidence.

Maintainer-workstation artifacts, mutable tags and registry-only builds are
forbidden. npm publication must use trusted publishing/OIDC with provenance;
a long-lived npm token is not a release design.

## 3. Rejected alternatives

- **Publish `@kami/*` directly:** leaks an internal product boundary and makes
  future extraction harder.
- **Use the unscoped `tasq` npm package:** it belongs to another project and
  would create a supply-chain ambiguity.
- **Open the entire Kami monorepo:** licenses and exposes unrelated products
  and prevents a bounded security/release surface.
- **Maintain a permanent bidirectional mirror:** creates two authorities and
  ambiguous issues, tags and security fixes.
- **MIT by default:** permissive, but lacks Apache-2.0's explicit patent grant.
- **Promise Node and every Bun target:** compilation possibility is not
  clean-room support evidence.

## 4. Consequences and gates

TQ-602 is a decision checkpoint, not a release. Core and Local are now a
published public alpha at `v0.1.0`; their exact distribution state remains in
`../concepts/PRODUCT_SURFACE_MATRIX.json`. TQ-603 must stop before any future publication if repository or npm
ownership, trusted publishing, artifact attestation, license closure or target
certification is absent.

TQ-604 then proves install, verify, onboarding, upgrade, backup/restore,
rollback and uninstall without a checkout. Only after that gate may public
documentation describe Tasq as installable.
