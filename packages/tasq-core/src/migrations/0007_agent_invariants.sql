-- Harden the agentic primitives against direct SQL, damaged clients, and
-- partial future integrations. These triggers mirror service invariants that
-- cannot be expressed as additive SQLite CHECK constraints without rebuilding
-- populated tables.

-- Normalize deterministic denormalized fields written by pre-invariant
-- clients before installing guards. Scope is canonical from the nearest
-- ancestor; timestamps use the row's own durable history rather than wall
-- clock time at migration.
UPDATE project
SET area_id = (
  SELECT goal.area_id FROM goal
  WHERE goal.id = project.goal_id AND goal.tenant_id = project.tenant_id
)
WHERE goal_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM goal
    WHERE goal.id = project.goal_id
      AND goal.tenant_id = project.tenant_id
      AND project.area_id IS NOT goal.area_id
  );

UPDATE task
SET goal_id = (
      SELECT project.goal_id FROM project
      WHERE project.id = task.project_id AND project.tenant_id = task.tenant_id
    ),
    area_id = (
      SELECT project.area_id FROM project
      WHERE project.id = task.project_id AND project.tenant_id = task.tenant_id
    )
WHERE project_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM project
    WHERE project.id = task.project_id
      AND project.tenant_id = task.tenant_id
      AND (task.goal_id IS NOT project.goal_id OR task.area_id IS NOT project.area_id)
  );

UPDATE task
SET area_id = (
  SELECT goal.area_id FROM goal
  WHERE goal.id = task.goal_id AND goal.tenant_id = task.tenant_id
)
WHERE project_id IS NULL
  AND goal_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM goal
    WHERE goal.id = task.goal_id
      AND goal.tenant_id = task.tenant_id
      AND task.area_id IS NOT goal.area_id
  );

WITH RECURSIVE canonical_task_scope(id, project_id, goal_id, area_id) AS (
  SELECT id, project_id, goal_id, area_id
  FROM task
  WHERE parent_task_id IS NULL
  UNION
  SELECT child.id, parent.project_id, parent.goal_id, parent.area_id
  FROM task AS child
  JOIN canonical_task_scope AS parent ON parent.id = child.parent_task_id
)
UPDATE task
SET project_id = (SELECT project_id FROM canonical_task_scope WHERE id = task.id),
    goal_id = (SELECT goal_id FROM canonical_task_scope WHERE id = task.id),
    area_id = (SELECT area_id FROM canonical_task_scope WHERE id = task.id)
WHERE parent_task_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM canonical_task_scope
    WHERE id = task.id
      AND (
        task.project_id IS NOT canonical_task_scope.project_id
        OR task.goal_id IS NOT canonical_task_scope.goal_id
        OR task.area_id IS NOT canonical_task_scope.area_id
      )
  );

UPDATE task
SET started_at = created_at
WHERE status = 'in_progress' AND started_at IS NULL;

UPDATE task
SET completed_at = updated_at
WHERE status = 'done' AND completed_at IS NULL;

CREATE UNIQUE INDEX uniq_task_claim_fence
  ON task_claim(tenant_id, task_id, fence);

CREATE TRIGGER task_claim_validate_insert
BEFORE INSERT ON task_claim
WHEN length(trim(NEW.actor)) = 0
  OR NEW.heartbeat_at < NEW.acquired_at
  OR NEW.expires_at <= NEW.heartbeat_at
  OR NEW.updated_at < NEW.created_at
  OR ((NEW.released_at IS NULL) != (NEW.release_reason IS NULL))
  OR (NEW.released_at IS NOT NULL AND NEW.released_at < NEW.acquired_at)
  OR (NEW.release_reason IS NOT NULL AND length(trim(NEW.release_reason)) = 0)
  OR NOT EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid task claim invariant');
END;

CREATE TRIGGER task_claim_validate_update
BEFORE UPDATE ON task_claim
WHEN length(trim(NEW.actor)) = 0
  OR NEW.heartbeat_at < NEW.acquired_at
  OR NEW.expires_at <= NEW.heartbeat_at
  OR NEW.updated_at < NEW.created_at
  OR ((NEW.released_at IS NULL) != (NEW.release_reason IS NULL))
  OR (NEW.released_at IS NOT NULL AND NEW.released_at < NEW.acquired_at)
  OR (NEW.release_reason IS NOT NULL AND length(trim(NEW.release_reason)) = 0)
  OR NOT EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid task claim invariant');
END;

CREATE TRIGGER task_claim_identity_immutable
BEFORE UPDATE ON task_claim
WHEN OLD.released_at IS NOT NULL
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.actor IS NOT OLD.actor
  OR NEW.fence IS NOT OLD.fence
  OR NEW.acquired_at IS NOT OLD.acquired_at
  OR NEW.metadata IS NOT OLD.metadata
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'task claim identity and released claims are immutable');
END;

CREATE TRIGGER task_claim_no_delete
BEFORE DELETE ON task_claim
BEGIN
  SELECT RAISE(ABORT, 'task claim history is append-only');
END;

