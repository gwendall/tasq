# Evidence Capture and Outcome Bundles

Private, replaceable Modules for byte-bound evidence capture and portable
outcome inspection. Core remains the only ledger.

- `freezeCaptureSession` fixes the commitment revision, attempt, exact target,
  resolution contract, criterion, source and byte/media bounds before capture.
- `finalizeCapture` hashes exact bytes, verifies the immutable object-store
  response and atomically appends the corresponding Core Artifact and Evidence.
- `buildOutcomeBundle` exports exact content-addressed record bodies plus
  explicit authority, custody and raw-byte references or omissions.
- signatures authenticate exact canonical bundle bytes and the signing key;
  they do not prove an outcome, grant authority or make an external reference
  available.

See [`TQ-630_EVIDENCE_OUTCOME_BUNDLES.md`](../../docs/contracts/TQ-630_EVIDENCE_OUTCOME_BUNDLES.md).
