# Tasq extension SDK

> **Implemented authoring contract.** Updated 2026-07-18 after TQ-305.
> `ADR-UK-EXT_EXTENSION_REGISTRY.md` defines durable identity and trust;
> this document explains the process-local code boundary that realizes it.

## What an extension is

A Tasq extension has two deliberately separate halves:

1. an immutable manifest installed in a workspace registry;
2. trusted process-local runtime code implementing the exact declared parsers,
   routes and deterministic evaluators.

Installing a manifest never downloads or executes code. Loading runtime code
never installs authority into a workspace. A host must do both under its own
trust policy and verify the same URI/version/digest identities.

```text
@tasq/schema
  generic persisted records + manifest DTOs
            ↓
@tasq/extension-sdk
  pure runtime interfaces + immutable resolver
            ↓
@tasq-internal/reference-extension
  Gmail / GitHub / Mercury / HTTP / filesystem modules
            ↓
@tasq/core
  durable provider-neutral registry + kernel transactions
            ↓
@tasq-internal/local-service
  bundled v1 compatibility provisioning and aliases
```

No package above the arrow may import a package below it. Executable provider
rules do not belong in `tasq-schema` or the generic service kernel.

## Runtime primitives

`@tasq/extension-sdk` exports:

- `ConditionTypeRuntime`: exact type URI/schema version plus canonical parser;
- `ObservationTypeRuntime`: parser, stable subject identity and route keys;
- `EvaluatorRuntime`: exact evaluator identity/digest, accepted type pairs,
  condition routes and a pure decision function;
- `TasqExtensionRuntime`: one manifest bound to those implementations;
- `defineExtensionRuntime`: validates and freezes the package declaration;
- `ExtensionRuntimeRegistry`: rejects collisions and resolves exact identities.

Evaluators receive canonical JSON objects and return only:

```ts
{
  decision: "matched" | "rejected" | "ambiguous";
  reasonCode: string;
  explanation: string;
}
```

They perform no I/O, model call, clock read, credential access or ledger write.
The kernel owns timing eligibility, atomic state transition, evidence creation
and audit. Connectors own provider I/O and observation normalization.

## Connector conformance

The same package exports the DB-free `tasq.connector-conformance.v1` boundary
for provider adapters. This is separate from an extension runtime: an extension
teaches Tasq how to parse and evaluate domain facts; a connector authenticates
to an external system and produces those facts or effects.

```ts
import {
  CONNECTOR_CONFORMANCE_PROTOCOL,
  assertConnectorConformance,
  defineConnectorConformanceProfile,
  runConnectorConformance,
} from "@tasq/extension-sdk";

const profile = defineConnectorConformanceProfile({
  protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
  connectorUri: "https://example.com/connectors/robot-arm",
  connectorVersion: "1.0.0",
  instanceRef: "connector:robot-arm:cell-a",
  bindingDigest: "sha256:<64 lowercase hex characters>",
  provider: {
    issuerUri: "https://controller.example.com",
    accountRef: "cell-a",
    audience: "robot-controller:cell-a",
  },
  clock: "injected",
  credentials: "secret_refs_only",
  redirects: "forbid_credential_forwarding",
  observations: {
    deliveryIdentity: "source_external_event_id",
    exactReplay: "return_original",
    conflictingReplay: "reject",
    sourceTime: "provenance_only",
    secretMinimized: true,
    digestBoundRawReference: true,
  },
  effects: [],
});

const report = await runConnectorConformance(profile, connectorProbe, {
  now: controlledClock.now(),
});
assertConnectorConformance(report);
```

Write-operation profiles additionally pin the effect/operation versions and
contract digest, provider idempotency mode and retention, uncertainty lookup,
and terminal receipt verification. The suite then attacks mutation, stale
fences, duplicate dispatch, lost responses and hostile receipts through public
connector behavior. `defineConnectorFailure` supplies a strict classified error
envelope whose recovery disposition cannot be chosen independently.

