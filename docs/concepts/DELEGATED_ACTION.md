# Delegated action model

**Status:** accepted direction; no new Kernel primitive is admitted by this
document

**Updated:** 2026-08-10

**Language:** [`CONTEXT.md`](CONTEXT.md)

**Kernel admission rules:**
[`COMMITMENT_DIMENSIONS.md`](COMMITMENT_DIMENSIONS.md)

**Execution backlog:** [`../roadmap/BACKLOG.md`](../roadmap/BACKLOG.md)

## 1. Decision

Tasq will treat consequential work performed by another human, agent, service
or runtime as a **delegated action composition**, not as a special task kind.

The composition answers:

```text
Who wants an outcome?
Who may request or approve action on their behalf?
What external thing is the action about?
What exact outcome and evidence are required?
Who may accept responsibility under which exact terms?
What execution occurred?
Who decided whether the outcome was satisfied?
What settlement and recourse follow?
Did possession of a scarce thing change?
```

Physical work is the strongest initial stress test because travel, access,
possession, injury, no-shows, partial performance and irreversible actions make
coordination failures visible. The model must nevertheless pass unrelated
software, procurement and operations scenarios before any concept enters the
universal Kernel.

This direction explicitly rejects three shortcuts:

1. adding physical-work, provider, price or location fields to `commitment`;
2. treating an accepted `assignment` as agreement to arbitrary commercial
   terms or as authority for an external effect;
3. creating a `fulfill` adapter that owns a second commitment, authority or
   completion truth.

## 2. First-principles decomposition

A delegated action is a composition of independent facts:

```text
Delegated action
  = principal intent
  + mandate
  + target reference
  + outcome contract
  + executor eligibility
  + agreement
  + execution attempts
  + observations and evidence
  + resolution
  + settlement
  + recourse
  + custody, when possession changes
```

No single record owns that equation. The value of Tasq is preserving each fact
under the authority, lifecycle and concurrency rules that actually apply to
it, then exposing deep journeys that compose them safely.

### 2.1 Obligation

The obligation is the outcome that remains owed. It is represented by a
`commitment` and a frozen `resolution contract` when independent validation is
required.

Execution effort, provider acceptance, an uploaded artifact or a successful
tool call does not satisfy the obligation by itself.

### 2.2 Authority

Authority answers whether a principal or delegated actor may propose, approve
or dispatch an exact action over an exact scope at an authority time.

Server grants, delegations, action identities, eligibility and effect
approvals already own these facts. A human-readable mandate must compile to
that authority rather than compete with it.

### 2.3 Target

The target is the external thing whose state is observed or changed: a
building, server, parcel, account, deployment, document or device.

Tasq currently has several partial identities: `external_ref`, condition and
observation `subject_refs`, authority `ResourceRef`, and opaque resource lease
keys. TQ-622 must decide one portable target-reference contract and explicit
bindings without turning Tasq into a catalog of domain objects.

### 2.4 Eligibility

Eligibility answers whether a principal satisfies purpose-specific
requirements at an evaluation time. Examples include a valid licence,
insurance, training, provider verification or site access.

Eligibility does not imply assignment, availability, authority or successful
performance. It is derived from current attestations under a policy.

### 2.5 Agreement

An agreement records that named parties accepted the same immutable terms.
Those terms may create reciprocal commitments, resolution policies and future
effects.

An assignment records responsibility for a commitment. Its acceptance must
remain independent from agreement to price, cancellation, show-up, rework,
confidentiality or settlement terms.

### 2.6 Execution

A runtime or provider owns scheduling, dispatch, checkpoints, timers and
retries. Tasq records assignments, claims, attempts, effects and receipts so a
replacement process can resume without inventing another obligation truth.

### 2.7 Observation and resolution

Artifacts and observations are external facts. Evidence binds exact facts to
success criteria. A validation decision applies a frozen resolution policy.
Only an explicit completion transition records that the obligation was
satisfied.

### 2.8 Settlement and recourse

Settlement decides what reciprocal obligations become due after resolution or
another agreed event. Recourse is the graph of follow-up commitments or
effects created by delay, breach, cancellation, rejected evidence or an
indeterminate external result.

