-- TQ-105: harden the service's exactly-once deadline fallback contract at
-- the storage boundary. The wait lifecycle CHECK already enforces result
-- presence; this trigger validates the result's meaning and tenant.

CREATE TRIGGER wait_condition_expiry_fallback_validate
BEFORE UPDATE ON wait_condition
WHEN NEW.status = 'expired'
  AND (
    (
      NEW.fallback_kind = 'activate_task'
      AND (
        NEW.fallback_result_task_id IS NOT NEW.fallback_target_task_id
        OR NOT EXISTS (
          SELECT 1 FROM task
          WHERE task.id = NEW.fallback_result_task_id
            AND task.tenant_id = NEW.tenant_id
            AND task.deleted_at IS NULL
            AND task.status NOT IN ('done','cancelled')
        )
      )
    )
    OR
    (
      NEW.fallback_kind = 'create_task'
      AND NOT EXISTS (
        SELECT 1 FROM task
        WHERE task.id = NEW.fallback_result_task_id
          AND task.tenant_id = NEW.tenant_id
          AND task.deleted_at IS NULL
          AND json_extract(task.metadata, '$.waitFallback.conditionId') = NEW.id
          AND json_extract(task.metadata, '$.waitFallback.sourceTaskId') = NEW.task_id
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid wait deadline fallback result');
END;
