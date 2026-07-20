-- TQ-502: append-only semantic compaction. Raw task/audit/evidence rows remain
-- authoritative and are never deleted or rewritten by this projection.

CREATE TABLE commitment_summary (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id),
  supersedes_summary_id TEXT REFERENCES commitment_summary(id),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 8000),
  summary_digest TEXT NOT NULL CHECK (
    summary_digest GLOB 'sha256:[0-9a-f]*' AND length(summary_digest) = 71
  ),
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  source_status TEXT NOT NULL CHECK (source_status IN ('done','cancelled')),
  source_event_sequence INTEGER NOT NULL CHECK (source_event_sequence >= 0),
  source_digest TEXT NOT NULL CHECK (
    source_digest GLOB 'sha256:[0-9a-f]*' AND length(source_digest) = 71
  ),
  source_refs TEXT NOT NULL CHECK (json_valid(source_refs) AND json_type(source_refs) = 'object'),
  actor TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principal(id),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX uniq_commitment_summary_root
  ON commitment_summary(tenant_id, task_id) WHERE supersedes_summary_id IS NULL;
CREATE UNIQUE INDEX uniq_commitment_summary_child
  ON commitment_summary(tenant_id, supersedes_summary_id) WHERE supersedes_summary_id IS NOT NULL;
CREATE INDEX idx_commitment_summary_task
  ON commitment_summary(tenant_id, task_id, created_at);

CREATE TRIGGER commitment_summary_insert_guard
BEFORE INSERT ON commitment_summary
WHEN NOT EXISTS (
    SELECT 1 FROM task
    WHERE task.id = NEW.task_id
      AND task.tenant_id = NEW.tenant_id
      AND task.deleted_at IS NULL
      AND task.status IN ('done','cancelled')
      AND task.status = NEW.source_status
      AND task.revision = NEW.source_revision
  )
  OR NOT EXISTS (
    SELECT 1 FROM principal
    WHERE principal.id = NEW.principal_id
      AND principal.tenant_id = NEW.tenant_id
      AND principal.status = 'enabled'
  )
  OR length(trim(NEW.actor)) = 0
  OR (
    NEW.supersedes_summary_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM commitment_summary prior
      WHERE prior.id = NEW.supersedes_summary_id
        AND prior.tenant_id = NEW.tenant_id
        AND prior.task_id = NEW.task_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid commitment summary invariant');
END;

CREATE TRIGGER commitment_summary_no_update
BEFORE UPDATE ON commitment_summary
BEGIN
  SELECT RAISE(ABORT, 'commitment summaries are append-only');
END;

CREATE TRIGGER commitment_summary_no_delete
BEFORE DELETE ON commitment_summary
BEGIN
  SELECT RAISE(ABORT, 'commitment summaries are append-only');
END;
