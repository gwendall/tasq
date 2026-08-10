# TQ-630 — Evidence Capture and Outcome Bundle Modules

> **Status:** source implemented and repository certified; private Modules,
> not a hosted evidence store, identity service or proof-of-truth claim

## Boundary

Evidence capture is an I/O workflow around existing Core records:

```text
frozen session
  -> exact bytes
  -> content digest
  -> immutable object-store acknowledgement
  -> one Core transaction: Artifact + Evidence
```

The session freezes the workspace, commitment revision, attempt, target digest,
resolution contract, criterion, source, accepted media types, byte ceiling and
expiry before capture. Finalization computes the digest itself and rejects a
store acknowledgement whose digest or byte length differs. Core then re-reads
the commitment, attempt, resolution contract and criterion inside the same
transaction that appends the Artifact and Evidence. A stale or cross-task
binding fails without a partial ledger write.

Upload/session progress is operational state owned by the Module or object
store. It is not a new Core table. An upload that succeeds before a later
ledger rejection may be an unreferenced object for the store's retention
policy to collect; it is never presented as recorded Tasq evidence.

## Disclosure contract

Every finalized manifest binds:

- exact stored byte digest, byte length, media type and immutable URI;
- source observation time, capture session and finalization time;
- exact attempt, target, commitment revision, resolution contract and
  criterion;
- each applied redaction and its scope/reason;
- original-byte disposition;
- retention policy and date;
- deletion policy, status and effective date.

These fields disclose policy and reported state. An append-only Tasq record
does not claim it can erase an external copy or independently enforce an
object-store policy.

## Outcome bundle

An outcome bundle is a deterministic content-addressed projection, not a
second state model. It embeds exact canonical bodies and per-record digests for
the commitment, agreement when compiled, assignments, attempts, artifacts,
evidence, resolution chain, effects, approvals, receipts and completion. It
also exports external authority, custody and raw-byte references, or requires
an explicit omission for each category.

Freshness verification re-reads Core and reports separately:

- `invalid` when the bundle's own digest is wrong;
- `stale` when a referenced record still exists with different exact bytes;
- `missing` when a referenced record cannot be read;
- `current` when every included Core record still matches.

New append-only records created after export do not retroactively invalidate
the historical packet. Callers choose whether their decision requires a newer
generation time.

## Signature assurance

`signOutcomeBundle` signs the canonical serialized bundle bytes. The envelope
states `signature_authenticates_exact_bundle_bytes_not_real_world_truth`.
Verification proves only possession of the selected signing key over those
bytes. Trust roots, signer eligibility, outcome validity and live authority
remain separate decisions.

## Explicit non-claims

The Modules do not provide:

- hosted media storage, deletion enforcement or a custody chain;
- liveness, GPS, camera or identity authenticity by themselves;
- an outcome oracle, automatic acceptance or effect authority;
- a new escrow, marketplace, provider or remote-effect surface;
- a mutable packet that can replace the canonical Core records.

## Executable evidence

- `packages/tasq-core/src/service/captured-evidence.ts` is the atomic checked
  append boundary over existing Artifact and Evidence records.
- `packages/tasq-evidence-bundles/src/capture.ts` freezes sessions, verifies
  bytes/store responses and records complete disclosure manifests.
- `packages/tasq-evidence-bundles/src/outcome-bundle.ts` builds, hashes, signs
  and freshness-checks exact projections.
- `packages/tasq-evidence-bundles/test/evidence-bundles.test.ts` proves replay
  without duplicates, pre-ledger integrity rejection, late-failure rollback,
  stale binding denial, disclosure preservation, stable exports, required
  omissions, stale/missing distinction and bytes-only signatures.
