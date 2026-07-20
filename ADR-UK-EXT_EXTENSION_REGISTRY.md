# ADR UK-EXT — Extension identity and registry

> **Status:** accepted — 2026-07-15  
> **Decision:** immutable, workspace-scoped registry of releases, type schemas
> and deterministic evaluators.  
> **Implements:** UK-003; prerequisite for UK-004.

## 1. Context

Tasq v1 hard-codes five wait kinds, five observation kinds, their Zod schemas,
routing functions and matchers in the core packages. That proves the
wait/observe/reconcile algebra but prevents an unfamiliar domain from extending
Tasq without changing kernel source and schema.

The universal kernel needs stable identifiers for data meaning and decision
meaning while preserving every existing database and CLI JSON v1 shape.

The registry is not a plugin downloader, package manager or code sandbox. It is
the durable declaration of which trusted extension meanings a workspace has
installed.

## 2. Decision

Tasq stores three immutable registry records:

```text
extension_release
  id, tenant_id
  extension_uri, version
  manifest_json, manifest_digest
  installed_at, installed_by

extension_type
  id, tenant_id, extension_release_id
  record_kind, type_uri, schema_version
  schema_json, schema_digest, created_at

extension_evaluator
  id, tenant_id, extension_release_id
  evaluator_uri, evaluator_version
  condition_type_uri, condition_schema_version
  accepted_observation_types
  implementation_digest, created_at
```

All three are append-only. Correction requires a new version. Ordinary task or
connector operations cannot install extension code.

### 2.1 Identity layers

| Identity | Format | Meaning |
|---|---|---|
| Extension | absolute HTTPS URI | Publisher-controlled package namespace |
| Release | extension URI + SemVer | One immutable manifest snapshot |
| Data type | absolute HTTPS URI + positive integer schema version | Canonical JSON data meaning |
| Evaluator | absolute HTTPS URI + positive integer version + implementation digest | Deterministic decision meaning |

Versions never use mutable aliases such as `latest`. Tasq-owned types use the
`https://schemas.tasq.dev/` namespace. Third-party publishers must control their
URI namespace.

### 2.2 Canonicalization and digests

- JSON is canonicalized recursively with lexicographically ordered object keys,
  omitted `undefined` values and unchanged array order. This is the RFC 8785
  subset supported by JSON-compatible Tasq DTOs.
- Digests use lowercase SHA-256 encoded as `sha256:<64 hex characters>`.
- `manifest_digest` covers the complete canonical manifest, including schemas
  and evaluator declarations.
- `schema_digest` covers the complete canonical JSON Schema document.
- `implementation_digest` binds evaluator URI/version to one trusted evaluator
  artifact identity. Reusing the URI/version with another digest is an
  integrity failure.

Digest comparison, not install time or display version, decides whether a retry
is identical.

### 2.3 JSON Schema rules

The first registry version accepts JSON Schema Draft 2020-12 object documents.
The canonical schema is stored inline because historical records must remain
inspectable even if a package disappears. Schemas are data, never executable
code.

External network `$ref` resolution is forbidden during kernel validation.
Schemas may use local fragments or content-addressed schemas already present in
the same release. Resource limits for document size, nesting and validation
belong to the extension SDK before untrusted manifests are accepted remotely.

### 2.4 Evaluator declaration

An evaluator registration binds exactly:

- one condition type URI/schema version;
- one evaluator URI/version;
- one implementation digest;
- a non-empty set of accepted observation type URI/schema-version pairs.

Routing and evaluation are supplied by installed trusted code. Registry rows do
not contain JavaScript, SQL, prompts or expressions. Runtime code must resolve
the exact registration before evaluating a generic condition.

Evaluator releases may reference compatible condition or observation types
owned by another immutable release already installed in the same workspace.
They may therefore contain evaluators and no new types. This composition is
intentional: a shared fact schema must not be copied merely to publish another
deterministic policy. Every referenced URI/version and record kind is checked
atomically during installation and again by database guards.

### 2.5 Install transaction

Installing a release is one transaction:

1. validate URI, SemVer, schemas and evaluator references against the manifest
   plus immutable types already installed in the workspace;
