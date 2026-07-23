# TQ-612 — independent completion resolution

**Status:** source candidate implemented and locally certified  
**Decision:** [ADR-005](../decisions/ADR-005_EVIDENCE_TRUST_AND_RESOLUTION.md)  
**Machine evidence:** [TQ-612 certification](TQ-612_COMPLETION_RESOLUTION_CERTIFICATION.json)

## Outcome

Tasq no longer has to treat attached evidence and the decision to complete as
the same act. A commitment can opt into `validationRequired` while retaining
the existing simple assertion/evidence modes for ordinary work.

The validated path is:

```text
commitment
  → frozen resolution contract
  → evidence + explicit trust record
  → completion proposal
  → optional challenge
  → validation decision
  → completion record
```

Only a current `accepted` decision can finalize a validated commitment.
Attempt success, evidence attachment, a proposal, or a challenge never changes
commitment status by itself.

## Implemented records

All resolution records are workspace-scoped, append-only and visible in
canonical inspection and Local Console detail:

- `resolution_contract` freezes success criteria, criterion/evidence rules,
  policy URI, version and implementation digest;
- `evidence_trust_record` distinguishes `unverified`,
  `authenticated_principal`, `authenticated_source` and `provider_verified`,
  with explicit revocation, validity and retention;
- `completion_proposal` binds every frozen criterion to exact evidence IDs;
- `completion_challenge` records a reasoned dispute without overwriting the
  proposal;
- `validation_decision` records `accepted`, `rejected`, `too_early`,
  `indeterminate` or `challenged`, including exact evidence/trust inputs;
- `completion_record` links the accepted decision and contract that authorized
  the final transition.

SQLite constraints and triggers preserve cross-workspace identity,
single-successor chains and immutability. `tasq doctor` independently audits
the complete graph.

## Policy shapes

| Policy | Resolution owner | Implemented behavior |
|---|---|---|
| Deterministic | Exact embedded evaluator identity | Fails closed on URI, version, implementation digest, criteria, source, freshness, retention or trust drift |
| Attestation | Eligible named principal | Rejects an ineligible principal and self-validation unless the frozen contract explicitly permits it |
| Optimistic | Injected clock plus challenge records | Returns `too_early` before the window, `accepted` without a dispute, and `challenged` when adjudication is required |
| Adjudicated | Eligible named adjudicator | Appends a decision; optimistic disputes must supersede the current challenged leaf |

Economic bonds, staking and prediction-market incentives remain outside the
kernel.

## Surfaces

- Core exports every primitive and advertises the
  `completion-resolution` discovery capability.
- `createLocalTasq(...).resolution` binds the same API for embedded Node/Bun
  applications; separate actors open separate clients over the same ledger.
- CLI exposes `tasq resolution ...`, `tasq add --validated` and
  `tasq done --decision <id>`.
- capability-scoped local MCP exposes read, contract, trust, proposal,
  challenge, attestation, settlement and adjudication tools.
- canonical JSON inspection and the read-only Local Console render the entire
  chain.

CLI and local MCP can record only `unverified` local attribution. Higher trust
classes require a host-supplied `EvidenceTrustAuthority` through Core; prose,
actor labels and client parameters cannot upgrade authenticity.

## Data safety and compatibility

Migration `0026_completion_resolution.sql` advances the source store format to
26. Existing commitments remain non-validated by default. Verified
pre-migration snapshots and receipts use the existing TQ-608 path.

Backup preserves the complete database. Portable workspace export/import now
includes all resolution records and is exercised after a disputed completion.
Replication deliberately rejects `validationRequired` commitment mutations
until the authority protocol includes the append-only resolution chain; it
does not silently replicate an incomplete completion basis.

Decision mutations use caller-scoped durable idempotency. An exact retry
returns the already committed decision even after the commitment has since
become terminal.

## Certification

The executable evidence covers:

- independent attestation and self-validation rejection;
- deterministic evaluator identity, criteria, source, freshness, trust
  revocation and retention failure;
- optimistic `too_early`, timely challenge, `challenged` and named
  adjudication;
- stale decision/supersession rejection and lost-response replay;
- CLI, local MCP, embedded client, inspection, Console, doctor and portable
  import/export;
- the complete repository test suite.

The source candidate is not a published package claim until a protected tag
release and downloaded-byte certification bind these changes to immutable
artifacts.
