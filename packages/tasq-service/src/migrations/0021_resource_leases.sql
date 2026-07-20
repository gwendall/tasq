CREATE TABLE resource_lease (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  resource_key TEXT NOT NULL,
  holder_actor TEXT NOT NULL,
  holder_principal_id TEXT NOT NULL REFERENCES principal(id),
  revision INTEGER NOT NULL DEFAULT 1,
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT resource_lease_chronology_check CHECK (heartbeat_at >= acquired_at AND expires_at > heartbeat_at),
  CONSTRAINT resource_lease_key_check CHECK (
    length(CAST(resource_key AS BLOB)) BETWEEN 1 AND 512
    AND resource_key = trim(resource_key)
    AND instr(resource_key, char(0)) = 0
    AND instr(resource_key, char(9)) = 0
    AND instr(resource_key, char(10)) = 0
    AND instr(resource_key, char(13)) = 0
  ),
  CONSTRAINT resource_lease_actor_check CHECK (
    length(holder_actor) BETWEEN 1 AND 200 AND holder_actor = trim(holder_actor)
  ),
  CONSTRAINT resource_lease_release_check CHECK (
    (released_at IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND release_reason IS NOT NULL
      AND released_at >= acquired_at AND length(trim(release_reason)) > 0)
  ),
  CONSTRAINT resource_lease_fence_check CHECK (fence > 0),
  CONSTRAINT resource_lease_revision_check CHECK (revision > 0),
  CONSTRAINT resource_lease_metadata_check CHECK (
    json_valid(metadata) AND json_type(metadata) = 'object'
    AND length(CAST(metadata AS BLOB)) <= 16384
  )
);
CREATE UNIQUE INDEX uniq_resource_lease_active
  ON resource_lease(workspace_id, resource_key) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uniq_resource_lease_fence
  ON resource_lease(workspace_id, resource_key, fence);
CREATE INDEX idx_resource_lease_world
  ON resource_lease(workspace_id, released_at, resource_key);
CREATE INDEX idx_resource_lease_holder
  ON resource_lease(workspace_id, holder_principal_id, expires_at);

CREATE TRIGGER resource_lease_identity_immutable
BEFORE UPDATE ON resource_lease
WHEN NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.resource_key != OLD.resource_key OR NEW.holder_actor != OLD.holder_actor
  OR NEW.holder_principal_id != OLD.holder_principal_id OR NEW.fence != OLD.fence
  OR NEW.acquired_at != OLD.acquired_at OR NEW.created_at != OLD.created_at
  OR NEW.metadata != OLD.metadata
BEGIN
  SELECT RAISE(ABORT, 'resource_lease identity is immutable');
END;

CREATE TRIGGER resource_lease_transition_guard
BEFORE UPDATE ON resource_lease
WHEN OLD.released_at IS NOT NULL OR NEW.revision != OLD.revision + 1
  OR NEW.heartbeat_at < OLD.heartbeat_at OR NEW.expires_at <= NEW.heartbeat_at
  OR NEW.updated_at < OLD.updated_at
  OR (NEW.released_at IS NULL AND (
    NEW.heartbeat_at = OLD.heartbeat_at OR NEW.expires_at <= OLD.expires_at
  ))
  OR (NEW.released_at IS NOT NULL AND (
    OLD.released_at IS NOT NULL OR NEW.heartbeat_at != OLD.heartbeat_at
    OR NEW.expires_at != OLD.expires_at OR NEW.updated_at != NEW.released_at
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid resource_lease transition');
END;

CREATE TRIGGER resource_lease_no_delete
BEFORE DELETE ON resource_lease
BEGIN
  SELECT RAISE(ABORT, 'resource_lease is append-history and cannot be deleted');
END;

CREATE TABLE resource_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  resource_key TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES resource_lease(id),
  actor TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principal(id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CONSTRAINT resource_event_type_check CHECK (
    event_type IN ('resource_lease_acquired','resource_lease_renewed','resource_lease_released','resource_lease_expired')
  ),
  CONSTRAINT resource_event_payload_check CHECK (json_valid(payload) AND json_type(payload) = 'object')
);
CREATE INDEX idx_resource_event_stream ON resource_event(workspace_id, sequence);
CREATE INDEX idx_resource_event_resource ON resource_event(workspace_id, resource_key, sequence);

CREATE TRIGGER resource_event_validate_insert
BEFORE INSERT ON resource_event
WHEN NOT EXISTS (
  SELECT 1 FROM resource_lease
  WHERE id = NEW.lease_id
    AND workspace_id = NEW.workspace_id
    AND resource_key = NEW.resource_key
)
BEGIN
  SELECT RAISE(ABORT, 'resource_event lease scope mismatch');
END;

CREATE TRIGGER resource_event_immutable_update
BEFORE UPDATE ON resource_event
BEGIN
  SELECT RAISE(ABORT, 'resource_event is immutable');
END;

CREATE TRIGGER resource_event_immutable_delete
BEFORE DELETE ON resource_event
BEGIN
  SELECT RAISE(ABORT, 'resource_event is immutable');
END;
