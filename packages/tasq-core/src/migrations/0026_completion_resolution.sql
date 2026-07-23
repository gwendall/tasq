-- ADR-005 / TQ-612: append-only evidence trust and independently validated completion.

ALTER TABLE task
  ADD COLUMN validation_required INTEGER NOT NULL DEFAULT 0
  CHECK (validation_required IN (0, 1));

CREATE TABLE resolution_contract (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  success_criteria_snapshot TEXT NOT NULL CHECK (length(trim(success_criteria_snapshot)) > 0),
  criteria_json TEXT NOT NULL
    CHECK (json_valid(criteria_json) AND json_type(criteria_json) = 'array'
      AND json_array_length(criteria_json) > 0),
  criteria_digest TEXT NOT NULL,
  policy_kind TEXT NOT NULL
    CHECK (policy_kind IN ('deterministic','attestation','optimistic','adjudicated')),
  policy_uri TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  implementation_digest TEXT NOT NULL,
  not_before INTEGER,
  challenge_window_ms INTEGER NOT NULL DEFAULT 0 CHECK (challenge_window_ms >= 0),
  allow_self_validation INTEGER NOT NULL DEFAULT 0 CHECK (allow_self_validation IN (0, 1)),
  eligible_validator_principal_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(eligible_validator_principal_ids)
      AND json_type(eligible_validator_principal_ids) = 'array'),
  adjudicator_principal_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(adjudicator_principal_ids)
      AND json_type(adjudicator_principal_ids) = 'array'),
  contract_digest TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_resolution_contract_task
  ON resolution_contract(tenant_id, task_id, created_at);
CREATE UNIQUE INDEX uniq_resolution_contract_digest
  ON resolution_contract(tenant_id, contract_digest);

CREATE TABLE evidence_trust_record (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  evidence_id TEXT NOT NULL REFERENCES task_evidence(id),
  action TEXT NOT NULL CHECK (action IN ('attest','revoke')),
  authenticity TEXT NOT NULL
    CHECK (authenticity IN ('unverified','authenticated_principal','authenticated_source','provider_verified')),
  authority_uri TEXT NOT NULL,
  authority_version INTEGER NOT NULL CHECK (authority_version > 0),
  authority_digest TEXT NOT NULL,
  supersedes_trust_record_id TEXT REFERENCES evidence_trust_record(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  verified_at INTEGER NOT NULL,
  valid_until INTEGER,
  retention_until INTEGER,
  recorded_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  created_at INTEGER NOT NULL,
  CHECK ((valid_until IS NULL OR valid_until >= verified_at)
    AND (retention_until IS NULL OR retention_until >= verified_at)),
  CHECK ((action = 'attest' AND supersedes_trust_record_id IS NULL)
    OR (action = 'revoke' AND supersedes_trust_record_id IS NOT NULL
      AND supersedes_trust_record_id <> id))
);

CREATE INDEX idx_evidence_trust_evidence
  ON evidence_trust_record(tenant_id, evidence_id, created_at);
CREATE UNIQUE INDEX uniq_evidence_trust_root
  ON evidence_trust_record(tenant_id, evidence_id)
  WHERE supersedes_trust_record_id IS NULL;
CREATE UNIQUE INDEX uniq_evidence_trust_child
  ON evidence_trust_record(tenant_id, supersedes_trust_record_id)
  WHERE supersedes_trust_record_id IS NOT NULL;

CREATE TABLE completion_proposal (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  resolution_contract_id TEXT NOT NULL REFERENCES resolution_contract(id),
  contract_digest TEXT NOT NULL,
  proposer_principal_id TEXT NOT NULL REFERENCES principal(id),
  criterion_evidence TEXT NOT NULL
    CHECK (json_valid(criterion_evidence) AND json_type(criterion_evidence) = 'array'
      AND json_array_length(criterion_evidence) > 0),
  summary TEXT,
  proposal_digest TEXT NOT NULL,
  proposed_at INTEGER NOT NULL
);

CREATE INDEX idx_completion_proposal_task
  ON completion_proposal(tenant_id, task_id, proposed_at);
CREATE INDEX idx_completion_proposal_contract
  ON completion_proposal(tenant_id, resolution_contract_id, proposed_at);
CREATE UNIQUE INDEX uniq_completion_proposal_digest
  ON completion_proposal(tenant_id, proposal_digest);

CREATE TABLE completion_challenge (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  proposal_id TEXT NOT NULL REFERENCES completion_proposal(id),
  challenger_principal_id TEXT NOT NULL REFERENCES principal(id),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  explanation TEXT NOT NULL CHECK (length(trim(explanation)) > 0),
  counter_evidence_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(counter_evidence_ids) AND json_type(counter_evidence_ids) = 'array'),
  challenged_at INTEGER NOT NULL
);

