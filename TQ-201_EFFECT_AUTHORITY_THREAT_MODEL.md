# TQ-201 — Effect and authority threat model

- **Status:** Accepted
- **Date:** 2026-07-15
- **Owners:** Tasq K2 semantics and connector boundary
- **Implements:** TQ-201
- **Unlocks:** ADR-002 / TQ-202

> **Follow-up resolved:** `ADR-002_EFFECT_REQUEST_IDENTITY.md` is accepted and
> implements the canonical request/digest choices this threat model deferred.

## Executive decision

Tasq may coordinate an external write only by treating four facts as distinct:

1. a principal proposed one exact effect request;
2. an authority approved that exact request under bounded conditions;
3. a connector attempted to dispatch it while holding a current claim fence;
4. an authentic provider receipt or later observation established the outcome.

None implies another. In particular, approval is not execution, dispatch is not
success, a successful HTTP response is not commitment completion, and a task or
remote-runtime completion is not authority to touch a provider.

There is no general exactly-once guarantee across Tasq, a network and an
arbitrary provider. K2 instead requires:

- exactly-once acceptance of each immutable ledger transition;
- one stable idempotency identity for semantically identical dispatch retries;
- provider-enforced deduplication where the provider supports it;
- no blind retry while the provider outcome is unknown;
- reconciliation from authentic receipts or observations;
- a new authorized effect for compensation.

This document fixes the threat boundary and required defenses. ADR-002 must
still choose the canonical request bytes, digest and effect-identity algorithm
before any K2 schema is accepted.

## Scope

### Protected assets

- money, messages, signatures, deployments, files and any other external state;
- the user's intent, approval limits and revocations;
- provider credentials and signing keys;
- effect, approval, execution-attempt and receipt integrity;
- tenant/workspace isolation;
- the audit trail needed to explain who authorized and caused a write;
- the ability to stop a stale or compromised worker before provider dispatch.

### Trust boundaries

```text
untrusted input / model / remote runtime
                │ proposes, never authorizes by capability alone
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Tasq K2 ledger                                                   │
│ immutable request + digest + approval + execution state + audit  │
└──────────────────────────────────────────────────────────────────┘
          │ exact envelope, live authority, claim fence
          ▼
┌──────────────────────────────────────────────────────────────────┐
│ connector enforcement boundary                                  │
│ re-checks identity/scope/fence; resolves secret refs; dispatches │
└──────────────────────────────────────────────────────────────────┘
          │ authenticated provider request
          ▼
┌──────────────────────┐       ┌───────────────────────────────────┐
│ external provider    │──────▶│ receipt / observation verifier    │
│ independent state    │       │ authenticates, deduplicates, links│
└──────────────────────┘       └───────────────────────────────────┘
```

The kernel is trusted to enforce durable state invariants, but is not trusted
with provider credentials and never performs network I/O. The connector is
trusted with the least provider authority needed for its registered operation.
Provider state remains independent and may change out of band. A verifier can
raise provenance strength; it cannot infer business success from prose.

### Adversaries and failures

The design assumes any of the following can occur, including in combination:

- prompt injection or a compromised agent proposes malicious parameters;
- a legitimate worker is slow, stale, duplicated, restarted or partitioned;
- a caller replays, reorders or mutates requests and approvals;
- a connector is buggy or compromised within its credential scope;
- a network returns late, drops a response or times out after provider commit;
- a provider has weak, expiring or absent idempotency support;
- a webhook, receipt or observation is forged, replayed or delivered late;
- a local actor label is spoofed because attribution is mistaken for identity;
- concurrent approval, revocation, cancellation and dispatch race;
- the database or process crashes at every boundary between durable writes;
- a remote clock is skewed or the host clock changes.

### Out of scope for this milestone

TQ-201 does not claim to solve a fully compromised host, malicious provider,
stolen connector credential used outside Tasq, or irreversible provider bugs.
Remote subject authentication, key rotation and authority verification remain
gated by implementation of ADR-004 before effect-capable remote deployment. K2
must nevertheless preserve enough immutable evidence to detect and contain
those failures.

## Non-negotiable safety properties

