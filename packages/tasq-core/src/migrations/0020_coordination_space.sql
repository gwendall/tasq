CREATE TABLE coordination_space (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principal(id),
  created_at INTEGER NOT NULL,
  CONSTRAINT coordination_space_id_check CHECK (
    length(workspace_id) BETWEEN 1 AND 200
    AND workspace_id GLOB '[A-Za-z0-9]*'
    AND workspace_id NOT GLOB '*[^A-Za-z0-9._:/-]*'
  )
);

CREATE TRIGGER coordination_space_immutable_update
BEFORE UPDATE ON coordination_space
BEGIN
  SELECT RAISE(ABORT, 'coordination_space is immutable');
END;

CREATE TRIGGER coordination_space_immutable_delete
BEFORE DELETE ON coordination_space
BEGIN
  SELECT RAISE(ABORT, 'coordination_space is immutable');
END;
