-- TQ-102: durable typed waits. A wait condition is monotone state attached to
-- one commitment; observations and reconciliations arrive in later migrations.

CREATE TABLE wait_condition (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  parameters TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  not_before INTEGER NOT NULL,
  deadline_at INTEGER,
  fallback_kind TEXT NOT NULL DEFAULT 'none',
  fallback_spec TEXT,
  fallback_target_task_id TEXT REFERENCES task(id),
  fallback_result_task_id TEXT REFERENCES task(id),
  supersedes_condition_id TEXT REFERENCES wait_condition(id),
  satisfied_by_observation_id TEXT,
  satisfied_at INTEGER,
  expired_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CONSTRAINT wait_condition_status_check
    CHECK (status IN ('waiting','satisfied','expired','cancelled')),
  CONSTRAINT wait_condition_kind_check
    CHECK (kind IN (
      'gmail.thread_reply',
      'github.pull_request_state',
      'mercury.transaction_state',
      'http.response',
      'filesystem.artifact'
    )),
  CONSTRAINT wait_condition_schema_version_check CHECK (schema_version > 0),
  CONSTRAINT wait_condition_parameters_json_check CHECK (json_valid(parameters)),
  CONSTRAINT wait_condition_deadline_check
    CHECK (deadline_at IS NULL OR deadline_at > not_before),
  CONSTRAINT wait_condition_fallback_kind_check
    CHECK (fallback_kind IN ('none','create_task','activate_task')),
  CONSTRAINT wait_condition_fallback_json_check
    CHECK (fallback_spec IS NULL OR json_valid(fallback_spec)),
  CONSTRAINT wait_condition_fallback_shape_check CHECK (
    (fallback_kind = 'none' AND fallback_spec IS NULL AND fallback_target_task_id IS NULL)
    OR
    (fallback_kind = 'create_task' AND fallback_spec IS NOT NULL AND fallback_target_task_id IS NULL)
    OR
    (fallback_kind = 'activate_task' AND fallback_spec IS NULL AND fallback_target_task_id IS NOT NULL)
  ),
  CONSTRAINT wait_condition_no_self_supersession_check
    CHECK (supersedes_condition_id IS NULL OR supersedes_condition_id <> id),
  CONSTRAINT wait_condition_lifecycle_check CHECK (
    (
      status = 'waiting'
      AND satisfied_at IS NULL
      AND satisfied_by_observation_id IS NULL
      AND expired_at IS NULL
      AND cancelled_at IS NULL
      AND cancel_reason IS NULL
      AND fallback_result_task_id IS NULL
    )
    OR
    (
      status = 'satisfied'
      AND satisfied_at IS NOT NULL
      AND satisfied_by_observation_id IS NOT NULL
      AND expired_at IS NULL
      AND cancelled_at IS NULL
      AND cancel_reason IS NULL
      AND fallback_result_task_id IS NULL
    )
    OR
    (
      status = 'expired'
      AND satisfied_at IS NULL
      AND satisfied_by_observation_id IS NULL
      AND expired_at IS NOT NULL
      AND deadline_at IS NOT NULL
      AND expired_at >= deadline_at
      AND cancelled_at IS NULL
      AND cancel_reason IS NULL
      AND (
        (fallback_kind = 'none' AND fallback_result_task_id IS NULL)
        OR
        (fallback_kind IN ('create_task','activate_task') AND fallback_result_task_id IS NOT NULL)
      )
    )
    OR
    (
      status = 'cancelled'
      AND satisfied_at IS NULL
      AND satisfied_by_observation_id IS NULL
      AND expired_at IS NULL
      AND cancelled_at IS NOT NULL
      AND cancelled_at >= created_at
      AND cancel_reason IS NOT NULL
      AND length(trim(cancel_reason)) > 0
      AND fallback_result_task_id IS NULL
    )
  ),
  CONSTRAINT wait_condition_chronology_check CHECK (
    updated_at >= created_at
    AND (satisfied_at IS NULL OR satisfied_at >= created_at)
    AND (expired_at IS NULL OR expired_at >= created_at)
  )
);

CREATE INDEX idx_wait_condition_task_status
  ON wait_condition(tenant_id, task_id, status, created_at);

CREATE INDEX idx_wait_condition_due
  ON wait_condition(tenant_id, status, deadline_at);

CREATE INDEX idx_wait_condition_kind
  ON wait_condition(tenant_id, kind, schema_version, status);

CREATE UNIQUE INDEX uniq_wait_condition_supersedes
  ON wait_condition(tenant_id, supersedes_condition_id)
  WHERE supersedes_condition_id IS NOT NULL;

-- Cross-row guards are additive triggers because SQLite cannot express them
-- as CHECK constraints. The service mirrors each rule with a useful error.
CREATE TRIGGER wait_condition_validate_insert
BEFORE INSERT ON wait_condition
WHEN length(trim(NEW.kind)) = 0
  OR NOT EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id
      AND task.tenant_id = NEW.tenant_id
      AND task.deleted_at IS NULL
      AND task.status NOT IN ('done','cancelled')
  )
  OR (
    NEW.fallback_target_task_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM task
      WHERE task.id = NEW.fallback_target_task_id
        AND task.tenant_id = NEW.tenant_id
        AND task.deleted_at IS NULL
        AND task.status NOT IN ('done','cancelled')
    )
  )
  OR (
    NEW.supersedes_condition_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM wait_condition
      WHERE wait_condition.id = NEW.supersedes_condition_id
        AND wait_condition.tenant_id = NEW.tenant_id
        AND wait_condition.task_id = NEW.task_id
        AND wait_condition.status = 'waiting'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid wait condition relationship');
END;

CREATE TRIGGER wait_condition_identity_immutable
BEFORE UPDATE ON wait_condition
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.parameters IS NOT OLD.parameters
  OR NEW.not_before IS NOT OLD.not_before
  OR NEW.deadline_at IS NOT OLD.deadline_at
  OR NEW.fallback_kind IS NOT OLD.fallback_kind
  OR NEW.fallback_spec IS NOT OLD.fallback_spec
  OR NEW.fallback_target_task_id IS NOT OLD.fallback_target_task_id
  OR NEW.supersedes_condition_id IS NOT OLD.supersedes_condition_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'wait condition identity is immutable');
END;

CREATE TRIGGER wait_condition_transition_guard
BEFORE UPDATE ON wait_condition
WHEN OLD.status <> 'waiting'
  OR NEW.status = 'waiting'
  OR NEW.status NOT IN ('satisfied','expired','cancelled')
BEGIN
  SELECT RAISE(ABORT, 'wait condition may transition from waiting exactly once');
END;

CREATE TRIGGER wait_condition_no_delete
BEFORE DELETE ON wait_condition
BEGIN
  SELECT RAISE(ABORT, 'wait condition history is append-only');
END;

CREATE TRIGGER task_no_terminal_with_waiting_condition
BEFORE UPDATE OF status, deleted_at ON task
WHEN (NEW.status IN ('done','cancelled') OR NEW.deleted_at IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM wait_condition
    WHERE wait_condition.tenant_id = NEW.tenant_id
      AND wait_condition.task_id = NEW.id
      AND wait_condition.status = 'waiting'
  )
BEGIN
  SELECT RAISE(ABORT, 'terminal or deleted task cannot have waiting conditions');
END;