Settlement is distinct from completion and payment dispatch:

```text
resolution decision
  -> settlement decision
  -> payment or credit effect approval
  -> effect dispatch
  -> provider receipt
```

### 2.9 Custody

Custody records durable possession or control of a target. It is not a resource
lease: a lease expires, while physical possession does not vanish at a TTL.

Custody requires separate admission work because a safe handoff may need a
single-current-custodian invariant, monotone lineage, dual acceptance,
condition evidence and fencing against concurrent transfers.

## 3. Existing coverage and gaps

| Question | Current canonical record | Gap or next layer |
|---|---|---|
| What outcome is owed? | commitment | none for delegated action |
| What proves satisfaction? | resolution contract, evidence, completion proposal and decision | capture and outcome-bundle journeys |
| Who is responsible? | assignment | exact accepted terms are not bound |
| Who may work now? | claim + fence | deep claim-and-start journey |
| What ran? | attempt | TQ-629 reference runtime exists; production runtimes and provider adapters remain external |
| What was produced? | artifact | not exposed by the current high-level embedded Interface |
| What external action is proposed? | effect | not exposed by the current high-level embedded Interface |
| Who authorized dispatch? | grant, delegation, eligibility, approval and permit | mandate Interface and remote-effect gate |
| What happened at the provider? | effect receipt or observation | TQ-629 reference lookup/reconciliation; production provider composition remains external |
| What outside thing is involved? | external reference, resource key, subject refs | one target-reference contract and binding semantics |
| Is an executor qualified? | narrow authority eligibility and task-scoped trust | general attestation Module |
| Did all parties accept exact terms? | assignment acceptance plus signed-statement building blocks | agreement Module and typed binder |
| What becomes payable or refundable? | effects can dispatch a decision already made | settlement Module |
| What remedy follows failure? | commitments, conditions and compensation effects can represent it | recourse policy and runtime materialization |
| Who possesses an asset? | private experimental custody lineage | no Kernel, remote or physical-truth claim |
| Can another party verify the whole outcome? | commitment inspection and workspace checkpoints | portable content-addressed outcome bundle |

The signed-purpose extension seam is now completed by TQ-624 and
[`ADR-012`](../decisions/ADR-012_TRUSTED_STATEMENT_BINDER_REGISTRY.md): Modules
register trusted code against portable, versioned binder descriptors. The
ledger freezes which implementation interpreted a statement but never loads
code from workspace data. Agreement, attestation, mandate and custody remain
separate domain work; they no longer require a central signed-binding enum.

## 4. Primitive admission decisions

Every candidate below is evaluated against the six rules in
[`COMMITMENT_DIMENSIONS.md`](COMMITMENT_DIMENSIONS.md): cross-domain failure,
non-reconstructible invariants, independent lifecycle, non-derivability,
stable meaning and one transactional write path.

### 4.1 Mandate — Module view, not a second authority record

A mandate is important but derivable from existing grants, delegations,
permission sets, scopes and approvals. Making another authoritative record
would permit disagreement about whether an action is allowed.

Decision:

- create a deep Mandates Module;
- compile readable intent into existing authority records;
- inspect the effective intersection and reason for denial;
- preserve immediate revocation through the existing guard;
- do not add a generic `mandate` table to Core.

### 4.2 Target reference — foundational value and binding candidate

Target identity recurs across conditions, observations, authority, resource
coordination, effects and external references. Identity fragmentation can
authorize or validate one object while acting on another.

Decision, completed by TQ-622 and
[`ADR-011`](../decisions/ADR-011_TARGET_REFERENCE_AND_BINDINGS.md):

- use a provider-neutral structured value with optional version/content digest
  and explicit plain or workspace-HMAC identifier form;
- derive opaque authority, lease, observation and signed-statement bindings
  from one domain-separated canonical digest;
- retain the secret-minimized external identifier only in the `external_ref`
  identity binding;
- keep the target reference as a schema value contract, with no new Kernel
  record or storage migration.

### 4.3 Agreement — shared Module, not commitment fields

Exact mutual assent has an independent lifecycle and audit requirement, but
the resulting obligations are already expressible as reciprocal commitments,
resolution contracts and effects. Jurisdiction-specific legal semantics must
not enter the Kernel.

