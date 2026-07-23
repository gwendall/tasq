# Tasq CLI JSON contract — v1

> Stable machine interface for `tasq ... --json`. This contract covers the
> agentic commitment primitives, typed external waits and evidence-backed completion. The Zod entity
> schemas remain the implementation source of truth; CLI E2E tests freeze the
> serialized field sets below.

## Compatibility policy

- v1 output uses raw JSON objects and arrays; there is no wrapper envelope.
- Keys are `camelCase`. Database column names never leak into CLI output.
- IDs are complete UUIDv7 strings, never display-shortened prefixes.
- Timestamps are non-negative unix milliseconds in JSON numbers.
- Nullable fields are present with `null`; they are not conditionally omitted.
- Metadata is always a JSON object.
- List commands always return arrays, including `[]` for no results.
- Success writes one JSON value to stdout and exits `0`.
- Errors from historical v1 commands write human-readable text to stderr and
  exit non-zero. The separately versioned `onboard --json` surface below has a
  typed JSON problem envelope; generic resource commands do too.
- Within v1, changing/removing a key, changing its type, changing nullability,
  or wrapping an existing response is breaking. A deliberate schema addition
  must update this document and the executable contract test.
- Consumers must still ignore unknown keys so a future explicitly additive
  extension does not cause unnecessary failure.

## Machine discovery and onboarding

Unlike legacy entity commands, discovery uses explicit versioned envelopes:

- `tasq onboard --space <id> --actor <label> --json` returns
  `tasq.autonomous-bootstrap.v1` with exactly `contractVersion`, `disposition`,
  `space`, `actor`, `transportBoundary`, `authority`, `recipeCapabilities`,
  `guide`, `discovery`, `recipes` and `warnings`. The additive
  `tasq.bootstrap-guide.v1` states the producer-vector/frozen-pointer execution
  policy, identifies argv[0] as a directly executable artifact even when its
  name ends in `.js`, forbids runtime wrappers, identifies the first bounded
  read and lists only journeys composable from returned recipes. Recipes are
  argv arrays with declared whole-argument
  placeholders, never shell strings. `argvTemplate[0]` is the actual executable
  that produced the document; clients execute it unchanged, or use a
  host-frozen pointer bound to that same artifact for the whole session,
  instead of assuming a `tasq` name exists in `PATH`. Every recipe repeats the
  explicit space and actor scope.

- `tasq discover --json` returns `tasq.discovery.v1` with exactly the top-level
  keys `contractVersion`, `generatedAt`, `expiresAt`, `workspaceId`,
  `transportBoundary`, `protocol`, `capabilities`, `extensions`, `cursors`,
  `resources`, `limits` and `compatibilityDigest`.
- `tasq discover schema <resource-id> --json` returns
  `tasq.schema-resource.v1` with `contractVersion`, `resourceId`, `recordKind`,
  `typeUri`, `schemaVersion`, `schema`, `schemaDigest` and `schemaBytes`.
- `tasq discover negotiate --hello '<json>' --json` returns
  `tasq.onboarding.v1` with `contractVersion`, `status`,
  `selectedProtocolVersion`, `compatibilityDigest`, `capabilities`, `types`,
  `cursors` and `problems`.
- `tasq context --max-records <n> --max-tokens <n> --json` (and the exact
  `brief` alias) returns `tasq.context-packet.v1`. Top-level keys are
  `contractVersion`, `generatedAt`, `workspaceId`, `requestingActor`, `scope`,
  `ordering`, `budget`, `selection`, `items` and `resumeCursor`. The compact
  canonical JSON payload is the measured budget unit; one UTF-8 byte is the
  conservative portable token upper bound. Items are atomic, truncations and
  omissions are explicit, and `resumeCursor.afterEventSequence` is exclusive.
- `tasq summary add/show` returns `tasq.commitment-summary.v1`; `summary list`
  and `summary current` return `tasq.commitment-summary-page.v1` with
  `contractVersion` and `items`. `summary current` additionally returns an
  additive `selection` object: `mode: current_only`, excluded
  `stale|superseded` states, `emptyDoesNotProveNoHistory: true` and the
  `summary.list` history recipe ID. Each item has exactly
  `contractVersion`, `id`, `workspaceId`, `commitmentId`,
  `supersedesSummaryId`, `summary`, `summaryDigest`, `source`, `actorAlias`,
  `principalId`, `createdAt`, `state` and `staleReasons`. `source` binds the
  task revision/terminal status, last non-summary audit sequence, canonical
  digest and exact raw drill-down references. `current|stale|superseded` is a
  derived read state, never authority. This is a separate additive contract;
  `tasq.context-packet.v1` remains unchanged.
