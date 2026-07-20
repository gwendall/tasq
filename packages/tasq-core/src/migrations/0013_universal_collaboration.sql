-- UK-006: universal collaboration identities and records.
-- Additive only: historical actor strings and task_dependency remain v1
-- compatibility fields while canonical principal/relation records are added.

CREATE TABLE principal (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  kind TEXT NOT NULL CHECK (kind IN ('human','agent','service','runtime')),
  display_name TEXT NOT NULL,
  local_alias TEXT,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, local_alias)
);
CREATE INDEX idx_principal_status ON principal (tenant_id, status, updated_at);

-- Every historical attribution becomes a stable local self-asserted principal.
-- hex(UTF-8 bytes) makes the identity deterministic without a host clock/hash.
INSERT OR IGNORE INTO principal
  (id, tenant_id, kind, display_name, local_alias, status, metadata, revision, created_at, updated_at)
SELECT
  'urn:tasq:local-principal:' || lower(hex(CAST(tenant_id AS BLOB))) || ':' || lower(hex(CAST(actor AS BLOB))),
  tenant_id,
  CASE WHEN actor = 'system' THEN 'service' ELSE 'agent' END,
  actor,
  actor,
  'enabled',
  '{}',
  1,
  first_seen,
  first_seen
FROM (
  SELECT tenant_id, actor, min(seen_at) AS first_seen FROM (
    SELECT tenant_id, actor, created_at AS seen_at FROM event
    UNION ALL SELECT tenant_id, actor, created_at FROM task_claim
    UNION ALL SELECT tenant_id, actor, created_at FROM task_attempt
    UNION ALL SELECT tenant_id, actor, created_at FROM task_evidence
    UNION ALL SELECT tenant_id, 'system' AS actor, created_at FROM task
  ) GROUP BY tenant_id, actor
);

ALTER TABLE task ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event ADD COLUMN principal_id TEXT REFERENCES principal(id);
ALTER TABLE task_claim ADD COLUMN principal_id TEXT REFERENCES principal(id);
ALTER TABLE task_attempt ADD COLUMN principal_id TEXT REFERENCES principal(id);
ALTER TABLE task_evidence ADD COLUMN principal_id TEXT REFERENCES principal(id);
ALTER TABLE task_claim ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE task_attempt ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

UPDATE event SET principal_id = (
  SELECT id FROM principal p WHERE p.tenant_id = event.tenant_id AND p.local_alias = event.actor
);
UPDATE task_claim SET principal_id = (
  SELECT id FROM principal p WHERE p.tenant_id = task_claim.tenant_id AND p.local_alias = task_claim.actor
);
UPDATE task_attempt SET principal_id = (
  SELECT id FROM principal p WHERE p.tenant_id = task_attempt.tenant_id AND p.local_alias = task_attempt.actor
);
UPDATE task_evidence SET principal_id = (
  SELECT id FROM principal p WHERE p.tenant_id = task_evidence.tenant_id AND p.local_alias = task_evidence.actor
);

CREATE INDEX idx_event_principal ON event (tenant_id, principal_id, sequence);
CREATE INDEX idx_task_claim_principal ON task_claim (tenant_id, principal_id, expires_at);
CREATE INDEX idx_task_attempt_principal ON task_attempt (tenant_id, principal_id, updated_at);
CREATE INDEX idx_task_evidence_principal ON task_evidence (tenant_id, principal_id, created_at);

CREATE TABLE commitment_relation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  from_task_id TEXT NOT NULL REFERENCES task(id),
  relation_type TEXT NOT NULL,
  to_task_id TEXT NOT NULL REFERENCES task(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  created_at INTEGER NOT NULL,
  ended_by_principal_id TEXT REFERENCES principal(id),
  ended_at INTEGER,
  CHECK (from_task_id <> to_task_id),
  CHECK ((ended_at IS NULL AND ended_by_principal_id IS NULL) OR
         (ended_at IS NOT NULL AND ended_by_principal_id IS NOT NULL AND ended_at >= created_at))
);
CREATE UNIQUE INDEX uniq_commitment_relation_active
  ON commitment_relation (tenant_id, from_task_id, relation_type, to_task_id)
  WHERE ended_at IS NULL;
CREATE INDEX idx_commitment_relation_from
  ON commitment_relation (tenant_id, from_task_id, relation_type, ended_at);
CREATE INDEX idx_commitment_relation_to
  ON commitment_relation (tenant_id, to_task_id, relation_type, ended_at);

-- Preserve IDs and direction: historical `from blocks on to` means
-- canonical `from depends_on to`.
INSERT INTO commitment_relation
  (id, tenant_id, from_task_id, relation_type, to_task_id, revision,
   created_by_principal_id, created_at, ended_by_principal_id, ended_at)
SELECT d.id, d.tenant_id, d.from_task_id,
  CASE d.type WHEN 'blocks' THEN 'depends_on' ELSE d.type END,
  d.to_task_id, 1, p.id, d.created_at,
  CASE WHEN d.deleted_at IS NULL THEN NULL ELSE p.id END,
  d.deleted_at