| ID | Property |
|---|---|
| SP-01 | The durable effect request is immutable and secret-minimized. Any meaningful mutation creates a different digest and invalidates prior approval. |
| SP-02 | An approval is an immutable decision over one exact digest, approver identity, scope, limits and validity interval. Capability advertisement is never approval. |
| SP-03 | Dispatch requires a current approved decision and rejects denied, revoked, expired, wrong-scope and over-limit authority. |
| SP-04 | Dispatch requires the exact active claim ID and fencing token. A stale worker cannot pass the connector boundary even if it retains process or network access. |
| SP-05 | One effect identity has one stable provider idempotency identity. Reuse with different semantics is an integrity error. |
| SP-06 | A timeout after possible dispatch is `indeterminate`, never assumed failed. Retry requires proof of absence or safe reuse of provider-enforced idempotency. |
| SP-07 | `committed` requires an authentic receipt or explicitly classified observation linked to the effect and execution attempt. HTTP success alone is insufficient when the provider contract is asynchronous. |
| SP-08 | Approval, execution, receipt, evidence and commitment completion remain separate records and decisions. |
| SP-09 | Cancellation or revocation can prevent a dispatch that has not crossed the execution boundary; it cannot rewrite an already dispatched or committed effect. |
| SP-10 | Compensation is a new proposed and authorized effect related to the original. History is never rewritten to “never happened.” |
| SP-11 | Every authority and expiry check uses one injected-clock snapshot for the operation. No K2 production path may read a device, database or provider clock implicitly. |
| SP-12 | Workspace, connector, credential audience and provider account are bound and checked independently. IDs from another workspace or account never authorize a write. |

## Threat catalogue

`Prevent` means the request cannot cross the connector boundary. `Detect`
means immutable records make the condition explicit. `Recover` means the
system has a safe reconciliation or compensation path.

### Request identity and integrity

| Threat | Failure or attack | Required control | Disposition |
|---|---|---|---|
| E-01 | Change recipient, amount, body, path, environment or another meaningful field after approval. | Freeze a canonical typed request; bind approval to its versioned digest; reject any digest mismatch. | Prevent |
| E-02 | Exploit ambiguous JSON, duplicate keys, number coercion, Unicode, defaults or field order so approver and connector see different meaning. | Parse against the registered effect schema before canonicalization; reject duplicate/unknown/invalid values; define one versioned canonical form and golden vectors in ADR-002. | Prevent |
| E-03 | Reuse an idempotency key with changed parameters. | Bind idempotency identity to effect identity and digest; treat parameter mismatch as integrity failure, matching real provider behavior such as EC2 `IdempotentParameterMismatch`. | Prevent + detect |
| E-04 | Hide credentials, bearer tokens or mutable signed URLs in the approved request or audit trail. | Canonical request contains typed secret references only; connector resolves credentials after authorization; logs and receipts are secret-minimized. | Prevent |
| E-05 | Downgrade an effect schema, connector contract or digest algorithm to reinterpret approved bytes. | Pin effect type URI, schema version, canonicalization version, digest algorithm and connector contract in the immutable envelope. No silent downgrade. | Prevent |
| E-06 | Point an otherwise valid request at a different provider account, tenant or environment. | Bind workspace, connector registration, provider account/audience and environment into authority scope and enforcement input. | Prevent |

### Authority and confused-deputy threats

| Threat | Failure or attack | Required control | Disposition |
|---|---|---|---|
| A-01 | Treat `--actor`, a principal record, discovery capability or remote task ownership as permission. | Separate attribution, authenticated identity, capability and authority. Only a verifiable approval or explicit pre-authorized policy grant can authorize. | Prevent |
| A-02 | A proposer approves its own high-stakes effect or swaps approver identity. | Authority policy defines eligible approvers and separation-of-duty rules; verification binds the authenticated approver to the decision. Local attribution alone is insufficient. | Prevent |
| A-03 | Replay an old approval for a new effect. | Bind approval to exact effect ID and digest, workspace, scope and limits; immutable supersession chain; no bearer-style approval detached from its subject. | Prevent |
| A-04 | Dispatch after approval expiry. | Re-evaluate validity at the atomic execution boundary using the injected operation timestamp; approval earlier in the workflow is not enough. | Prevent |
| A-05 | Use approval for the wrong operation, connector, account, recipient, environment or amount. | Typed scope and limits are evaluated against canonical request fields by fail-closed policy. Unknown fields/operators are incompatible. | Prevent |
| A-06 | Race revocation or denial against dispatch (TOCTOU). | In one ledger transaction, load the latest effective decision, check time/scope/fence, and enter `executing`. A later revocation cannot claim to cancel crossed dispatch. | Prevent + detect |
| A-07 | Replay, reorder or fork approval supersession records. | Append-only decisions with expected revision and one non-branching supersession relation; conflicting histories fail integrity checks. | Prevent + detect |
| A-08 | A broad connector credential becomes a confused deputy for an unapproved operation. | Connector exposes registered operations, checks effect type and scope again, and uses least-privilege audience-bound credentials. No arbitrary URL/tool dispatch. | Prevent |
| A-09 | Key rotation or verification outage silently downgrades a signed approval to actor text. | Verification level and key ID are immutable. Unknown/revoked keys fail closed; any emergency manual override is a distinct audited authority decision. | Prevent + detect |

