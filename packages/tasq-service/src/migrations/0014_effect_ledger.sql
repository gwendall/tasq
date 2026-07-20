-- TQ-203/TQ-204: exact effect ledger and immutable authority decisions.
-- No provider execution surface is added by this migration.

CREATE TABLE effect (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  attempt_id TEXT REFERENCES task_attempt(id),
  canonical_request TEXT NOT NULL CHECK (json_valid(canonical_request)),
  request_digest TEXT NOT NULL,
  request_protocol TEXT NOT NULL,
  canonicalization TEXT NOT NULL,
  digest_algorithm TEXT NOT NULL,
  effect_type_uri TEXT NOT NULL,
  effect_schema_version INTEGER NOT NULL CHECK (effect_schema_version > 0),
  connector_operation_uri TEXT NOT NULL,
  connector_operation_version INTEGER NOT NULL CHECK (connector_operation_version > 0),
  connector_contract_digest TEXT NOT NULL,
  connector_instance_ref TEXT NOT NULL,
  connector_binding_digest TEXT NOT NULL,
  dispatch_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','authorized','executing','committed','failed','indeterminate','cancelled')),
  authorized_by_approval_id TEXT,
  claim_id TEXT REFERENCES task_claim(id),
  fence INTEGER,
  supersedes_effect_id TEXT REFERENCES effect(id),
  compensation_of_effect_id TEXT REFERENCES effect(id),
  created_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  authorized_at INTEGER,
  execution_started_at INTEGER,
  indeterminate_at INTEGER,
  resolved_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, dispatch_idempotency_key),
  CHECK ((claim_id IS NULL AND fence IS NULL) OR
         (claim_id IS NOT NULL AND fence IS NOT NULL AND fence > 0)),
  CHECK ((supersedes_effect_id IS NULL OR supersedes_effect_id <> id) AND
         (compensation_of_effect_id IS NULL OR compensation_of_effect_id <> id)),
  CHECK (supersedes_effect_id IS NULL OR compensation_of_effect_id IS NULL),
  CHECK (updated_at >= created_at AND
         (authorized_at IS NULL OR authorized_at >= created_at) AND
         (execution_started_at IS NULL OR execution_started_at >= authorized_at) AND
         (indeterminate_at IS NULL OR indeterminate_at >= execution_started_at) AND
         (resolved_at IS NULL OR resolved_at >= execution_started_at) AND
         (cancelled_at IS NULL OR cancelled_at >= created_at)),
  CHECK (
    (status = 'proposed' AND authorized_by_approval_id IS NULL AND authorized_at IS NULL AND
      claim_id IS NULL AND execution_started_at IS NULL AND indeterminate_at IS NULL AND
      resolved_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL) OR
    (status = 'authorized' AND authorized_by_approval_id IS NOT NULL AND authorized_at IS NOT NULL AND
      claim_id IS NULL AND execution_started_at IS NULL AND indeterminate_at IS NULL AND
      resolved_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL) OR
    (status = 'executing' AND authorized_by_approval_id IS NOT NULL AND authorized_at IS NOT NULL AND
      claim_id IS NOT NULL AND execution_started_at IS NOT NULL AND indeterminate_at IS NULL AND
      resolved_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL) OR
    (status = 'indeterminate' AND authorized_by_approval_id IS NOT NULL AND authorized_at IS NOT NULL AND
      claim_id IS NOT NULL AND execution_started_at IS NOT NULL AND indeterminate_at IS NOT NULL AND
      resolved_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL) OR
    (status IN ('committed','failed') AND authorized_by_approval_id IS NOT NULL AND authorized_at IS NOT NULL AND
      claim_id IS NOT NULL AND execution_started_at IS NOT NULL AND resolved_at IS NOT NULL AND
      cancelled_at IS NULL AND cancel_reason IS NULL) OR
    (status = 'cancelled' AND authorized_by_approval_id IS NULL AND authorized_at IS NULL AND
      claim_id IS NULL AND execution_started_at IS NULL AND indeterminate_at IS NULL AND
      resolved_at IS NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND
      length(trim(cancel_reason)) > 0)
  )
);
CREATE INDEX idx_effect_task ON effect (tenant_id, task_id, created_at);
CREATE INDEX idx_effect_status ON effect (tenant_id, status, updated_at);
CREATE INDEX idx_effect_digest ON effect (tenant_id, request_digest);
CREATE UNIQUE INDEX uniq_effect_supersedes ON effect (tenant_id, supersedes_effect_id)
  WHERE supersedes_effect_id IS NOT NULL;