FROM task_dependency d
JOIN principal p ON p.tenant_id = d.tenant_id AND p.local_alias = 'system';

CREATE TABLE assignment (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  assigner_principal_id TEXT NOT NULL REFERENCES principal(id),
  assignee_principal_id TEXT NOT NULL REFERENCES principal(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected','revoked','released')),
  instructions_ref TEXT,
  accepted_at INTEGER,
  ended_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((status = 'proposed' AND accepted_at IS NULL AND ended_at IS NULL) OR
         (status = 'accepted' AND accepted_at IS NOT NULL AND ended_at IS NULL) OR
         (status IN ('rejected','revoked') AND accepted_at IS NULL AND ended_at IS NOT NULL) OR
         (status = 'released' AND accepted_at IS NOT NULL AND ended_at IS NOT NULL))
);
CREATE INDEX idx_assignment_task ON assignment (tenant_id, task_id, status, created_at);
CREATE INDEX idx_assignment_assignee ON assignment (tenant_id, assignee_principal_id, status, updated_at);

CREATE TABLE external_ref (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  system TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  version TEXT,
  digest TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, system, resource_type, external_id)
);
CREATE INDEX idx_external_ref_record ON external_ref (tenant_id, record_type, record_id, created_at);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  attempt_id TEXT REFERENCES task_attempt(id),
  type_uri TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  name TEXT NOT NULL,
  media_type TEXT,
  uri TEXT,
  digest TEXT NOT NULL,
  inline_data_ref TEXT,
  created_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at INTEGER NOT NULL,
  CHECK (uri IS NOT NULL OR inline_data_ref IS NOT NULL)
);
CREATE INDEX idx_artifact_task ON artifact (tenant_id, task_id, created_at);
CREATE INDEX idx_artifact_attempt ON artifact (tenant_id, attempt_id, created_at);
CREATE INDEX idx_artifact_digest ON artifact (tenant_id, digest);

CREATE TABLE completion_record (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  completion_policy_uri TEXT NOT NULL,
  completion_policy_version INTEGER NOT NULL CHECK (completion_policy_version > 0),
  policy_input_digest TEXT NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids) AND json_type(evidence_ids) = 'array'),
  decided_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  decided_at INTEGER NOT NULL,
  UNIQUE (tenant_id, task_id, resulting_revision)
);
CREATE INDEX idx_completion_record_task ON completion_record (tenant_id, task_id, resulting_revision);

-- Preserve completed history without pretending that a pre-kernel decision was
-- cryptographically verified. New completions use the live policy and digest;
-- imported rows are explicitly marked as legacy/unverified.
INSERT INTO completion_record
  (id, tenant_id, task_id, resulting_revision, completion_policy_uri,
   completion_policy_version, policy_input_digest, evidence_ids,
   decided_by_principal_id, decided_at)
SELECT
  t.id, t.tenant_id, t.id, t.revision,
  'urn:tasq:completion-policy:legacy-unverified', 1,
  'legacy-unverified:' || t.id || ':' || t.revision,
  COALESCE((SELECT json_group_array(e.id) FROM task_evidence e
            WHERE e.tenant_id = t.tenant_id AND e.task_id = t.id), '[]'),
  p.id, t.completed_at
FROM task t
JOIN principal p ON p.tenant_id = t.tenant_id AND p.local_alias = 'system'
WHERE t.status = 'done' AND t.completed_at IS NOT NULL;