2. canonicalize and hash all documents;
3. reject any existing type/evaluator identity with a different digest;
4. insert release, types and evaluators atomically;
5. return the existing release on an identical retry.

Partial installation is impossible. A release cannot shadow a type identity
owned by another installed release.

### 2.6 Disable/removal policy

UK-003 provides no destructive uninstall. Historical conditions and
reconciliations may depend on exact schemas/evaluators. A later lifecycle ADR
may add an append-only disable decision for creation of new records, but active
or historical references retain their registry rows indefinitely.

## 3. Compatibility migration

The registry lands additively. Closed v1 columns remain unchanged and continue
to define CLI JSON v1.

New storage identities:

```text
wait_condition:
  type_uri, evaluator_uri, evaluator_version,
  evaluator_implementation_digest

observation:
  type_uri

reconciliation:
  evaluator_uri, evaluator_version,
  evaluator_implementation_digest
```

Every historical row is deterministically backfilled from its existing kind
and matcher version. New v1 writes populate both representations through one
service path. Database triggers reject missing or mutated universal identities.

The reference release registers Gmail, GitHub, Mercury, HTTP and filesystem
types. Their historical matcher outcomes remain byte-equivalent. UK-004 moved
their schemas/routing/evaluator code into `@tasq-internal/reference-extension` and
left only the closed v1 alias adapter in the service.

### 3.1 Transitional implementation digest

The reference evaluator digest covers the frozen semantic artifact identity:
every evaluator identity, accepted type pair, routing contract and exact
decision output. UK-004 was a package-only relocation with byte-equivalent
behavior, so historical evaluator version 1 and its digest remain valid. Any
future change to a route, decision, reason code or explanation requires a new
evaluator version and implementation digest.

## 4. Opaque records

UK-003 does not enable opaque actionable records.

- Unknown condition/effect types are rejected.
- Current v1 observation ingestion still accepts only the five registered
  reference types.
- A later workspace policy may permit opaque observation/artifact retention,
  but those records remain inert until validated against an installed schema.

This prevents “store anything” from becoming “execute anything.”

## 5. Trust and security

- Registry installation is an administrative trusted-code action.
- `installed_by` is attribution under the current local actor model, not proof
  of remote authority; principal authorization arrives in UK-006.
- Provider credentials and raw provider content never enter manifests.
- A manifest digest proves content identity, not publisher authenticity.
  Signed packages/transparency are future supply-chain hardening.
- Pure evaluator rules remain mandatory; in-process TypeScript is trusted code,
  not a sandbox.

## 6. Rejected alternatives

### Keep a central enum

Rejected because every third-party domain would require a kernel release and
schema migration.

### Store only package names and load current code

Rejected because historical meaning could silently change when a package is
upgraded or removed.

### Store executable predicates in the database

Rejected because it creates a remote-code/prompt execution surface and destroys
deterministic inspection.

### Use one free-form manifest JSON row without indexed registrations

Rejected because uniqueness, cross-workspace safety and exact evaluator
resolution would depend on application scans rather than database invariants.

### Make extension URI/version globally unique across all workspaces

Rejected for the local-first model. Workspaces may install independently;
identity conflicts are enforced within a workspace. Hosted deduplication may
share immutable blobs without sharing authority.

## 7. Invariants

UK-003 is accepted only if tests prove:

1. identical install retry returns the same release;
2. conflicting manifest/type/evaluator reuse is rejected;
3. a release installs atomically with all registrations;
4. registry rows are physically immutable;
5. every historical/current typed fact row has a backfilled universal identity;
6. v1 CLI JSON keys remain byte-compatible;
7. the five reference matcher outcomes remain unchanged;
8. `doctor` detects missing registration, identity drift and digest mismatch;
9. the compatibility inventory covers every new table and field.

## 8. Consequences

Tasq has both a generic durable vocabulary and an executable package boundary.
The bundled reference extension proves the registry contract without making
its five domains kernel dependencies.

The cost is deliberate duplication during the v1 window: enum kind plus URI,
matcher version plus evaluator identity. That duplication is safe only because
one service adapter writes both and `doctor` verifies equivalence.
