# TQ-801 — Hosted authority foundation

> **Status:** implemented and repository-certified — 2026-07-21
> **Machine certificate:** `TQ-801_AUTHORITY_CERTIFICATION.json`
> **Remote surface status:** not implemented

## Outcome

Tasq now has a small pure authority package for the decision immediately
before a future hosted adapter may call the kernel. It turns a previously
verified external identity plus one current workspace-authority snapshot into
one strict allow/deny decision at one injected timestamp.

This closes the first implementation slice of ADR-004. It does not implement
credential verification, persistence, routing, audit, REST, remote MCP, a
hosted Console or a deployable server.

## Contracts

`@tasq-internal/authority` owns:

- `tasq.verified-identity.v1`, which preserves exact issuer, opaque subject,
  audience, authentication method, actor, credential binding and registered
  action upper bounds without storing credentials;
- versioned subject bindings, principals, permission sets, grants,
  delegations and effect eligibility DTOs;
- 16 immutable `urn:tasq:action:*` definitions, each pinned by version and
  implementation digest;
- `tasq.authorization-request.v1` and
  `tasq.authorization-decision.v1`;
- a pure deny-by-default evaluator with complete request and policy digests.

The evaluator captures the injected `Clock` exactly once. Validity uses
inclusive `notBefore` and exclusive `expiresAt`. It rejects a rewind before
authentication or binding creation, but never reads wall or monotonic device
time.

## Authority algebra

A direct allow requires all of:

```text
exact registered action and resource
∩ exact service audience and live verified identity
∩ enabled issuer/subject binding and principal
∩ token action upper bound
∩ live scoped grant through an immutable permission set
∩ sender binding when privileged
∩ separate effect eligibility when applicable
```

A delegated call additionally intersects the actor's enabled binding and
principal, actor grant and exact live delegation. Subject and actor identities
remain distinct in the decision. Token scope, actor prose, workspace-admin
status or effect grant alone can never authorize the call.

The future effect-dispatch route still needs the existing exact effect
request, approval, claim fence, permit and receipt gate after this eligibility
decision. Authorization is not effect approval or completion.

## Executable evidence

The package suite covers strict schemas, deep registry immutability,
deterministic replay, full-snapshot decision binding, live grant revocation,
issuer collision, time boundaries, actor intersection, sender constraints,
separation of duties, corrupt snapshots and source purity.

The independent eval consumes only the package contract and models:

- a browser human with a read grant;
- a headless agent acting for a human across two issuers;
- an mTLS/SPIFFE connector service eligible to dispatch;
- identical decisions after REST/MCP/BFF normalization;
- cross-workspace probes, revocation with an unexpired token and a
  freeze/advance/rewind clock matrix.

## Honest next boundary

TQ-802 now persists bindings, principals, permission sets, grants,
delegations, eligibility and append-only decisions; enforces optimistic
authority revisions; and routes to an isolated workspace store only after an
allow. The transport verifier and remote routes remain later checkpoints.
