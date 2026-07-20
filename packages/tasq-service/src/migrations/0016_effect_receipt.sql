-- TQ-206: immutable connector reports and provider-grounded outcomes.

CREATE TABLE effect_receipt (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  effect_id TEXT NOT NULL REFERENCES effect(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  attempt_id TEXT NOT NULL REFERENCES task_attempt(id),
  approval_id TEXT NOT NULL REFERENCES effect_approval(id),
  evidence_id TEXT NOT NULL REFERENCES task_evidence(id),
  canonical_report TEXT NOT NULL CHECK (json_valid(canonical_report) AND json_type(canonical_report) = 'object'),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest GLOB 'sha256:[0-9a-f]*' AND length(receipt_digest) = 71),
  connector_instance_ref TEXT NOT NULL,
  external_receipt_id TEXT NOT NULL,
  provider_operation_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('committed','failed','indeterminate')),
  resolves_receipt_id TEXT REFERENCES effect_receipt(id),
  verification_level TEXT NOT NULL
    CHECK (verification_level IN ('self_asserted','authenticated_context','cryptographic')),
  verification_method TEXT NOT NULL CHECK (length(trim(verification_method)) > 0),
  coverage TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(coverage) AND json_type(coverage) = 'array'),
  verification TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(verification) AND json_type(verification) = 'object'),
  recorded_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  UNIQUE (tenant_id, connector_instance_ref, external_receipt_id),
  UNIQUE (tenant_id, evidence_id),
  CHECK (
    (outcome = 'indeterminate' AND resolves_receipt_id IS NULL AND provider_operation_id IS NULL) OR
    (outcome IN ('committed','failed') AND provider_operation_id IS NOT NULL)
  )
);
CREATE INDEX idx_effect_receipt_effect ON effect_receipt (tenant_id, effect_id, recorded_at);
CREATE INDEX idx_effect_receipt_provider_operation
  ON effect_receipt (tenant_id, connector_instance_ref, provider_operation_id);

ALTER TABLE effect ADD COLUMN outcome_receipt_id TEXT;

CREATE TRIGGER effect_receipt_no_update BEFORE UPDATE ON effect_receipt
BEGIN SELECT RAISE(ABORT, 'effect receipts are immutable'); END;
CREATE TRIGGER effect_receipt_no_delete BEFORE DELETE ON effect_receipt
BEGIN SELECT RAISE(ABORT, 'effect receipts are append-only'); END;

