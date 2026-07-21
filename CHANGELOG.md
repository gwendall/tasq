# Changelog

Tasq has not made a public release. Historical implementation checkpoints are
recorded in `BACKLOG.md`; this file begins the public release history selected
by ADR-008.

## Unreleased

### Added

- Add canonical human and machine-readable public backlogs so a fresh human or
  agent can distinguish the next executable checkpoint, external publication
  gates and unimplemented remote products without private-repository context.
- Add a deterministic target release installer with side-by-side versions,
  atomic activation and data-preserving uninstall, plus a clean-room lifecycle
  certificate covering onboarding, contention, Console, backup, upgrade and
  matching snapshot/binary restore.
- Add transport-neutral bounded Console overview, work, actor, claim,
  resource, wait, effect, redacted audit and honest operational-health read
  contracts with workspace-bound keyset cursors and injected authority time.
- Add loopback polling and SSE over one redacted Console event-batch contract,
  with exclusive reconnect, typed cursor recovery, one-frame backpressure,
  deterministic overflow fallback and injected time/scheduling.
- Add the responsive, keyboard-accessible Local operator Console with seven
  canonical views, bounded filters, explicit live/stale states, audit timeline
  and preview-before-download redacted support bundles.
- Add installed Local Console lifecycle contracts: a versioned foreground
  listener announcement, proof-of-life `web status`, private crash-safe
  registration and full standalone/npm candidate upgrade coverage without
  checkout-relative assets or install-created listeners.
- Add a statically exportable Next.js public product and documentation app
  with consumer-specific guides, machine-derived support status, exact
  `/product-truth.json`, synthetic-only visuals and adversarial browser gates.
- Add the fail-closed `/adopt.json` pre-executable contract and a candidate
  human-plus-agent adoption certificate covering installed-byte onboarding,
  typed contention/recovery and same-ledger Console inspection.

### Security

- Upgrade `drizzle-orm` to 0.45.2 for corrected SQL identifier escaping. Public
  package manifests now derive external dependency versions from their source
  manifests, and wrapped driver errors retain safe contention classification.
