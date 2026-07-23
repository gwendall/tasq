# ADR-002 — Canonical effect request and identity

- **Status:** Accepted
- **Date:** 2026-07-15
- **Owners:** Tasq K2 semantics
- **Implements:** TQ-202
- **Depends on:** `../contracts/TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md`
- **Unlocks:** TQ-203 and TQ-204

## Context

An approval, an idempotency key and a receipt are safe only if they refer to an
unambiguous request. Raw JSON is not that identity:

- property order varies;
- duplicate keys may be interpreted differently;
- floating-point and large-number serialization differs across languages;
- omitted, `null`, defaulted and `undefined` values are easily conflated;
- a provider credential, account or environment can change without changing
  visible business parameters;
- the same exact action can be intentionally performed twice;
- one logical dispatch can be delivered more than once after a crash.

Therefore “same request”, “same intended occurrence” and “same provider
dispatch” are different questions. Conflating them either permits duplicate
effects or makes legitimate repeated effects impossible.

## Decision summary

Tasq adopts three independent identities:

| Identity | Form | Answers |
|---|---|---|
| `requestDigest` | domain-separated SHA-256 of canonical request bytes | Are the exact authority-bearing semantics identical? |
| `effectId` | UUIDv7 generated from the injected operation clock plus randomness | Is this the same intentional occurrence in the ledger? |
| `dispatchIdempotencyKey` | deterministic opaque digest of workspace + effect ID + request digest | Is this a retry of the same logical provider dispatch? |

An approval binds both `effectId` and `requestDigest`. A proposal retry returns
the existing effect only when its client idempotency key and digest both match.
Two intentionally identical effects have the same request digest, different
effect IDs, different dispatch keys and require separate authority.

The reference contract is implemented without persistence in
`@tasq-run/schema/effects` and frozen by
`packages/tasq-schema/test/effects.test.ts` before the K2 tables exist.

## 1. Canonical request envelope

The complete authority-bearing request is:

```text
protocol:                 "tasq.effect-request.v1"
canonicalization:         "tasq.jcs-safe-integer.v1"
digestAlgorithm:          "sha-256"
workspaceId:              non-empty opaque workspace identity
effectTypeUri:            absolute HTTPS type URI
effectSchemaVersion:      positive integer
connector:
  operationUri:           absolute HTTPS connector-operation contract URI
  operationVersion:       positive integer
  contractDigest:         sha256:<lowercase hex>
  instanceRef:            stable non-secret configured target identity
  bindingDigest:          digest of immutable provider/account/environment binding
parameters:               strict normalized JSON object
secretBindings[]:
  name:                   unique stable field identity
  ref:                    opaque secret-store reference, never a value or path leak
  version:                immutable secret version
  contentDigest?:         optional digest when the secret is effect content
```

The envelope deliberately excludes:

- `effectId`, approval IDs, claim IDs and execution-attempt IDs;
- title, rationale, notes, UI summaries and audit annotations;
- timestamps that do not alter provider semantics;
- provider credentials, access tokens, cookies, signing material and raw
  secret values;
- connector process IDs, hostnames and other replaceable runtime details.

The envelope includes the connector operation and immutable instance binding
because changing provider account, environment, origin or semantic renderer is
authority-significant even when `parameters` is unchanged.

`instanceRef` is not sufficient alone: its `bindingDigest` changes when its
provider origin, account, environment or credential audience changes. Credential
rotation within the same bounded authority does not change the digest. A target
rebind must create a new binding identity or digest and therefore needs a new
effect/approval.

### Effect-type normalization

Before the generic canonicalizer runs, the registered effect schema/parser:

1. rejects unknown fields and invalid types;
2. materializes all semantic defaults;
3. normalizes domain values such as currency, recipient references, paths,
   addresses and timestamps;
4. classifies and replaces effect-content secrets with immutable bindings;
5. produces only the restricted JSON value set below.

The canonicalizer never guesses domain equivalence. Unicode normalization,
case folding, URL/path resolution, decimal scale and provider defaults belong
to the registered effect type or connector contract. If two normalized values
differ by one code point or one field, their digests differ.

## 2. Canonicalization algorithm

`tasq.jcs-safe-integer.v1` is a deliberately narrower RFC 8785-compatible
profile:

- allowed values are `null`, booleans, Unicode-scalar strings, safe signed
  integers, arrays and plain objects;
- object keys are sorted lexicographically by UTF-16 code units as in JCS;
- arrays retain order; `secretBindings` is first normalized by unique `name`;
- strings use JSON/ECMAScript escaping and UTF-8 output;
- duplicate object names must be rejected by the wire parser before a generic
  JSON parser can erase them;
- lone Unicode surrogates, sparse arrays, accessors, symbol keys, non-plain
  objects and prototype-pollution keys (`__proto__`, `constructor`,
  `prototype`) are rejected;