- `tasq context-link attach/detach/show` returns
  `tasq.external-context-link.v1`; `context-link list` returns
  `tasq.external-context-link-page.v1`. A link contains the commitment,
  purpose URI, append action/parent, external target identity, attribution,
  lifecycle state and an explicit `pinned|floating` binding. It never contains
  external content or credentials and never grants authority. Current listing
  adds a `selection` object that excludes detached/superseded rows and points
  to `context-link.history`; `--history` returns the append-only chain.

Discovery and schema lookup exit `0` on success. A compatible negotiation exits
`0`; `incompatible` and `refresh_required` are valid JSON responses written to
stdout but exit `1`, so shell clients must capture stdout before interpreting
the status. Malformed hello input and unknown resources remain ordinary errors
on stderr. Discovery is read-only, capability advertisement is not an
authorization grant, and `authenticated_remote` may only be asserted by a host
that performed authentication.

Bootstrap exits `0` with `disposition: created|joined`. With `--json`, a
bootstrap validation/config/storage failure writes
`tasq.autonomous-bootstrap-problem.v1` to stdout and exits `2`, `4` or `3`
respectively. Its exact keys are `contractVersion`, `status`, `code`, `message`,
`retryable` and `nextActions`; each next action contains `description` and an
`argv` array. `recipeCapabilities` filters returned guidance only. The
`authority` object explicitly reports that local-process capability enforcement
is absent and effect authority is not granted.

There is intentionally no `contractVersion` field injected into every entity:
that would duplicate domain data and break the existing raw-object interface.
If an incompatible v2 is ever required, it must be opt-in through a new CLI
surface before the v1 surface is retired.

## Progressive adoption envelopes

These commands were introduced through the protected `v0.1.1` release and
remain part of the current protected release line:

- `tasq setup --space <id> --actor <label> --json` returns
  `tasq.human-setup.v1` with `contractVersion`, `disposition`, `space`,
  `actor`, `configPath`, `nextArgv` and `boundary`. It validates identities and
  joins the space before atomically persisting the selected human defaults.
- `tasq demo --json` returns `tasq.isolated-demo.v1` with
  `contractVersion`, `isolation`, `liveHomeConsulted`, `setup`, `created`,
  `before`, `completed` and `after`. Every nested command executes in a
  temporary `TASQ_HOME` removed before the parent command exits.
- `tasq agent install <host> ... --json` returns
  `tasq.agent-install-plan.v1` with `contractVersion`, `host`, `executable`,
  `space`, `actor`, `capabilities`, `mutatesHost`, `applyArgv`,
  `genericTarget`, `configuration`, `authority` and `applied`. Preview is the
  default. `--apply` delegates Codex/Claude mutation to the host CLI; generic
  application creates one explicit absolute target and refuses overwrite.
  Requested capabilities never grant effect authority.

## Executable, backup and portability envelopes

These additive operational surfaces are independently versioned:

- `tasq version --json` returns `tasq.executable-version.v1` with `version` and
  `storeFormat`. The latter is `tasq.store-format.v1` and declares `current`,
  `readable`, `writable`, `directlyMigratable`,
  `oldestDirectlyTestedSource`, `irreversible` and `rollback`.
- `tasq backup ... --json` returns `tasq.backup-receipt.v1` with `ok`, `target`,
  `sizeBytes`, lowercase SHA-256, `verified`, `eventCursor`, `storeFormat`,
  `rollbackRule` and `rotated`.
- `tasq export ... --json` returns `tasq.portable-export-result.v1` with the
  target, workspace, format, bounded record/byte counts, digest, declared
  omissions and an import argv. The file itself is
  `tasq.portable-export.v1`.
- `tasq import <export> --db <new-path> --json` returns
  `tasq.portable-import-result.v1`, verification results and exact isolated
  doctor/onboarding argv arrays. Import refuses an existing target and never
  merges.
- `tasq doctor --json` additively includes the executable `storeFormat`.

