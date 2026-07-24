# TQ-613–TQ-616 — signed-statement architecture and delivery contract

> **Status:** TQ-613–TQ-615 implemented in source; TQ-616 source candidate
> passes and the protected downloaded-byte gate remains
>
> **Decision:** [ADR-009](../decisions/ADR-009_SIGNED_STATEMENTS_AND_CREDENTIALS.md)
>
> **Machine gate:**
> [SIGNED_STATEMENT_ACCEPTANCE.json](SIGNED_STATEMENT_ACCEPTANCE.json)

## 1. Outcome

Tasq should let a human, agent or workload make a portable cryptographic
statement over one exact artifact, decision or operation without turning a
signature into truth or permission.

The complete path is:

```text
principal
  → signing credential enrolled by a trusted host
  → registered purpose + canonical statement payload
  → constrained signer
  → detached signature
  → verification against credential snapshot and trust root
  → live authorization or validation decision
  → typed domain record
```

The implementation is complete only when all of the following can coexist:

- `tasq add → list → done` works with no key or signature ceremony;
- a report can be content-addressed and signed by its author;
- another principal can validate the report without the author's signature
  becoming self-approval;
- a consequential effect can require an eligible signed approval while
  retaining the existing permit, fence and receipt boundary;
- an offline operation can preserve end-to-end origin without gaining offline
  effect authority;
- credential loss, rotation, revocation and compromise produce explicit,
  recoverable states;
- a copied or altered signature bundle fails in every surface and language;
- current release and product truth continue to say `not_implemented` until a
  protected release passes the complete gate.

## 2. Scope boundary

### Tasq owns

- language-neutral signed-statement and public credential DTOs;
- deterministic payload canonicalization and pre-authentication encoding;
- append-only statement and verification records;
- registered purpose/profile identity;
- typed binding from statements into evidence, resolution, effect approval,
  replication and checkpoints;
- discovery, inspection, export/import and doctor coverage;
- current credential-state checks at the authority boundary;
- public conformance vectors and adversarial acceptance.

### The host owns

- private-key generation, custody, use and deletion;
- hardware, keychain, KMS, WebAuthn or workload signer integration;
- enrollment ceremony and recovery proof;
- mapping an external identity to a Tasq principal;
- configured trust roots and credential resolver;
- deciding which caller may invoke which signing purpose.

### Policy owns

- whether a signature is required;
- eligible principals and credential profiles;
- freshness, challenge, quorum and separation-of-duty rules;
- whether later compromise requires a finding, new validation, reopening or
  compensation.

### Tasq does not claim

- signatures make content true;
- signatures make plaintext secret;
- a shared same-user software key resists every local process;
- a signature prevents record deletion or full-database rollback;
- a public blockchain, universal PKI or certificate authority;
- PGP-compatible document signing;
- legal non-repudiation in every jurisdiction;
- a remote signing service, KMS or public transparency log.

## 3. Required records and contracts

### 3.1 Portable statement payload

`SignedStatementPayloadV1` is strict, bounded and canonical:

```ts
type SignedStatementPayloadV1 = {
  contractVersion: "tasq.signed-statement.v1";
  statementId: string;
  workspaceId: string;
  audience: string;
  issuerPrincipalId: string;
  credentialId: string;
  purpose: {
    uri: string;
    version: number;
  };
  subject: {
    typeUri: string;
    id: string;
    revision?: number;
    digest: `sha256:${string}`;
  };
  actionUri?: string;
  payloadDigest?: `sha256:${string}`;
  expectedRevision?: number;
  nonce: string;
  issuedAt: string;
  notBefore?: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
};
```

Required constraints:

- IDs and nonces are non-empty, bounded and contain no secrets;
- `audience`, purpose, subject type and action are absolute registered URIs;
- integers are safe positive integers;
- timestamps are explicit RFC 3339 instants, but signer time never replaces
  the injected authority clock;
- metadata is size-bounded and cannot affect authority unless its purpose
  schema explicitly graduates the field into the canonical payload;