CREATE TABLE effect_approval (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  effect_id TEXT NOT NULL REFERENCES effect(id),
  request_digest TEXT NOT NULL,
  approver_principal_id TEXT NOT NULL REFERENCES principal(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','denied','revoked')),
  scope TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope) AND json_type(scope) = 'object'),
  limits TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits) AND json_type(limits) = 'object'),
  valid_from INTEGER,
  expires_at INTEGER,
  verification_level TEXT NOT NULL
    CHECK (verification_level IN ('self_asserted','authenticated_context','cryptographic')),
  verification_method TEXT NOT NULL CHECK (length(trim(verification_method)) > 0),
  verification TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(verification) AND json_type(verification) = 'object'),
  supersedes_approval_id TEXT REFERENCES effect_approval(id),
  decided_at INTEGER NOT NULL,
  CHECK ((valid_from IS NULL OR valid_from >= 0) AND
         (expires_at IS NULL OR expires_at > decided_at) AND
         (valid_from IS NULL OR expires_at IS NULL OR expires_at > valid_from)),
  CHECK (decision <> 'revoked' OR supersedes_approval_id IS NOT NULL)
);
CREATE INDEX idx_effect_approval_effect ON effect_approval (tenant_id, effect_id, decided_at);
CREATE INDEX idx_effect_approval_approver ON effect_approval (tenant_id, approver_principal_id, decided_at);
CREATE UNIQUE INDEX uniq_effect_approval_root ON effect_approval (tenant_id, effect_id)
  WHERE supersedes_approval_id IS NULL;
CREATE UNIQUE INDEX uniq_effect_approval_supersedes ON effect_approval (tenant_id, supersedes_approval_id)
  WHERE supersedes_approval_id IS NOT NULL;

-- Effect identity and intent are immutable. Only guarded lifecycle columns move.
CREATE TRIGGER effect_revision_and_identity_guard BEFORE UPDATE ON effect
BEGIN
  SELECT RAISE(ABORT, 'effect revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'effect identity and request are immutable') WHERE
    NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.task_id <> OLD.task_id OR
    NEW.attempt_id IS NOT OLD.attempt_id OR NEW.canonical_request <> OLD.canonical_request OR
    NEW.request_digest <> OLD.request_digest OR NEW.request_protocol <> OLD.request_protocol OR
    NEW.canonicalization <> OLD.canonicalization OR NEW.digest_algorithm <> OLD.digest_algorithm OR
    NEW.effect_type_uri <> OLD.effect_type_uri OR NEW.effect_schema_version <> OLD.effect_schema_version OR
    NEW.connector_operation_uri <> OLD.connector_operation_uri OR
    NEW.connector_operation_version <> OLD.connector_operation_version OR
    NEW.connector_contract_digest <> OLD.connector_contract_digest OR
    NEW.connector_instance_ref <> OLD.connector_instance_ref OR
    NEW.connector_binding_digest <> OLD.connector_binding_digest OR
    NEW.dispatch_idempotency_key <> OLD.dispatch_idempotency_key OR
    NEW.supersedes_effect_id IS NOT OLD.supersedes_effect_id OR
    NEW.compensation_of_effect_id IS NOT OLD.compensation_of_effect_id OR
    NEW.created_by_principal_id <> OLD.created_by_principal_id OR NEW.created_at <> OLD.created_at;
  SELECT RAISE(ABORT, 'invalid effect state transition') WHERE NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('authorized','cancelled')) OR
    (OLD.status = 'authorized' AND NEW.status IN ('proposed','executing','cancelled')) OR
    (OLD.status = 'executing' AND NEW.status IN ('committed','failed','indeterminate')) OR
    (OLD.status = 'indeterminate' AND NEW.status IN ('committed','failed'))
  );
END;

CREATE TRIGGER effect_no_delete BEFORE DELETE ON effect
BEGIN SELECT RAISE(ABORT, 'effects are append-only'); END;
CREATE TRIGGER effect_approval_no_update BEFORE UPDATE ON effect_approval
BEGIN SELECT RAISE(ABORT, 'effect approvals are immutable'); END;
CREATE TRIGGER effect_approval_no_delete BEFORE DELETE ON effect_approval
BEGIN SELECT RAISE(ABORT, 'effect approvals are append-only'); END;

