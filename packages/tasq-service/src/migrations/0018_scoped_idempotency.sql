ALTER TABLE idempotency_key RENAME TO idempotency_key_legacy;

CREATE TABLE idempotency_key (
  tenant_id TEXT NOT NULL,
  caller_scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  digest_version TEXT NOT NULL
    CHECK (digest_version IN ('tasq.jcs.sha256.v1','tasq.legacy.sha256.v0')),
  request_digest TEXT NOT NULL
    CHECK (
      substr(request_digest, 1, 7) = 'sha256:' AND
      length(request_digest) = 71 AND
      substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  result_type TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_status TEXT,
  result_revision INTEGER,
  event_sequence INTEGER,
  retention_class TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, caller_scope, operation, key),
  CHECK (
    length(trim(tenant_id)) BETWEEN 1 AND 500 AND
    length(trim(caller_scope)) BETWEEN 1 AND 1000 AND
    length(trim(operation)) BETWEEN 1 AND 200 AND
    length(trim(key)) BETWEEN 1 AND 500
  ),
  CHECK (
    length(trim(result_type)) BETWEEN 1 AND 200 AND
    length(trim(result_id)) BETWEEN 1 AND 2000 AND
    (result_status IS NULL OR length(trim(result_status)) BETWEEN 1 AND 200) AND
    (result_revision IS NULL OR result_revision > 0) AND
    (event_sequence IS NULL OR event_sequence > 0)
  ),
  CHECK (
    created_at >= 0 AND (
      (retention_class = 'durable' AND expires_at IS NULL) OR
      (retention_class = 'standard' AND expires_at IS NOT NULL AND expires_at > created_at)
    )
  )
);

-- Old keys had workspace-global scope and no declared horizon. Preserve them
-- as durable compatibility identities: over-deduplication is safer than
-- silently accepting a duplicate after upgrade.
INSERT INTO idempotency_key (
  tenant_id,
  caller_scope,
  operation,
  key,
  digest_version,
  request_digest,
  result_type,
  result_id,
  result_status,
  result_revision,
  event_sequence,
  retention_class,
  expires_at,
  created_at
)
SELECT
  tenant_id,
  'workspace:legacy',
  operation,
  key,
  'tasq.legacy.sha256.v0',
  'sha256:' || request_hash,
  'legacy',
  result_id,
  NULL,
  NULL,
  NULL,
  'durable',
  NULL,
  created_at
FROM idempotency_key_legacy;

DROP TABLE idempotency_key_legacy;

CREATE INDEX idx_idempotency_expiry
  ON idempotency_key (tenant_id, retention_class, expires_at);