- unknown and duplicate JSON keys fail before canonicalization;
- large content is represented only by immutable digest and location in the
  owning artifact/evidence record.

### 3.2 Signature bundle

`SignedStatementBundleV1` contains:

```ts
type SignedStatementBundleV1 = {
  envelopeVersion: "tasq.signed-statement-envelope.v1";
  payloadType: "application/vnd.tasq.signed-statement.v1+json";
  payload: string; // base64url exact canonical payload bytes
  signature: {
    profileUri: string;
    profileVersion: number;
    keyId: string;
    value: string; // base64url, no padding
  };
  supportingProofs: Array<{
    typeUri: string;
    version: number;
    digest: `sha256:${string}`;
    bundle: unknown;
  }>;
};
```

The signature input is DSSE-style pre-authentication encoding over the exact
`payloadType` and decoded `payload` bytes. The verifier:

1. validates the envelope before decoding;
2. resolves the registered signature profile;
3. rejects unknown fields, algorithm confusion and duplicate signatures;
4. verifies the signature before trusting payload routing fields;
5. parses the decoded payload and independently regenerates its canonical
   bytes;
6. requires byte equality with the signed bytes;
7. resolves the exact credential revision and principal binding;
8. evaluates validity and revocation at one injected acceptance time;
9. validates purpose-specific subject coverage and nonce rules;
10. returns a typed result without performing a domain mutation.

### 3.3 Signing credential

The control-plane record is `SigningCredentialV1`:

```ts
type SigningCredentialV1 = {
  credentialId: string;
  workspaceId: string;
  principalId: string;
  profileUri: string;
  profileVersion: number;
  publicMaterial: unknown;
  publicMaterialDigest: `sha256:${string}`;
  trustRootDigest: `sha256:${string}`;
  status: "pending" | "active" | "suspended" | "revoked" |
          "compromised" | "retired";
  revision: number;
  validFrom: string;
  expiresAt?: string;
  replacesCredentialId?: string;
  enrollmentMethod: string;
  enrollmentEvidenceDigest: `sha256:${string}`;
};
```

Private material is intentionally absent. Public material has one immutable
canonical representation per profile. A credential event records every state
transition and its authority decision. A credential ID can never be rebound to
another principal, profile, public key or workspace.

### 3.4 Verification record

`SignatureVerificationRecordV1` is append-only:

```ts
type SignatureVerificationRecordV1 = {
  id: string;
  workspaceId: string;
  statementId: string;
  statementDigest: `sha256:${string}`;
  bundleDigest: `sha256:${string}`;
  credentialId: string;
  credentialRevision: number;
  credentialDigest: `sha256:${string}`;
  principalId: string;
  trustRootDigest: `sha256:${string}`;
  profileUri: string;
  profileVersion: number;
  verifierImplementationDigest: `sha256:${string}`;
  verifiedAt: string;
  credentialStateAtVerification: string;
  outcome: "valid" | "invalid" | "indeterminate";
  reasonCode: string;
  supportingProofDigests: string[];
};
```

Invalid proofs normally return a typed error before any authoritative domain
mutation. A deployment may retain a secret-minimized invalid-attempt security
event, but it must not persist attacker-controlled payload bodies in the
workspace ledger.

Valid verification is necessary but not sufficient for domain acceptance.
The consuming transaction stores the verification record and typed domain
binding atomically with the authorized mutation.

## 4. Purpose registry

V1 purpose descriptors contain:

```text
purpose URI/version
accepted subject type URI/version
required signed fields
allowed signature profiles
freshness and nonce mode
whether expectedRevision is mandatory
whether online authorization is mandatory
typed domain binder identity and implementation digest
```

First-party purposes implemented in source:

| Purpose | Subject | Consumer | Meaning |
|---|---|---|---|
| `artifact-authorship` | artifact ID + digest | artifact/evidence trust | Principal asserts authorship of exact bytes |
| `artifact-acceptance` | artifact ID + digest | resolution | Principal explicitly accepts exact artifact version |
| `completion-attestation` | proposal + contract digest | validation decision | Eligible principal attests under frozen policy |
| `effect-approval` | effect ID + request digest | effect approval | Eligible principal approves this exact occurrence and request |
| `replication-operation-origin` | operation dot + operation digest | replication authority | Principal originated exact offline operation |
| `workspace-checkpoint` | authority epoch/cursor/root digest | witness/export | Authority observed this exact ledger root |

Purpose names above are frozen by accepted ADR-009. Implementation
freezes absolute `https://schemas.tasq.dev/` URIs and golden vectors.

There is no `generic-document-signature` purpose and no generic “signed prose
authorizes commands” path.

## 5. Signature profiles

### 5.1 Baseline Ed25519 profile

The first portable agent/workload profile:

- uses Ed25519 under RFC 8032;
- stores public keys in one pinned portable encoding;
- signs DSSE-style pre-authentication bytes;
- requires exactly one 64-byte signature;
- rejects low-level key or signature encodings outside the profile;
- includes positive and negative language-neutral vectors;
- never accepts a symmetric MAC as principal identity.

The existing local HMAC connector-permit helper remains valid for its narrow
same-host permit boundary. It is not a signing credential profile.

### 5.2 WebAuthn human profile

The optional human profile:

- uses a fresh server-generated challenge containing the complete statement
  digest and single-use nonce;
- verifies RP ID, origin, challenge, credential ID, signature and configured
  user-presence/user-verification policy;
- stores exact client data, authenticator data and signature only in a bounded
  proof bundle;
- treats the authenticator counter as a clone signal, not an infallible global
  sequence;
- never calls a generic WebAuthn login assertion a document signature.

### 5.3 Keyless workload profile

A future keyless profile may verify:

- an ephemeral public key;
- a short-lived certificate bound to an expected workload identity;
- an independent timestamp or transparency inclusion proof;
- exact issuer, audience, subject and workflow constraints.

It is an adapter, not a dependency of Local and not a reason to send private
workspace contents to a public transparency service.

## 6. Authority and key lifecycle

### Enrollment

Enrollment requires an authenticated authority action distinct from ordinary
workspace mutation. It proves key possession by signing a server nonce and
binds the credential to one principal, workspace, profile and trust root.

Self-enrollment is allowed only when an existing grant explicitly permits it.
An unauthenticated caller cannot create a principal and enroll its own key in
one request.

### Rotation

Rotation creates a new credential, proves possession, authorizes replacement
and links both immutable identities. Existing statements retain the exact old
credential snapshot.

### Suspension and revocation

Suspension/revocation takes effect on the next verification or guarded
mutation. It cannot race behind a domain commit: the authority writer gate
used by TQ-804 must serialize the credential-state check and domain mutation.

### Compromise

Compromise records:

- the authority decision time;
- the earliest defensible compromise time, when known;
- source/reason evidence;
- affected trust roots and replacement plan.

The product never trusts a signer-supplied `issuedAt` to place a statement
before compromise. Historical eligibility uses authority acceptance time plus
optional trusted timestamp/witness evidence.

### Recovery

Recovery is a distinct authority workflow. Acceptable policies include another
active credential, human account recovery, configured organization
administration or an offline recovery factor. Recovery must not silently grant
effect-approval eligibility or rotate authority epochs.

### Removal

Public credential descriptors and events needed to verify retained statements
are not physically deleted during ordinary rotation or workspace export.
Privacy deletion may remove external identity data under a separate policy
while retaining a non-secret tombstone, digest and affected-proof status.

## 7. Cross-stack implementation map

### `@tasq-run/schema`

- portable payload, bundle, credential, verification and problem schemas;
- canonicalization, PAE and digest golden vectors;
- registered profile/purpose descriptor schemas;
- no signer, trust root, filesystem or network dependency.

### `@tasq-run/core`

