CREATE TABLE settlement_decision (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  decision_kind TEXT NOT NULL,
  agreement_offer_id TEXT NOT NULL REFERENCES agreement_offer(id),
  activation_id TEXT NOT NULL REFERENCES agreement_activation(id),
  obligation_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL REFERENCES task(id),
  basis_json TEXT NOT NULL,
  basis_digest TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  matched_rule_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  entitlements_json TEXT NOT NULL,
  prior_decision_id TEXT REFERENCES settlement_decision(id),
  supersedes_decision_id TEXT REFERENCES settlement_decision(id),
  decided_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  decided_at INTEGER NOT NULL,
  decision_digest TEXT NOT NULL,
  CONSTRAINT settlement_decision_kind_check CHECK (decision_kind IN ('settlement','recourse')),
  CONSTRAINT settlement_decision_classification_check CHECK (
    classification IN ('full','partial','show_up','cancellation','rework','credit','indeterminate')
  ),
  CONSTRAINT settlement_decision_json_check CHECK (
    json_valid(basis_json) AND json_valid(policy_json) AND json_valid(entitlements_json)
  )
);
CREATE INDEX idx_settlement_decision_subject
  ON settlement_decision(tenant_id, agreement_offer_id, obligation_id, decided_at);
CREATE UNIQUE INDEX uniq_settlement_decision_digest
  ON settlement_decision(tenant_id, decision_digest);
CREATE UNIQUE INDEX uniq_settlement_decision_successor
  ON settlement_decision(tenant_id, supersedes_decision_id)
  WHERE supersedes_decision_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_settlement_decision_settlement_root
  ON settlement_decision(tenant_id, activation_id, obligation_id)
  WHERE decision_kind = 'settlement' AND supersedes_decision_id IS NULL;
CREATE UNIQUE INDEX uniq_settlement_decision_recourse_root
  ON settlement_decision(tenant_id, prior_decision_id)
  WHERE decision_kind = 'recourse' AND supersedes_decision_id IS NULL;
CREATE TRIGGER settlement_decision_no_update BEFORE UPDATE ON settlement_decision
BEGIN SELECT RAISE(ABORT, 'settlement decisions are immutable'); END;
CREATE TRIGGER settlement_decision_no_delete BEFORE DELETE ON settlement_decision
BEGIN SELECT RAISE(ABORT, 'settlement decisions are append-only'); END;

CREATE TABLE settlement_materialization (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  decision_id TEXT NOT NULL REFERENCES settlement_decision(id),
  entitlement_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL REFERENCES task(id),
  effect_id TEXT REFERENCES effect(id),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, decision_id, entitlement_id),
  UNIQUE (tenant_id, commitment_id),
  UNIQUE (tenant_id, effect_id)
);
CREATE INDEX idx_settlement_materialization_decision
  ON settlement_materialization(tenant_id, decision_id, created_at);
CREATE TRIGGER settlement_materialization_no_update BEFORE UPDATE ON settlement_materialization
BEGIN SELECT RAISE(ABORT, 'settlement materializations are immutable'); END;
CREATE TRIGGER settlement_materialization_no_delete BEFORE DELETE ON settlement_materialization
BEGIN SELECT RAISE(ABORT, 'settlement materializations are append-only'); END;
