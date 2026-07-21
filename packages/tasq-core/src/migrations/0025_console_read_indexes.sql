-- TQ-701: bounded operator pages must seek through indexes, not sort full ledgers.

CREATE INDEX IF NOT EXISTS idx_console_work
  ON task(tenant_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status NOT IN ('done','cancelled');

CREATE INDEX IF NOT EXISTS idx_console_actors
  ON principal(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_console_claims
  ON task_claim(tenant_id, acquired_at DESC, id DESC)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_console_resources
  ON resource_lease(workspace_id, acquired_at DESC, id DESC)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_console_waits
  ON wait_condition(tenant_id, created_at DESC, id DESC)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_console_effects
  ON effect(tenant_id, created_at DESC, id DESC)
  WHERE status IN ('proposed','authorized','executing','indeterminate');

CREATE INDEX IF NOT EXISTS idx_console_delivery_status
  ON delivery_outbox(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_console_replication_outgoing_status
  ON replication_outgoing_operation(workspace_id, status);