Decision:

- implement offer, acceptance, withdrawal, expiry and superseding amendment in
  an Agreements Module;
- bind each acceptance to the exact canonical terms digest;
- compile accepted terms to reciprocal commitment/effect graphs transactionally;
- do not add price, currency or cancellation fields to `commitment`.

### 4.4 Attestation — shared trust Module

A purpose-scoped assertion about a principal or target has independent
identity, validity, issuer, scope and revocation. Task-scoped evidence trust and
effect-approver eligibility cannot safely stand in for general qualifications.

Decision:

- add an Attestations Module after extensible statement binders exist;
- distinguish an attestation from the policy decision that it is sufficient;
- make current-at-time queries and append-only revocation first class;
- never infer authority, availability or truth from a signature alone.

### 4.5 Settlement — shared Module above effects

Settlement policy is replaceable and may be commercial, organizational or
jurisdiction-specific. The resulting decision and external effect still need
durable identity, replay safety and audit.

Decision:

- keep settlement policy replaceable above the universal completion model;
- persist its versioned decision and exact input digest in the Module;
- compile entitlements to reciprocal commitments or proposed effects;
- never describe a payment connector as escrow without the corresponding
  legal and funds-flow role.

### 4.6 Custody — experimental first-class Module

Custody cannot be reconstructed safely from an expiring lease or uncoordinated
photos. TQ-631 passes the repository cross-domain Module test, but not the
stronger distributed admission test for a future universal primitive.

Decision:

- keep it behind an experimental Module Interface and separate store contract;
- elect one accepted successor transactionally while permitting refusal and
  append-only incidents;
- use signed observations as evidence, never as successor election;
- record the TQ-631 graduation to shared experimental Module in ADR-017;
- require authenticated replication and wider evidence for any later Kernel
  admission decision.

### 4.7 Concepts that remain policy, Profile or Adapter concerns

The following do not enter the Kernel:

- bids, quotes, price discovery and provider routing;
- geospatial search, travel estimation and local supply density;
- calendars, appointment presentation and time zones;
- provider credentials, webhooks and provider-specific statuses;
- insurance products and jurisdiction-specific employment classification;
- worker reputation and capability ranking;
- domain reason codes such as `no_access`, `store_closed` or `parking_problem`;
- marketplace take rates, escrow marketing and managed-service positioning.

They may produce typed records and decisions through Modules, Profiles,
Extensions, Connectors, Runtimes and Surfaces.

## 5. Target Module architecture

```text
Domain Profiles
  physical verification · remote hands · deployments · procurement · logistics

Delegated-action Modules
  Agreements · Attestations · Mandates · Settlement · Custody · Outcome Bundles

Operational Modules
  Runner · Evidence Capture · Review Inbox · Connector Router

Authority Modules
  Principals · Grants · Delegations · Credentials · Effect approval

Tasq Kernel
  Commitments · Relations · Assignments · Claims · Attempts
  Artifacts · Evidence · Resolution · Effects · Resource leases

Durability
  Revisions · Fences · Idempotency · Events · Digests · Replication
```

Each Module must earn Depth: its Interface hides transactional ordering,
revision checks, fencing, exact retry, audit and policy plumbing. A shallow
pass-through that merely renames every underlying mutation is not an accepted
journey Module.

### 5.1 Mandates Module

Minimum Interface intent:

```text
issue(intent) -> effective mandate
inspect(id, action, target, at) -> allow or typed denial with basis
revoke(id, expected_revision) -> revoked mandate view
```

The Implementation owns compilation to grants/delegations and never bypasses
the live Server guard.

### 5.2 Attestations Module

Minimum Interface intent:

```text
issue(exact claim, issuer proof) -> attestation
revoke(attestation, reason, expected_revision) -> revocation record
evaluate(requirements, subjects, at) -> eligibility decision with basis
```

The evaluation result is policy output. It is not a timeless `qualified=true`
flag.

### 5.3 Agreements Module

Minimum Interface intent:

