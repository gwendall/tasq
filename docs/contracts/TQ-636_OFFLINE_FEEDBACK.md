# TQ-636 — Offline-first CLI feedback

Status: published and protected-byte certified in `v0.4.0`.

## Problem and primitive

Feedback disappears when reporting requires leaving the failing terminal.
`tasq feedback "one-line summary"` appends a report to a private local JSONL
journal and succeeds without a network or GitHub account. The report includes
the build version, platform and only a secret-free shape of the last failed
Tasq invocation: command, allow-listed subcommand, flag names, exit code and
recorded time. Positional values, flag values and error text are never stored.

`tasq feedback list` reads pending reports. Publication is a separate explicit
effect:

```bash
tasq feedback push --repo owner/name --dry-run
GH_TOKEN=... tasq feedback push --repo owner/name
```

The push adapter searches for a hidden report UUID marker before creating an
issue, validates the GitHub response, and appends a publication receipt after
each report. A partial batch can therefore resume without republishing reports
that already have local receipts. Tokens are accepted only from `GH_TOKEN` or
`GITHUB_TOKEN`; they are neither persisted nor printed.

## Safety and authority

- The store is append-only, bounded to 10 MiB/10,000 events, mode `0600`,
  fsynced per event and protected against symlink traversal.
- Capture never opens the ledger and never performs network I/O.
- `--dry-run` requires no token and performs no network I/O.
- GitHub issue activity is normalized by the existing bridge as an observation
  only. Creating, closing or commenting on an issue never completes a Tasq
  commitment.
- The hidden marker reduces duplicate creation across lost-response retries;
  it is not a GitHub transaction or an exactly-once claim.

## Evidence

- `packages/tasq-cli/src/commands/feedback.ts`
- `packages/tasq-cli/test/local-workflow.test.ts`
- `packages/tasq-github-bridge/src/index.ts`
- `packages/tasq-github-bridge/test/github-bridge.test.ts`
- `docs/contracts/TQ-636_OFFLINE_FEEDBACK.json`
