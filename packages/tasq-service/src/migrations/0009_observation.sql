-- TQ-103: immutable normalized observations with provider-delivery identity.
-- The row itself is the provenance record; task-scoped audit is created later
-- when reconciliation relates this fact to a commitment.

CREATE TABLE observation (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  subject_ref TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  verification_level TEXT NOT NULL DEFAULT 'unverified',
  verification_method TEXT,
  raw_ref TEXT,
  digest TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',

  CONSTRAINT observation_kind_check CHECK (kind IN (
    'gmail.message',
    'github.pull_request',
    'mercury.transaction',
    'http.check',
    'filesystem.stat'
  )),
  CONSTRAINT observation_schema_version_check CHECK (schema_version > 0),
  CONSTRAINT observation_payload_json_check CHECK (json_valid(payload)),
  CONSTRAINT observation_metadata_json_check CHECK (json_valid(metadata)),
  CONSTRAINT observation_timestamp_check CHECK (occurred_at >= 0 AND recorded_at >= 0),
  CONSTRAINT observation_verification_level_check CHECK (
    verification_level IN ('unverified','authenticated_source','provider_verified')
  ),
  CONSTRAINT observation_verification_method_check CHECK (
    verification_level = 'unverified'
    OR (verification_method IS NOT NULL AND length(trim(verification_method)) > 0)
  ),
  CONSTRAINT observation_raw_binding_check CHECK (
    raw_ref IS NULL OR (digest IS NOT NULL AND length(trim(digest)) > 0)
  )
);

CREATE UNIQUE INDEX uniq_observation_delivery
  ON observation(tenant_id, source, external_event_id);

CREATE INDEX idx_observation_candidate
  ON observation(tenant_id, kind, subject_ref, occurred_at);

CREATE INDEX idx_observation_recorded
  ON observation(tenant_id, recorded_at, id);

CREATE TRIGGER observation_validate_insert
BEFORE INSERT ON observation
WHEN length(trim(NEW.source)) = 0
  OR length(trim(NEW.external_event_id)) = 0
  OR length(trim(NEW.subject_ref)) = 0
  OR length(trim(NEW.recorded_by)) = 0
  OR (NEW.verification_method IS NOT NULL AND length(trim(NEW.verification_method)) = 0)
  OR (NEW.raw_ref IS NOT NULL AND length(trim(NEW.raw_ref)) = 0)
  OR (NEW.digest IS NOT NULL AND length(trim(NEW.digest)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid observation invariant');
END;

CREATE TRIGGER observation_no_update
BEFORE UPDATE ON observation
BEGIN
  SELECT RAISE(ABORT, 'observations are append-only');
END;

CREATE TRIGGER observation_no_delete
BEFORE DELETE ON observation
BEGIN
  SELECT RAISE(ABORT, 'observations are append-only');
END;

-- Close a gap left by the additive 0008 lifecycle: historical databases need
-- no rebuild, but new conditions must always enter through `waiting`.
CREATE TRIGGER wait_condition_insert_waiting_only
BEFORE INSERT ON wait_condition
WHEN NEW.status <> 'waiting'
BEGIN
  SELECT RAISE(ABORT, 'wait conditions must be created waiting');
END;

-- `satisfied_by_observation_id` was added one migration earlier and therefore
-- cannot gain a foreign key without rebuilding wait_condition. Enforce the
-- same tenant-scoped relationship additively before TQ-104 starts using it.
CREATE TRIGGER wait_condition_satisfied_observation_validate
BEFORE UPDATE ON wait_condition
WHEN NEW.status = 'satisfied'
  AND NOT EXISTS (
    SELECT 1 FROM observation
    WHERE observation.id = NEW.satisfied_by_observation_id
      AND observation.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'satisfying observation is missing or belongs to another tenant');
END;