When a JSON invocation opens an unsupported store, stdout contains
`tasq.store-compatibility-problem.v1` and the process exits 3. Its code is one
of `store_format_newer_than_executable`, `store_format_unrecognized`,
`store_migration_history_partial` or `store_migration_checksum_drift`; it also
contains `detectedFormat`, `supported`, `mutationPerformed: false` and
`message`. A committed migration whose post-check failed instead returns
`tasq.migration-safety-problem.v1`, the failed receipt summary and an explicit
matching-snapshot restore plan, also with exit 3.

## Generic resource coordination

`resource acquire|renew|release` returns `tasq.resource-operation.v1` with
`contractVersion`, `disposition`, `observedAt`, `lease` and `eventCursor`.
`resource get` returns a lease view; `resource list` returns
`tasq.resource-world.v1`; `resource events` returns
`tasq.resource-events.v1`; `resource verify` returns
`tasq.resource-fence.v1`; and `resource sweep` returns
`tasq.resource-sweep.v1`.

A resource lease always contains `id`, `workspaceId`, `resourceKey`,
`holderActor`, `holderPrincipalId`, `revision`, `fence`, `acquiredAt`,
`heartbeatAt`, `expiresAt`, `releasedAt`, `releaseReason`, `metadata`,
`createdAt` and `updatedAt`. Resource events contain `sequence`, `id`,
`workspaceId`, `resourceKey`, `leaseId`, `actor`, `principalId`, `eventType`,
`payload` and `createdAt`.

With `--json`, every resource failure writes only
`tasq.resource-problem.v1` to stdout, keeps stderr empty and exits non-zero.
Its keys are `contractVersion`, `status`, `code`, `message`, `retryable`,
`workspaceId`, `resourceKey`, `currentLease` and `nextActions`. Contention
includes the active holder/expiry/fence and executable inspect/retry guidance.
All resource commands require explicit `--tenant` and `--actor`; mutations also
require `--idempotency-key`.

## `TaskClaimV1`

Returned by:

- `tasq claim <task> --json`
- `tasq release <task> --json`

```json
{
  "id": "<uuidv7>",
  "tenantId": "gwendall",
  "taskId": "<uuidv7>",
  "actor": "hermes",
  "fence": 1,
  "acquiredAt": 1784023200000,
  "heartbeatAt": 1784023200000,
  "expiresAt": 1784025000000,
  "releasedAt": null,
  "releaseReason": null,
  "metadata": {},
  "createdAt": 1784023200000,
  "updatedAt": 1784023200000
}
```

`release` returns the same object with non-null `releasedAt` and
`releaseReason`. Re-acquisition after release/expiry creates a new ID and a
higher positive `fence`; heartbeat renewal by the same actor preserves both ID
and fence.

## `TaskAttemptV1`

Returned by:

- `tasq attempt start <task> --json`
- `tasq attempt show <attempt> --json`
- every attempt transition with `--json`
- `tasq attempt list [task] --json` as `TaskAttemptV1[]`

```json
{
  "id": "<uuidv7>",
  "tenantId": "gwendall",
  "taskId": "<uuidv7>",
  "claimId": "<uuidv7-or-null>",
  "actor": "hermes",
  "runtime": "a2a",
  "externalId": "remote-42",
  "contextId": null,
  "status": "running",
  "statusMessage": null,
  "startedAt": 1784023200000,
  "endedAt": null,
  "metadata": {},
  "createdAt": 1784023200000,
  "updatedAt": 1784023200000
}
```

`status` is one of `running`, `input_required`, `succeeded`, `failed`, or
`cancelled`. `endedAt` is null for active states and non-null for terminal
states. Terminal objects never change again. Frozen `TaskAttemptV1` omits its
internal revision; retry-safe transition recipes obtain the canonical current
revision from `commitment.inspect` before compare-and-swap.

## `TaskEvidenceV1`

Returned by:

- `tasq evidence add <task> --json`
- `tasq evidence show <evidence> --json`
- `tasq evidence list [task] --json` as `TaskEvidenceV1[]`

```json
{
  "id": "<uuidv7>",
  "tenantId": "gwendall",
  "taskId": "<uuidv7>",
  "attemptId": "<uuidv7-or-null>",
  "supersedesEvidenceId": null,
  "actor": "watcher:http",
  "kind": "deployment",
  "summary": "endpoint returned 200",
  "uri": "https://example.test/release",
  "digest": null,
  "source": null,
  "observedAt": 1784023200000,
  "metadata": {},
  "createdAt": 1784023200000
}
```

Evidence is append-only. A correction is another object whose
`supersedesEvidenceId` points to the prior evidence; no existing JSON object is
rewritten.

