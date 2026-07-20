-- UK-003: immutable extension registry plus additive universal identities.

CREATE TABLE extension_release (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  extension_uri TEXT NOT NULL CHECK (extension_uri LIKE 'https://%'),
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 71
    AND substr(manifest_digest, 1, 7) = 'sha256:'
    AND substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  installed_at INTEGER NOT NULL CHECK (installed_at >= 0),
  installed_by TEXT NOT NULL CHECK (length(trim(installed_by)) > 0),
  UNIQUE (tenant_id, extension_uri, version)
);

CREATE TABLE extension_type (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  extension_release_id TEXT NOT NULL REFERENCES extension_release(id),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('condition','observation','evidence','artifact','effect')),
  type_uri TEXT NOT NULL CHECK (type_uri LIKE 'https://%'),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  schema_digest TEXT NOT NULL CHECK (
    length(schema_digest) = 71
    AND substr(schema_digest, 1, 7) = 'sha256:'
    AND substr(schema_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (tenant_id, type_uri, schema_version)
);

CREATE INDEX idx_extension_type_release
  ON extension_type(tenant_id, extension_release_id);

CREATE TABLE extension_evaluator (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  extension_release_id TEXT NOT NULL REFERENCES extension_release(id),
  evaluator_uri TEXT NOT NULL CHECK (evaluator_uri LIKE 'https://%'),
  evaluator_version INTEGER NOT NULL CHECK (evaluator_version > 0),
  condition_type_uri TEXT NOT NULL CHECK (condition_type_uri LIKE 'https://%'),
  condition_schema_version INTEGER NOT NULL CHECK (condition_schema_version > 0),
  accepted_observation_types TEXT NOT NULL CHECK (json_valid(accepted_observation_types) AND json_type(accepted_observation_types) = 'array'),
  implementation_digest TEXT NOT NULL CHECK (
    length(implementation_digest) = 71
    AND substr(implementation_digest, 1, 7) = 'sha256:'
    AND substr(implementation_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (tenant_id, evaluator_uri, evaluator_version)
);

CREATE INDEX idx_extension_evaluator_release
  ON extension_evaluator(tenant_id, extension_release_id);

CREATE TRIGGER extension_release_no_update
BEFORE UPDATE ON extension_release
BEGIN
  SELECT RAISE(ABORT, 'extension releases are immutable');
END;

CREATE TRIGGER extension_release_no_delete
BEFORE DELETE ON extension_release
BEGIN
  SELECT RAISE(ABORT, 'extension releases are immutable');
END;

CREATE TRIGGER extension_type_validate_insert
BEFORE INSERT ON extension_type
WHEN NOT EXISTS (
  SELECT 1 FROM extension_release
  WHERE id = NEW.extension_release_id AND tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'extension type release must exist in the same tenant');
END;

CREATE TRIGGER extension_type_no_update
BEFORE UPDATE ON extension_type
BEGIN
  SELECT RAISE(ABORT, 'extension types are immutable');
END;

CREATE TRIGGER extension_type_no_delete
BEFORE DELETE ON extension_type
BEGIN
  SELECT RAISE(ABORT, 'extension types are immutable');
END;

CREATE TRIGGER extension_evaluator_validate_insert
BEFORE INSERT ON extension_evaluator
WHEN NOT EXISTS (
  SELECT 1 FROM extension_release
  WHERE id = NEW.extension_release_id AND tenant_id = NEW.tenant_id
) OR NOT EXISTS (
  SELECT 1 FROM extension_type
  WHERE tenant_id = NEW.tenant_id
    AND type_uri = NEW.condition_type_uri
    AND schema_version = NEW.condition_schema_version
    AND record_kind = 'condition'
) OR json_array_length(NEW.accepted_observation_types) = 0
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.accepted_observation_types) accepted
    WHERE json_type(accepted.value) <> 'object'
      OR json_type(accepted.value, '$.typeUri') <> 'text'
      OR json_type(accepted.value, '$.schemaVersion') <> 'integer'
      OR NOT EXISTS (
        SELECT 1 FROM extension_type
        WHERE tenant_id = NEW.tenant_id
          AND type_uri = json_extract(accepted.value, '$.typeUri')
          AND schema_version = json_extract(accepted.value, '$.schemaVersion')
          AND record_kind = 'observation'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'extension evaluator references invalid release or registered types');
END;

CREATE TRIGGER extension_evaluator_no_update
BEFORE UPDATE ON extension_evaluator
BEGIN
  SELECT RAISE(ABORT, 'extension evaluators are immutable');
END;

CREATE TRIGGER extension_evaluator_no_delete
BEFORE DELETE ON extension_evaluator
BEGIN
  SELECT RAISE(ABORT, 'extension evaluators are immutable');
END;

ALTER TABLE wait_condition ADD COLUMN type_uri TEXT;
ALTER TABLE wait_condition ADD COLUMN evaluator_uri TEXT;
ALTER TABLE wait_condition ADD COLUMN evaluator_version INTEGER;
ALTER TABLE wait_condition ADD COLUMN evaluator_implementation_digest TEXT;

UPDATE wait_condition SET
  type_uri = CASE kind
    WHEN 'gmail.thread_reply' THEN 'https://schemas.tasq.dev/conditions/gmail/thread-reply'
    WHEN 'github.pull_request_state' THEN 'https://schemas.tasq.dev/conditions/github/pull-request-state'
    WHEN 'mercury.transaction_state' THEN 'https://schemas.tasq.dev/conditions/mercury/transaction-state'
    WHEN 'http.response' THEN 'https://schemas.tasq.dev/conditions/http/response'
    WHEN 'filesystem.artifact' THEN 'https://schemas.tasq.dev/conditions/filesystem/artifact'
  END,
  evaluator_uri = CASE kind
    WHEN 'gmail.thread_reply' THEN 'https://schemas.tasq.dev/evaluators/gmail/thread-reply'
    WHEN 'github.pull_request_state' THEN 'https://schemas.tasq.dev/evaluators/github/pull-request-state'
    WHEN 'mercury.transaction_state' THEN 'https://schemas.tasq.dev/evaluators/mercury/transaction-state'
    WHEN 'http.response' THEN 'https://schemas.tasq.dev/evaluators/http/response'
    WHEN 'filesystem.artifact' THEN 'https://schemas.tasq.dev/evaluators/filesystem/artifact'
  END,
  evaluator_version = 1,
  evaluator_implementation_digest = 'sha256:d616cb665c5e74912217a9f2074a3da15b2976f4ce50ce16a2c46bad3d91a161';

CREATE INDEX idx_wait_condition_type
  ON wait_condition(tenant_id, type_uri, schema_version, status);

ALTER TABLE observation ADD COLUMN type_uri TEXT;

UPDATE observation SET type_uri = CASE kind
  WHEN 'gmail.message' THEN 'https://schemas.tasq.dev/observations/gmail/message'
  WHEN 'github.pull_request' THEN 'https://schemas.tasq.dev/observations/github/pull-request'
  WHEN 'mercury.transaction' THEN 'https://schemas.tasq.dev/observations/mercury/transaction'
  WHEN 'http.check' THEN 'https://schemas.tasq.dev/observations/http/check'
  WHEN 'filesystem.stat' THEN 'https://schemas.tasq.dev/observations/filesystem/stat'
END;

CREATE INDEX idx_observation_type
  ON observation(tenant_id, type_uri, schema_version, occurred_at);

ALTER TABLE reconciliation ADD COLUMN evaluator_uri TEXT;
ALTER TABLE reconciliation ADD COLUMN evaluator_version INTEGER;
ALTER TABLE reconciliation ADD COLUMN evaluator_implementation_digest TEXT;

UPDATE reconciliation SET
  evaluator_uri = CASE matcher_kind
    WHEN 'gmail.thread_reply' THEN 'https://schemas.tasq.dev/evaluators/gmail/thread-reply'
    WHEN 'github.pull_request_state' THEN 'https://schemas.tasq.dev/evaluators/github/pull-request-state'
    WHEN 'mercury.transaction_state' THEN 'https://schemas.tasq.dev/evaluators/mercury/transaction-state'
    WHEN 'http.response' THEN 'https://schemas.tasq.dev/evaluators/http/response'
    WHEN 'filesystem.artifact' THEN 'https://schemas.tasq.dev/evaluators/filesystem/artifact'
  END,
  evaluator_version = matcher_version,
  evaluator_implementation_digest = 'sha256:d616cb665c5e74912217a9f2074a3da15b2976f4ce50ce16a2c46bad3d91a161';

CREATE INDEX idx_reconciliation_evaluator
  ON reconciliation(tenant_id, evaluator_uri, evaluator_version, reconciled_at);

CREATE TRIGGER wait_condition_extension_identity_insert
BEFORE INSERT ON wait_condition
WHEN NEW.type_uri IS NULL
  OR NEW.evaluator_uri IS NULL
  OR NEW.evaluator_version IS NULL
  OR NEW.evaluator_implementation_digest IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM extension_type
    WHERE tenant_id = NEW.tenant_id
      AND record_kind = 'condition'
      AND type_uri = NEW.type_uri
      AND schema_version = NEW.schema_version
  )
  OR NOT EXISTS (
    SELECT 1 FROM extension_evaluator
    WHERE tenant_id = NEW.tenant_id
      AND evaluator_uri = NEW.evaluator_uri
      AND evaluator_version = NEW.evaluator_version
      AND condition_type_uri = NEW.type_uri
      AND condition_schema_version = NEW.schema_version
      AND implementation_digest = NEW.evaluator_implementation_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'wait condition extension identity is not registered');
END;

CREATE TRIGGER wait_condition_extension_identity_no_update
BEFORE UPDATE OF type_uri, evaluator_uri, evaluator_version, evaluator_implementation_digest
ON wait_condition
BEGIN
  SELECT RAISE(ABORT, 'wait condition extension identity is immutable');
END;

CREATE TRIGGER observation_extension_identity_insert
BEFORE INSERT ON observation
WHEN NEW.type_uri IS NULL OR NOT EXISTS (
  SELECT 1 FROM extension_type
  WHERE tenant_id = NEW.tenant_id
    AND record_kind = 'observation'
    AND type_uri = NEW.type_uri
    AND schema_version = NEW.schema_version
)
BEGIN
  SELECT RAISE(ABORT, 'observation extension identity is not registered');
END;

CREATE TRIGGER reconciliation_extension_identity_insert
BEFORE INSERT ON reconciliation
WHEN NEW.evaluator_uri IS NULL
  OR NEW.evaluator_version IS NULL
  OR NEW.evaluator_implementation_digest IS NULL
  OR NEW.evaluator_version <> NEW.matcher_version
  OR NOT EXISTS (
    SELECT 1
    FROM extension_evaluator evaluator
    JOIN wait_condition condition ON condition.id = NEW.condition_id
    WHERE evaluator.tenant_id = NEW.tenant_id
      AND condition.tenant_id = NEW.tenant_id
      AND evaluator.evaluator_uri = NEW.evaluator_uri
      AND evaluator.evaluator_version = NEW.evaluator_version
      AND evaluator.implementation_digest = NEW.evaluator_implementation_digest
      AND evaluator.condition_type_uri = condition.type_uri
      AND evaluator.condition_schema_version = condition.schema_version
  )
BEGIN
  SELECT RAISE(ABORT, 'reconciliation evaluator identity is not registered');
END;
