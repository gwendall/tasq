CREATE TABLE replication_authority_recovery (
  workspace_id TEXT NOT NULL,
  authority_epoch TEXT NOT NULL,
  authority_replica_id TEXT NOT NULL,
  prior_authority_epoch TEXT NOT NULL,
  restored_sequence INTEGER NOT NULL,
  snapshot_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  recovered_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, authority_epoch),
  CONSTRAINT replication_authority_recovery_sequence_check CHECK (restored_sequence >= 0),
  CONSTRAINT replication_authority_recovery_reason_check CHECK (
    length(trim(reason)) BETWEEN 1 AND 2000
  )
);

CREATE INDEX idx_replication_authority_recovery_time
  ON replication_authority_recovery(workspace_id, recovered_at);