See `TQ-305_CONNECTOR_CONFORMANCE.md` for the complete behavioral matrix,
limitations and reference eval.

## Minimal unfamiliar extension

```ts
import { defineExtensionRuntime } from "@tasq/extension-sdk";

export const robotics = defineExtensionRuntime({
  manifest: roboticsManifest,
  conditions: [{
    typeUri: "https://robot.example/conditions/at-station",
    schemaVersion: 1,
    parse: parseAtStation,
  }],
  observations: [{
    typeUri: "https://robot.example/observations/scan",
    schemaVersion: 1,
    parse: parseScan,
    subjectRef: scanSubject,
    routeKeys: scanRoutes,
  }],
  evaluators: [{
    evaluatorUri: "https://robot.example/evaluators/at-station",
    evaluatorVersion: 1,
    implementationDigest: "sha256:…",
    conditionType: {
      typeUri: "https://robot.example/conditions/at-station",
      schemaVersion: 1,
    },
    acceptedObservationTypes: [{
      typeUri: "https://robot.example/observations/scan",
      schemaVersion: 1,
    }],
    conditionRouteKeys,
    evaluate,
  }],
});
```

An evaluator-only release may reuse types from another loaded extension. The
runtime registry validates all cross-extension references after loading the
complete set, just as the durable registry validates workspace registrations.

## Versioning rules

- Changing accepted input meaning requires a new schema version.
- Changing any route, decision, reason code or explanation requires a new
  evaluator version and implementation digest.
- Never mutate a published manifest or reuse a URI/version with new content.
- Historical runtimes must remain loadable while referenced records exist.
- JSON Schema describes canonical stored data; the runtime parser must produce
  the same shape. Test defaults, conditional fields, bounds and enums on both.

## Bundled reference extension

`@tasq-internal/reference-extension` is one immutable release with five independent
domain modules. It owns every v1 provider schema, subject/route function and
matcher rule. The service retains only closed CLI aliases such as
`gmail.thread_reply → condition type URI + evaluator URI` during the v1
compatibility window.

The extraction deliberately preserves existing route strings, decision codes,
explanations and CLI JSON. It also corrected registry JSON Schema snapshots that
had drifted from the actual Zod validators; executable parity tests now freeze
HTTP methods, Mercury vocabulary/defaults and all five reconciliation paths.

## Current limits

- Runtime loading is static trusted TypeScript; there is no package downloader,
  signature verification, sandbox or remote-code loader.
- The generic SDK is usable independently, but Tasq's public create/ingest CLI
  still exposes the five v1 aliases. Generic record APIs arrive after the
  universal conformance gate.
- Registry installation remains an administrative service API, not an ordinary
  task mutation. Embedded consumers call `installExtension` from `@tasq/core`;
  installation stores a manifest but never downloads or executes runtime code.

## Required tests for a new extension

1. manifest/runtime identity and digest alignment;
2. valid, invalid, boundary and canonical-default parser cases;
3. collision-safe subject and multi-key routing fixtures;
4. matched, rejected and ambiguous evaluator fixtures with exact outputs;
5. retry/order invariance and absence of I/O or ambient clock dependence;
6. cross-extension reference resolution where used;
7. one black-box coordination scenario against the unmodified kernel.

## Required tests for a new connector

1. strict conformance profile validation and immutable operation identities;
2. exact observation replay plus visible conflicting natural-key delivery;
3. no raw credentials, ambient device clock or credential-forwarding redirect;
4. effect mutation and stale-fence rejection before provider I/O;
5. exact dispatch retry only where provider idempotency makes it safe;
6. indeterminate timeout recovery without blind redispatch;
7. independently verified, fully covered receipts and hostile-receipt rejection;
8. `assertConnectorConformance` in CI with harness-owned provider counters;
9. one black-box scenario against the unmodified kernel or ingestion boundary.
