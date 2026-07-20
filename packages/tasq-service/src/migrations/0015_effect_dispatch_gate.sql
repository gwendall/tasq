-- TQ-205: the executing transition must bind one active attempt to its live
-- claim/fence. Provider-specific scope/limit evaluation remains in trusted
-- connector policy code and is repeated at the connector boundary.

CREATE TRIGGER effect_execution_attempt_guard BEFORE UPDATE ON effect
WHEN NEW.status = 'executing'
BEGIN
  SELECT RAISE(ABORT, 'effect execution requires a live nonterminal commitment')
    WHERE NOT EXISTS (
      SELECT 1 FROM task t WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id AND
        t.deleted_at IS NULL AND t.status NOT IN ('done','cancelled'));
  SELECT RAISE(ABORT, 'effect execution requires a running attempt bound to its claim')
    WHERE NEW.attempt_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM task_attempt a
      JOIN task_claim c ON c.id = NEW.claim_id
      WHERE a.id = NEW.attempt_id AND a.tenant_id = NEW.tenant_id AND
        a.task_id = NEW.task_id AND a.status = 'running' AND
        a.claim_id = NEW.claim_id AND a.principal_id IS NOT NULL AND
        c.tenant_id = NEW.tenant_id AND c.task_id = NEW.task_id AND
        c.principal_id = a.principal_id AND c.fence = NEW.fence AND
        c.released_at IS NULL AND c.expires_at > NEW.execution_started_at);
END;
