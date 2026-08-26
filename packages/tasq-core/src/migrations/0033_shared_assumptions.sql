-- ADR-021: shared assumptions.
--
-- An assumption is one immutable sentence that work rests on, shared by many
-- commitments. Withdrawing it pauses the commitments linked to it so that a
-- change of mind reaches the queue instead of living in one agent's transcript.
--
-- Paused is DERIVED, never stored: a commitment is paused exactly while it holds
-- an active link to a withdrawn assumption. This is the same shape the premise
-- path already uses (presence of an invalidation ref), it adds no column to
-- `task`, and it cannot drift out of sync with the assumption it depends on.

CREATE TABLE assumption (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  text TEXT NOT NULL,
  -- Identity within a tenant. Trim, collapse internal whitespace, casefold.
  -- This is what makes assumptions shared without anyone looking up an id.
  normalized_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'standing',
  stated_by_principal_id TEXT NOT NULL,
  stated_at INTEGER NOT NULL,
  withdrawn_by_principal_id TEXT,
  withdrawn_at INTEGER,
  withdrawal_reason TEXT,
  -- Evidence is encouraged and deliberately NOT required: requiring it
  -- reproduces the adoption failure this primitive exists to fix.
  withdrawal_evidence_ids_json TEXT,
  CONSTRAINT assumption_status_check CHECK (status IN ('standing', 'withdrawn')),
  CONSTRAINT assumption_text_check CHECK (
    length(text) BETWEEN 1 AND 200 AND length(normalized_text) BETWEEN 1 AND 200
  ),
  CONSTRAINT assumption_reason_check CHECK (
    withdrawal_reason IS NULL OR length(withdrawal_reason) BETWEEN 1 AND 2000
  ),
  CONSTRAINT assumption_withdrawal_check CHECK (
    (status = 'standing'
      AND withdrawn_by_principal_id IS NULL AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR
    (status = 'withdrawn'
      AND withdrawn_by_principal_id IS NOT NULL AND withdrawn_at IS NOT NULL AND withdrawal_reason IS NOT NULL)
  ),
  CONSTRAINT assumption_chronology_check CHECK (withdrawn_at IS NULL OR withdrawn_at >= stated_at),
  CONSTRAINT assumption_evidence_json_check CHECK (
    withdrawal_evidence_ids_json IS NULL OR json_valid(withdrawal_evidence_ids_json)
  )
);

-- Uniqueness binds STANDING assumptions only. A belief that was withdrawn can
-- be stated again when new evidence supports it; both rows stay, so the
-- history shows the belief dying and coming back rather than silently reviving.
CREATE UNIQUE INDEX uniq_assumption_text ON assumption(tenant_id, normalized_text)
  WHERE status = 'standing';
CREATE INDEX idx_assumption_status ON assumption(tenant_id, status, stated_at);

-- The sentence and who stated it can never change. A changed belief is a new
-- assumption plus a withdrawal of the old one, which keeps the history readable.
CREATE TRIGGER assumption_immutable_statement BEFORE UPDATE ON assumption
WHEN OLD.text <> NEW.text
  OR OLD.normalized_text <> NEW.normalized_text
  OR OLD.tenant_id <> NEW.tenant_id
  OR OLD.stated_by_principal_id <> NEW.stated_by_principal_id
  OR OLD.stated_at <> NEW.stated_at
BEGIN SELECT RAISE(ABORT, 'assumption text and statement are immutable'); END;

-- Withdrawal is terminal. Reviving a belief is stating it again as a new one.
CREATE TRIGGER assumption_withdrawal_is_final BEFORE UPDATE ON assumption
WHEN OLD.status = 'withdrawn'
BEGIN SELECT RAISE(ABORT, 'a withdrawn assumption is final; state a new one instead'); END;

CREATE TRIGGER assumption_no_delete BEFORE DELETE ON assumption
BEGIN SELECT RAISE(ABORT, 'assumptions are append-only'); END;

CREATE TABLE assumption_link (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'gwendall',
  assumption_id TEXT NOT NULL REFERENCES assumption(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  status TEXT NOT NULL DEFAULT 'active',
  linked_by_principal_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  unlinked_by_principal_id TEXT,
  unlinked_at INTEGER,
  unlink_reason TEXT,
  CONSTRAINT assumption_link_status_check CHECK (status IN ('active', 'unlinked')),
  CONSTRAINT assumption_link_unlink_check CHECK (
    (status = 'active'
      AND unlinked_by_principal_id IS NULL AND unlinked_at IS NULL AND unlink_reason IS NULL)
    OR
    (status = 'unlinked'
      AND unlinked_by_principal_id IS NOT NULL AND unlinked_at IS NOT NULL AND unlink_reason IS NOT NULL)
  ),
  CONSTRAINT assumption_link_reason_check CHECK (
    unlink_reason IS NULL OR length(unlink_reason) BETWEEN 1 AND 2000
  ),
  CONSTRAINT assumption_link_chronology_check CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
);

-- One live link per (assumption, commitment); unlinked rows stay for the record.
CREATE UNIQUE INDEX uniq_assumption_link_active
  ON assumption_link(tenant_id, assumption_id, task_id) WHERE status = 'active';
CREATE INDEX idx_assumption_link_task ON assumption_link(tenant_id, task_id, status);
CREATE INDEX idx_assumption_link_assumption ON assumption_link(tenant_id, assumption_id, status);

CREATE TRIGGER assumption_link_immutable_binding BEFORE UPDATE ON assumption_link
WHEN OLD.tenant_id <> NEW.tenant_id
  OR OLD.assumption_id <> NEW.assumption_id
  OR OLD.task_id <> NEW.task_id
  OR OLD.linked_by_principal_id <> NEW.linked_by_principal_id
  OR OLD.linked_at <> NEW.linked_at
BEGIN SELECT RAISE(ABORT, 'an assumption link binding is immutable'); END;

CREATE TRIGGER assumption_link_no_relink BEFORE UPDATE ON assumption_link
WHEN OLD.status = 'unlinked'
BEGIN SELECT RAISE(ABORT, 'an unlinked assumption link is final; link again instead'); END;

CREATE TRIGGER assumption_link_no_delete BEFORE DELETE ON assumption_link
BEGIN SELECT RAISE(ABORT, 'assumption links are append-only'); END;
