# Changelog

Tasq has not made a public release. Historical implementation checkpoints are
recorded in `BACKLOG.md`; this file begins the public release history selected
by ADR-008.

## Unreleased

### Added

- Add a deterministic target release installer with side-by-side versions,
  atomic activation and data-preserving uninstall, plus a clean-room lifecycle
  certificate covering onboarding, contention, Console, backup, upgrade and
  matching snapshot/binary restore.

### Security

- Upgrade `drizzle-orm` to 0.45.2 for corrected SQL identifier escaping. Public
  package manifests now derive external dependency versions from their source
  manifests, and wrapped driver errors retain safe contention classification.