CREATE TRIGGER effect_receipt_insert_guard BEFORE INSERT ON effect_receipt
BEGIN
  SELECT RAISE(ABORT, 'receipt principal workspace mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM principal p WHERE p.id = NEW.recorded_by_principal_id AND
        p.tenant_id = NEW.tenant_id AND p.status = 'enabled');
  SELECT RAISE(ABORT, 'receipt effect binding mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM effect e
      WHERE e.id = NEW.effect_id AND e.tenant_id = NEW.tenant_id AND
        e.task_id = NEW.task_id AND e.attempt_id = NEW.attempt_id AND
        e.authorized_by_approval_id = NEW.approval_id AND
        e.status IN ('executing','indeterminate') AND
        e.request_digest = json_extract(NEW.canonical_report, '$.requestDigest') AND
        e.dispatch_idempotency_key = json_extract(NEW.canonical_report, '$.dispatchIdempotencyKey') AND
        e.claim_id = json_extract(NEW.canonical_report, '$.claimId') AND
        e.fence = json_extract(NEW.canonical_report, '$.fence') AND
        e.connector_instance_ref = NEW.connector_instance_ref AND
        e.connector_instance_ref = json_extract(NEW.canonical_report, '$.connectorInstanceRef') AND
        e.connector_binding_digest = json_extract(NEW.canonical_report, '$.connectorBindingDigest'));
  SELECT RAISE(ABORT, 'receipt report identity mismatch') WHERE
    json_extract(NEW.canonical_report, '$.protocol') <> 'tasq.effect-receipt.v1' OR
    NEW.tenant_id <> json_extract(NEW.canonical_report, '$.workspaceId') OR
    NEW.effect_id <> json_extract(NEW.canonical_report, '$.effectId') OR
    NEW.approval_id <> json_extract(NEW.canonical_report, '$.approvalId') OR
    NEW.external_receipt_id <> json_extract(NEW.canonical_report, '$.externalReceiptId') OR
    NEW.provider_operation_id IS NOT json_extract(NEW.canonical_report, '$.providerOperationId') OR
    NEW.outcome <> json_extract(NEW.canonical_report, '$.outcome') OR
    NEW.resolves_receipt_id IS NOT json_extract(NEW.canonical_report, '$.resolvesReceiptId') OR
    NEW.occurred_at <> json_extract(NEW.canonical_report, '$.occurredAt');
  SELECT RAISE(ABORT, 'receipt evidence binding mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM task_evidence ev
      WHERE ev.id = NEW.evidence_id AND ev.tenant_id = NEW.tenant_id AND
        ev.task_id = NEW.task_id AND ev.attempt_id = NEW.attempt_id AND
        ev.kind = 'effect_receipt' AND
        ev.uri = json_extract(NEW.canonical_report, '$.rawRef') AND
        ev.digest = json_extract(NEW.canonical_report, '$.rawDigest') AND
        ev.source = NEW.connector_instance_ref AND
        ev.observed_at = NEW.occurred_at AND
        json_extract(ev.metadata, '$.effectId') = NEW.effect_id AND
        json_extract(ev.metadata, '$.approvalId') = NEW.approval_id AND
        json_extract(ev.metadata, '$.receiptId') = NEW.id AND
        json_extract(ev.metadata, '$.receiptDigest') = NEW.receipt_digest AND
        json_extract(ev.metadata, '$.outcome') = NEW.outcome);
  SELECT RAISE(ABORT, 'terminal receipt requires strong exact coverage')
    WHERE NEW.outcome IN ('committed','failed') AND (
      NEW.verification_level = 'self_asserted' OR json_array_length(NEW.coverage) <> 4 OR
      NOT EXISTS (SELECT 1 FROM json_each(NEW.coverage) WHERE value = 'provider_account') OR
      NOT EXISTS (SELECT 1 FROM json_each(NEW.coverage) WHERE value = 'provider_operation') OR
      NOT EXISTS (SELECT 1 FROM json_each(NEW.coverage) WHERE value = 'request_identity') OR
      NOT EXISTS (SELECT 1 FROM json_each(NEW.coverage) WHERE value = 'outcome'));
  SELECT RAISE(ABORT, 'receipt resolution mismatch') WHERE
    (NEW.outcome = 'indeterminate' AND NOT EXISTS (
      SELECT 1 FROM effect e WHERE e.id = NEW.effect_id AND e.status = 'executing')) OR
    (NEW.outcome IN ('committed','failed') AND NEW.resolves_receipt_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM effect e WHERE e.id = NEW.effect_id AND e.status = 'executing')) OR
    (NEW.outcome IN ('committed','failed') AND NEW.resolves_receipt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM effect e JOIN effect_receipt prior ON prior.id = NEW.resolves_receipt_id
      WHERE e.id = NEW.effect_id AND e.status = 'indeterminate' AND
        e.outcome_receipt_id = prior.id AND prior.effect_id = e.id AND prior.outcome = 'indeterminate'));
END;

CREATE TRIGGER effect_outcome_insert_guard BEFORE INSERT ON effect
WHEN NEW.outcome_receipt_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'new effects cannot have outcome receipts'); END;

CREATE TRIGGER effect_outcome_transition_guard BEFORE UPDATE ON effect
BEGIN
  SELECT RAISE(ABORT, 'non-outcome effect state cannot reference a receipt')
    WHERE NEW.status IN ('proposed','authorized','executing','cancelled') AND
      NEW.outcome_receipt_id IS NOT NULL;
  SELECT RAISE(ABORT, 'effect outcome requires its exact receipt')
    WHERE NEW.status IN ('indeterminate','committed','failed') AND NOT EXISTS (
      SELECT 1 FROM effect_receipt r
      WHERE r.id = NEW.outcome_receipt_id AND r.tenant_id = NEW.tenant_id AND
        r.effect_id = NEW.id AND r.task_id = NEW.task_id AND r.attempt_id = NEW.attempt_id AND
        r.approval_id = NEW.authorized_by_approval_id AND r.outcome = NEW.status AND
        ((OLD.status = 'executing' AND r.resolves_receipt_id IS NULL) OR
         (OLD.status = 'indeterminate' AND r.resolves_receipt_id = OLD.outcome_receipt_id)));
END;
