ALTER TABLE replication_replica
  ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'legacy:unbound';

CREATE INDEX idx_replication_replica_principal
  ON replication_replica(workspace_id, principal_id, status);

CREATE TRIGGER replication_replica_principal_immutable
BEFORE UPDATE OF principal_id ON replication_replica
WHEN NEW.principal_id != OLD.principal_id
BEGIN
  SELECT RAISE(ABORT, 'replication replica principal binding is immutable');
END;
