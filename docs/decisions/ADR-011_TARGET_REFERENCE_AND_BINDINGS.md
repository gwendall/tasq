# ADR-011 — Portable target reference and derived bindings

> **Status:** Accepted — 2026-08-10
> **Decision owner:** `@gwendall`
> **Execution:** TQ-622

## Context

The same external thing can participate in an `external_ref`, an authority
decision, a resource lease, an observation route and a signed statement. Those
records currently accept unrelated strings. Copying a provider identifier into
each one lets spelling, version or digest drift authorize one thing while
observing or acting on another. Making an `external_ref` row the identity would
instead bind portable authority to a store-local, record-specific UUID.

## Considered designs

### Store-owned reference

Use `external_ref.id` everywhere. This maximizes Locality in the store but has
low Leverage outside it: a caller cannot name a target before the row exists,
two records cannot share the value without another lookup, portable statements
depend on one store, and an authority verifier must read collaboration state.

### Canonical target URI

Use one normalized absolute URI everywhere. The Interface is small, but raw
provider and site identities then leak into authority scopes, resource keys,
events and denial messages. URI query/fragment conventions also conflate
identity, version and content digest, and workspace-secret minimization becomes
an informal caller rule.

### Structured value with derived opaque bindings

Use one strict provider-neutral value containing a namespace, resource type,
plain or workspace-HMAC identifier, optional version and optional content
digest. Canonicalize and hash it once, then derive every authority-bearing
binding from that digest. Only the `external_ref` identity retains the
secret-minimized external identifier.

## Decision

Tasq adopts the third design as the `tasq.target-ref.v1` value contract. The
deep Module Interface is one pure operation, `prepareTargetRefV1`, which
validates and freezes the value and returns its external-ref identity, opaque
authority resource, resource key, observation subject and signed-statement
subject. Callers never choose these bindings independently.

This is a value contract in `@tasq-run/schema`, not a new Kernel record or
table. Existing records remain authoritative for their own lifecycles. An
Adapter may persist the external identity through `external_ref`; authority,
lease, observation and signed-statement Implementations consume the derived
opaque bindings at their existing seams.

Target identity, target version and target content digest remain distinct. A
reference without version or digest is honestly `moving`; a version makes it
`versioned`; a digest makes it `content_addressed`. High-impact Profiles may
require a stronger specificity but the universal value contract does not guess
domain policy.

Plain identifiers must already be safe to disclose within the workspace.
Sensitive identifiers use the explicit `workspace_hmac_sha256` form, computed
outside Tasq with workspace-held key material. Namespaces cannot contain
credentials, query or fragment, and every non-external binding is a SHA-256
derived opaque value.

## Consequences

- target drift changes every authority-bearing binding;
- an `external_ref` UUID is never mistaken for portable target identity;
- provider catalogs, discovery, URL resolution and secret/HMAC key management
  remain outside the Module;
- no current table or portable-data migration is required;
- future persisted target state would require a separate Kernel admission
  decision rather than silently expanding this value contract.
