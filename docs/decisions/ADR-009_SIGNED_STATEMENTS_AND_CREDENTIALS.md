# ADR-009 — Purpose-bound signed statements and signing credentials

- **Status:** Accepted — 2026-07-24
- **Decision owner:** Tasq trust, authority and portability boundary
- **Depends on:** ADR-002, ADR-003, ADR-004, ADR-005 and ADR-UK-006
- **Implementation:** TQ-613 through TQ-615 complete in source; TQ-616
  protected-artifact gate open
- **Does not change published support:** Tasq Local actor labels remain
  self-asserted and the published `v0.3.0` surfaces do not accept
  principal-signed statements

## 1. Context

Tasq already preserves append-only artifacts, evidence, approvals, receipts,
resolution records, audit events and replication operations. Canonical digests
detect content drift, revisions reject stale writes and authenticated hosted
adapters can bind a request to a principal.

Those controls do not provide a portable answer to:

> Which principal intentionally made this exact statement, for this exact
> purpose, over these exact bytes?

A digest proves content identity, not authorship. Transport authentication
proves who controlled one connection, not necessarily who authored a portable
artifact after it leaves that connection. A local actor label is attribution,
not authentication. A valid provider receipt or connector permit has its own
narrow trust contract and cannot be reused as a general principal signature.

The missing property matters in several unrelated domains:

- a research author signs the digest of a report while an independent reviewer
  separately decides whether it satisfies the commitment;
- a human signs one exact consequential approval and an agent cannot change
  its parameters while retaining that approval;
- an offline replica submits a mutation whose origin remains verifiable after
  transport intermediaries and retries;
- a workspace authority publishes a checkpoint that an external witness can
  retain to detect later rollback or truncation.

This passes the kernel admission test as a cross-cutting trust primitive, but
only if signatures remain separate from authorization, truth and execution.

## 2. Decision

Tasq will model a **signed statement**: an immutable, purpose-bound
cryptographic assertion by one principal over one exact canonical payload.

Tasq will not make “signed document” a primitive. A document remains an
artifact. A signed statement may assert authorship, acceptance or another
registered purpose over the artifact's identity and digest.

The separation is:

| Concept | Establishes | Does not establish |
|---|---|---|
| Content digest | Exact byte identity | Author, permission, truth or presence over time |
| Cryptographic signature | Possession of a signing credential over exact purpose-bound bytes | Principal binding, permission or semantic correctness |
| Credential binding | Which principal and trust domain control the verification method | Current authorization |
| Signature verification | The proof passed one exact profile and credential snapshot | The statement is true or allowed |
| Authorization decision | The authenticated principal may perform one action now | The resulting artifact or evidence is correct |
| Validation decision | Evidence satisfies a frozen resolution contract | Permission to perform an external effect |
| Witness/checkpoint proof | A statement existed no later than a witnessed point | Confidentiality or semantic truth |

A signature is therefore an input to authority or validation. It never becomes
authority by itself.

## 3. Canonical language

### Signing credential

A public verification method bound to one principal under an explicit trust
root and lifecycle. The private signing capability is held outside Tasq.

### Signed statement

One immutable occurrence in which a signing credential signs an exact
purpose-bound payload. It has its own identity so identical statements can be
made intentionally more than once.

### Statement purpose

A registered absolute URI plus version that defines the meaning, required
subject fields, freshness rules and consuming service. Unknown purposes are
inert and cannot authorize or validate anything.

### Signature profile

A versioned contract that fixes payload encoding, pre-authentication encoding,
algorithm, signature format, public-key format and verification rules. The
verifier chooses the algorithm from the registered profile and credential; it
never trusts an attacker-selected algorithm field.

### Credential event

An append-only enrollment, activation, rotation, suspension, revocation,
compromise or retirement statement about a signing credential. Key material is
immutable; lifecycle changes append history and advance current state.

### Witness receipt

Optional evidence from an independent authority, timestamp service or
transparency system that binds a statement digest to an observed time or
ordered checkpoint. It strengthens rollback and historical-validity claims but
does not change the statement's meaning.