### Ownership, replay and concurrency

| Threat | Failure or attack | Required control | Disposition |
|---|---|---|---|
| C-01 | A lease expires and the stale worker dispatches after another worker takes over. | Require claim ID and monotonically increasing fence at connector enforcement; compare with current ledger state immediately before `executing`. | Prevent |
| C-02 | Two live processes race the same effect. | Effect revision/state transition and execution-attempt creation are transactional; only one process can cross `authorized → executing`. | Prevent |
| C-03 | Retry a proposal, approval, dispatch intent, receipt or reconciliation delivery. | Operation-specific idempotency keys with immutable-result comparison; identical replay returns the original, conflicting replay fails. | Prevent + detect |
| C-04 | Crash after ledger marks `executing` but before network send. | Recovery may prove non-dispatch from connector evidence and move to `failed`, or redispatch only with the same provider idempotency identity. Never mint a new identity automatically. | Recover |
| C-05 | Crash after provider commit but before local receipt persistence. | Remain `executing`/`indeterminate`; query by provider idempotency/external operation ID or ingest later authentic observation. Do not blind retry. | Recover |
| C-06 | Cancellation races a dispatch. | Cancellation is legal only before the execution boundary wins. Once `executing`, expose uncertainty and use reconciliation/compensation. | Prevent + recover |
| C-07 | Cross-workspace IDOR links a claim, approval, attempt or receipt to another effect. | Every lookup and foreign relation is workspace-scoped; database guards and service checks reject mixed-workspace graphs. | Prevent |

### Provider and network uncertainty

| Threat | Failure or attack | Required control | Disposition |
|---|---|---|---|
| P-01 | Network timeout is interpreted as provider failure and retried, duplicating money/message/delete. | Transition to `indeterminate` whenever dispatch may have occurred. Retry only after proof of absence or with retained provider idempotency support. | Prevent + recover |
| P-02 | Provider accepts synchronously but completes asynchronously, partially, or later rejects. | Connector contract classifies acknowledgment versus terminal receipt and supplies a reconciliation operation. `committed` follows the registered terminal semantics. | Detect + recover |
| P-03 | Provider does not support durable idempotency, or expires keys before Tasq retry retention. | Register support level and retry horizon. High-impact non-idempotent operations require lookup-before-write, unique provider resource identity, or manual resolution; otherwise refuse autonomous execution. | Prevent |
| P-04 | Redirect, DNS/config mix-up or audience confusion sends credentials/request to the wrong endpoint. | Connector allowlists provider origins, validates TLS, forbids credential-bearing redirects and binds tokens to audience/resource where supported. | Prevent |
| P-05 | Provider applies a different normalized request than Tasq approved. | Receipt stores provider operation ID plus a secret-minimized normalized result/digest. Connector detects semantically relevant mismatch and marks it for manual resolution. | Detect |
| P-06 | Provider state changes out of band after commit. | Preserve the committed historical receipt; ingest the later fact separately. Never mutate the original effect outcome to match current state. | Detect |

### Receipt, webhook and observation threats