- pure bundle parser/verifier orchestration interfaces;
- append-only statement and verification persistence;
- purpose registry and typed domain binders;
- transaction APIs that accept host-verified credential context;
- inspection, discovery, export/import and doctor integration;
- no private-key generation, storage or generic sign operation.

### `@tasq-run/extension-sdk`

- profile and purpose conformance testkit;
- constrained `StatementSigner` and `StatementVerifier` interfaces;
- host adapter examples with ephemeral test keys only;
- no production credential store or signing service.

### Tasq service and Local CLI

- unsigned simple journeys remain the default;
- read commands can inspect and independently reverify a bundle;
- opt-in signing uses a configured signer reference or interactive host
  ceremony, never `--private-key` or a signature secret in argv;
- importing a bundle requires explicit workspace/audience and typed purpose;
- errors distinguish missing signer, unsupported profile, invalid proof,
  revoked credential, stale statement and unauthorized purpose.

### Local MCP and agent integrations

- discovery exposes statement-read/submit tools only when host configured;
- no general arbitrary-byte signing tool is registered;
- a signing tool, if a host chooses to expose one, is purpose-scoped and
  returns an exact preview/digest before any required human confirmation;
- tool descriptions state that signed ledger prose cannot widen authority;
- the agent skill teaches `inspect → request signature → submit → verify`, not
  private-key management.

### Authority and Server

- authority store owns credentials, events, recovery and trust roots;
- subject binding, credential binding and live authorization remain separate;
- REST and remote MCP share one verification/authorization guard;
- request bodies cannot select their verifier, algorithm or trust root;
- credential check and domain mutation serialize under the TQ-804 authority
  gate;
- nonce/challenge state is bounded, single-use, expiry-checked with the injected
  clock and safe under retry.

### Evidence and resolution

- evidence trust may reference a verified authorship/source statement;
- completion attestation includes proposal, contract and evidence-set digests;
- self-validation, eligibility, challenge and adjudication remain ADR-005
  policy;
- later credential compromise creates a finding and optional new decision, not
  a silent rewrite.

### Effects

- signed approval binds effect occurrence, request digest, scope, limits,
  validity, connector binding and expected effect revision;
- the effect gate rechecks current authority and credential state;
- TQ-205 connector permit is still separately issued after the approval;
- provider receipt verification remains independent of principal signing.

### Replication

- signed offline operations bind operation dot, complete operation digest,
  workspace, authority audience and origin principal;
- the authority verifies transport identity and statement identity;
- a mismatch is `unauthenticated_origin` or `signature_identity_mismatch`, not
  a merge conflict;
- exact signed retry is idempotent;
- no signed offline payload may acquire/renew claims, approve or dispatch
  effects, change keys or resolve conflicts without online authority;
- snapshot/export contains public proof and verification state, never signers.

### Console and public site

Console projects bounded proof status, purpose, signer, credential lifecycle
and verification time. It never renders secret material or ambiguous
“verified” labels.

The static public site documents signed statements only after implementation
and protected release. Before then it may describe the roadmap with an explicit
planned label but must not show executable commands.

### Release and supply chain

GitHub attestations, npm provenance and release signatures remain the source
distribution trust chain. They may use similar cryptography but do not bind a
workspace principal or authorize a commitment.

### Cross-language SDKs

Every client uses the same frozen payload bytes, PAE, digest and signature
vectors. A Python or other SDK may construct/verify bundles but never
reimplement Tasq authorization or migrate the store.

## 8. Storage and migration

The implementation is additive. Proposed durable ownership:

| Store | Record family |
|---|---|
| Workspace ledger | signed statement, verification result, typed domain binding, workspace checkpoint |
| Authority control plane | signing credential, credential event, trust root, challenge/nonce, recovery audit |
| Host secret store | private key or remote signer handle |
| External witness | optional latest checkpoint/inclusion evidence |

Migration rules:

1. create append-only workspace proof tables with workspace-safe references;
2. create control-plane credential tables independently from the domain store;
3. install update/delete guards and doctor parity checks;
4. leave every historical record unsigned;
5. activate signature-required policy only after configured credentials exist;
6. preserve backups and exact store-format compatibility ranges under TQ-608;
7. update portable export/import before raising any support state;
8. reject downgrade to a binary that cannot preserve signature-required state;
9. reject replication of proof-dependent records until its projection version
   includes the full chain.

No migration may generate a key, self-sign historical content or infer a
principal binding from actor text.

## 9. Assurance profiles and product UX

Signed statements are progressively disclosed:

| Level | User experience | Security claim |
|---|---|---|
| Unsigned local | existing simple commands | append-only local attribution |
| Authenticated transport | hosted login/workload identity | server authenticated the request principal |
| Signed principal statement | configured credential and purpose | exact portable statement verified at acceptance |
| Witnessed statement | timestamp/checkpoint proof | statement existed by witnessed point |
| Policy-approved outcome | eligible validation/authority decision | configured policy accepted the statement |

Every UI and API returns the level and reason. It never collapses them to one
boolean.

For a human, the signing prompt derives a preview from the exact signed payload
and prominently shows:

- workspace and relying authority;
- action/purpose;
- artifact or effect digest and material fields;
- expiry and one-time challenge;
- whether the signature authorizes, attests, validates or only claims
  authorship.

For an agent, the machine response returns the canonical payload digest and
typed next action. Prose cannot change the purpose or signed bytes.

## 10. Threat model

Critical adversarial cases include:

### Content and encoding

- whitespace/property-order variants;
- duplicate keys, unsafe numbers, Unicode ambiguity and invalid UTF-8;
- altered payload with reused signature;
- changed `payloadType`, purpose, workspace, audience or action;
- signature wrapping, duplicate signature and partial-coverage attacks;
- unsupported profile or verifier implementation drift.

### Identity and authority

- key bound to another principal/workspace;
- active signature from an ineligible principal;
- actor label substitution;
- delegated actor exceeding subject or actor grant;
- signature accepted after suspension/revocation/expiry;
- self-signed credential enrollment without trusted authority;
- valid artifact-authorship proof replayed as effect approval.

### Replay and concurrency

- statement ID reused with different bytes;
- online nonce reused, expired or accepted concurrently;
- valid statement over stale expected revision;
- exact lost-response retry;
- revoked credential racing a domain commit;
- old valid signature replayed against another authority epoch.

### Key custody

- private key present in ledger, logs, env, argv, prompt, support bundle or
  portable export;
- signer exposed as arbitrary-byte oracle;
- test key accidentally accepted in production;
- algorithm/key-type confusion;
- key rotation rebinding an old credential ID;
- compromise backdated using signer-controlled time.

### Persistence and transport

- direct SQL mutation of payload, signature, verification or binding;
- statement deletion and complete database rollback;
- export/import omitting public credential history;
- replication accepting a signature-dependent record without proof;
- checkpoint accepted without external witness while claiming rollback
  resistance.

### Semantic overclaim

- signature treated as evidence truth;
- author treated as independent validator;
- signed approval treated as connector permit or provider receipt;
- release attestation treated as workspace authority;
- signature status rendered as timeless “verified”.

## 11. Delivery sequence

### TQ-613 — Portable statement contract

Deliver:

- schemas, canonical payload, PAE and digest/signature vectors;
- Ed25519 baseline verifier;
- profile and purpose descriptors;
- no persistence or product claim.

Acceptance:

- TypeScript, Node and Bun produce identical positive vectors;
- at least one independent Python fixture verifies the same vectors;
- every meaningful field mutation fails;
- malformed/ambiguous encoding fails before verification;
- no private-key API enters Core.

### TQ-614 — Credential authority and signer boundary

Depends on TQ-613 and TQ-802.

Deliver:

- authority credential/event/trust-root storage;
- enrollment proof of possession;
- rotation, suspension, revocation, compromise, retirement and recovery
  contracts;
- constrained signer/verifier host interfaces;
- Local software-key test adapter and WebAuthn design adapter;
- no generic agent signing oracle.

