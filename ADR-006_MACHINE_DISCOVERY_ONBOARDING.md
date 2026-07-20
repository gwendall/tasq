# ADR-006 — machine discovery and safe cold-start onboarding

> **Status:** accepted — 2026-07-15  
> **Implementation:** complete — embedded API, local CLI and black-box
> package-independent client eval
> **Decision scope:** UK-009  
> **Depends on:** UK-001–UK-008, ADR-UK-EXT, ADR-UK-006 collaboration records  
> **Does not authorize:** remote authentication, capability grants, extension
> installation, effect execution or protocol-specific task mapping

## 1. Problem

A runtime that knows only that an endpoint speaks Tasq must not need this
repository, `_life` conventions, provider knowledge or another runtime's prompt
to participate safely. It needs a bounded machine contract answering:

1. Which Tasq protocol and discovery contracts are supported?
2. Which capability groups are actually implemented on this deployment?
3. Which extension releases, types, schemas and evaluators are installed for
   the authenticated workspace?
4. How are lossless feeds resumed?
5. Which resource and request limits apply?
6. Is the client's required subset exactly compatible, and if not, why?

Today those answers are spread across TypeScript exports and human docs. That
is adequate for a repository-aware coding agent, not for universal autonomous
onboarding.

## 2. Boundary

Discovery is a read-only projection over kernel capabilities and the immutable
workspace extension registry. Onboarding is deterministic compatibility
negotiation over that projection. Neither is authentication or authorization.

- A transport authenticates a principal before returning workspace discovery.
- The local CLI may identify its boundary as `local_process`; that is an honest
  deployment mode, not a claim of remote credential verification.
- Capability presence means “this semantic operation exists.” It does not mean
  the current principal may invoke it.
- Negotiation never installs an extension, mutates the ledger, grants a role,
  approves an effect or completes a commitment.
- Provider connectors, policy profiles and runtime execution remain outside
  the kernel.

The embedded service is the reference semantic implementation. CLI, HTTP,
MCP, A2A and later transports expose the same DTOs without adding invariants.

## 3. Stable entry resources

Transport adapters reserve these relative resources:

```text
GET  /.well-known/tasq
GET  /.well-known/tasq/schemas/{resourceId}
POST /.well-known/tasq/onboarding
```

The current local reference maps them to:

```text
tasq discover --json
tasq discover schema <resource-id> --json
tasq discover negotiate --hello '<json>' --json
```

Knowing the well-known path or the `discover` verb is the only Tasq-specific
bootstrap knowledge required. UK-009 does not ship an unauthenticated HTTP
server. A future remote adapter must authenticate before calling the embedded
workspace functions and may separately publish a minimal transport/auth
bootstrap document containing no workspace registry data.

## 4. Discovery document v1

The top-level contract identifier is exactly `tasq.discovery.v1`. A v1
document contains:

```text
contractVersion
generatedAt, expiresAt
workspaceId
transportBoundary
protocol { uri, versions }
capabilities[] { uri, version, operations[] }
extensions[] { extensionUri, version, manifestDigest, types[], evaluators[] }
cursors[] { uri, version, fields[], ordering, exclusive }
resources { discovery, schemaTemplate, onboarding }
limits { documentBytes, schemaBytes, helloBytes, requiredItems }
compatibilityDigest
```

### 4.1 Identities and ordering

- Protocol, capability and cursor identities are absolute HTTPS URIs owned by
  the Tasq schema namespace. Versions are positive integers.
- Extension/type/evaluator identities and digests are the immutable values
  already frozen by ADR-UK-EXT.
- Arrays are sorted by canonical identity and version. Operation names and
  cursor fields are ordered contract data, never incidental object iteration.
- Only implemented behavior is advertised. Pending effects/approvals, remote
  auth, hosted tenancy and protocol adapters are absent until implemented.
- The document uses canonical JSON and is bounded before being returned.

### 4.2 Schemas as bounded resources

Discovery carries type identity, record kind, schema version, SHA-256 digest,
canonical byte length and an opaque `resourceId`; it does not inline every
schema into the main document. `getDiscoverySchema(resourceId)` returns the
canonical schema plus the same identity/digest after re-reading the current
registry. Resource IDs are derived from the full immutable type identity, not
from a user path, row ID or array offset.

This avoids an unbounded well-known response while allowing a client to fetch
only schemas it can consume. A digest mismatch is a registry-integrity failure,
not a reason to trust the newly received bytes.

### 4.3 Time, cache and compatibility digest

`generatedAt` comes from an injected `Clock`; `expiresAt` is a fixed bounded
offset from that snapshot. Discovery code never reads device time directly.

`compatibilityDigest` is SHA-256 over the canonical, stable compatibility
payload: protocol, capabilities, extensions/types/evaluators, cursors,
resources and limits. It excludes `generatedAt`, `expiresAt`, workspace ID,
database row IDs, installation timestamps and actor aliases. Therefore:

- the same compatibility state has the same digest across calls and clocks;
- an extension/capability/schema change produces another digest;
- clients may cache until `expiresAt`, use the digest as an ETag/pin and
  re-negotiate when it changes.

The digest proves content equality, not server identity or authenticity. A
remote transport must protect it with its authenticated channel.

## 5. Capability groups

V1 advertises only groups exposed by the strict kernel entrypoint:

```text
commitments
relations
principals
assignments
claims
attempts
artifacts
evidence
completion-records
inspection
audit
extension-registry
```