CREATE INDEX idx_completion_challenge_proposal
  ON completion_challenge(tenant_id, proposal_id, challenged_at);

CREATE TABLE validation_decision (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  resolution_contract_id TEXT NOT NULL REFERENCES resolution_contract(id),
  proposal_id TEXT NOT NULL REFERENCES completion_proposal(id),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('accepted','rejected','too_early','indeterminate','challenged')),
  policy_uri TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  implementation_digest TEXT NOT NULL,
  policy_input_digest TEXT NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(evidence_ids) AND json_type(evidence_ids) = 'array'),
  trust_record_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(trust_record_ids) AND json_type(trust_record_ids) = 'array'),
  supersedes_decision_id TEXT REFERENCES validation_decision(id),
  decided_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  explanation TEXT NOT NULL CHECK (length(trim(explanation)) > 0),
  decided_at INTEGER NOT NULL,
  CHECK (supersedes_decision_id IS NULL OR supersedes_decision_id <> id)
);

CREATE INDEX idx_validation_decision_proposal
  ON validation_decision(tenant_id, proposal_id, decided_at);
CREATE UNIQUE INDEX uniq_validation_decision_root
  ON validation_decision(tenant_id, proposal_id)
  WHERE supersedes_decision_id IS NULL;
CREATE UNIQUE INDEX uniq_validation_decision_child
  ON validation_decision(tenant_id, supersedes_decision_id)
  WHERE supersedes_decision_id IS NOT NULL;

ALTER TABLE completion_record
  ADD COLUMN resolution_contract_id TEXT REFERENCES resolution_contract(id);
ALTER TABLE completion_record
  ADD COLUMN validation_decision_id TEXT REFERENCES validation_decision(id);

CREATE TRIGGER resolution_contract_validate_insert
BEFORE INSERT ON resolution_contract
BEGIN
  SELECT RAISE(ABORT, 'resolution contract task mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM task t
    WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id
      AND t.deleted_at IS NULL AND t.validation_required = 1
      AND t.success_criteria IS NOT NULL
      AND t.success_criteria = NEW.success_criteria_snapshot
  );
  SELECT RAISE(ABORT, 'resolution contract principal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM principal p
    WHERE p.id = NEW.created_by_principal_id AND p.tenant_id = NEW.tenant_id
  );
END;

CREATE TRIGGER evidence_trust_validate_insert
BEFORE INSERT ON evidence_trust_record
BEGIN
  SELECT RAISE(ABORT, 'evidence trust task mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM task_evidence e
    WHERE e.id = NEW.evidence_id AND e.tenant_id = NEW.tenant_id
      AND e.task_id = NEW.task_id
  );
  SELECT RAISE(ABORT, 'evidence trust principal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM principal p
    WHERE p.id = NEW.recorded_by_principal_id AND p.tenant_id = NEW.tenant_id
  );
  SELECT RAISE(ABORT, 'evidence trust supersession mismatch')
  WHERE NEW.supersedes_trust_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evidence_trust_record prior
    WHERE prior.id = NEW.supersedes_trust_record_id
      AND prior.tenant_id = NEW.tenant_id
      AND prior.task_id = NEW.task_id
      AND prior.evidence_id = NEW.evidence_id
      AND prior.action = 'attest'
  );
END;

CREATE TRIGGER completion_proposal_validate_insert
BEFORE INSERT ON completion_proposal
BEGIN
  SELECT RAISE(ABORT, 'completion proposal contract mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM resolution_contract c
    JOIN task t ON t.id = c.task_id AND t.tenant_id = c.tenant_id
    WHERE c.id = NEW.resolution_contract_id
      AND c.tenant_id = NEW.tenant_id
      AND c.task_id = NEW.task_id
      AND c.contract_digest = NEW.contract_digest
      AND t.deleted_at IS NULL
      AND t.success_criteria = c.success_criteria_snapshot
  );
  SELECT RAISE(ABORT, 'completion proposal principal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM principal p
    WHERE p.id = NEW.proposer_principal_id AND p.tenant_id = NEW.tenant_id
      AND p.status = 'enabled'
  );
END;

CREATE TRIGGER completion_challenge_validate_insert
BEFORE INSERT ON completion_challenge
BEGIN
  SELECT RAISE(ABORT, 'completion challenge proposal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM completion_proposal p
    WHERE p.id = NEW.proposal_id AND p.tenant_id = NEW.tenant_id
      AND p.task_id = NEW.task_id
  );
  SELECT RAISE(ABORT, 'completion challenge principal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM principal p
    WHERE p.id = NEW.challenger_principal_id AND p.tenant_id = NEW.tenant_id
      AND p.status = 'enabled'
  );
