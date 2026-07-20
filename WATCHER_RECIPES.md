# Read-only watcher recipes

> **TQ-108 executable companions:**
> `packages/tasq-evals/fixtures/read-only-watchers.json` and
> `read-only-watchers.test.ts`.

A watcher is a read-only connector process. It authenticates to a provider,
reads one fact, reduces it to an allowlisted normalized observation, and calls
Tasq. It never decides that a commitment is complete and never performs a
provider write.

## Shared contract

Every watcher invocation must:

1. keep credentials and raw bodies outside Tasq;
2. derive a stable provider delivery identity;
3. pass the provider occurrence time separately from Tasq's injected recording
   clock;
4. state `verificationLevel` and `verificationMethod` honestly;
5. keep only bounded matcher fields plus an optional content-addressed
   `rawRef`/`digest` pair;
6. ingest first, then reconcile explicitly;
7. persist the observation composite cursor when polling;
8. treat identical redelivery as success and conflicting identity reuse as a
   connector-integrity error.

After reconciliation, inspect the complete graph with:

```bash
tasq inspect <commitment-id> --json
```

The returned attempt, fact, reconciliation evidence and completion record are
different objects. A watcher never calls `tasq done`.

## Gmail reply

Read Gmail History/Message APIs with read-only scope. Store no subject or body;
the matcher needs only connector account, message ID, thread ID and normalized
sender identity.

```bash
tasq observation ingest \
  --source gmail-connector:work-inbox \
  --external-event-id gmail-message-991 \
  --kind gmail.message \
  --payload '{"connectorAccount":"work-inbox","messageId":"message-991","threadId":"thread-arkwood-42","sender":"finance@arkwood.example"}' \
  --occurred-at 2026-07-15T09:00:00Z \
  --verification-level provider_verified \
  --verification-method gmail-history-api \
  --raw-ref urn:connector-record:gmail:message-991 \
  --digest sha256:gmail-message-991 \
  --actor watcher:gmail --json
```

## GitHub pull-request merge

Accept a signed GitHub App delivery or read through a GitHub App installation.
Normalize host/owner/repository/PR number/state and immutable merge SHA; omit
comments, patch text and installation tokens.

```bash
tasq observation ingest \
  --source github-app:kami \
  --external-event-id github-delivery-481 \
  --kind github.pull_request \
  --payload '{"host":"github.com","owner":"kami","repository":"kernel","pullRequestNumber":481,"state":"merged","mergeCommitSha":"fix481abc"}' \
  --occurred-at 2026-07-15T09:10:00Z \
  --verification-level authenticated_source \
  --verification-method github-app-signature \
  --actor watcher:github --json
```

## Mercury transaction settlement

Use read-only transaction access. Never store account/routing numbers, API
tokens or provider response bodies. Amount is integer minor units; settlement
state is a provider fact, not model prose.

```bash
tasq observation ingest \
  --source mercury-connector:operating \
  --external-event-id mercury-sync-txn-2026-481-settled \
  --kind mercury.transaction \
  --payload '{"connectorAccount":"operating","transactionId":"txn-2026-481","direction":"incoming","currency":"USD","minorUnits":5800000,"counterparty":"Example Customer","settlementState":"settled"}' \
  --occurred-at 2026-07-15T09:20:00Z \
  --verification-level provider_verified \
  --verification-method mercury-api \
  --actor watcher:mercury --json
```

## Filesystem artifact

Constrain the watcher to a configured root, reject traversal and symlink
escapes, then stat/hash without modifying the target. Store the logical root
alias and relative path, never a user-specific absolute path.

The bundled manually invoked adapter emits the complete normalized JSON fact:

```bash
bun run packages/tasq-filesystem-watcher/src/cli.ts \
  --root-alias life --root "$HOME/Code/_life" --path TASKS.md
```

It does not import or call Tasq. The caller may review and pass that JSON to
the ingestion surface below.

```bash
tasq observation ingest \
  --source filesystem-watcher:build-output \
  --external-event-id stat-reports-release-json-481 \
  --kind filesystem.stat \
  --payload '{"connectorRoot":"build-output","relativePath":"reports/release.json","kind":"file","sizeBytes":481,"digest":"sha256:release-481"}' \
  --occurred-at 2026-07-15T09:30:00Z \
  --verification-level authenticated_source \
  --verification-method sandboxed-stat-and-sha256 \
  --actor watcher:filesystem --json
```

## HTTP deployment health

The monitor performs a safe read method with bounded redirects, response size
and timeout. Store status and an allowlisted body digest, not headers/cookies or
the raw body. A timeout is absence/unknown, not a fabricated failed fact.

```bash
tasq observation ingest \
  --source http-monitor:production \
  --external-event-id health-version-N-200 \
  --kind http.check \
  --payload '{"url":"https://service.example/health/version","method":"GET","statusCode":200,"bodyDigest":"sha256:version-N"}' \
  --occurred-at 2026-07-15T09:40:00Z \
  --verification-level authenticated_source \
  --verification-method monitor-mtls \
  --actor watcher:http --json
```

## Reconcile and resume

For a known pair:

```bash
tasq reconcile <wait-id> <observation-id> --actor watcher:reconciler --json
```

For polling, persist both cursor components returned by `observation list` or
`tasq.inspect.v1`:

```bash
tasq observation list \
  --after-recorded-at <unix-ms-or-iso-supported-by-surface> \
  --after-id <observation-id> --ascending --json
```

Process results in returned order and advance the cursor only after downstream
handling commits. On restart, replaying the last provider delivery converges on
the existing observation.
