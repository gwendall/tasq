-- TQ-503: reusable knowledge remains external; Tasq stores only append-only links.

CREATE TABLE external_context_link (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  purpose_uri TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('attach','detach')),
  supersedes_link_id TEXT REFERENCES external_context_link(id),
  system TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  version TEXT,
  digest TEXT,
  actor TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principal(id),
  created_at INTEGER NOT NULL,
  CHECK (action = 'attach' OR supersedes_link_id IS NOT NULL),
  CHECK (
    length(trim(purpose_uri)) BETWEEN 1 AND 2000 AND
    length(trim(system)) BETWEEN 1 AND 2000 AND
    length(trim(resource_type)) BETWEEN 1 AND 120 AND
    length(trim(external_id)) BETWEEN 1 AND 1000 AND
    (url IS NULL OR length(trim(url)) BETWEEN 1 AND 2000) AND
    (version IS NULL OR length(trim(version)) BETWEEN 1 AND 500) AND
    (digest IS NULL OR length(trim(digest)) BETWEEN 1 AND 500) AND
    length(trim(actor)) BETWEEN 1 AND 500 AND
    created_at >= 0
  )
);

CREATE UNIQUE INDEX uniq_external_context_link_root
  ON external_context_link (
    tenant_id, task_id, purpose_uri, system, resource_type, external_id
  ) WHERE supersedes_link_id IS NULL;
CREATE UNIQUE INDEX uniq_external_context_link_child
  ON external_context_link (tenant_id, supersedes_link_id)
  WHERE supersedes_link_id IS NOT NULL;
CREATE INDEX idx_external_context_link_task
  ON external_context_link (tenant_id, task_id, created_at);
CREATE INDEX idx_external_context_link_target
  ON external_context_link (tenant_id, system, resource_type, external_id);

CREATE TRIGGER external_context_link_no_update
BEFORE UPDATE ON external_context_link
BEGIN SELECT RAISE(ABORT, 'external context links are immutable'); END;

CREATE TRIGGER external_context_link_no_delete
BEFORE DELETE ON external_context_link
BEGIN SELECT RAISE(ABORT, 'external context links are append-only'); END;

CREATE TRIGGER external_context_link_workspace_guard
BEFORE INSERT ON external_context_link
BEGIN
  SELECT RAISE(ABORT, 'external context link task workspace mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM task
      WHERE id = NEW.task_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL
    );
  SELECT RAISE(ABORT, 'external context link principal workspace mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM principal
      WHERE id = NEW.principal_id AND tenant_id = NEW.tenant_id AND status = 'enabled'
    );
  SELECT RAISE(ABORT, 'external context link parent mismatch')
    WHERE NEW.supersedes_link_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM external_context_link AS parent
      WHERE parent.id = NEW.supersedes_link_id
        AND parent.tenant_id = NEW.tenant_id
        AND parent.task_id = NEW.task_id
        AND parent.purpose_uri = NEW.purpose_uri
        AND parent.system = NEW.system
        AND parent.resource_type = NEW.resource_type
        AND parent.external_id = NEW.external_id
    );
  SELECT RAISE(ABORT, 'external context link duplicate detach')
    WHERE NEW.action = 'detach' AND EXISTS (
      SELECT 1 FROM external_context_link AS parent
      WHERE parent.id = NEW.supersedes_link_id AND parent.action = 'detach'
    );
END;
