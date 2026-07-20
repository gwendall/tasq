ALTER TABLE task ADD COLUMN success_criteria TEXT;
ALTER TABLE task ADD COLUMN completion_mode TEXT NOT NULL DEFAULT 'assertion'
  CHECK (completion_mode IN ('assertion','evidence'));

CREATE TABLE task_claim (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  actor TEXT NOT NULL,
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT task_claim_expiry_check CHECK (expires_at > acquired_at),
  CONSTRAINT task_claim_fence_check CHECK (fence > 0)
);
CREATE UNIQUE INDEX uniq_task_claim_active
  ON task_claim(tenant_id, task_id) WHERE released_at IS NULL;
CREATE INDEX idx_task_claim_actor ON task_claim(tenant_id, actor, expires_at);
CREATE INDEX idx_task_claim_task ON task_claim(tenant_id, task_id, created_at);

CREATE TABLE task_attempt (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  claim_id TEXT REFERENCES task_claim(id),
  actor TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  context_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  status_message TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT task_attempt_status_check
    CHECK (status IN ('running','input_required','succeeded','failed','cancelled'))
);
CREATE INDEX idx_task_attempt_task ON task_attempt(tenant_id, task_id, started_at);
CREATE INDEX idx_task_attempt_external ON task_attempt(tenant_id, runtime, external_id);
CREATE INDEX idx_task_attempt_status ON task_attempt(tenant_id, status, updated_at);

CREATE TABLE task_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  task_id TEXT NOT NULL REFERENCES task(id),
  attempt_id TEXT REFERENCES task_attempt(id),
  supersedes_evidence_id TEXT REFERENCES task_evidence(id),
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  uri TEXT,
  digest TEXT,
  source TEXT,
  observed_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CONSTRAINT task_evidence_content_check CHECK (summary IS NOT NULL OR uri IS NOT NULL)
);
CREATE INDEX idx_task_evidence_task ON task_evidence(tenant_id, task_id, created_at);
CREATE INDEX idx_task_evidence_attempt ON task_evidence(tenant_id, attempt_id);
CREATE INDEX idx_task_evidence_kind ON task_evidence(tenant_id, kind, observed_at);
