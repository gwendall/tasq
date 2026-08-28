-- What the ledger refused.
--
-- Thirty-one event types, a hundred and thirty-four claims acquired, and until
-- now nothing recorded a single refusal. The ledger kept a complete account of
-- everything it ALLOWED and no trace of anything it PREVENTED.
--
-- The refusal is the product. `tasq demo` exists to show three of them. And
-- nobody - not a user, not the maintainer - could answer "how many collisions
-- did this stop for me last week", which makes twenty days of dogfood produce
-- a feeling instead of a number.
--
-- A contention is a SITUATION, not an instant. A polling agent turned away four
-- hundred times is one situation with a count of four hundred, not four hundred
-- rows. That is what the primary key encodes, and it is what keeps a
-- high-frequency signal from becoming a high-frequency table.
CREATE TABLE contention (
  tenant_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'claim_held_by_another',
    'claim_blocked_by_unresolved',
    'complete_not_holder',
    'complete_without_evidence'
  )),
  -- Who asked and was turned away. The label is stored beside the id on
  -- purpose: the refused caller's principal row does not exist, because the
  -- only place it would have been created is the transaction that just rolled
  -- back. A contention is a fact about a moment, and it has to carry its own
  -- names.
  requested_by_principal_id TEXT NOT NULL,
  requested_by_label TEXT NOT NULL,
  -- Who held it. Empty where the refusal is not about a holder at all:
  -- WITHOUT ROWID forces NOT NULL on every primary key column, and a nullable
  -- key column would make each no-holder refusal a new row instead of a
  -- counted repeat.
  holder_principal_id TEXT NOT NULL DEFAULT '',
  holder_label TEXT NOT NULL DEFAULT '',
  first_at INTEGER NOT NULL CHECK (first_at >= 0),
  last_at INTEGER NOT NULL CHECK (last_at >= first_at),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (tenant_id, commitment_id, kind, requested_by_principal_id, holder_principal_id)
) WITHOUT ROWID;

-- "What did Tasq prevent, and when" - the question the table exists to answer.
CREATE INDEX idx_contention_recent ON contention(tenant_id, last_at DESC);

-- A refusal is not a mutation and must never read as one. Nothing here may be
-- rewritten to say a different thing happened: only the counter and the last
-- sighting move.
CREATE TRIGGER contention_facts_immutable
BEFORE UPDATE ON contention
WHEN NEW.tenant_id != OLD.tenant_id
  OR NEW.commitment_id != OLD.commitment_id
  OR NEW.kind != OLD.kind
  OR NEW.requested_by_principal_id != OLD.requested_by_principal_id
  OR NEW.holder_principal_id != OLD.holder_principal_id
  OR NEW.first_at != OLD.first_at
  OR NEW.attempts <= OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'a contention record is append-only; only last_at and attempts advance');
END;
