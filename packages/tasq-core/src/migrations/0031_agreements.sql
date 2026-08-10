CREATE TABLE agreement_offer (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  offeror_principal_id TEXT NOT NULL REFERENCES principal(id),
  terms_json TEXT NOT NULL,
  terms_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  supersedes_offer_id TEXT REFERENCES agreement_offer(id),
  offered_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  CONSTRAINT agreement_offer_chronology_check CHECK (expires_at > offered_at),
  CONSTRAINT agreement_offer_json_check CHECK (json_valid(terms_json) AND json_valid(metadata_json))
);
CREATE INDEX idx_agreement_offer_current ON agreement_offer(tenant_id, expires_at, offered_at);
CREATE UNIQUE INDEX uniq_agreement_offer_digest ON agreement_offer(tenant_id, terms_digest, id);
CREATE UNIQUE INDEX uniq_agreement_offer_successor ON agreement_offer(tenant_id, supersedes_offer_id)
  WHERE supersedes_offer_id IS NOT NULL;
CREATE TRIGGER agreement_offer_no_update BEFORE UPDATE ON agreement_offer
BEGIN SELECT RAISE(ABORT, 'agreement offers are immutable'); END;
CREATE TRIGGER agreement_offer_no_delete BEFORE DELETE ON agreement_offer
BEGIN SELECT RAISE(ABORT, 'agreement offers are append-only'); END;

CREATE TABLE agreement_acceptance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  offer_id TEXT NOT NULL REFERENCES agreement_offer(id),
  party_principal_id TEXT NOT NULL REFERENCES principal(id),
  terms_digest TEXT NOT NULL,
  acceptance_digest TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  CONSTRAINT agreement_acceptance_json_check CHECK (json_valid(metadata_json)),
  UNIQUE (tenant_id, offer_id, party_principal_id),
  UNIQUE (tenant_id, acceptance_digest)
);
CREATE INDEX idx_agreement_acceptance_offer ON agreement_acceptance(tenant_id, offer_id, accepted_at);
CREATE TRIGGER agreement_acceptance_no_update BEFORE UPDATE ON agreement_acceptance
BEGIN SELECT RAISE(ABORT, 'agreement acceptances are immutable'); END;
CREATE TRIGGER agreement_acceptance_no_delete BEFORE DELETE ON agreement_acceptance
BEGIN SELECT RAISE(ABORT, 'agreement acceptances are append-only'); END;

CREATE TABLE agreement_termination (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  offer_id TEXT NOT NULL REFERENCES agreement_offer(id),
  actor_principal_id TEXT NOT NULL REFERENCES principal(id),
  action TEXT NOT NULL,
  terms_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  terminated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  CONSTRAINT agreement_termination_action_check CHECK (action IN ('withdrawn','rejected')),
  CONSTRAINT agreement_termination_json_check CHECK (json_valid(metadata_json)),
  UNIQUE (tenant_id, offer_id)
);
CREATE TRIGGER agreement_termination_no_update BEFORE UPDATE ON agreement_termination
BEGIN SELECT RAISE(ABORT, 'agreement terminations are immutable'); END;
CREATE TRIGGER agreement_termination_no_delete BEFORE DELETE ON agreement_termination
BEGIN SELECT RAISE(ABORT, 'agreement terminations are append-only'); END;

CREATE TABLE agreement_activation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES coordination_space(workspace_id),
  offer_id TEXT NOT NULL REFERENCES agreement_offer(id),
  terms_digest TEXT NOT NULL,
  acceptance_ids_json TEXT NOT NULL,
  compilations_json TEXT NOT NULL,
  supersedes_activation_id TEXT REFERENCES agreement_activation(id),
  activated_at INTEGER NOT NULL,
  activation_digest TEXT NOT NULL,
  CONSTRAINT agreement_activation_json_check CHECK (
    json_valid(acceptance_ids_json) AND json_valid(compilations_json)
  ),
  UNIQUE (tenant_id, offer_id),
  UNIQUE (tenant_id, activation_digest)
);
CREATE UNIQUE INDEX uniq_agreement_activation_successor ON agreement_activation(tenant_id, supersedes_activation_id)
  WHERE supersedes_activation_id IS NOT NULL;
CREATE TRIGGER agreement_activation_no_update BEFORE UPDATE ON agreement_activation
BEGIN SELECT RAISE(ABORT, 'agreement activations are immutable'); END;
CREATE TRIGGER agreement_activation_no_delete BEFORE DELETE ON agreement_activation
BEGIN SELECT RAISE(ABORT, 'agreement activations are append-only'); END;