| Threat | Failure or attack | Required control | Disposition |
|---|---|---|---|
| R-01 | Forge a receipt or webhook that marks an effect committed. | Verify provider signature/MAC or authenticated lookup response over sufficient message fields; record verification method/key ID. Weak assertions cannot satisfy high-stakes receipt policy. | Prevent |
| R-02 | Replay a previously valid signed webhook. | Deduplicate stable delivery/operation identity and content digest; enforce provider timestamp/nonce policy where available without replacing durable identity checks. | Prevent |
| R-03 | Valid signature covers too little content, allowing effect ID, status or account substitution. | Connector defines required signed components and parses the original bytes before transformation. Reject insufficient coverage. | Prevent |
| R-04 | Signature validates under the wrong provider account, endpoint or rotated key. | Bind verification key, issuer, audience/account and connector instance; key rotation never widens acceptable identity. | Prevent |
| R-05 | Delivery timestamp, source `occurredAt` or provider clock is used to resurrect expired authority. | Authority uses only the injected ledger operation time. Source time is provenance and matcher input, never an authorization clock. | Prevent |
| R-06 | A valid provider receipt is treated as proof the larger commitment succeeded. | Receipt may create evidence, but completion policy independently accepts evidence and appends a completion record. | Prevent |
| R-07 | Raw receipt leaks secrets or mutable remote content changes behind a URL. | Store secret-minimized fields plus content digest, immutable raw reference and verification metadata; access to raw material is separately authorized. | Prevent + detect |

### Time, operations and audit threats

| Threat | Failure or attack | Required control | Disposition |
|---|---|---|---|
| O-01 | Raw device, database or provider time makes expiry nondeterministic or test-dependent. | Inject `Clock`; capture one `now` per operation; ban `Date.now`, zero-argument `Date`, performance clocks and SQL time defaults outside the sole adapter. | Prevent |
| O-02 | Time moves backward/forward between checks inside one operation. | Reuse the operation snapshot for approval, lease, receipt and audit timestamps. Later operations may observe a different injected time explicitly. | Prevent |
| O-03 | Audit says an actor caused an effect but cannot prove identity or authority. | Preserve actor attribution separately from authenticated principal, approval verification and connector identity. The authority trail must contain all three when applicable. | Detect |
| O-04 | Database tampering rewrites immutable request, approval, receipt or terminal outcome. | Service immutability, defensive SQL triggers, migration checksums and `doctor` integrity checks; future remote/high-stakes deployments may add signed attestations but cannot depend on prose logs. | Prevent + detect |
| O-05 | Observability or error logs expose canonical payload secrets, tokens or signature material. | Structured allowlisted audit payloads, secret references, bounded summaries and explicit redaction tests. | Prevent |
| O-06 | An operator retries an `indeterminate` effect under pressure with a fresh ID. | Surface a hard typed state and resolution procedure; creating a semantically equivalent second effect requires explicit authority acknowledging duplicate risk. | Prevent + detect |

## Required K2 control sequence

The only accepted path to an external write is:

```text
1. parse registered effect schema
2. canonicalize and freeze secret-minimized request
3. derive effect digest + stable idempotency identity
4. append immutable approval decision over exact digest
5. atomically re-check latest approval + scope + limits + injected time
6. atomically re-check claim ID/fence + effect revision, enter executing
7. connector re-checks envelope and resolves least-privilege secret refs
8. dispatch once, reusing the same provider idempotency identity on safe retry
9. persist authentic receipt or mark indeterminate
10. reconcile provider outcome; optionally derive evidence
11. completion policy independently decides the commitment
```

Steps 5 and 6 are one ledger transaction. Step 7 is a second fail-closed check
at the network boundary, not a replacement for the ledger decision. No caller
may invoke step 8 with a free-form tool request or reconstruct approved
parameters from prose.

## Time contract

All K2 APIs receive a service context containing `Clock { now(): number }` or
an explicit operation timestamp captured from that clock. A mutation captures
one unix-millisecond value and uses it for:

- approval validity and revocation ordering;
- claim/lease validity;
- effect transition and execution-attempt timestamps;
- receipt recording and audit events;
- deterministic UUID generation where applicable.

Explicit provider/source timestamps such as `occurredAt` remain immutable
domain inputs. They never replace the injected operation time for authority.
Signature verification may compare provider `created`/`expires` metadata with
the same injected snapshot under connector policy. Tests can therefore freeze,
advance or reverse simulated time without touching the host clock.

## Failure semantics