## 4. Signed payload

The portable payload is `tasq.signed-statement.v1`:

```text
contractVersion:        "tasq.signed-statement.v1"
statementId:            unique intentional occurrence ID
workspaceId:            exact workspace
audience:               exact relying authority or local trust-domain URI
issuerPrincipalId:      signer attribution expected from credential binding
credentialId:           immutable verification-method identity
purpose:
  uri:                  registered absolute URI
  version:              positive integer
subject:
  typeUri:              registered subject type
  id:                   exact domain record or external subject identity
  revision?:            exact mutable-record revision when applicable
  digest:               domain-separated content or state digest
actionUri?:             registered authority action when the statement requests one
payloadDigest?:         digest of separately retained artifact/content
expectedRevision?:      authority precondition when the statement requests a mutation
nonce:                  purpose-scoped replay challenge or random statement nonce
issuedAt:               signer-asserted time; never authority time by itself
notBefore?:             optional signed validity lower bound
expiresAt?:             optional signed exclusive validity upper bound
metadata:               bounded, schema-owned non-authority data only
```

Every authority-significant field is signed. Workspace, audience, purpose,
subject, action and validity cannot be supplied beside the signature as
unsigned routing hints.

`statementId` identifies an occurrence. An exact retry reuses it and must
produce the same payload digest and signature bundle. Reuse with different
bytes is an integrity failure. Two intentional identical attestations use
different statement IDs.

## 5. Encoding and signature profile

The baseline profile uses:

1. Tasq's existing strict safe-integer canonical JSON to produce the payload
   bytes;
2. a fixed media type
   `application/vnd.tasq.signed-statement.v1+json`;
3. DSSE-style pre-authentication encoding that signs both media type and exact
   payload bytes;
4. an asymmetric signature profile whose algorithm and public-key encoding are
   pinned by the registered credential profile;
5. base64url encoding without padding for the detached signature.

The first software/workload profile should use Ed25519. The architecture is
profile-agile, not algorithm-negotiable: adding another algorithm requires a
new registered profile, test vectors and policy admission. The envelope never
accepts `alg=none`, caller-selected algorithm downgrade or ambiguous key
formats.

One statement has one issuer. Independent approvals or threshold policy use
several individually verifiable statements and an ordinary policy decision.
V1 does not implement aggregate signatures, shared private keys or a generic
multisignature script.

WebAuthn is a separate human-interaction profile. Its server challenge must
bind the complete Tasq statement digest, workspace, audience, purpose and
single-use nonce. A WebAuthn assertion proves the configured authenticator
ceremony; it is not treated as an arbitrary raw-document signature.

Keyless certificate/transparency bundles may become another profile for CI or
workload identities. Tasq release provenance remains a separate distribution
contract and is not silently imported as workspace authority.

## 6. Credential ownership and lifecycle

The Tasq kernel never generates, stores, exports or receives private keys.
A host supplies a constrained signer and a credential resolver.

A public credential descriptor contains:

```text
credentialId, workspaceId, principalId
profileUri, profileVersion
publicVerificationMaterial or immutable resolver reference
publicMaterialDigest, trustRootDigest
status, revision
validFrom, expiresAt?
createdAt, activatedAt?, suspendedAt?, revokedAt?, compromisedAt?, retiredAt?
replacesCredentialId?, replacedByCredentialId?
enrollmentMethod, enrollmentEvidenceDigest
```

Public verification material and its profile are immutable. Rotation enrolls a
new credential and links the old and new records. It never edits a key under
an existing ID.

Lifecycle meanings remain distinct:

- `suspended` blocks new acceptance while investigation is ongoing;
- `revoked` blocks new acceptance from the authority decision onward;
- `compromised` records the earliest defensible compromise boundary and may
  make statements at or after that boundary ineligible under policy;
- `retired` is an orderly end of use and does not imply compromise.

Signer-supplied `issuedAt` is not proof that signing preceded compromise. A
trusted acceptance time, WebAuthn ceremony, timestamp or witness receipt is
required for historical-time claims. Revocation never silently rewrites a
past completion or effect. It appends a security finding; policy may require a
new decision, explicit reopening or compensation.