```text
offer(terms) -> offer digest and expiry
accept(offer, party proof) -> pending or effective agreement
withdraw(offer, expected_revision) -> terminal offer
amend(agreement, replacement terms) -> new offer linked by supersession
inspect(id) -> terms, acceptances and compiled obligations
```

No caller coordinates the reciprocal commitment graph manually.

### 5.4 Settlement Module

Minimum Interface intent:

```text
settlement.evaluate(agreement, resolution and complete attempt facts) -> decision + new obligations
recourse.evaluate(prior decision and complete effect facts) -> decision + new obligations/compensation proposals
settlement.get(id) -> immutable basis, policy, classification and materializations
```

Settlement never changes the historical completion decision it consumed.

### 5.5 Custody Module

Minimum Interface intent:

```text
offer_handoff(target, from, to, condition) -> pending handoff
accept_handoff(handoff, recipient proof) -> new current custodian
refuse_handoff(handoff, reason) -> terminal refusal
report_incident(target, state, evidence) -> immutable incident record
current(target, at) -> custodian and complete lineage
```

The TQ-631 implementation prevents two accepted successors from the same
current custody state with a transactional successor uniqueness constraint.
It exports exact portable lineage but does not implement multi-writer merge.

### 5.6 Runner and operations Modules

The reference Runner owns:

- timers, retries and recovery;
- outbox consumption and event cursors;
- connector dispatch through exact permits and fences;
- provider lookup before retrying indeterminate effects;
- deterministic materialization of recourse commitments.

TQ-629 implements this as a private replaceable composition. It consumes the
durable Core outbox, requires a live fence callback at the connector mutation
boundary, reconstructs the exact permit after restart, uses provider lookup for
every persisted executing/indeterminate effect, and delegates exactly-once
materialization to Core's idempotency and decision-root constraints. It adds no
runtime row, credential store or provider status to Core.

The Review Inbox projects, without creating another source of truth:

- unaccepted assignments or agreements;
- missing or expired eligibility;
- input-required and no-progress attempts;
- submitted, challenged or ambiguous evidence;
- indeterminate effects;
- settlement and custody disputes;
- overdue recourse and redispatch.

## 6. Deep journeys

The high-level embedded Interface now exposes the existing assignments,
artifacts, external references and effects. TQ-623 also adds atomic
`claimAndStart` and `submitOutcome` journeys over those same records; the
remaining journeys below depend on later Modules.

Target journeys include:

```text
delegate
  -> create/freeze outcome
  -> propose assignment or agreement
  -> bind target and authority context

accept-and-start
  -> verify exact terms and eligibility
  -> accept responsibility
  -> acquire claim/fence
  -> start attempt

submit-outcome
  -> append artifacts
  -> capture provenance and evidence
  -> close attempt
  -> create completion proposal

resolve-and-settle
  -> validate or adjudicate
  -> complete only when allowed
  -> evaluate settlement
  -> authorize exact effects

recover
  -> inspect current revisions and cursor
  -> reconcile external outcomes
  -> reclaim with a higher fence
  -> materialize recourse without duplicate effects
```

Simple users retain `add -> list -> done`. Delegated-action concepts appear
only when the selected journey needs them.

## 7. Adversarial conformance scenarios

No implementation may claim general delegated-action support until the same
Module Interfaces pass all scenarios without provider-specific Kernel changes.

### 7.1 Physical verification

An agent, acting under a bounded mandate, requests exterior photographs of a
property. The executor accepts exact terms. Access is denied after travel and
the agreement defines a show-up settlement.

Required failures and observations:

- stale or recycled photographs do not satisfy freshness/provenance rules;
- absence of access authority stops the action without punitive completion;
- no-access evidence may satisfy a different criterion without satisfying the
  primary inspection commitment;
- a show-up settlement does not forge primary completion;
- a replacement provider cannot reuse the first provider's fence.

### 7.2 Remote hands

An authorized agent requests a power cycle on one exact rack device. The
technician has facility access but the provider response times out. Later
telemetry shows the device restarted.

Required failures and observations:

- spend authority does not imply rack access;
- a provider timeout becomes `indeterminate`, not automatic failure or retry;
- telemetry may reconcile the effect without proving the larger service-health
  commitment;
- a second power cycle requires safe provider lookup or a new authorization.

