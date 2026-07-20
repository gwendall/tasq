-- tasq v0.3 — first-class peer task dependency (SPEC §4.5).
--
-- A directed edge between two tasks. `type='blocks'` means `from_task_id`
-- blocks `to_task_id` (the dependent's actionability changes when the
-- blocker resolves). `relates_to` / `duplicates` are informational.
--
-- Dependencies have no `cancelled` state — DELETE = soft-delete (SPEC §5.3),
-- so the UNIQUE index is PARTIAL (WHERE deleted_at IS NULL) to let an edge be
-- re-added after removal. The service layer enforces the recursive cycle guard
-- for `blocks` (no SQLite recursive trigger), mirroring the reparent guard.
--
-- Forward-compat: purely additive. Mirrors the Drizzle `taskDependency` table.

CREATE TABLE IF NOT EXISTS task_dependency (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  from_task_id TEXT NOT NULL REFERENCES task(id),
  to_task_id TEXT NOT NULL REFERENCES task(id),
  type TEXT NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks','relates_to','duplicates')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_task_dep
  ON task_dependency(tenant_id, from_task_id, to_task_id, type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_dep_to
  ON task_dependency(tenant_id, to_task_id, type, deleted_at);

CREATE INDEX IF NOT EXISTS idx_task_dep_from
  ON task_dependency(tenant_id, from_task_id, type, deleted_at);
