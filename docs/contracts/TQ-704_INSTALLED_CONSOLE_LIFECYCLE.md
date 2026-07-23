# TQ-704 installed Console lifecycle

**Status:** complete for `v0.2.0`; installed Console certified from published
bytes on both supported targets

**Scope:** Tasq Local foreground Console only

**Authority:** the canonical ledger remains the only coordination truth

## Outcome

The Local Console now starts and can be rediscovered from the installed Tasq
Local executable without a repository checkout. Its HTML, CSS, JavaScript,
read models and migrations are bundled into the same release artifact. Install
never starts a process, opens a port or changes `TASQ_HOME`.

```bash
tasq web --tenant robotics/team-a
tasq web status --tenant robotics/team-a --json
```

`web` owns one explicit foreground process. `SIGINT` or `SIGTERM` closes the
listener before its database and removes its registration. There is no daemon,
background service, login item, shell mutation or uninstall hook.

## Machine discovery contract

`tasq web ... --json` writes exactly one compact NDJSON startup record before
waiting. The `tasq.console-listener.v1` record contains:

- installed product SemVer and explicit workspace;
- one random instance identity;
- exact loopback URL, host and bound port;
- read-only, unauthenticated and foreground-process declarations;
- the injected-clock startup timestamp and owning process ID;
- the two documented shutdown signals.

The same exact record is returned by `/api/console/runtime`. `web status`
returns `tasq.console-discovery.v1` and reports `running` only after contacting
that URL and matching instance, workspace, version, endpoint and process.
Therefore a file left by a crash can never by itself claim that a Console is
live. The rendered Console footer shows the installed Tasq Local version and
links to this listener identity for human verification after an upgrade.

## Local registration and races

The descriptor path is
`TASQ_HOME/run/console/<sha256(workspace-id)>.json`. The directory is mode
`0700`, the file is mode `0600`, publication is atomic and a new process never
replaces an existing owner. Workspace text is not used as a path.

An unreachable descriptor is `stale`. Startup reclaims it only when its owner
process is gone. An invalid descriptor or a possibly-live owner fails closed
with the path or existing URL. Cleanup removes a descriptor only when its
instance ID still belongs to the stopping process.

The descriptor is discovery metadata, not authentication, authority or domain
state. Loopback Host validation, no-store responses, strict CSP and the absence
of HTTP mutation remain unchanged.

## Upgrade and uninstall

The clean-room release journey now exercises the complete Console rather than
only importing its code:

1. install v1 outside the checkout and create shared ledger state;
2. start the v1 Console with machine announcement;
3. prove it through `web status` and `/api/console/runtime`;
4. load the server-rendered workspace and self-contained assets;
5. stop it and prove the registration and port are gone;
6. install and activate v2 over the same `TASQ_HOME`;
7. start v2, verify its new product version and the unchanged ledger data;
8. stop before rollback or uninstall;
9. uninstall binaries while preserving all ledger data.

The standalone CLI artifact and the generated npm package candidate also boot
the full Console from hostile temporary directories. These tests would fail if
an asset, dynamic import, migration or native binding resolved through the
source checkout.

## Clock boundary

Listener `startedAt` is sampled once from the `Clock` passed at the composition
root. Registration, discovery, packaging, install, upgrade and uninstall do
not call the device clock. Network timeout is transport scheduling only and
does not determine ledger or listener authority.

## Executable evidence

- `packages/tasq-cli/test/console-lifecycle.test.ts`: private atomic ownership,
  stale recovery and fail-closed ambiguity.
- `packages/tasq-cli/test/web.test.ts`: announcement, proof-of-life discovery,
  duplicate refusal, assets, signal shutdown and registration cleanup.
- `packages/tasq-cli/test/artifact-smoke.test.ts`: full Console from the
  standalone artifact alone.
- `packages/tasq-cli/test/public-packages.test.ts`: full Console from the
  installed npm candidate alone.
- `packages/tasq-cli/test/public-lifecycle.test.ts`: v1 Console, direct v2
  upgrade on the same ledger, stop and data-preserving uninstall.
- `packages/tasq-inspector/test/inspector.test.ts`: exact runtime endpoint and
  injected deterministic listener identity.
- `packages/tasq-evals/public-adoption.test.ts` and
  `packages/tasq-evals/console-read-contract.test.ts`: installed public
  adoption, same-ledger inspection, no hidden write surface and no
  ambient-clock regression guard.

Linux x64 and macOS arm64 run the release lifecycle in CI. Real Chromium
journeys remain a separate required Console job.

## Published certification result

Protected run
[30042551026](https://github.com/gwendall/tasq/actions/runs/30042551026)
downloaded and attestation-verified the `v0.2.0` assets on macOS ARM64 and Linux
x64, then exercised the same-ledger installed Console as part of the complete
lifecycle and public-adoption journeys. TQ-704 is published-byte complete for
the first public-alpha release.