CREATE TRIGGER task_attempt_validate_insert
BEFORE INSERT ON task_attempt
WHEN length(trim(NEW.actor)) = 0
  OR length(trim(NEW.runtime)) = 0
  OR (
    NEW.status IN ('succeeded','failed','cancelled')
    AND NEW.ended_at IS NULL
  )
  OR (
    NEW.status IN ('running','input_required')
    AND NEW.ended_at IS NOT NULL
  )
  OR (NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at)
  OR NOT EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id
  )
  OR (
    NEW.claim_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_claim
      WHERE task_claim.id = NEW.claim_id
        AND task_claim.tenant_id = NEW.tenant_id
        AND task_claim.task_id = NEW.task_id
        AND task_claim.actor = NEW.actor
    )
  )
  OR (
    NEW.status IN ('running','input_required')
    AND EXISTS (
      SELECT 1 FROM task
      WHERE task.id = NEW.task_id
        AND (task.deleted_at IS NOT NULL OR task.status IN ('done','cancelled'))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid task attempt invariant');
END;

CREATE TRIGGER task_attempt_validate_update
BEFORE UPDATE ON task_attempt
WHEN (
    NEW.status IN ('succeeded','failed','cancelled')
    AND NEW.ended_at IS NULL
  )
  OR (
    NEW.status IN ('running','input_required')
    AND NEW.ended_at IS NOT NULL
  )
  OR (NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at)
  OR (
    NEW.status IN ('running','input_required')
    AND EXISTS (
      SELECT 1 FROM task
      WHERE task.id = NEW.task_id
        AND (task.deleted_at IS NOT NULL OR task.status IN ('done','cancelled'))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid task attempt lifecycle');
END;

CREATE TRIGGER task_attempt_identity_immutable
BEFORE UPDATE ON task_attempt
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.claim_id IS NOT OLD.claim_id
  OR NEW.actor IS NOT OLD.actor
  OR NEW.runtime IS NOT OLD.runtime
  OR NEW.external_id IS NOT OLD.external_id
  OR NEW.context_id IS NOT OLD.context_id
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.metadata IS NOT OLD.metadata
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'task attempt identity is immutable');
END;

CREATE TRIGGER task_attempt_terminal_immutable
BEFORE UPDATE ON task_attempt
WHEN OLD.status IN ('succeeded','failed','cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal task attempts are immutable');
END;

CREATE TRIGGER task_attempt_no_delete
BEFORE DELETE ON task_attempt
BEGIN
  SELECT RAISE(ABORT, 'task attempt history is append-only');
END;

CREATE TRIGGER task_no_terminal_with_active_attempt
BEFORE UPDATE OF status, deleted_at ON task
WHEN (NEW.status IN ('done','cancelled') OR NEW.deleted_at IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM task_attempt
    WHERE task_attempt.tenant_id = NEW.tenant_id
      AND task_attempt.task_id = NEW.id
      AND task_attempt.status IN ('running','input_required')
  )
BEGIN
  SELECT RAISE(ABORT, 'terminal or deleted task cannot have active attempts');
END;

CREATE TRIGGER task_no_active_attempt_after_terminal
BEFORE UPDATE OF status ON task_attempt
WHEN NEW.status IN ('running','input_required')
  AND EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id
      AND task.tenant_id = NEW.tenant_id
      AND (task.deleted_at IS NOT NULL OR task.status IN ('done','cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot activate an attempt for a terminal or deleted task');
END;

CREATE TRIGGER task_evidence_validate_insert
BEFORE INSERT ON task_evidence
WHEN length(trim(NEW.actor)) = 0
  OR length(trim(NEW.kind)) = 0
  OR (
    (NEW.summary IS NULL OR length(trim(NEW.summary)) = 0)
    AND (NEW.uri IS NULL OR length(trim(NEW.uri)) = 0)
  )
  OR NOT EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id AND task.tenant_id = NEW.tenant_id
  )
  OR (
    NEW.attempt_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_attempt
      WHERE task_attempt.id = NEW.attempt_id
        AND task_attempt.tenant_id = NEW.tenant_id
        AND task_attempt.task_id = NEW.task_id
    )
  )
  OR NEW.supersedes_evidence_id = NEW.id
  OR (
    NEW.supersedes_evidence_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_evidence
      WHERE task_evidence.id = NEW.supersedes_evidence_id
        AND task_evidence.tenant_id = NEW.tenant_id
        AND task_evidence.task_id = NEW.task_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid task evidence invariant');
END;

CREATE TRIGGER task_evidence_no_update
BEFORE UPDATE ON task_evidence
BEGIN
  SELECT RAISE(ABORT, 'task evidence is append-only');
END;

CREATE TRIGGER task_evidence_no_delete
BEFORE DELETE ON task_evidence
BEGIN
  SELECT RAISE(ABORT, 'task evidence is append-only');
END;

CREATE TRIGGER task_evidence_mode_requires_criteria_insert
BEFORE INSERT ON task
WHEN NEW.completion_mode = 'evidence'
  AND (NEW.success_criteria IS NULL OR length(trim(NEW.success_criteria)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'evidence completion mode requires success criteria');
END;

CREATE TRIGGER task_evidence_mode_requires_criteria_update
BEFORE UPDATE OF completion_mode, success_criteria ON task
WHEN NEW.completion_mode = 'evidence'
  AND (NEW.success_criteria IS NULL OR length(trim(NEW.success_criteria)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'evidence completion mode requires success criteria');
END;
