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
