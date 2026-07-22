# TQ-107 — Generic inspection, projection and cursor integration

> **Status:** implemented — 2026-07-15

TQ-107 adds one canonical, additive read contract over the complete graph of a
commitment: `tasq.inspect.v1`. It is available through the embedded minimal
kernel and through `tasq inspect <id> --json`; without `--json`, the same
snapshot renders as deterministic profile-neutral Markdown.

## Included records

The snapshot contains the commitment, involved principals, assignments,
relations, claims, attempts, artifacts, effects, effect approvals, effect
receipts, evidence, completion records,
conditions, their related observations and reconciliations, external
references, and ordered audit events.

Condition, observation, artifact, evaluator and completion-policy meaning uses
canonical URI/version/digest objects. Historical aliases survive only as
explicit `compatibilityKind` or `actorAlias` fields. No area, goal, project,
recurrence, prioritization or `_life` field is required.

TQ-203/TQ-204 additively extended this v1 graph with `effects` and
`effectApprovals`. Each effect retains its exact canonical request, digest,
dispatch key, type and connector binding; approvals retain the full immutable
authority chain. Existing keys and nested record meanings did not change.
TQ-206 additively adds `effectReceipts`, including the canonical provider
report, verification coverage and evidence link for terminal or indeterminate
outcomes.

## Cursor contract

Each snapshot carries a workspace watermark:

```json
{
  "afterEventSequence": 42,
  "afterObservation": { "recordedAt": 1784123456789, "id": "..." }
}
```

Consumers resume the ordered task audit with `afterEventSequence` and immutable
fact polling with the strict composite observation cursor. The watermark is
workspace-wide rather than graph-local, so a client cannot miss a new relation
or fact merely because it was not attached when the snapshot was read.

## Compatibility

The existing `show`, `wait`, `observation`, `reconcile`, event and projection
JSON v1 shapes are unchanged. `tasq.inspect.v1` is a new contract, not an
in-place extension of those DTOs. Its renderer lives in the kernel service and
the minimal-kernel subprocess proves that inspection loads neither the bundled
planning profile nor the reference extension.

## Verification

- service integration builds and inspects a complete external-fact flow;
- CLI E2E freezes the top-level envelope and profile-neutral commitment keys;
- minimal-kernel composition exercises the inspection API with zero installed
  reference extensions and zero planning rows;
- the universal inventory classifies the new command and JSON envelope;
- UK-008's doctor/cursor gate remains green.
