# TQ-622 target-reference contract

**Status:** complete source contract

**Decision:**
[`ADR-011`](../decisions/ADR-011_TARGET_REFERENCE_AND_BINDINGS.md)

**Implementation:** `@tasq-run/schema/targets`

## Outcome

Tasq has one provider-neutral value for the external thing an action observes
or changes, plus deterministic bindings into records that already own
collaboration, authority, coordination, observation and trust.

```text
prepareTargetRefV1(input)
  -> canonical target
  -> target digest
  -> external_ref identity
  -> authority ResourceRef
  -> resource lease key
  -> observation subject ref
  -> signed-statement subject
```

The Module earns Depth by hiding canonicalization, privacy-form encoding,
specificity classification, digest domain separation and five binding formats
behind this single Interface. It performs no I/O and has no Adapter seam.

## Value contract

```text
contractVersion: tasq.target-ref.v1
namespace: canonical absolute URI without credentials, query or fragment
resourceType: lower-case registered token
identifier:
  form: plain | workspace_hmac_sha256
  value: bounded portable identity or 64 lower-case HMAC hex characters
version: optional external revision selector
digest: optional sha256 content digest
```

The exact canonical JSON field order is contract version, namespace,
resourceType, identifier form/value, version and digest. The target digest is:

```text
SHA-256("tasq.target-ref-digest.v1\0" || canonicalTarget)
```

The frozen physical-property vector is:

```text
targetDigest = sha256:f11a64403736c0be48c570c23e51e0f31de2253314520ee66d35cd57ef15f26c
opaqueKey    = tqt1_8RpkQDc2wL5IxXDCPlHg8x3iJTMUUg7mbTXNV-8V8mw
```

## Binding rules

| Existing concern | Derived value | Rule |
|---|---|---|
| external identity | `system`, `resourceType`, encoded `externalId`, version, digest | Only binding allowed to retain the secret-minimized external identifier |
| authority | `{ kind: "resource", id: opaqueKey }` | Parses as the existing authority `ResourceRef`; grants never bind a copied raw ID |
| exclusive coordination | `opaqueKey` | Parses as the existing `ResourceKey`; a lease remains temporary coordination, not target identity |
| observation | `urn:tasq:target-ref:<digest hex>` | Extension/Adapter binds its normalized subject to the target without exposing the raw identifier |
| signed statement | target type URI, `opaqueKey`, target digest | Signature authenticates exact target bytes but grants no authority or truth |

An `external_ref` row may bind this identity to a commitment, attempt, artifact
or another supported local record. Its UUID is not the target reference.

## Specificity

- `moving`: no version and no digest; future external state may differ;
- `versioned`: version but no digest; identity is bound to an external revision
  label whose content still depends on that system;
- `content_addressed`: digest present; exact bytes are bound even when an
  external version is also supplied.

Changing namespace, resource type, identifier, version or digest changes the
target digest and every opaque binding. An agreement amendment, larger budget
or valid signature cannot preserve authority over a changed target.

## Privacy and refusal

- canonical namespaces with credentials, query or fragment are rejected;
- non-canonical URI aliases are rejected rather than normalized silently;
- identifiers are trimmed Unicode scalar strings without controls;
- the reserved workspace-HMAC prefix cannot be smuggled through the plain
  form;
- HMAC key material and computation remain outside Tasq;
- unknown fields are rejected;
- provider, price, location, access credential and catalog data have no place
  in the value.

## Conformance scenarios

| Scenario | Target binding | Required observation |
|---|---|---|
| property exterior verification | workspace-HMAC property identity, optional registry version | route/authority keys disclose no address or parcel identifier |
| remote rack hands | facility inventory namespace, rack-device identity and inventory version | a different device or inventory revision needs different authority |
| software deployment | release namespace, deployment target and immutable artifact digest | release or digest drift invalidates the prior effect scope |
| procurement | catalog namespace, product identity and seller revision/digest | a substituted model is a different target, not budget headroom |
| compromised agent | signed target A followed by requested target B | signature, assignment and agreement for A cannot authorize B |

The schema suite freezes canonicalization, privacy and drift behavior. The
cross-package eval parses the derived values through current collaboration,
authority, resource and signed-statement Interfaces. No provider-specific
Kernel field or storage migration is involved.
