CREATE TABLE attestation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  issuer_principal_id TEXT NOT NULL REFERENCES principal(id),
  subject_type_uri TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_digest TEXT,
  purpose_uri TEXT NOT NULL,
  purpose_version INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  claim_type_uri TEXT NOT NULL,
  claim_version INTEGER NOT NULL,
  claim_json TEXT NOT NULL,
  claim_digest TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  expires_at INTEGER,
  supersedes_attestation_id TEXT REFERENCES attestation(id),
  attestation_digest TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  CONSTRAINT attestation_version_check CHECK (purpose_version > 0 AND claim_version > 0),
  CONSTRAINT attestation_chronology_check CHECK (expires_at IS NULL OR expires_at > not_before),
  CONSTRAINT attestation_json_check CHECK (
    json_valid(scope_json) AND json_valid(claim_json) AND
    json_valid(evidence_json) AND json_valid(metadata_json)
  )
);
CREATE INDEX idx_attestation_current_lookup ON attestation(
  tenant_id, subject_type_uri, subject_id, purpose_uri, purpose_version, not_before
);
CREATE UNIQUE INDEX uniq_attestation_workspace_digest ON attestation(tenant_id, attestation_digest);
CREATE UNIQUE INDEX uniq_attestation_supersedes ON attestation(tenant_id, supersedes_attestation_id)
  WHERE supersedes_attestation_id IS NOT NULL;
CREATE TRIGGER attestation_no_update BEFORE UPDATE ON attestation
BEGIN SELECT RAISE(ABORT, 'attestations are immutable'); END;
CREATE TRIGGER attestation_no_delete BEFORE DELETE ON attestation
BEGIN SELECT RAISE(ABORT, 'attestations are append-only'); END;

CREATE TABLE attestation_revocation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  attestation_id TEXT NOT NULL REFERENCES attestation(id),
  revoker_principal_id TEXT NOT NULL REFERENCES principal(id),
  reason_code TEXT NOT NULL,
  explanation TEXT,
  effective_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  revocation_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  CONSTRAINT attestation_revocation_chronology_check CHECK (effective_at <= recorded_at),
  CONSTRAINT attestation_revocation_metadata_check CHECK (json_valid(metadata_json))
);
CREATE UNIQUE INDEX uniq_attestation_revocation ON attestation_revocation(tenant_id, attestation_id);
CREATE INDEX idx_attestation_revocation_effective ON attestation_revocation(tenant_id, effective_at, attestation_id);
CREATE TRIGGER attestation_revocation_no_update BEFORE UPDATE ON attestation_revocation
BEGIN SELECT RAISE(ABORT, 'attestation revocations are immutable'); END;
CREATE TRIGGER attestation_revocation_no_delete BEFORE DELETE ON attestation_revocation
BEGIN SELECT RAISE(ABORT, 'attestation revocations are append-only'); END;
