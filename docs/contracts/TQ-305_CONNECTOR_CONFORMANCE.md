# TQ-305 — Universal connector conformance

> **Implemented 2026-07-18.** `@tasq-run/extension-sdk` now contains a
> provider-neutral declaration, classified failure envelope and DB-free
> black-box testkit for read and write connectors.

## Why this exists

Tasq cannot make Gmail, a bank, a robot or a deployment API behave the same.
It can require every adapter at that boundary to prove the same safety
properties. That keeps provider details outside the kernel while making an
unknown connector predictable to an unknown runtime.

```text
provider-specific adapter
          │
          ├── declares what it supports (profile)
          └── demonstrates the claim (black-box probe)
                         │
                         ▼
              one conformance report
```

The profile is not a trust badge. It is a strict machine-readable claim. The
probe exercises public connector behavior against an instrumented fake provider;
the report is the evidence that the implementation matches that claim.

## The contract

Every profile binds one immutable connector version and instance to:

- an HTTPS connector identity, provider issuer, account and audience;
- a lowercase SHA-256 instance binding;
- injected time only;
- secret references rather than credential values;
- refusal to forward credentials across redirects;
- optional normalized observation behavior;
- exact versioned effect operations and their contract digests.

Observation connectors must produce bounded canonical facts. Delivery identity
is `(source, externalEventId)`: an exact replay normalizes identically and a
same-identity/different-content delivery has a different digest so the ledger
can reject the conflict. Provider timestamps remain provenance, never authority.

Effect connectors must declare provider idempotency, whether autonomous retry
is safe, how uncertainty is looked up, and how terminal receipts are verified.
The declaration is rejected if, for example, it combines autonomous retry with
no provider idempotency, promises manual-only recovery while advertising an
automatic retry, or accepts incomplete receipt coverage.

## Failure semantics

`defineConnectorFailure` produces `tasq.connector-failure.v1`. A connector names
the observed class; the SDK derives the only allowed recovery disposition.

| Failure classes | Required disposition |
|---|---|
| invalid request, unauthorized, stale fence, integrity error, misconfigured | reject before provider I/O |
| throttled/transient before send | retry only with the same dispatch identity |
| transport outcome unknown, provider pending | indeterminate; lookup only, no blind retry |
| provider rejected/failed | terminal failed |

The envelope cross-checks whether provider I/O happened and requires the stable
dispatch identity for every post-dispatch outcome. A connector cannot relabel an
unknown provider outcome as a harmless retry.

## What the black-box suite proves

`runConnectorConformance(profile, probe, { now })` owns no database, network or
clock. The connector author supplies controlled provider behavior and an
explicit Unix-millisecond snapshot. The suite verifies, where declared:

- exact observation replay, conflict visibility, canonical data and secret
  minimization;
- one provider operation for an initial dispatch and no duplicate on a safe
  exact retry;
- request mutation and expired claim fence rejection before provider I/O;
- timeout becoming `indeterminate` after exactly one provider operation;
- lookup of the same dispatch identity without redispatch, or an explicit
  manual-only recovery boundary;
- the promised receipt strength and full provider-account, provider-operation,
  request-identity and outcome coverage;
- rejection of forged, wrong-account and incomplete receipts;
- probe exceptions becoming failed checks rather than false passes.

`assertConnectorConformance(report)` turns any failed check into a test failure.
The report contains stable check IDs suitable for CI and future discovery
attestations.

## Author workflow

1. Keep the connector package outside `tasq-schema` and `tasq-service`.
2. Declare its exact profile with `defineConnectorConformanceProfile`.
3. Put provider credentials behind connector-owned secret references.
4. Instrument a fake provider and implement the observation/effect probes.
5. Call `runConnectorConformance` with an injected clock value in the connector's
   own test suite and assert the report.
6. Run one real adapter through the same suite without changing the kernel.

The repository eval does step 6 with `@tasq-internal/filesystem-watcher`. It reads a
deterministic temporary artifact, passes the observation checks and proves the
source digest is unchanged. The SDK test uses the already-authenticated effect
permit gate to exercise the write, retry, fence, uncertainty and hostile-receipt
paths.

## Honest limits

This proves observable behavior of the supplied connector build and probe. It
does not prove that a production binary is the tested binary, that a credential
has least privilege, or that a provider keeps its documented guarantees. Build
attestation, deployment sandboxing, live credential policy and periodic provider
canaries remain host/deployment responsibilities. A malicious probe can lie;
CI should therefore use harness-owned provider instrumentation and pin the
connector artifact digest.

TQ-306 applies this contract to separately packaged reference read and write
connectors. TQ-302 exposes the existing kernel through capability-separated MCP
tools; neither task changes these connector invariants.
