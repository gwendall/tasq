-- Static tasq-zero fixture. Every later migration must run against these rows.

CREATE TABLE area (
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
CREATE UNIQUE INDEX uniq_area_tenant_slug ON area(tenant_id, slug);
CREATE UNIQUE INDEX uniq_area_tenant_name ON area(tenant_id, name);

CREATE TABLE goal (
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
CREATE INDEX idx_goal_area ON goal(tenant_id, area_id, status);
CREATE INDEX idx_goal_status ON goal(tenant_id, status, deleted_at);

CREATE TABLE project (
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
CREATE INDEX idx_project_status ON project(tenant_id, status, deleted_at);
CREATE INDEX idx_project_goal ON project(tenant_id, goal_id, status);
CREATE INDEX idx_project_area ON project(tenant_id, area_id, status);

CREATE TABLE task (
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
CREATE INDEX idx_task_status ON task(tenant_id, status, deleted_at);
CREATE INDEX idx_task_goal ON task(tenant_id, goal_id, status);
CREATE INDEX idx_task_area ON task(tenant_id, area_id, status);
CREATE INDEX idx_task_project ON task(tenant_id, project_id, status);
CREATE INDEX idx_task_scheduled ON task(tenant_id, scheduled_at);
CREATE INDEX idx_task_due ON task(tenant_id, due_at);

CREATE TABLE event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  actor TEXT NOT NULL DEFAULT 'gwendall',
  entity_type TEXT NOT NULL CHECK (entity_type IN ('area','goal','project','task')),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_event_entity ON event(tenant_id, entity_type, entity_id, created_at);
CREATE INDEX idx_event_recent ON event(tenant_id, created_at);
CREATE INDEX idx_event_actor ON event(tenant_id, actor, created_at);

CREATE TABLE _migration (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

INSERT INTO area VALUES (
  '01910000-0000-7000-8000-000000000001', 'gwendall', 'Personal', 'personal', 4,
  'weekly', 'Original tasq-zero area', '{"fixture":"0000"}',
  1600000000000, 1600000001000, NULL
);

INSERT INTO goal VALUES (
  '01910000-0000-7000-8000-000000000002', 'gwendall',
  '01910000-0000-7000-8000-000000000001', 'Preserve old data', NULL,
  'Someday', 4, 'active', NULL, '{}', 1600000002000, 1600000003000, NULL
);

INSERT INTO project VALUES (
  '01910000-0000-7000-8000-000000000003', 'gwendall',
  '01910000-0000-7000-8000-000000000002',
  '01910000-0000-7000-8000-000000000001',
  'Legacy migration', NULL, 'active', '{}', 1600000004000, 1600000005000, NULL
);

INSERT INTO task VALUES (
  '01910000-0000-7000-8000-000000000010', 'gwendall',
  '01910000-0000-7000-8000-000000000003',
  '01910000-0000-7000-8000-000000000002',
  '01910000-0000-7000-8000-000000000001',
  'Tasq-zero open task', 'Oldest supported row', 'Run all migrations',
  'open', 5, 20, NULL, 1600100000000, NULL, NULL,
  '{"legacyId":"1"}', 1600000006000, 1600000007000, NULL
);

INSERT INTO task VALUES (
  '01910000-0000-7000-8000-000000000011', 'gwendall',
  '01910000-0000-7000-8000-000000000003',
  '01910000-0000-7000-8000-000000000002',
  '01910000-0000-7000-8000-000000000001',
  'Tasq-zero completed task', NULL, NULL, 'done', 3, NULL,
  NULL, NULL, 1600000008000, 1600000009000, '{}',
  1600000008000, 1600000009000, NULL
);

-- Equal timestamps force 0004 to use id as its deterministic tie-breaker.
INSERT INTO event VALUES
  ('01910000-0000-7000-8000-000000000020', 'gwendall', 'migrate-from-life',
   'task', '01910000-0000-7000-8000-000000000010', 'created',
   '{"position":1}', 1600000010000),
  ('01910000-0000-7000-8000-000000000021', 'gwendall', 'migrate-from-life',
   'task', '01910000-0000-7000-8000-000000000011', 'created',
   '{"position":2}', 1600000010000),
  ('01910000-0000-7000-8000-000000000022', 'gwendall', 'gwendall',
   'task', '01910000-0000-7000-8000-000000000011', 'completed',
   '{"position":3}', 1600000011000);

INSERT INTO _migration VALUES (1, '0000_init.sql', 1599999999000);