END;

CREATE TRIGGER validation_decision_validate_insert
BEFORE INSERT ON validation_decision
BEGIN
  SELECT RAISE(ABORT, 'validation decision proposal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM completion_proposal p
    JOIN resolution_contract c ON c.id = p.resolution_contract_id
      AND c.tenant_id = p.tenant_id
    WHERE p.id = NEW.proposal_id AND p.tenant_id = NEW.tenant_id
      AND p.task_id = NEW.task_id
      AND c.id = NEW.resolution_contract_id
      AND c.policy_uri = NEW.policy_uri
      AND c.policy_version = NEW.policy_version
      AND c.implementation_digest = NEW.implementation_digest
  );
  SELECT RAISE(ABORT, 'validation decision principal mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM principal p
    WHERE p.id = NEW.decided_by_principal_id AND p.tenant_id = NEW.tenant_id
      AND p.status = 'enabled'
  );
  SELECT RAISE(ABORT, 'validation decision supersession mismatch')
  WHERE NEW.supersedes_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM validation_decision prior
    WHERE prior.id = NEW.supersedes_decision_id
      AND prior.tenant_id = NEW.tenant_id
      AND prior.task_id = NEW.task_id
      AND prior.proposal_id = NEW.proposal_id
  );
END;

CREATE TRIGGER completion_record_validate_resolution_insert
BEFORE INSERT ON completion_record
BEGIN
  SELECT RAISE(ABORT, 'validated completion requires accepted decision')
  WHERE EXISTS (
    SELECT 1 FROM task t
    WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id
      AND t.validation_required = 1
  ) AND (
    NEW.resolution_contract_id IS NULL OR NEW.validation_decision_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM validation_decision d
      WHERE d.id = NEW.validation_decision_id
        AND d.tenant_id = NEW.tenant_id
        AND d.task_id = NEW.task_id
        AND d.resolution_contract_id = NEW.resolution_contract_id
        AND d.outcome = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM validation_decision child
          WHERE child.supersedes_decision_id = d.id
        )
    )
  );
  SELECT RAISE(ABORT, 'ordinary completion cannot claim validated resolution')
  WHERE EXISTS (
    SELECT 1 FROM task t
    WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id
      AND t.validation_required = 0
  ) AND (NEW.resolution_contract_id IS NOT NULL OR NEW.validation_decision_id IS NOT NULL);
END;

CREATE TRIGGER resolution_contract_immutable_update
BEFORE UPDATE ON resolution_contract BEGIN
  SELECT RAISE(ABORT, 'resolution contracts are immutable');
END;
CREATE TRIGGER resolution_contract_immutable_delete
BEFORE DELETE ON resolution_contract BEGIN
  SELECT RAISE(ABORT, 'resolution contracts are immutable');
END;
CREATE TRIGGER evidence_trust_immutable_update
BEFORE UPDATE ON evidence_trust_record BEGIN
  SELECT RAISE(ABORT, 'evidence trust records are immutable');
END;
CREATE TRIGGER evidence_trust_immutable_delete
BEFORE DELETE ON evidence_trust_record BEGIN
  SELECT RAISE(ABORT, 'evidence trust records are immutable');
END;
CREATE TRIGGER completion_proposal_immutable_update
BEFORE UPDATE ON completion_proposal BEGIN
  SELECT RAISE(ABORT, 'completion proposals are immutable');
END;
CREATE TRIGGER completion_proposal_immutable_delete
BEFORE DELETE ON completion_proposal BEGIN
  SELECT RAISE(ABORT, 'completion proposals are immutable');
END;
CREATE TRIGGER completion_challenge_immutable_update
BEFORE UPDATE ON completion_challenge BEGIN
  SELECT RAISE(ABORT, 'completion challenges are immutable');
END;
CREATE TRIGGER completion_challenge_immutable_delete
BEFORE DELETE ON completion_challenge BEGIN
  SELECT RAISE(ABORT, 'completion challenges are immutable');
END;
CREATE TRIGGER validation_decision_immutable_update
BEFORE UPDATE ON validation_decision BEGIN
  SELECT RAISE(ABORT, 'validation decisions are immutable');
END;
CREATE TRIGGER validation_decision_immutable_delete
BEFORE DELETE ON validation_decision BEGIN
  SELECT RAISE(ABORT, 'validation decisions are immutable');
END;
