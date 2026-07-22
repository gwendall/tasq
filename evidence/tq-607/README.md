# TQ-607 private dogfood evidence

This directory contains redacted, repository-safe coordinates and summaries
for the private multi-application dogfood gate. It never contains adopter
databases, private commitment prose, full support bundles or workstation
paths.

The machine status in `TQ-607_DOGFOOD_STATUS.json` is updated only through
`pnpm dogfood`. The retained databases, installed candidate and backup remain
outside every adopter checkout; these files record their version, digest,
cursor and bounded observable results.

| Evidence | Purpose |
|---|---|
| `baseline-2026-07-22.json` | exact candidate, clean-room install and verified live backup/isolated restore |
| `clean-room-install-friction-2026-07-22.json` | first discovered package-install friction and resolution |
| `denshin-journey-2026-07-22.json` | attempt lifecycle, restart recovery, two runs, separate completion authority and run/rebase/merge provenance |
| `kami-robotics-journey-2026-07-22.json` | contention, expiry/reclaim, stale-fence rejection, observable receipt and merged-adopter provenance |
| `life-pilot-activation-2026-07-22.json` | explicit live-space onboarding without private content |
| `journal-checkpoint-2026-07-22.json` | audited legacy parity finding and preserved forensic checkpoint |
| `cold-agent-onboarding-2026-07-22.json` | clean repository preflight from documented entrypoints |
| `support-bundle-review-2026-07-22.json` | bounded review of redaction, completeness and preview-only download |
| `forward-upgrade-01-2026-07-22.json` | same-ledger upgrade to the first dogfood fix and multi-actor audit proof |
| `personal-use-day-01-2026-07-22.json` | first real live-ledger decision: reconcile a stale shipped commitment with source evidence |
| `replacement-agent-cursor-restart-2026-07-22.json` | replacement actor resumes one real commitment from the persisted baseline cursor |
