CREATE TABLE delivery_sink (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  kind TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled'
    CHECK (status IN ('enabled', 'disabled')),
  start_after_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (start_after_sequence >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (configuration_digest GLOB 'sha256:[0-9a-f]*' AND length(configuration_digest) = 71)
);

CREATE INDEX idx_delivery_sink_status
  ON delivery_sink (tenant_id, status, id);

CREATE TABLE delivery_outbox (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  sink_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL REFERENCES event(sequence),
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  delivered_at INTEGER,
  quarantined_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sink_id) REFERENCES delivery_sink(tenant_id, id),
  CHECK (
    (status = 'pending' AND lease_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND quarantined_at IS NULL) OR
    (status = 'delivering' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL AND quarantined_at IS NULL) OR
    (status = 'delivered' AND lease_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL AND quarantined_at IS NULL) OR
    (status = 'quarantined' AND lease_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND quarantined_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, sink_id, event_sequence)
);

CREATE INDEX idx_delivery_outbox_due
  ON delivery_outbox (tenant_id, sink_id, status, available_at, event_sequence);

CREATE INDEX idx_delivery_outbox_event
  ON delivery_outbox (tenant_id, event_sequence);

-- The trigger is the atomicity boundary: it runs inside the event INSERT's
-- transaction and inherits NEW.created_at. There is no ambient device clock.
CREATE TRIGGER delivery_outbox_after_event_insert
AFTER INSERT ON event
BEGIN
  INSERT INTO delivery_outbox (
    id,
    tenant_id,
    sink_id,
    event_sequence,
    event_id,
    status,
    attempt_count,
    available_at,
    created_at,
    updated_at
  )
  SELECT
    sink.id || '/' || NEW.id,
    NEW.tenant_id,
    sink.id,
    NEW.sequence,
    NEW.id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at,
    NEW.created_at
  FROM delivery_sink AS sink
  WHERE sink.tenant_id = NEW.tenant_id
    AND sink.status = 'enabled'
    AND NEW.sequence > sink.start_after_sequence;
END;
