CREATE TABLE replication_authority (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  authority_replica_id TEXT NOT NULL,
  authority_epoch TEXT NOT NULL,
  current_sequence INTEGER NOT NULL DEFAULT 0,
  minimum_retained_sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT replication_authority_sequence_check CHECK (
    current_sequence >= 0 AND minimum_retained_sequence >= 0
    AND minimum_retained_sequence <= current_sequence
  )
);

CREATE TABLE replication_local_replica (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  replica_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  next_counter INTEGER NOT NULL DEFAULT 1,
  previous_digest TEXT,
  authority_replica_id TEXT NOT NULL,
  authority_epoch TEXT NOT NULL,
  observed_sequence INTEGER NOT NULL DEFAULT 0,
  pull_cursor TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT replication_local_counter_check CHECK (next_counter > 0),
  CONSTRAINT replication_local_sequence_check CHECK (observed_sequence >= 0)
);

CREATE TABLE replication_replica (
  workspace_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  accepted_counter INTEGER NOT NULL DEFAULT 0,
  accepted_digest TEXT,
  acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL,
  last_contact_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, replica_id, generation_id),
  CONSTRAINT replication_replica_status_check CHECK (status IN ('active','stale','revoked')),
  CONSTRAINT replication_replica_frontier_check CHECK (
    accepted_counter >= 0 AND acknowledged_sequence >= 0
    AND ((accepted_counter = 0 AND accepted_digest IS NULL)
      OR (accepted_counter > 0 AND accepted_digest IS NOT NULL))
  )
);
CREATE INDEX idx_replication_replica_status
  ON replication_replica(workspace_id, status, last_contact_at);

CREATE TABLE replication_outgoing_operation (
  workspace_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  counter INTEGER NOT NULL,
  operation_digest TEXT NOT NULL,
  previous_digest TEXT,
  operation_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  authority_sequence INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, replica_id, generation_id, counter),
  CONSTRAINT replication_outgoing_counter_check CHECK (counter > 0),
  CONSTRAINT replication_outgoing_status_check CHECK (
    status IN ('pending','applied','equivalent','conflicted','rejected')
  ),
  CONSTRAINT replication_outgoing_json_check CHECK (json_valid(operation_json))
);
CREATE UNIQUE INDEX uniq_replication_outgoing_digest
  ON replication_outgoing_operation(workspace_id, operation_digest);
CREATE INDEX idx_replication_outgoing_pending
  ON replication_outgoing_operation(workspace_id, replica_id, generation_id, status, counter);

CREATE TABLE replication_accepted_operation (
  workspace_id TEXT NOT NULL,
  authority_sequence INTEGER NOT NULL,
  replica_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  counter INTEGER NOT NULL,
  operation_digest TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  disposition TEXT NOT NULL,
  result_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, authority_sequence),
  CONSTRAINT replication_accepted_sequence_check CHECK (authority_sequence > 0),
  CONSTRAINT replication_accepted_disposition_check CHECK (
    disposition IN ('applied','equivalent','conflicted')
  ),
  CONSTRAINT replication_accepted_json_check CHECK (
    json_valid(operation_json) AND json_valid(result_json)
  )
);
CREATE UNIQUE INDEX uniq_replication_accepted_dot
  ON replication_accepted_operation(workspace_id, replica_id, generation_id, counter);
CREATE UNIQUE INDEX uniq_replication_accepted_digest
  ON replication_accepted_operation(workspace_id, operation_digest);
CREATE INDEX idx_replication_accepted_origin
  ON replication_accepted_operation(workspace_id, replica_id, generation_id, counter);

CREATE TABLE replication_conflict (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  authority_sequence INTEGER NOT NULL,
  replica_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  counter INTEGER NOT NULL,
  operation_digest TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  base_snapshot_json TEXT,
  authority_snapshot_json TEXT,
  incoming_snapshot_json TEXT,
  principal_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  resolved_by_operation_digest TEXT,
  CONSTRAINT replication_conflict_reason_check CHECK (
    reason IN ('concurrent_mutation','retired_identity')
  ),
  CONSTRAINT replication_conflict_record_type_check CHECK (record_type = 'commitment'),
  CONSTRAINT replication_conflict_json_check CHECK (
    (base_snapshot_json IS NULL OR json_valid(base_snapshot_json))
    AND (authority_snapshot_json IS NULL OR json_valid(authority_snapshot_json))
    AND (incoming_snapshot_json IS NULL OR json_valid(incoming_snapshot_json))
  )
);
CREATE UNIQUE INDEX uniq_replication_conflict_sequence
  ON replication_conflict(workspace_id, authority_sequence);
CREATE INDEX idx_replication_conflict_unresolved
  ON replication_conflict(workspace_id, resolved_by_operation_digest, authority_sequence);

CREATE TABLE replication_retired_identity (
  workspace_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  tombstone_digest TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, record_type, record_id),
  CONSTRAINT replication_retired_type_check CHECK (record_type = 'commitment')
);
CREATE INDEX idx_replication_retired_at
  ON replication_retired_identity(workspace_id, retired_at);

CREATE TABLE replication_materialized_record (
  workspace_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  covered_sequence INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, record_type, record_id),
  CONSTRAINT replication_materialized_type_check CHECK (record_type = 'commitment'),
  CONSTRAINT replication_materialized_sequence_check CHECK (covered_sequence >= 0)
);
