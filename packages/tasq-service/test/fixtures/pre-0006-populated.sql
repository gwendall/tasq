-- Static historical fixture: database shape immediately after 0005_idempotency.
--
-- Keep this independent from the current migration implementation. Its purpose
-- is to prove that the full runner upgrades real pre-agentic state rather than
-- merely proving that a fresh database can be created.

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
  deleted_at INTEGER,
  parent_task_id TEXT REFERENCES task(id),
  recurrence TEXT,
  recurrence_interval INTEGER NOT NULL DEFAULT 1,
  recurrence_anchor TEXT NOT NULL DEFAULT 'due',
  last_done_at INTEGER,
  streak INTEGER NOT NULL DEFAULT 0,
  recurrence_parent_id TEXT REFERENCES task(id)
);
CREATE INDEX idx_task_status ON task(tenant_id, status, deleted_at);
CREATE INDEX idx_task_goal ON task(tenant_id, goal_id, status);
CREATE INDEX idx_task_area ON task(tenant_id, area_id, status);
CREATE INDEX idx_task_project ON task(tenant_id, project_id, status);
CREATE INDEX idx_task_scheduled ON task(tenant_id, scheduled_at);
CREATE INDEX idx_task_due ON task(tenant_id, due_at);
CREATE INDEX idx_task_parent ON task(tenant_id, parent_task_id, status)
  WHERE parent_task_id IS NOT NULL;
CREATE INDEX idx_task_recurrence_parent ON task(tenant_id, recurrence_parent_id)
  WHERE recurrence_parent_id IS NOT NULL;

