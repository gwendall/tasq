CREATE TABLE workspace_checkpoint (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  authority_epoch TEXT NOT NULL,
  event_cursor INTEGER NOT NULL CHECK (event_cursor >= 0),
  root_contract_uri TEXT NOT NULL,
  root_contract_version INTEGER NOT NULL CHECK (root_contract_version > 0),
  root_digest TEXT NOT NULL,
  exported_record_count INTEGER NOT NULL CHECK (exported_record_count >= 0),
  created_by_principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  UNIQUE (tenant_id, authority_epoch, event_cursor, root_digest)
);

CREATE TABLE accepted_signing_credential_snapshot (
  tenant_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  principal_id TEXT NOT NULL,
  profile_uri TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  public_material_json TEXT NOT NULL CHECK (json_valid(public_material_json)),
  public_material_digest TEXT NOT NULL,
  trust_root_digest TEXT NOT NULL,
  isolation_class TEXT NOT NULL,
  status_at_acceptance TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  replaces_credential_id TEXT,
  enrollment_method TEXT NOT NULL,
  enrollment_evidence_digest TEXT NOT NULL,
  credential_digest TEXT NOT NULL,
  captured_at INTEGER NOT NULL CHECK (captured_at >= 0),
  PRIMARY KEY (tenant_id, credential_id, credential_revision)
);

CREATE TABLE signed_statement (
  statement_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  issuer_principal_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  purpose_uri TEXT NOT NULL,
  purpose_version INTEGER NOT NULL CHECK (purpose_version > 0),
  subject_type_uri TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL,
  bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
  bundle_digest TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  UNIQUE (tenant_id, statement_id),
  UNIQUE (tenant_id, purpose_uri, purpose_version, credential_id, statement_id)
);

CREATE TABLE signature_verification_record (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL REFERENCES signed_statement(statement_id),
  statement_digest TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  credential_digest TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  trust_root_digest TEXT NOT NULL,
  profile_uri TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  verifier_implementation_digest TEXT NOT NULL,
  verified_at INTEGER NOT NULL CHECK (verified_at >= 0),
  credential_state_at_verification TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('valid','invalid','indeterminate')),
  reason_code TEXT NOT NULL,
  supporting_proof_digests_json TEXT NOT NULL CHECK (json_valid(supporting_proof_digests_json)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, statement_id, verifier_implementation_digest, verified_at)
);

CREATE TABLE signed_statement_nonce (
  tenant_id TEXT NOT NULL,
  purpose_uri TEXT NOT NULL,
  nonce TEXT NOT NULL,
  statement_id TEXT NOT NULL REFERENCES signed_statement(statement_id),
  consumed_at INTEGER NOT NULL CHECK (consumed_at >= 0),
  PRIMARY KEY (tenant_id, purpose_uri, nonce)
);

CREATE TABLE signed_statement_binding (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL REFERENCES signed_statement(statement_id),
  verification_id TEXT NOT NULL REFERENCES signature_verification_record(id),
  binding_kind TEXT NOT NULL CHECK (binding_kind IN (
    'artifact_authorship','artifact_acceptance','completion_attestation',
    'effect_approval','replication_operation_origin','workspace_checkpoint'
  )),
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  UNIQUE (tenant_id, binding_kind, record_type, record_id, statement_id)
);

CREATE INDEX signed_statement_subject
  ON signed_statement(tenant_id, subject_type_uri, subject_id, accepted_at);
CREATE INDEX workspace_checkpoint_order
  ON workspace_checkpoint(tenant_id, event_cursor, created_at);
CREATE INDEX accepted_signing_credential_principal
  ON accepted_signing_credential_snapshot(tenant_id, principal_id, captured_at);
CREATE INDEX signature_verification_statement
  ON signature_verification_record(tenant_id, statement_id, verified_at);
CREATE INDEX signed_statement_binding_record
  ON signed_statement_binding(tenant_id, record_type, record_id, created_at);

CREATE TRIGGER signed_statement_no_update BEFORE UPDATE ON signed_statement
BEGIN SELECT RAISE(ABORT, 'signed statements are immutable'); END;
CREATE TRIGGER signed_statement_no_delete BEFORE DELETE ON signed_statement
BEGIN SELECT RAISE(ABORT, 'signed statements are append-only'); END;
CREATE TRIGGER signature_verification_no_update BEFORE UPDATE ON signature_verification_record
BEGIN SELECT RAISE(ABORT, 'signature verification records are immutable'); END;
CREATE TRIGGER signature_verification_no_delete BEFORE DELETE ON signature_verification_record
BEGIN SELECT RAISE(ABORT, 'signature verification records are append-only'); END;
CREATE TRIGGER signed_statement_nonce_no_update BEFORE UPDATE ON signed_statement_nonce
BEGIN SELECT RAISE(ABORT, 'signed statement nonces are immutable'); END;
CREATE TRIGGER signed_statement_nonce_no_delete BEFORE DELETE ON signed_statement_nonce
BEGIN SELECT RAISE(ABORT, 'signed statement nonces are retained'); END;
CREATE TRIGGER signed_statement_binding_no_update BEFORE UPDATE ON signed_statement_binding
BEGIN SELECT RAISE(ABORT, 'signed statement bindings are immutable'); END;
CREATE TRIGGER signed_statement_binding_no_delete BEFORE DELETE ON signed_statement_binding
BEGIN SELECT RAISE(ABORT, 'signed statement bindings are append-only'); END;
CREATE TRIGGER workspace_checkpoint_no_update BEFORE UPDATE ON workspace_checkpoint
BEGIN SELECT RAISE(ABORT, 'workspace checkpoints are immutable'); END;
CREATE TRIGGER workspace_checkpoint_no_delete BEFORE DELETE ON workspace_checkpoint
BEGIN SELECT RAISE(ABORT, 'workspace checkpoints are append-only'); END;
CREATE TRIGGER accepted_signing_credential_no_update BEFORE UPDATE ON accepted_signing_credential_snapshot
BEGIN SELECT RAISE(ABORT, 'accepted signing credential snapshots are immutable'); END;
CREATE TRIGGER accepted_signing_credential_no_delete BEFORE DELETE ON accepted_signing_credential_snapshot
BEGIN SELECT RAISE(ABORT, 'accepted signing credential snapshots are retained'); END;