- `undefined`, floats, `NaN`, infinities, negative zero, unsafe integers and
  bigints are rejected rather than coerced or omitted;
- absent and `null` remain distinct; defaults are materialized before this
  stage, never during hashing;
- the canonical result is limited to 65,536 UTF-8 bytes, depth 32 and 10,000
  nodes. Larger bodies/artifacts use immutable references plus digests.

Money uses integer minor units. Exact decimals or integers outside the safe
range use schema-normalized strings. This avoids cross-language numeric drift
and incorporates the verified RFC 8785 negative-zero erratum.

This strict profile is intentionally different from the older extension
manifest helper, which omits object `undefined` and permits ordinary JSON
numbers. Authority-bearing code must use only `@tasq-run/schema/effects`.

### Digest

The normative preimage is the exact UTF-8 concatenation:

```text
"tasq.effect-request-digest.v1\0" || canonicalRequest
```

The result is lowercase SHA-256 encoded as:

```text
sha256:<64 lowercase hexadecimal characters>
```

The domain separator prevents the same JSON bytes hashed for a manifest,
artifact or unrelated protocol from becoming an effect-request identity. The
canonical string, canonicalization ID, digest algorithm and digest are all
persisted. Execution recomputes and compares them; it never trusts a digest
supplied without loading the frozen request.

The frozen vector in `effects.test.ts` has:

```text
requestDigest = sha256:170041327837b3ec17abfb2af60267265e6dd8c373bc824cc41beb5b3b3ac01d
```

Property insertion order and secret-binding input order produce the same
vector. Amount, recipient, workspace, type version, operation version,
connector instance or secret version changes produce a different digest.

## 3. Effect occurrence identity

`effectId` is a random UUIDv7. Its timestamp bits come from the injected
`Clock` snapshot captured for the proposal operation; no effect code reads a
host, database or provider clock. Randomness prevents collisions and the time
component preserves useful ledger locality.

The ID is not derived from `requestDigest` because exact requests may be
legitimately repeated. It is not supplied by the provider because the effect
must exist before dispatch.

Correction never mutates a request. Before dispatch, it cancels the old effect
and creates a new effect with a new ID, digest and optional
`supersedesEffectId`. After dispatch, history remains and a new effect is either
an explicitly accepted duplicate-risk retry or a compensation.

### Proposal idempotency

The client proposal key is scoped to:

```text
(workspaceId, "effect.propose", clientIdempotencyKey)
```

- same key + same canonical request digest returns the original effect;
- same key + different digest is `idempotency_conflict`;
- a new key creates a new intentional occurrence even when the digest matches.

The proposal key is an ingestion/retry identity, not provider authority and not
the provider dispatch key.

## 4. Dispatch identity

The full Tasq dispatch key is:

```text
base64url(
  SHA-256(
    "tasq.effect-dispatch.v1\0" ||
    workspaceId || "\0" || effectId || "\0" || requestDigest
  )
)
```

with the prefix `tqfx1_` and no Base64 padding. It is generated and persisted
when the effect is proposed. The reference vector is:

```text
tqfx1_zY2wH3bu2yKS7TIeQa1R5p-YRJATpaIIpkTnB5GUnWo
```

Every network retry for one effect reuses this key. A connector must never mint
a new provider idempotency key after timeout or process restart.

Provider formats vary. A connector contract declares one of:

- `native` — send the full Tasq key unchanged;
- `mapped` — deterministically map it while retaining at least 128 bits of
  collision resistance and pin the mapping algorithm/version;
- `resource_identity` — use a provider resource/operation identity with equal
  conflict semantics;
- `none` — no durable provider deduplication.

`none` never silently degrades to retryable. Protected effects then require a
lookup-before-write strategy, a provable non-dispatch result or human handling.
The connector contract also advertises provider idempotency retention; Tasq
does not autonomously retry beyond that horizon.

An `effectExecutionId` identifies each connector-boundary crossing for audit.
Several execution records may share one effect and dispatch key; they must
never represent several intended provider operations.

## 5. Approval binding

An approval decision contains at least:

```text
effectId, requestDigest
approverPrincipalId, decision
scope, limits, validFrom?, expiresAt?
verification, supersedesApprovalId?
```

Both identity fields are mandatory:

- digest alone would replay authority onto a second intentionally identical
  effect;
- effect ID alone would fail to prove which immutable semantics were reviewed.

Human-readable previews are derived from the frozen canonical request and are
not an alternate authority payload. The approval surface must expose the
digest and all material fields. An LLM summary, title or rationale may help a
human but can never replace the bound bytes.

Any mutation creates a new effect and invalidates old authority. Approval
expiry and revocation are re-evaluated at the atomic execution boundary using
one injected-clock snapshot as required by TQ-201.

## 6. Connector rendering and secret handling

The provider wire request is not itself the canonical request. A registered
connector operation renders canonical parameters into provider fields. Its URI,
version and contract digest are inside the approved envelope, and connector
enforcement refuses a different contract.

