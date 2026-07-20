-- tasq-zero — initial schema migration.
-- Manual SQL to match the Drizzle table definitions in
-- @kami/tasq-schema. Kept manual (vs drizzle-kit autogen) to be 100%
-- inspectable and to encode CHECK constraints + indexes explicitly.

CREATE TABLE IF NOT EXISTS area (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  cadence_target TEXT,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_area_tenant_slug ON area(tenant_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_area_tenant_name ON area(tenant_id, name);

CREATE TABLE IF NOT EXISTS goal (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  area_id TEXT NOT NULL REFERENCES area(id),
  title TEXT NOT NULL,
  description TEXT,
  horizon TEXT,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','abandoned')),
  target_date INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goal_area ON goal(tenant_id, area_id, status);
CREATE INDEX IF NOT EXISTS idx_goal_status ON goal(tenant_id, status, deleted_at);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  goal_id TEXT REFERENCES goal(id),
  area_id TEXT REFERENCES area(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','waiting','done','cancelled')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_project_status ON project(tenant_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_project_goal ON project(tenant_id, goal_id, status);
CREATE INDEX IF NOT EXISTS idx_project_area ON project(tenant_id, area_id, status);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  project_id TEXT REFERENCES project(id),
  goal_id TEXT REFERENCES goal(id),
  area_id TEXT REFERENCES area(id),
  title TEXT NOT NULL,
  description TEXT,
  next_action TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  priority INTEGER CHECK (priority IS NULL OR priority BETWEEN 1 AND 5),
  estimated_minutes INTEGER CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  scheduled_at INTEGER,
  due_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(tenant_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_task_goal ON task(tenant_id, goal_id, status);
CREATE INDEX IF NOT EXISTS idx_task_area ON task(tenant_id, area_id, status);
CREATE INDEX IF NOT EXISTS idx_task_project ON task(tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_scheduled ON task(tenant_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_task_due ON task(tenant_id, due_at);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  actor TEXT NOT NULL DEFAULT 'gwendall',
  entity_type TEXT NOT NULL CHECK (entity_type IN ('area','goal','project','task')),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_entity ON event(tenant_id, entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_recent ON event(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_actor ON event(tenant_id, actor, created_at);

-- Migration bookkeeping
CREATE TABLE IF NOT EXISTS _migration (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);
