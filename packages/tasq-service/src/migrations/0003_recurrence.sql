-- tasq v0.3 — first-class recurrence (SPEC §6.4-H).
--
-- A minimal neutral cadence-enum + anchor stored on `task`. NULL recurrence =
-- one-shot (the pre-v0.3 default). On completion of a recurring task the
-- service materializes the next instance (one cadence-step from the chosen
-- anchor) and emits an `instance_generated` event. `last_done_at` / `streak`
-- are engine-owned signals fed (surfaced, not reweighted) to the prioritizer.
--
-- Note on CHECK constraints: SQLite's ALTER TABLE ADD COLUMN cannot add a
-- table-level CHECK retroactively, so the recurrence/anchor/interval CHECKs
-- live in the Drizzle table definition (applied to fresh `task` creates) and
-- are enforced on every write by the Zod layer (principle #13 — all writes go
-- through the service). Pre-existing rows are unconstrained at the engine
-- level but can never be invalid because nothing writes SQL outside the service.
--
-- Forward-compat: purely additive. Pre-v0.3 rows have recurrence IS NULL =
-- one-shot ; their behavior is unchanged (no materialization on completion).

ALTER TABLE task ADD COLUMN recurrence TEXT;
ALTER TABLE task ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE task ADD COLUMN recurrence_anchor TEXT NOT NULL DEFAULT 'due';
ALTER TABLE task ADD COLUMN last_done_at INTEGER;
ALTER TABLE task ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN recurrence_parent_id TEXT REFERENCES task(id);

CREATE INDEX IF NOT EXISTS idx_task_recurrence_parent
  ON task(tenant_id, recurrence_parent_id)
  WHERE recurrence_parent_id IS NOT NULL;