The renderer must:

- consume the stored canonical request, not caller-reconstructed prose;
- fail on unsupported or ignored authority-significant fields;
- resolve `secretBindings` only after approval/fence enforcement;
- verify that secret version/content binding still matches;
- obtain provider credentials separately from the effect request;
- bind credentials to the approved connector instance/account/audience;
- produce a secret-minimized dispatch summary for receipt comparison.

Provider authentication credentials are excluded because rotation should not
change the business effect. A secret that is itself effect content—for example
an exact deployment configuration or encrypted attachment—uses a versioned
binding in the digest. Raw secret values never enter the ledger, canonical
bytes, approval, event log or error output.

## 7. Receipt and retry relationships

Provider receipt identity is independent:

```text
(connector binding, provider account, external operation ID)
```

A webhook delivery ID deduplicates transport delivery, not the underlying
operation. Reusing either identity with different meaningful content is an
integrity error. A receipt links `effectId`, `requestDigest`, dispatch key and
the relevant execution record without becoming approval or commitment
completion.

After a timeout:

- a lookup by dispatch key/external operation ID may reconcile the original;
- a safe retry reuses the same effect ID, request digest and dispatch key;
- absence must be proven under the connector contract before retrying a
  non-idempotent operation;
- a fresh effect ID is a new occurrence and requires explicit authority that
  acknowledges duplicate risk.

## 8. Rejected alternatives

### Raw `JSON.stringify`

Rejected because object order, `undefined`, duplicate names and numbers do not
provide a language-neutral authority identity.

### Existing extension-manifest canonicalizer

Rejected for effects because it treats `undefined` as omission/null and accepts
numbers beyond the strict safe-integer profile. Historical manifest digests do
not change; the two domains remain explicit.

### Full RFC 8785 number model

Rejected for v1 authority requests because IEEE-754 rendering and values such
as negative zero invite cross-language/schema ambiguity. The JCS ordering and
string rules remain useful, while numbers are restricted to safe integers.

### Deterministic CBOR or Protobuf

Rejected for v1 because Tasq's extension and protocol surfaces are already
JSON/JSON-Schema based. A second wire model would add conversion ambiguity and
SDK burden without improving the effect algebra. A future encoding may be
added only with new protocol/canonicalization IDs and vectors; it cannot
reinterpret v1.

### Digest-derived effect ID

Rejected because it prevents two intentional identical actions and encourages
approval reuse. Content equality is not occurrence identity.

### Random provider key per execution attempt

Rejected because a crash/retry would become a new external operation. The key
belongs to the effect, not the worker process or execution attempt.

### Hashing secret values

Rejected as a general solution because low-entropy secrets are guessable and
the kernel should not receive them. Immutable opaque references and versions
bind semantics without exposing values.

## 9. Consequences

Positive:

- approvals are exact, portable and mutation-sensitive;
- identical retries and intentional duplicates are unambiguous;
- provider timeouts can resume without new dispatch identity;
- account/environment/connector rebinding invalidates authority;
- golden vectors let non-TypeScript clients interoperate;
- all identity computation is deterministic and clock-free after the caller
  supplies an effect ID.

Costs:

- effect schemas must normalize defaults and avoid floats;
- connectors must register immutable operation and instance-binding digests;
- large bodies become artifacts/content-addressed references;
- providers without durable idempotency remain partially manual;
- existing generic canonical JSON cannot be reused accidentally.

## 10. Implementation constraints for TQ-203/TQ-204

The additive K2 schema and service must:

1. persist canonical request, all algorithm IDs, request digest, effect ID and
   dispatch key immutably;
2. use the shared client-idempotency ledger for proposal retries and compare
   the request digest on replay;
3. recompute digest and dispatch key in `doctor`;
4. bind every approval to effect ID plus digest;
5. store correction/compensation as relations between immutable effects;
6. create distinct execution records while retaining one dispatch key;
7. enforce workspace-safe references in service and SQLite guards;
8. generate proposal/effect/execution IDs from the injected operation time;
9. add discovery capability/schema resources before any remote effect surface;
10. preserve current M1 tables, CLI JSON and extension registry behavior.

## 11. Acceptance

ADR-002 is accepted when:

- the source contract rejects ambiguous JSON, unsafe numbers, raw secret
  fields, duplicate bindings, excessive depth and excessive size;
- insertion-order variants produce the frozen digest;
- every material mutation produces a different digest;
- one effect produces a stable dispatch key and a second effect produces a
  different key for the same request;
- the package typechecks and the full existing suite remains green;
- documentation advances the frontier to TQ-203/TQ-204 without claiming that
  effect persistence or execution already exists.

## References

- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
- [RFC 8785 verified errata](https://www.rfc-editor.org/errata/rfc8785)
- [RFC 9110 §9.2.2 — Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
- [AWS EC2 idempotency and parameter mismatch](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
