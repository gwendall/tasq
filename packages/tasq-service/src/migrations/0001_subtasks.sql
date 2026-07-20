-- tasq v0.2 — sub-task hierarchy.
--
-- Adds `parent_task_id` to `task`. NULL = top-level task.
-- App-level invariants (cycle prevention + depth limit) enforced in the
-- service layer because SQLite has no recursive trigger primitive worth
-- maintaining here.
--
-- Forward-compat: this is purely additive. Pre-v0.2 rows have
-- parent_task_id IS NULL ; behaviour is unchanged for them.

ALTER TABLE task ADD COLUMN parent_task_id TEXT REFERENCES task(id);

CREATE INDEX IF NOT EXISTS idx_task_parent ON task(tenant_id, parent_task_id, status)
  WHERE parent_task_id IS NOT NULL;