### 7.3 Software deployment

An agent accepts an agreement to deploy an immutable release and establish
health. Deployment succeeds but the health condition fails.

Required failures and observations:

- agreement acceptance is not effect approval;
- attempt success and deployment receipt do not complete the outcome;
- rollback is a compensation effect and investigation is a new commitment;
- settlement policy can distinguish execution effort from satisfied outcome.

### 7.4 Procurement

An agent may purchase approved equipment under a budget mandate. The seller
substitutes another model and requests a scope change.

Required failures and observations:

- target/version drift invalidates the original authorization;
- a new quote or amendment does not mutate accepted terms;
- budget headroom alone cannot approve an unqualified target;
- receipt, delivery and acceptance remain separate facts.

### 7.5 Custody transfer

An asset passes from seller to courier to warehouse to recipient. Damage is
reported after the warehouse handoff.

Required failures and observations:

- one source custody state cannot produce two accepted successors;
- transfer acceptance binds the target, parties, condition and evidence;
- an incident does not rewrite prior custody;
- liability policy is outside the custody lineage.

### 7.6 Compromised agent

A credentialed agent attempts to order an unauthorized site visit and then
submits a signed statement claiming approval.

Required failures and observations:

- a valid signature cannot widen a grant or mandate;
- assignment, agreement and qualification cannot substitute for authorization;
- denial opens no foreign workspace or provider route;
- audit records the typed reason without leaking secret target data.

## 8. Outcome bundle

A delegated action needs a portable result that another principal can inspect
without trusting a screenshot or a mutable provider page.

An outcome bundle is a content-addressed projection, not a second state model.
It should bind:

- commitment identity and frozen revision/criteria;
- target references;
- agreement terms and party acceptances when applicable;
- attempts, artifacts and evidence digests;
- trust, challenges, validation and completion records;
- settlement decisions, effects and receipts;
- relevant attestations and authority decision references;
- custody handoffs when applicable;
- generation time, event cursor and omitted-data disclosure.

A signed outcome bundle authenticates exact bytes and signer only. It does not
replace the records, prove truth or grant authority.

## 9. Privacy and safety constraints

- Target references and route keys must be secret-minimized and workspace
  scoped where disclosure creates risk.
- Raw photos, documents, credentials and provider payloads remain outside the
  ledger; Tasq stores bounded references and digests.
- Evidence capture must support redaction, retention and deletion policy
  without pretending append-only audit can erase external copies.
- A worker or runtime must be able to stop safely and record an externally
  impossible attempt without fabricating success.
- High-impact actions require an accountable principal and bounded mandate;
  an autonomous agent is not its own source of authority.
- Remote effects remain disabled until TQ-906's independent gate passes.

## 10. Explicit non-goals

This direction does not make Tasq:

- a human-labor marketplace;
- a geospatial worker search engine;
- an employer, vendor of record or merchant of record;
- a payment processor or escrow provider;
- a workflow runtime;
- an identity-document verification provider;
- an insurance product;
- a warehouse or last-mile network;
- the owner of provider credentials or raw evidence bodies.

Products such as fulfill.run may compose these concerns with Tasq. They do not
move them into the universal Kernel.

## 11. Roadmap and graduation rule

TQ-622 through TQ-632 in [`BACKLOG.md`](../roadmap/BACKLOG.md) implement this
direction in increasing order of commitment:

1. freeze target identity and conformance cases;
2. **done (TQ-623):** expose existing records plus atomic claim/start and
   submit-outcome journeys;
3. **done (TQ-624):** make signed-statement binders safely extensible;
4. **done (TQ-625–TQ-626):** add Attestations and Mandates;
5. **done (TQ-627–TQ-628):** add Agreements and Settlement/Recourse;
6. **done (TQ-629–TQ-630):** build the reference Runner, Evidence Capture,
   Review Inbox and Outcome Bundle;
7. prototype Custody behind an experimental Interface;
8. pass the cross-domain delegated-action certification.

No item may claim a new Kernel primitive merely because this document names
it. Graduation still requires the six admission rules, a second unrelated
domain, hostile concurrency tests, portable-data behavior and an explicit
decision updating the normative Kernel contract.
