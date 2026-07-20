ALTER TABLE event RENAME TO event_legacy;

CREATE TABLE event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  actor TEXT NOT NULL DEFAULT 'system',
  entity_type TEXT NOT NULL CHECK (entity_type IN ('area','goal','project','task')),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO event (
  id, tenant_id, actor, entity_type, entity_id, event_type, payload, occurred_at, created_at
)
SELECT
  id, tenant_id, actor, entity_type, entity_id, event_type, payload, NULL, created_at
FROM event_legacy
ORDER BY created_at, id;

DROP TABLE event_legacy;

CREATE INDEX idx_event_entity
  ON event (tenant_id, entity_type, entity_id, sequence);
CREATE INDEX idx_event_recent
  ON event (tenant_id, sequence);
CREATE INDEX idx_event_actor
  ON event (tenant_id, actor, sequence);