CREATE TABLE task_dependency (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  from_task_id TEXT NOT NULL REFERENCES task(id),
  to_task_id TEXT NOT NULL REFERENCES task(id),
  type TEXT NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks','relates_to','duplicates')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX uniq_task_dep
  ON task_dependency(tenant_id, from_task_id, to_task_id, type)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_task_dep_to
  ON task_dependency(tenant_id, to_task_id, type, deleted_at);
CREATE INDEX idx_task_dep_from
  ON task_dependency(tenant_id, from_task_id, type, deleted_at);

CREATE TABLE event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  actor TEXT NOT NULL DEFAULT 'system',
  entity_type TEXT NOT NULL CHECK (entity_type IN ('area','goal','project','task')),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_event_entity ON event(tenant_id, entity_type, entity_id, sequence);
CREATE INDEX idx_event_recent ON event(tenant_id, sequence);
CREATE INDEX idx_event_actor ON event(tenant_id, actor, sequence);

CREATE TABLE idempotency_key (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uniq_idempotency_tenant_key
  ON idempotency_key (tenant_id, key);

-- Historical stores did not yet carry migration checksums. The current runner
-- must backfill them while applying only migrations newer than this snapshot.
CREATE TABLE _migration (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

INSERT INTO area VALUES (
  '01900000-0000-7000-8000-000000000001', 'gwendall', 'Kami', 'kami', 5,
  'weekly', 'Company and product work', '{"importedFrom":"_life"}',
  1700000000000, 1700000001000, NULL
);

INSERT INTO goal VALUES (
  '01900000-0000-7000-8000-000000000002', 'gwendall',
  '01900000-0000-7000-8000-000000000001', 'Ship Tasq',
  'Build the durable commitment layer', 'Q3 2026', 5, 'active',
  1788134400000, '{"legacyId":"G-7"}', 1700000002000, 1700000003000, NULL
);

INSERT INTO project VALUES (
  '01900000-0000-7000-8000-000000000003', 'gwendall',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000001',
  'Tasq standalone', 'Extract and harden the ledger', 'active',
  '{"source":"legacy-project"}', 1700000004000, 1700000005000, NULL
);

INSERT INTO task VALUES (
  '01900000-0000-7000-8000-000000000010', 'gwendall',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000001',
  'Legacy root task', 'Must survive the agentic migration',
  'Open the migration test', 'open', 5, 45, 1700100000000, 1700200000000,
  NULL, NULL, '{"legacyId":"42","tags":["migration","critical"]}',
  1700000006000, 1700000007000, NULL, NULL,
  NULL, 1, 'due', NULL, 0, NULL
);

INSERT INTO task VALUES (
  '01900000-0000-7000-8000-000000000011', 'gwendall',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000001',
  'Legacy child task', NULL, 'Wait for the blocker', 'blocked', 4, 15,
  NULL, NULL, NULL, NULL, '{}', 1700000008000, 1700000009000, NULL,
  '01900000-0000-7000-8000-000000000010',
  NULL, 1, 'due', NULL, 0, NULL
);

INSERT INTO task VALUES (
  '01900000-0000-7000-8000-000000000012', 'gwendall',
  '01900000-0000-7000-8000-000000000003',
  '01900000-0000-7000-8000-000000000002',
  '01900000-0000-7000-8000-000000000001',
  'Completed blocker', NULL, NULL, 'done', 3, 10,
  NULL, 1700300000000, 1700000010000, 1700000020000, '{}',
  1700000010000, 1700000020000, NULL, NULL,
  NULL, 1, 'due', 1700000020000, 1, NULL
);

INSERT INTO task VALUES (
  '01900000-0000-7000-8000-000000000013', 'gwendall',
  NULL, NULL, '01900000-0000-7000-8000-000000000001',
  'Weekly review', NULL, 'Open the weekly review', 'done', 4, 30,
  NULL, 1700400000000, 1700000030000, 1700000040000,
  '{"ritual":true}', 1700000030000, 1700000040000, NULL, NULL,
  'weekly', 2, 'due', 1700000040000, 4, NULL
);

INSERT INTO task VALUES (
  '01900000-0000-7000-8000-000000000014', 'gwendall',
  NULL, NULL, '01900000-0000-7000-8000-000000000001',
  'Old deleted task', NULL, NULL, 'cancelled', 1, NULL,
  NULL, NULL, NULL, NULL, '{"reason":"obsolete"}',
  1700000050000, 1700000060000, 1700000060000, NULL,
  NULL, 1, 'due', NULL, 0, NULL
);

INSERT INTO task_dependency VALUES (
  '01900000-0000-7000-8000-000000000020', 'gwendall',
  '01900000-0000-7000-8000-000000000012',
  '01900000-0000-7000-8000-000000000011',
  'blocks', 1700000011000, 1700000011000, NULL
);

INSERT INTO event (
  sequence, id, tenant_id, actor, entity_type, entity_id, event_type,
  payload, occurred_at, created_at
) VALUES
  (3, '01900000-0000-7000-8000-000000000030', 'gwendall', 'migrate-from-life',
   'area', '01900000-0000-7000-8000-000000000001', 'created',
   '{"slug":"kami"}', 1699999999000, 1700000000000),
  (7, '01900000-0000-7000-8000-000000000031', 'gwendall', 'migrate-from-life',
   'task', '01900000-0000-7000-8000-000000000010', 'created',
   '{"legacyId":"42"}', NULL, 1700000006000),
  (11, '01900000-0000-7000-8000-000000000032', 'gwendall', 'gwendall',
   'task', '01900000-0000-7000-8000-000000000012', 'completed',
   '{"note":"historical completion"}', 1700000020000, 1700000020000);

INSERT INTO idempotency_key VALUES (
  'gwendall', 'legacy-import-task-42', 'task.create',
  '4f830d49750f5a32f74e2e7d0a5f7474d3d1661454ad095d22fd098c8c365f21',
  '01900000-0000-7000-8000-000000000010', 1700000006000
);

INSERT INTO _migration (id, name, applied_at) VALUES
  (1, '0000_init.sql', 1699999900000),
  (2, '0001_subtasks.sql', 1699999910000),
  (3, '0002_task_dependency.sql', 1699999920000),
  (4, '0003_recurrence.sql', 1699999930000),
  (5, '0004_event_sequence.sql', 1699999940000),
  (6, '0005_idempotency.sql', 1699999950000);