## Evidence-backed completion

`tasq done <task> --evidence <id>[,<id>...] --json` returns the normal complete
`TaskV1` object, not a special completion envelope. The stable task keys are:

```text
id, tenantId, projectId, goalId, areaId, parentTaskId,
title, description, nextAction, successCriteria, completionMode,
validationRequired, status,
priority, estimatedMinutes, scheduledAt, dueAt, startedAt, completedAt,
recurrence, recurrenceInterval, recurrenceAnchor, lastDoneAt, streak,
recurrenceParentId, metadata, createdAt, updatedAt, deletedAt
```

On success, `status` is `done` and `completedAt` is non-null. The immutable
completion record retains policy identity, evidence IDs and deciding principal;
the `completed` audit event also exposes the decision basis.

## Independently validated completion

`validationRequired` is additive and defaults to `false`. When true, the task
must use evidence completion and `done` requires
`--decision <accepted-validation-id>` instead of accepting evidence alone.

`tasq resolution` exposes exact JSON objects for:

- `contract` / `show`: `ResolutionContract` and
  `CompletionResolutionChain`;
- `trust` / `revoke-trust`: `EvidenceTrustRecord`;
- `propose`: `CompletionProposal`;
- `challenge`: `CompletionChallenge`;
- `attest`, `settle`, and `adjudicate`: `ValidationDecision`.

The complete chain contains exactly `contract`, `proposals`, `challenges`,
`decisions` and `trustRecords`. Decision outcomes are `accepted`, `rejected`,
`too_early`, `indeterminate` or `challenged`. Only a current `accepted`
decision can complete the task. CLI trust records are always `unverified`;
higher authenticity requires a host authority through Core.

## Composite task view

`tasq show <task> --json` returns all `TaskV1` keys plus exactly these v1
coordination fields:

**The object is flat.** Read the task status as `result.status`, not
`result.task.status`; there is no nested `task` key or response envelope.

```json
{
  "dependencies": [],
  "unresolvedBlockers": 0,
  "claim": null,
  "attempts": [],
  "evidence": []
}
```

`claim` is `TaskClaimV1 | null`; attempts and evidence are arrays of their v1
objects. Only the currently active claim is surfaced here. Historical claims
remain available through the service layer and audit events.

## `WaitConditionV1`

Returned by `wait create|show|cancel`, by `wait list` as an array, and nested
under deadline evaluation results. Stable keys:

```text
id, tenantId, taskId, kind, schemaVersion, parameters, status,
notBefore, deadlineAt, fallbackKind, fallbackSpec, fallbackTargetTaskId,
fallbackResultTaskId, supersedesConditionId, satisfiedAt,
satisfiedByObservationId, expiredAt, cancelledAt, cancelReason,
createdAt, updatedAt
```

`parameters` is the canonical typed v1 predicate object. `fallbackSpec` is an
object only for `create_task`; `fallbackTargetTaskId` is non-null only for
`activate_task`; `fallbackResultTaskId` remains null until a fallback commits.
Exactly one terminal field family becomes non-null when status leaves
`waiting`.

## `ObservationV1`

Returned by `observation ingest|show` and by `observation list` / `wait
candidates` as arrays. Stable keys:

```text
id, tenantId, source, externalEventId, kind, schemaVersion, subjectRef,
payload, occurredAt, recordedAt, recordedBy, verificationLevel,
verificationMethod, rawRef, digest, metadata
```

`subjectRef` is derived by Tasq; callers never supply it. Re-delivering the
same `(tenantId, source, externalEventId)` and canonical content returns the
same object. Reusing that identity with different content is an integrity
error. `recordedAt` is Tasq ingestion time, whereas `occurredAt` is connector
domain time.

## `ReconciliationV1`

Returned by `reconcile <wait> <observation>` and `reconcile show`, or by
`reconcile list` as an array. Stable keys:

```text
id, tenantId, conditionId, observationId, matcherKind, matcherVersion,
decision, effect, reasonCode, explanation, evidenceId, reconciledAt,
reconciledBy
```

`decision` is `matched|rejected|ambiguous`; `effect` is
`satisfied|no_change|condition_terminal`. A factual match can therefore remain
auditable even when it is late or the condition already terminated.

## Deadline sweep envelopes

`wait sweep --json` returns:

```json
{
  "sweepNow": 1784023200000,
  "evaluated": 1,
  "satisfied": 0,
  "expired": 1,
  "alreadyTerminal": 0,
  "results": [
    {
      "condition": "<WaitConditionV1>",
      "outcome": "expired",
      "sweepNow": 1784023200000,
      "reconciliations": [],
      "fallbackResultTaskId": "<uuidv7-or-null>"
    }
  ],
  "errors": []
}
```

The top-level keys and the five deadline-result keys are stable. `outcome` is
`satisfied|expired|already_terminal|not_due`. Batch errors have exactly
`conditionId` and `message`; successful peer results are still returned, but
the CLI exits `1` when `errors` is non-empty. Repeating a completed sweep does
not repeat the fallback and normally returns zero evaluated due rows.

## `CommitmentInspectionV1` (`inspect <id> --json`)

`inspect` is the additive canonical graph contract. Its exact top-level keys
are:

```text
contractVersion, inspectedAt, workspaceId, commitment, principals,
assignments, relations, claims, attempts, artifacts, effects, effectApprovals,
effectReceipts, evidence,
resolutionContracts, evidenceTrustRecords, completionProposals,
completionChallenges, validationDecisions, completionRecords,
conditions, observations, reconciliations, externalRefs,
externalContextLinks, events, resumeCursor
```

`contractVersion` is `tasq.inspect.v1`. The nested commitment uses canonical
`workspaceId`, `completionPolicy` and `notBefore` keys and contains no planning
profile fields. Related records use `commitmentId`; URI-addressed meanings use
`type: {uri,schemaVersion}`, `evaluator: {uri,version,implementationDigest}` or
`policy: {uri,version}`. Historical aliases, when useful for audit, are
explicitly named `compatibilityKind` and `actorAlias`.

`effectReceipts` contains the append-only outcome reports associated with the
graph's effects. Each item exposes its canonical report and parsed `report`,
verification `coverage` and details, linked evidence ID and recorder. Terminal
outcomes are provider-grounded records, not commitment completion decisions.

`resumeCursor` has exactly `afterEventSequence` and `afterObservation`.
`afterObservation` is null or `{recordedAt,id}`. Both are workspace-wide
high-water marks captured by the same read operation; consumers pass them to
the existing lossless event and observation polling contracts.

This contract does not modify the frozen `TaskV1`, `WaitConditionV1`,
`ObservationV1` or `ReconciliationV1` shapes.

## `InspectorIndexV1` (`GET /api/index` from `tasq web`)

`tasq web` does not accept `--json`; it is a long-running local HTTP
composition. Its bounded JSON index has `contractVersion:
tasq.inspector-index.v1` and these exact top-level keys:

```text
contractVersion, inspectedAt, workspaceId, filter, matched, truncated, items
```

`filter` has exactly `status`, `query` and `limit`. Each item has exactly
`commitmentId`, `title`, `status`, `revision`, `priority`, `dueAt`, `updatedAt`
and `signals`. Signals have exactly `waits`, `waiting`, `effects`,
`unresolvedEffects`, `authorityDecisions` and `receipts`. The index returns at
most 100 items; `matched` and `truncated` disclose omitted matches. It never
copies request, receipt, evidence or metadata bodies.

`GET /api/commitments/:id` returns the unchanged `tasq.inspect.v1` contract
above. JSON failures use `{error:{code,message}}`. `HEAD` returns the same
status/headers without a body. Every other method returns `405` with `Allow:
GET, HEAD`; foreign Host-derived URLs return `421`. Every response is
`no-store` and its HTTP `Date` plus snapshot time derive from the same injected
request clock. This API is unauthenticated loopback read access, not a remote
agent transport or new authority boundary.

## Retry semantics

`claim`, task status transitions, attempt start/transitions, `evidence add`,
resolution mutations, and `wait create` accept `--idempotency-key`. Task and attempt transitions also
accept `--expected-revision`; frozen compatibility objects omit that revision,
so autonomous consumers read it from `commitment.inspect`. Retrying
the same operation, actor, and payload resolves to the same durable resource
ID; reusing the key for another request or actor is an error. Claims and
attempts are lifecycle objects, so a much later retry may return that same
resource in its newer state (for example a released claim or succeeded
attempt), not a frozen copy of the first response. Evidence is immutable and
therefore remains identical. Resolution decisions also replay after the task
becomes terminal, so a lost response never requires re-evaluating changed
state. Consumers must use returned IDs rather than infer
identity from titles, timestamps, or external prose.