Acceptance:

- cross-workspace/key rebinding and recovery escalation fail;
- revocation races serialize with admitted mutations;
- no secret appears in database, logs, CLI/MCP or export;
- a same-user test adapter is labeled as a weaker isolation class.

### TQ-615 — Domain and surface integration — done in source

Depends on TQ-614, TQ-612, TQ-205 and TQ-405.

Deliver:

- append-only statement/verification persistence;
- typed artifact, resolution, effect, replication and checkpoint bindings;
- discovery, Core, embedded client, CLI, MCP and Console projections;
- doctor, backup, export/import and replication compatibility;
- exact support/non-support documentation.

Acceptance:

- artifact replacement invalidates authorship/acceptance;
- independent validation stays independent;
- signed effect approval cannot bypass permit/fence/receipt;
- signed offline operation cannot obtain authority-required capability;
- old unsigned simple journeys remain byte-compatible at their API boundary.

### TQ-616 — Adversarial and clean-room certification — source candidate;
protected-byte gate open

Depends on TQ-615 and the deployed Server certification boundary TQ-808.

Deliver:

- complete machine matrix in
  `SIGNED_STATEMENT_ACCEPTANCE.json`;
- hostile local and hosted cross-surface evals;
- cross-language conformance;
- process-kill, lost-response, revocation-race and restore tests;
- published-byte certification before any implemented support claim.

Acceptance:

- all critical failures are absent;
- exact downloaded bytes pass supported platforms/runtimes;
- an unbriefed agent cannot turn signing into broader authority;
- an operator can rotate/revoke/recover and still inspect historical proof;
- docs and Console explain guarantees and non-guarantees precisely.

## 12. Release gates

No release may claim signed statements until:

1. ADR-009 is accepted;
2. TQ-613 through TQ-616 are complete;
3. schema and store migrations pass TQ-608 data-safety tests;
4. public package vectors pass Node, Bun and Python clean-room verification;
5. Server tests prove the identical REST/MCP guard and revocation race;
6. Local docs preserve unsigned progressive disclosure;
7. Console and public site avoid ambiguous verification language;
8. protected artifacts and machine certification bind the exact release.

Remote effects additionally remain behind TQ-906. A passed signature gate does
not authorize financial or consequential provider actions by default.

## 13. Open choices resolved during TQ-613

The following implementation details must be frozen with vectors, not left to
individual adapters:

- exact first-party purpose/profile URIs;
- Ed25519 public-key encoding;
- statement size/depth/node limits;
- nonce length and online challenge retention;
- supporting-proof size and accepted timestamp bundle formats;
- verifier implementation digest derivation;
- portable public credential snapshot format;
- exact typed problem codes;
- whether checkpoint roots reuse existing journal/snapshot digests or receive
  a new domain-separated workspace-root contract.

None may weaken the ADR separation between signature, credential binding,
authorization, validation and witnessed presence.

## 14. References

- [ADR-009 signed statements](../decisions/ADR-009_SIGNED_STATEMENTS_AND_CREDENTIALS.md)
- [ADR-004 hosted identity and authorization](../decisions/ADR-004_AUTHENTICATED_HOSTED_TENANCY.md)
- [ADR-005 evidence trust and resolution](../decisions/ADR-005_EVIDENCE_TRUST_AND_RESOLUTION.md)
- [ADR-003 replication](../decisions/ADR-003_REPLICA_CONFLICT_MODEL.md)
- [ADR-002 canonical effect identity](../decisions/ADR-002_EFFECT_REQUEST_IDENTITY.md)
- [TQ-205 connector permit](TQ-205_CONNECTOR_DISPATCH_GATE.md)
- [TQ-612 completion resolution](TQ-612_INDEPENDENT_COMPLETION_RESOLUTION.md)
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html)
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html)
- [DSSE](https://github.com/secure-systems-lab/dsse)
- [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [Sigstore keyless signing](https://docs.sigstore.dev/cosign/signing/overview/)
