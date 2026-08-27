-- Which device said it was this principal.
--
-- The actor label is self-asserted: anyone can type `--actor gwendall`. At the
-- local boundary that is not a hole, because anyone who can pass the flag can
-- also open the SQLite file directly - the trust boundary is the OS account,
-- not the CLI. Adding a login there would be theatre.
--
-- The real defect is quieter and it is already here: the principal is derived
-- from (space, alias), so two people or two machines using "gwendall" ARE the
-- same principal and the ledger merges them in silence. On a shared or
-- replicated store that silence is the whole problem.
--
-- This records the device behind each write. It does not authenticate anyone
-- yet; it makes the collision observable, which is the thing that cannot be
-- retrofitted onto history.

CREATE TABLE principal_device (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- sha256 of the raw public key, domain-separated. Short enough to print.
  fingerprint TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  public_key TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, fingerprint),
  FOREIGN KEY (principal_id) REFERENCES principal(id) ON DELETE CASCADE
) WITHOUT ROWID;

-- "Which principals is this device acting as" - the question `whoami` and the
-- fleet view ask.
CREATE INDEX idx_principal_device_fingerprint
  ON principal_device(tenant_id, fingerprint, last_seen_at);

-- A public key belongs to exactly one fingerprint, forever. Without this a
-- device could rotate its key and keep a fingerprint, which would make the
-- fingerprint mean nothing.
CREATE TRIGGER principal_device_key_immutable
BEFORE UPDATE OF public_key, algorithm, fingerprint ON principal_device
WHEN NEW.public_key != OLD.public_key
  OR NEW.algorithm != OLD.algorithm
  OR NEW.fingerprint != OLD.fingerprint
BEGIN
  SELECT RAISE(ABORT, 'a device key binding is immutable; a new key is a new device');
END;