-- Revision guards: updates must be explicit monotone compare-and-swap steps.
CREATE TRIGGER principal_revision_guard
BEFORE UPDATE ON principal
BEGIN
  SELECT RAISE(ABORT, 'principal revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'principal identity is immutable')
    WHERE NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.local_alias IS NOT OLD.local_alias;
END;

CREATE TRIGGER task_revision_guard
BEFORE UPDATE ON task
BEGIN
  SELECT RAISE(ABORT, 'task revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
END;

CREATE TRIGGER assignment_revision_guard
BEFORE UPDATE ON assignment
BEGIN
  SELECT RAISE(ABORT, 'assignment revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'assignment identity is immutable') WHERE
    NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
    NEW.task_id <> OLD.task_id OR NEW.assigner_principal_id <> OLD.assigner_principal_id OR
    NEW.assignee_principal_id <> OLD.assignee_principal_id OR NEW.role <> OLD.role OR
    NEW.instructions_ref IS NOT OLD.instructions_ref;
END;

CREATE TRIGGER task_claim_revision_guard
BEFORE UPDATE ON task_claim
BEGIN
  SELECT RAISE(ABORT, 'claim revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
END;

CREATE TRIGGER task_attempt_revision_guard
BEFORE UPDATE ON task_attempt
BEGIN
  SELECT RAISE(ABORT, 'attempt revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
END;

CREATE TRIGGER commitment_relation_revision_guard
BEFORE UPDATE ON commitment_relation
BEGIN
  SELECT RAISE(ABORT, 'relation revision must increment by one')
    WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'relation identity or ended relation is immutable') WHERE
    NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
    NEW.from_task_id <> OLD.from_task_id OR NEW.to_task_id <> OLD.to_task_id OR
    NEW.relation_type <> OLD.relation_type OR NEW.created_by_principal_id <> OLD.created_by_principal_id OR
    NEW.created_at <> OLD.created_at OR OLD.ended_at IS NOT NULL;
END;

-- Append-only collaboration outputs. Corrections are new records/relations.
CREATE TRIGGER external_ref_no_update BEFORE UPDATE ON external_ref
BEGIN SELECT RAISE(ABORT, 'external references are immutable'); END;
CREATE TRIGGER external_ref_no_delete BEFORE DELETE ON external_ref
BEGIN SELECT RAISE(ABORT, 'external references are append-only'); END;
CREATE TRIGGER artifact_no_update BEFORE UPDATE ON artifact
BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
CREATE TRIGGER artifact_no_delete BEFORE DELETE ON artifact
BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
CREATE TRIGGER completion_record_no_update BEFORE UPDATE ON completion_record
BEGIN SELECT RAISE(ABORT, 'completion records are immutable'); END;
CREATE TRIGGER completion_record_no_delete BEFORE DELETE ON completion_record
BEGIN SELECT RAISE(ABORT, 'completion records are append-only'); END;

-- Cross-row workspace and ownership checks SQLite cannot express as FKs.
CREATE TRIGGER assignment_workspace_guard BEFORE INSERT ON assignment
BEGIN
  SELECT RAISE(ABORT, 'assignment task workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM task t WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'assignment assigner workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = NEW.assigner_principal_id AND p.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'assignment assignee workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = NEW.assignee_principal_id AND p.tenant_id = NEW.tenant_id);
END;

CREATE TRIGGER relation_workspace_guard BEFORE INSERT ON commitment_relation
BEGIN
  SELECT RAISE(ABORT, 'relation task workspace mismatch') WHERE
    NOT EXISTS (SELECT 1 FROM task t WHERE t.id = NEW.from_task_id AND t.tenant_id = NEW.tenant_id)
    OR NOT EXISTS (SELECT 1 FROM task t WHERE t.id = NEW.to_task_id AND t.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'relation principal workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = NEW.created_by_principal_id AND p.tenant_id = NEW.tenant_id);
END;

CREATE TRIGGER artifact_workspace_guard BEFORE INSERT ON artifact
BEGIN
  SELECT RAISE(ABORT, 'artifact task workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM task t WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'artifact attempt ownership mismatch') WHERE
    NEW.attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM task_attempt a WHERE a.id = NEW.attempt_id AND a.task_id = NEW.task_id AND a.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'artifact principal workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = NEW.created_by_principal_id AND p.tenant_id = NEW.tenant_id);
END;

CREATE TRIGGER completion_workspace_guard BEFORE INSERT ON completion_record
BEGIN
  SELECT RAISE(ABORT, 'completion record must bind the current done revision')
    WHERE NOT EXISTS (SELECT 1 FROM task t WHERE t.id = NEW.task_id AND t.tenant_id = NEW.tenant_id AND t.revision = NEW.resulting_revision AND t.status = 'done');
  SELECT RAISE(ABORT, 'completion principal workspace mismatch')
    WHERE NOT EXISTS (SELECT 1 FROM principal p WHERE p.id = NEW.decided_by_principal_id AND p.tenant_id = NEW.tenant_id);
  SELECT RAISE(ABORT, 'completion evidence ownership mismatch') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_ids) e
    WHERE NOT EXISTS (SELECT 1 FROM task_evidence te WHERE te.id = e.value AND te.task_id = NEW.task_id AND te.tenant_id = NEW.tenant_id));
END;

-- Attribution is not authorization, but it must never cross workspace
-- boundaries. Nullable columns preserve additive migration compatibility;
-- every service-created row supplies a principal.
CREATE TRIGGER event_principal_workspace_guard BEFORE INSERT ON event
BEGIN
  SELECT RAISE(ABORT, 'event principal workspace mismatch') WHERE
    NEW.principal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM principal p WHERE p.id = NEW.principal_id AND p.tenant_id = NEW.tenant_id);
END;
CREATE TRIGGER claim_principal_workspace_guard BEFORE INSERT ON task_claim
BEGIN
  SELECT RAISE(ABORT, 'claim principal workspace mismatch') WHERE
    NEW.principal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM principal p WHERE p.id = NEW.principal_id AND p.tenant_id = NEW.tenant_id);
END;
CREATE TRIGGER attempt_principal_workspace_guard BEFORE INSERT ON task_attempt
BEGIN
  SELECT RAISE(ABORT, 'attempt principal workspace mismatch') WHERE
    NEW.principal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM principal p WHERE p.id = NEW.principal_id AND p.tenant_id = NEW.tenant_id);
END;
CREATE TRIGGER evidence_principal_workspace_guard BEFORE INSERT ON task_evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence principal workspace mismatch') WHERE
    NEW.principal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM principal p WHERE p.id = NEW.principal_id AND p.tenant_id = NEW.tenant_id);
END;