CREATE TRIGGER effect_workspace_guard BEFORE INSERT ON effect
BEGIN
  SELECT RAISE(ABORT, 'new effects must start proposed at revision one')
    WHERE NEW.status <> 'proposed' OR NEW.revision <> 1;
  SELECT RAISE(ABORT, 'effect task workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM task t WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id AND t.deleted_at IS NULL);
  SELECT RAISE(ABORT, 'effect attempt ownership mismatch') WHERE
    NEW.attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM task_attempt a WHERE a.id = NEW.attempt_id AND a.task_id = NEW.task_id AND a.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'effect principal workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = NEW.created_by_principal_id AND p.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'effect supersession workspace mismatch') WHERE
    NEW.supersedes_effect_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM effect e WHERE e.id = NEW.supersedes_effect_id AND e.tenant_id = NEW.tenant_id AND
        e.task_id = NEW.task_id AND e.status = 'cancelled');
  SELECT RAISE(ABORT, 'effect compensation workspace mismatch') WHERE
    NEW.compensation_of_effect_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM effect e WHERE e.id = NEW.compensation_of_effect_id AND e.tenant_id = NEW.tenant_id AND e.status = 'committed');
END;

CREATE TRIGGER effect_approval_workspace_guard BEFORE INSERT ON effect_approval
BEGIN
  SELECT RAISE(ABORT, 'approval effect workspace or digest mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM effect e WHERE e.id = NEW.effect_id AND e.tenant_id = NEW.tenant_id AND e.request_digest = NEW.request_digest);
  SELECT RAISE(ABORT, 'approval principal workspace mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM principal p WHERE p.id = NEW.approver_principal_id AND p.tenant_id = NEW.tenant_id AND p.status = 'enabled');
  SELECT RAISE(ABORT, 'approval decision predates effect')
    WHERE NOT EXISTS (SELECT 1 FROM effect e WHERE e.id = NEW.effect_id AND NEW.decided_at >= e.created_at);
  SELECT RAISE(ABORT, 'approval supersession mismatch') WHERE
    NEW.supersedes_approval_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM effect_approval a
      WHERE a.id = NEW.supersedes_approval_id AND a.tenant_id = NEW.tenant_id AND
            a.effect_id = NEW.effect_id AND a.request_digest = NEW.request_digest AND
            NEW.decided_at >= a.decided_at AND
            NOT EXISTS (SELECT 1 FROM effect_approval child WHERE child.supersedes_approval_id = a.id));
  SELECT RAISE(ABORT, 'revocation must supersede an approval') WHERE
    NEW.decision = 'revoked' AND NOT EXISTS (
      SELECT 1 FROM effect_approval a WHERE a.id = NEW.supersedes_approval_id AND a.decision = 'approved');
END;

-- Entering an authority-bearing state requires the exact current leaf approval.
CREATE TRIGGER effect_authorization_guard BEFORE UPDATE ON effect
WHEN NEW.status = 'authorized'
BEGIN
  SELECT RAISE(ABORT, 'effect authorization requires a current valid exact approval')
    WHERE NOT EXISTS (
      SELECT 1 FROM effect_approval a
      WHERE a.id = NEW.authorized_by_approval_id AND a.effect_id = NEW.id AND
            a.tenant_id = NEW.tenant_id AND a.request_digest = NEW.request_digest AND
            a.decision = 'approved' AND
            (a.valid_from IS NULL OR a.valid_from <= NEW.authorized_at) AND
            (a.expires_at IS NULL OR NEW.authorized_at < a.expires_at) AND
            NOT EXISTS (SELECT 1 FROM effect_approval child WHERE child.supersedes_approval_id = a.id));
END;

-- TQ-205 will expose this transition through one connector enforcement helper.
-- The SQL boundary is already fail-closed for direct or damaged clients.
CREATE TRIGGER effect_execution_authority_guard BEFORE UPDATE ON effect
WHEN NEW.status = 'executing'
BEGIN
  SELECT RAISE(ABORT, 'effect execution requires a current valid exact approval')
    WHERE NOT EXISTS (
      SELECT 1 FROM effect_approval a
      WHERE a.id = NEW.authorized_by_approval_id AND a.effect_id = NEW.id AND
            a.tenant_id = NEW.tenant_id AND a.request_digest = NEW.request_digest AND
            a.decision = 'approved' AND
            (a.valid_from IS NULL OR a.valid_from <= NEW.execution_started_at) AND
            (a.expires_at IS NULL OR NEW.execution_started_at < a.expires_at) AND
            NOT EXISTS (SELECT 1 FROM effect_approval child WHERE child.supersedes_approval_id = a.id));
  SELECT RAISE(ABORT, 'effect execution requires the current live claim fence')
    WHERE NOT EXISTS (
      SELECT 1 FROM task_claim c WHERE c.id = NEW.claim_id AND c.task_id = NEW.task_id AND
        c.tenant_id = NEW.tenant_id AND c.fence = NEW.fence AND c.released_at IS NULL AND
        c.expires_at > NEW.execution_started_at);
END;
