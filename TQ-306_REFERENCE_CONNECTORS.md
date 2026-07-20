# TQ-306 — reference read and effect connectors

> **Implemented 2026-07-19.** This is a separately packaged, executable example
> of the TQ-305 connector contract. It does not add a provider ontology or a
> network client to the Tasq kernel.

## Outcome

`@tasq-internal/reference-connectors` demonstrates both directions of a real
provider integration against a deliberately narrow versioned-work-item API:

```text
read
provider snapshot ── authenticated HTTPS ──> bounded observation

write
approved effect ── permit ──> connector ── idempotency key ──> provider
                                      <── signed receipt / lookup ──┘
```

The example is domain-specific on purpose. A universal arbitrary-HTTP writer
would let a model choose endpoint semantics at runtime and would make approval,
idempotency and receipt claims meaningless. New providers copy this shape and
replace only their adapter, request schema and verification code.

## Read boundary

The read connector receives a client already bound to one provider account. It
requests one exact project/item identity and emits:

- a collision-safe canonical delivery identity covering account, project, item
  and provider version without exposing those values in the identity itself;
- a canonical `state`, item identity and account binding;
- the SHA-256 digest of the title, never its raw content;
- provider time as provenance, not authorization time;
- a digest-bound raw reference pinned to the configured HTTPS origin.

Exact replay is byte-equivalent. Same-version changed content retains the
natural delivery identity but changes its digest, allowing the ledger to reject
a conflicting redelivery.

## Effect boundary

The write connector supports exactly one operation: create a comment on one
work item. The approved parameters contain account/project/item, an immutable
body reference, body digest and byte count. The body itself is resolved only
after the connector has authenticated the permit and rechecked the live claim
fence, exact request digest, scope and size limit.

The connector then:

1. snapshots its injected clock once;
2. validates the authenticated Tasq permit and exact connector binding;
3. resolves content and checks its approved byte count plus SHA-256 digest;
4. sends the Tasq dispatch identity as the provider `Idempotency-Key`;
5. accepts only a receipt covering provider account, provider operation,
   request identity and outcome;
6. records an unproved timeout, redirect, non-success HTTP response or invalid
   POST response as `indeterminate`;
7. resolves uncertainty by lookup of the same dispatch identity, never by a
   blind second write.

Receipt authenticity uses a provider-verifier interface. The shipped reference
authenticator uses HMAC-SHA-256 so hostile, wrong-account and incomplete
receipts can be tested deterministically. A production connector can replace
that verifier with the provider's signature or authenticated receipt mechanism.

`bindVerifiedEffectReceipt` converts an already verified exact report into the
pure callback required by the kernel transaction. Any mutation between
verification and persistence is rejected.

## Concrete HTTPS client

`createFetchWorkItemProviderClient` is not a mock transport. It implements the
fixed work-item wire protocol using `fetch`, but accepts an injected fetch
function for deterministic tests. It:

- requires an HTTPS base URL without embedded credentials;
- resolves only a secret reference supplied by the composition root;
- pins every request and provider raw reference to one origin;
- sets `redirect: "manual"` and never forwards authorization to redirects;
- bounds response bodies before parsing;
- treats malformed or non-terminal POST responses as unknown outcomes.

The package never owns a credential store and normalized outputs never contain
the resolved token or comment body.

## Executable evidence

Package tests run both connectors through the reusable TQ-305 black-box suite.
They prove exact replay, visible conflicts, one provider operation under retry,
mutation/fence rejection before I/O, timeout lookup without redispatch,
complete receipt verification, hostile receipt rejection, content-digest
binding, origin pinning and redirect refusal.

The TQ-306 eval composes the package with an unmodified minimal kernel. It reads
one provider fact, creates a commitment/claim/attempt/effect, records a separate
cryptographic approval, begins execution, dispatches exactly once under retry,
and persists the verified receipt as evidence. The parent commitment remains
open, proving provider success has no implicit completion authority.

Every connector/ledger timestamp in that flow comes from a controlled injected
clock. Production source contains no raw device-clock read.

## Honest limits

- This is a reference work-item protocol, not a first-party GitHub, Gmail or
  Mercury integration.
- Provider credentials and receipt keys are supplied by a trusted host; Tasq
  does not store or rotate them.
- Generic third-party observation ingestion is still not a public kernel API;
  the read connector stops at the normalized conformance boundary.
- The local MCP server can begin an effect only inside a trusted embedding; its
  generic stdio mode still cannot dispatch.
- Provider artifact attestation, live canaries and least-privilege credential
  policy remain deployment responsibilities.
- A verified provider effect supplies evidence. It never completes the parent
  commitment without the separate completion policy decision.