| Observation at boundary | Safe ledger result | Automatic retry? |
|---|---|---|
| Validation, authority, scope, limit or fence fails before dispatch | remain `proposed` or enter `cancelled`; append denial/failure audit | No |
| Connector proves request was never sent/applied | `failed` with evidence | Only as a new authorized execution policy permits, retaining identity rules |
| Network fails before the connector can prove whether send occurred | `indeterminate` | No blind retry |
| Provider idempotency lookup returns the original operation | `committed`, `failed` or still `indeterminate` from authentic provider state | Re-query only |
| Same idempotency identity with changed parameters | integrity error | Never |
| Provider reports terminal success with required verification | `committed` plus receipt | No |
| Provider reports terminal failure and proves no effect occurred | `failed` plus receipt | No |
| Provider performed an unwanted committed effect | original remains `committed`; propose compensation | Compensation needs new authority |

## TQ-208 adversarial acceptance vectors

Implementation is not complete until black-box tests prove at least these
vectors against one generic K2 service and connector enforcement contract:

1. **Money:** approve EUR 58.00, mutate to EUR 5,800.00, recipient or account;
   every mutation changes the digest and cannot dispatch. Duplicate delivery
   with the original identity yields one provider operation.
2. **Important communication:** approve an exact recipient/subject/body and
   attachment digests; injected headers, BCC, changed attachment or stale fence
   are rejected. A timeout becomes `indeterminate` and lookup reconciles it.
3. **Destructive filesystem:** approve one normalized root-contained path and
   operation; traversal, symlink swap, wrong root and stale claim fail at the
   connector boundary. Compensation is not falsely advertised as resurrection.
4. **Deployment:** approval scoped to immutable artifact digest and environment
   cannot be replayed for another image, account or environment.
5. **Approval races:** expiry, denial and revocation at controlled-clock
   boundaries are deterministic; exactly one of dispatch or pre-dispatch
   cancellation wins.
6. **Crash matrix:** kill before intent, after `executing`, after provider
   commit and after receipt; restart never creates a second provider effect.
7. **Receipt attacks:** forged, replayed, wrong-account, insufficiently covered
   and weak-verification receipts cannot commit a protected effect.
8. **Isolation:** cross-workspace approval, claim, effect and receipt IDs are
   rejected even when all records otherwise exist.
9. **Clock purity:** the complete suite passes with a controlled clock and the
   production-source architecture scan finds no ambient clock access.

## Residual risk and deployment policy

- A connector compromised with a broad credential can act outside Tasq. Use
  provider-side least privilege, spending limits, recipient allowlists and
  independent alerts; K2 reduces authority but is not a hardware security
  boundary.
- Some providers cannot prove non-execution after timeout. Such effects may
  remain `indeterminate` indefinitely and require a human decision.
- Provider idempotency retention may be shorter than Tasq audit retention. The
  connector contract must publish its safe retry horizon and refuse autonomous
  retry after it.
- Revocation cannot recall a request already accepted by a provider.
- A valid receipt proves only what its issuer and signed fields assert.
- Local actor strings are not authentication. Until ADR-004 is implemented,
  effect-capable remote deployment is prohibited.

Failing closed is intentional. A blocked money transfer is recoverable; an
unauthorized or duplicated transfer may not be.

## Standards and provider evidence

This threat model adopts, without pretending they create end-to-end
exactly-once delivery:

- [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
  for the limits on retrying non-idempotent requests after connection failure;
- [AWS EC2 idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)
  and [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
  as provider contracts that bind one key to one parameter set;
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) for token replay
  prevention, audience restriction and current OAuth threat guidance;
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) for signed-component
  coverage, nonce, creation/expiry metadata and signature replay hazards;
- [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
  and [Stripe webhook guidance](https://docs.stripe.com/webhooks) as concrete
  evidence that signature verification and replay controls are separate;
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) as input to ADR-002's
  canonical JSON decision, including its I-JSON constraints and verified
  negative-zero erratum. TQ-201 does not preselect it.

## Exit criteria

TQ-201 is complete because this document:

- identifies assets, trust boundaries, attackers and combined failure modes;
- covers stale fences, replay, post-approval mutation, confused deputies,
  provider uncertainty and forged receipts;
- freezes the twelve safety properties and fail-closed control sequence;
- makes injected time a normative authority dependency;
- supplies the adversarial vectors that TQ-208 must execute;
- leaves canonicalization and identity choices explicitly to ADR-002.