Recovery authority and signing authority are separate. A principal may enroll
a replacement credential only through a configured recovery path. A lost key
cannot sign its own replacement, and a workspace administrator does not
automatically become an effect approver.

## 7. Signer boundary

No general `sign arbitrary bytes` tool is exposed to an agent. That would turn
Tasq into a signing oracle.

A signer capability accepts only:

- a registered statement purpose;
- canonical payload bytes produced by the trusted library;
- an exact credential ID;
- host policy context and, when required, an explicit human ceremony.

It returns only the detached signature and profile metadata. It may reject a
purpose even when the caller can create ordinary commitments.

Private signing material must never appear in:

- a ledger row, event, error or support bundle;
- a command-line argument, environment variable or MCP payload;
- a task description, prompt, workspace file or agent-readable configuration;
- a portable export, backup manifest or replication operation.

Local software keys provide meaningful protection only when the signer process
or hardware store is isolated from the agents being distrusted. A key file
readable by every process under the same operating-system user does not create
a hostile-agent security boundary.

## 8. Storage and domain integration

The workspace ledger stores append-only signed-statement proof and immutable
verification records. The authority/control plane owns credential enrollment,
principal binding and current lifecycle.

The generic statement store is not a polymorphic authority edge. Each consuming
domain service must validate the registered purpose and attach the statement
through an explicit typed relationship:

- artifact authorship/acceptance attaches to an artifact or evidence-trust
  record;
- completion attestation attaches to a completion proposal or validation
  decision;
- effect approval attaches to the exact effect approval and request digest;
- replicated mutation origin attaches to the exact replication operation;
- an authority checkpoint attaches to one workspace epoch/cursor/root digest.

Unknown statements may be retained only as inert opaque proof under an explicit
import policy. They cannot satisfy evidence trust, authorize an effect, mutate
state or advance replication until their profile, purpose and typed binder are
installed.

The accepted verification record freezes:

```text
statement ID and digest
signature and proof-bundle digests
credential ID, revision and public-material digest
principal binding and trust-root digest
profile URI/version and verifier implementation digest
verifiedAt from the injected authority clock
validity/revocation state observed at acceptance
verification outcome and reason code
optional witness/timestamp identities and digests
```

Historical verification remains inspectable after key rotation. A later
re-verification appends a new result; it does not mutate the original.

## 9. Product integration rules

### Evidence and completion

A valid principal signature can support `authenticated_principal` evidence
trust only when the credential binding and accepting surface meet ADR-004 or an
explicit local trust profile. It does not automatically produce
`authenticated_source` or `provider_verified`, and it never decides that the
evidence satisfies a criterion.

### Effects

An effect approval may require a signed statement from an eligible principal.
The existing TQ-205 connector permit remains a separate authority-to-connector
capability. A principal signature cannot replace the current approval,
revision, claim, fence, permit, connector policy or provider receipt.

### Replication

Online replication still requires authenticated transport and registered
replica identity. A signed operation can preserve end-to-end origin through
intermediaries, but it does not grant offline claim, lease, approval or effect
authority. Signature-required operation classes fail closed when a signature
is absent or invalid.

### Server and Cloud

The hosted authority resolves credentials, verifies statements, evaluates live
authorization and commits the domain mutation under one serialized guard.
Credential verification cannot be performed after an unguarded kernel write.

### Local

Simple local `add → list → done` remains unsigned. Local signatures are
opt-in and honestly labeled with their isolation class. Existing records are
never retroactively described as signed.

### Console and audit

Surfaces show specific states such as `signature valid at acceptance`,
`credential revoked later`, `unsigned local attribution` or `proof cannot be
reverified`. A generic green “verified” badge is forbidden because it hides
whether the product verified authorship, authority, source or outcome.

## 10. Rollback, deletion and transparency

Signatures prevent undetected content substitution only while the private key
remains unavailable to the attacker and verification is actually enforced.
They do not prevent:

- deletion of a signed statement;
- rollback of the complete database to an older valid state;
- suppression of a statement before another party observes it;
- key theft, coercion or an authorized signer making a false assertion;
- disclosure of signed plaintext.

Tasq's existing append-only guards and doctor checks detect ordinary local
drift. Strong anti-truncation requires an authority-signed checkpoint retained
outside the database, or an independent witness/transparency service. The same
signed-statement primitive can represent a workspace checkpoint, but public
witness operation is a separate product and deployment claim.

## 11. Compatibility

- Existing unsigned commitments, evidence, approvals and completion records
  remain valid under their current low-assurance policies.
- No migration fabricates a signature, credential or trust class for historical
  rows.
- A policy may require signatures only for new actions after an explicit
  activation boundary.
- Portable export preserves statements, public credential history,
  verification records and witness bundles; it never exports private keys.
- Import verifies all proof digests before activation and preserves unknown
  profiles as inert or rejects them according to declared policy.
- Replication rejects signature-dependent state until its projection includes
  the complete proof and credential snapshot needed by the authority.
- Backup/restore and authority-epoch recovery do not implicitly rotate signing
  credentials.

## 12. Rejected alternatives

### Sign raw Markdown or arbitrary files

Rejected as the product primitive. File bytes are artifacts; intent, workspace,
purpose, audience and authorization preconditions must also be signed.

### Treat any valid signature as authorization

Rejected because compromised, expired, ineligible or wrong-purpose credentials
could become confused deputies. Live policy remains authoritative.

### Put private keys in the ledger or agent workspace

Rejected because every reader, backup, prompt or support path would become a
key-exfiltration path.

### Reuse connector permits as principal signatures

Rejected because TQ-205 permits are short-lived capabilities issued after
authority checks for one connector dispatch. Their signer and semantics are not
principal authorship.

### Require signatures on every todo

Rejected because it would add ceremony without improving the single-user local
threat model. Assurance is policy-selected and progressively disclosed.

### Store one mutable `signature_valid` flag

Rejected because verification depends on a profile, credential revision,
trust root, time, purpose and later lifecycle findings. Results are immutable
records, not a timeless boolean.

### Build a blockchain or universal public transparency log

Rejected as a kernel requirement. An external witness can retain signed
checkpoints without moving global consensus, tokens or public disclosure into
Tasq.

## 13. Consequences

Positive:

- artifact authorship and consequential approvals become portable;
- agents cannot substitute content while retaining another principal's proof;
- offline mutation origin can survive transport and retry boundaries;
- key rotation and compromise remain explicit and inspectable;
- simple todos keep their current frictionless path;
- the same primitive supports human, workload and future witness profiles.

Costs:

- key isolation, enrollment, recovery and revocation become real product work;
- signatures enlarge exports, replication projections and inspection;
- policies must specify purpose, freshness, eligibility and historical
  revocation behavior;
- cross-language SDKs require frozen test vectors;
- hostile local processes remain outside the guarantee unless signers are
  isolated;
- anti-rollback requires an external checkpoint or witness boundary.

## 14. Accepted decision

The maintainer accepted:

1. `signed statement` rather than `signed document` as the primitive;
2. DSSE-style typed pre-authentication over canonical Tasq JSON;
3. one signer per statement and policy-level multi-party approval;
4. host-owned private keys and authority-owned public credential lifecycle;
5. optional assurance for Local and mandatory policy gates only where needed;
6. the explicit non-claim that signatures alone do not prove truth,
   authorization, non-deletion or rollback resistance.

TQ-613 through TQ-615 are implemented in source. Public support remains gated
by TQ-616's protected exact-artifact and unbriefed-agent certification; source
completion does not make the published `v0.3.0` accept signed statements.

## References

- [RFC 8032 — Edwards-Curve Digital Signature Algorithm](https://www.rfc-editor.org/rfc/rfc8032.html)
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [DSSE — Dead Simple Signing Envelope](https://github.com/secure-systems-lab/dsse)
- [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- [Sigstore keyless signing](https://docs.sigstore.dev/cosign/signing/overview/)
