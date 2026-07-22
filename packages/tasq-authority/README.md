# `@tasq-internal/authority`

Pure, deny-by-default identity and authorization foundation for future Tasq
Server adapters. This package is internal and is not a network server.

## What it consumes

An authentication adapter must first verify a credential and construct a
strict `VerifiedIdentity`. A workspace router then supplies current subject
bindings, principals, immutable permission-set definitions, live grants,
optional delegation and effect eligibility in one `AuthorizationRequest`.

The caller must inject a `Clock`:

```ts
const decision = evaluateAuthorization(request, clock);
if (decision.decision !== "allow") return deny(decision);
return guardedKernelCall();
```

The evaluator captures the clock once and returns one deterministic,
digest-bound `AuthorizationDecision`. Token actions are only an upper bound;
they never replace a live grant. A delegated call needs the intersection of
subject grant, actor grant and exact delegation. Administration, effect
approval/dispatch and privileged replication require sender binding. Effect
approval and connector dispatch also require distinct eligibility.

## What remains outside

- TLS, proxy trust and credential parsing/verification;
- OIDC discovery, JWKS, introspection, DPoP replay and SPIFFE adapters;
- subject/grant persistence, audit and workspace-store routing (implemented by
  the private TQ-802 Server foundation, still not part of this pure package);
- REST, remote MCP, browser sessions and Tasq kernel calls;
- exact effect permits, fences and receipts.

Those layers must wrap this package in the order fixed by
`../../docs/decisions/ADR-004_AUTHENTICATED_HOSTED_TENANCY.md`. No remote route exists merely
because this evaluator exists.

Run its focused checks with:

```bash
pnpm --filter @tasq-internal/authority typecheck
pnpm --filter @tasq-internal/authority test
pnpm --filter @tasq-internal/evals test -- hosted-authority-foundation.test.ts
```