The bundled compatibility surface may additionally advertise typed
conditions, observations, reconciliations and deadline sweeps when their
reference runtime is installed. Life planning, ranking and markdown projection
are profile capabilities, not universal kernel capabilities, and are not part
of the strict document.

Each group lists exact semantic operation identifiers such as `inspect` or
`transition`; it does not mirror every CLI flag. A conformance test must map
every advertised operation to an exported implementation and reject an
advertisement for planned behavior.

## 6. Cursor declarations

V1 publishes two lossless cursor contracts:

- event feed: strictly increasing `sequence`, exclusive resume;
- observation feed: lexicographic `(recordedAt,id)`, ascending, exclusive
  resume.

Timestamp-only filtering is never advertised as a lossless cursor. A client
hello can require cursor identities; missing support is an incompatibility,
not permission to poll by wall-clock guesses.

## 7. Client hello and deterministic negotiation

The request contract is exactly `tasq.client-hello.v1` and is strictly parsed.
It contains bounded arrays of:

```text
supportedProtocolVersions[]
requiredCapabilities[] { uri, version }
requiredTypes[] { typeUri, schemaVersion, optional schemaDigest }
requiredCursors[] { uri, version }
optional knownCompatibilityDigest
optional maxSchemaBytes
```

The response contract is exactly `tasq.onboarding.v1`:

```text
status: compatible | incompatible | refresh_required
selectedProtocolVersion: integer | null
compatibilityDigest
capabilities[], types[], cursors[]        # exact negotiated subset
problems[] { code, path, message }
```

The algorithm is pure after reading one discovery snapshot:

1. choose the highest exact protocol version present in both sets;
2. if a known digest differs, return only `refresh_required` and no negotiated
   subset, forcing the client to inspect fresh discovery;
3. compare every required identity/version exactly;
4. compare pinned schema digests exactly when supplied;
5. reject a required schema larger than the client's declared bound;
6. sort all typed problems deterministically;
7. return `compatible` only when the problem list is empty.

No “closest version,” silent downgrade, fuzzy URI, unpinned replacement or
partial-success mutation is allowed.

## 8. Typed incompatibilities

V1 problem codes are closed:

```text
unsupported_protocol_version
discovery_changed
missing_capability
missing_type
schema_digest_mismatch
schema_too_large
missing_cursor
invalid_hello
```

Malformed or oversized hello input fails before negotiation as `invalid_hello`.
Ordinary incompatibility returns a valid response rather than throwing or
inventing support.

## 9. Limits

Reference v1 uses explicit conservative bounds:

- discovery JSON: 2 MiB;
- one canonical schema resource: 1 MiB;
- client hello JSON: 256 KiB;
- 256 required capabilities, types and cursors each;
- discovery cache lifetime: 5 minutes.

Installed registry limits remain independently enforced. A deployment may
advertise lower limits but never accept above its advertised bound. Changing a
limit changes `compatibilityDigest`.

## 10. Security and privacy

- Workspace discovery is authenticated-resource metadata; do not expose it
  cross-tenant or anonymously by default.
- No credentials, raw provider payloads, absolute local paths, actor aliases,
  principal metadata or life-planning data appear in the strict document.
- Schema content is already trusted installation metadata, but remains bounded
  and digest-verified before return.
- Resource IDs are opaque and workspace-scoped; lookup still checks workspace.
- Negotiation must not be confused with authorization. The response deliberately
  says `capabilities`, never `grants` or `permissions`.
- A client must not execute unknown types merely because their schemas are
  discoverable; trusted evaluator loading remains an administrative boundary.

## 11. Alternatives rejected

### Human docs or repository introspection

Useful for engineers, impossible to negotiate reliably and unavailable to a
headless third-party runtime.

### OpenAPI alone

OpenAPI describes HTTP shapes, not installed workspace extensions, evaluator
digests, non-HTTP embeddings, cursor safety or semantic non-conflation.

### Reuse MCP `initialize` or A2A Agent Card as the canonical model

Both are valuable adapters, but making either the source contract would couple
the kernel to one execution protocol. UK-010 maps this neutral document into
those surfaces.

### Inline all schemas

Simple for tiny installs but turns discovery into an attacker-controlled or
extension-count-controlled unbounded response. Bounded content-addressed
resources preserve cold-start autonomy without forcing all bytes at once.

### Auto-install missing extensions during onboarding

Discovery is not trusted-code administration. Automatic installation would
turn a read-only compatibility check into remote code authority.

### SemVer ranges and best-effort downgrade

They hide semantic incompatibility. V1 negotiates exact integer protocol and
capability versions; extension releases retain their existing immutable SemVer
identity.

## 12. Acceptance gate

UK-009 is complete only when executable tests prove:

1. a minimal kernel document contains no provider or life-planning identity;
2. a reference install discovers all installed extension releases, exact
   schema/evaluator digests and both cursor contracts;
3. every advertised capability maps to an exported implementation;
4. document and schema sizes are bounded and schemas verify canonically;
5. clock changes alter only cache timestamps, not compatibility digest;
6. compatible, missing capability/type/cursor, digest mismatch, size limit,
   stale pin and unsupported-version hellos return exact deterministic results;
7. malformed/oversized input is rejected without a database mutation;
8. an unfamiliar package-independent subprocess client can cold-start from
   only the discovery document and its schema resources; UK-011 subsequently
   extended this proof to two coordinating runtimes.
