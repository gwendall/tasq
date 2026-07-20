-- TQ-104: deterministic reconciliation plus a multi-key observation routing
-- index. Routes are derived, immutable rows; match decisions are historical
-- facts and never updated or deleted.

CREATE TABLE observation_route (
  observation_id TEXT NOT NULL REFERENCES observation(id),
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  route_key TEXT NOT NULL,
  PRIMARY KEY (observation_id, route_key)
);

CREATE INDEX idx_observation_route_lookup
  ON observation_route(tenant_id, kind, route_key, observation_id);

-- Every historical observation gets its primary typed subject route.
INSERT INTO observation_route (observation_id, tenant_id, kind, route_key)
SELECT id, tenant_id, kind, subject_ref FROM observation;

-- Mercury supports an explicit transaction-id matcher and a stricter
-- amount/counterparty matcher. The latter needs a second route.
INSERT OR IGNORE INTO observation_route (observation_id, tenant_id, kind, route_key)
SELECT
  id,
  tenant_id,
  kind,
  json_array(
    'mercury.transaction.match',
    json_extract(payload, '$.connectorAccount'),
    json_extract(payload, '$.direction'),
    json_extract(payload, '$.currency'),
    json_extract(payload, '$.minorUnits')
  )
FROM observation
WHERE kind = 'mercury.transaction';

CREATE TRIGGER observation_route_validate_insert
BEFORE INSERT ON observation_route
WHEN length(trim(NEW.route_key)) = 0
  OR NOT EXISTS (
    SELECT 1 FROM observation
    WHERE observation.id = NEW.observation_id
      AND observation.tenant_id = NEW.tenant_id
      AND observation.kind = NEW.kind
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid observation route invariant');
END;

CREATE TRIGGER observation_route_no_update
BEFORE UPDATE ON observation_route
BEGIN
  SELECT RAISE(ABORT, 'observation routes are append-only');
END;

CREATE TRIGGER observation_route_no_delete
BEFORE DELETE ON observation_route
BEGIN
  SELECT RAISE(ABORT, 'observation routes are append-only');
END;

CREATE TABLE reconciliation (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  condition_id TEXT NOT NULL REFERENCES wait_condition(id),
  observation_id TEXT NOT NULL REFERENCES observation(id),
  matcher_kind TEXT NOT NULL,
  matcher_version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  effect TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  explanation TEXT NOT NULL,
  evidence_id TEXT REFERENCES task_evidence(id),
  reconciled_at INTEGER NOT NULL,
  reconciled_by TEXT NOT NULL,

  CONSTRAINT reconciliation_matcher_version_check CHECK (matcher_version > 0),
  CONSTRAINT reconciliation_decision_check CHECK (decision IN ('matched','rejected','ambiguous')),
  CONSTRAINT reconciliation_effect_check CHECK (effect IN ('satisfied','no_change','condition_terminal')),
  CONSTRAINT reconciliation_timestamp_check CHECK (reconciled_at >= 0),
  CONSTRAINT reconciliation_outcome_check CHECK (
    (decision = 'matched' AND effect = 'satisfied' AND evidence_id IS NOT NULL)
    OR
    (decision = 'matched' AND effect IN ('no_change','condition_terminal') AND evidence_id IS NULL)
    OR
    (decision IN ('rejected','ambiguous') AND effect = 'no_change' AND evidence_id IS NULL)
  )
);

CREATE UNIQUE INDEX uniq_reconciliation_evaluation
  ON reconciliation(tenant_id, condition_id, observation_id, matcher_version);

CREATE INDEX idx_reconciliation_condition
  ON reconciliation(tenant_id, condition_id, reconciled_at);

CREATE INDEX idx_reconciliation_observation
  ON reconciliation(tenant_id, observation_id, reconciled_at);

CREATE TRIGGER reconciliation_validate_insert
BEFORE INSERT ON reconciliation
WHEN length(trim(NEW.matcher_kind)) = 0
  OR length(trim(NEW.reason_code)) = 0
  OR length(trim(NEW.explanation)) = 0
  OR length(trim(NEW.reconciled_by)) = 0
  OR NOT EXISTS (
    SELECT 1 FROM wait_condition
    WHERE wait_condition.id = NEW.condition_id
      AND wait_condition.tenant_id = NEW.tenant_id
      AND wait_condition.kind = NEW.matcher_kind
      AND wait_condition.created_at <= NEW.reconciled_at
  )
  OR NOT EXISTS (
    SELECT 1 FROM observation
    WHERE observation.id = NEW.observation_id
      AND observation.tenant_id = NEW.tenant_id
      AND observation.recorded_at <= NEW.reconciled_at
  )
  OR (
    NEW.evidence_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM task_evidence
      JOIN wait_condition ON wait_condition.id = NEW.condition_id
      WHERE task_evidence.id = NEW.evidence_id
        AND task_evidence.tenant_id = NEW.tenant_id
        AND task_evidence.task_id = wait_condition.task_id
    )
  )
  OR (
    NEW.effect = 'satisfied'
    AND NOT EXISTS (
      SELECT 1 FROM wait_condition
      WHERE wait_condition.id = NEW.condition_id
        AND wait_condition.status = 'satisfied'
        AND wait_condition.satisfied_by_observation_id = NEW.observation_id
    )
  )
  OR (
    NEW.effect = 'condition_terminal'
    AND EXISTS (
      SELECT 1 FROM wait_condition
      WHERE wait_condition.id = NEW.condition_id
        AND wait_condition.status = 'waiting'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid reconciliation invariant');
END;

CREATE TRIGGER reconciliation_no_update
BEFORE UPDATE ON reconciliation
BEGIN
  SELECT RAISE(ABORT, 'reconciliations are append-only');
END;

CREATE TRIGGER reconciliation_no_delete
BEFORE DELETE ON reconciliation
BEGIN
  SELECT RAISE(ABORT, 'reconciliations are append-only');
END;
