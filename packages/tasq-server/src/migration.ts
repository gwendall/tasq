import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

export const AUTHORITY_MIGRATION_NAME = "0001_authority_control_plane";

export const AUTHORITY_MIGRATION_SQL = `
CREATE TABLE host_tenant (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE hosted_workspace (
  workspace_id TEXT PRIMARY KEY,
  host_tenant_id TEXT NOT NULL REFERENCES host_tenant(id),
  storage_binding_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  authority_revision INTEGER NOT NULL DEFAULT 0 CHECK (authority_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE authority_principal (
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service', 'runtime')),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE subject_binding (
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  disabled_at INTEGER,
  replaced_by_binding_id TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, issuer, subject),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES authority_principal(workspace_id, id),
  FOREIGN KEY (workspace_id, replaced_by_binding_id) REFERENCES subject_binding(workspace_id, id)
);

CREATE TABLE permission_set (
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  uri TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  implementation_digest TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (workspace_id, uri, version),
  UNIQUE (workspace_id, uri, version, implementation_digest)
);

CREATE TABLE authorization_grant (
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  id TEXT NOT NULL,
  grantor_principal_id TEXT NOT NULL,
  grantee_principal_id TEXT NOT NULL,
  permission_uri TEXT NOT NULL,
  permission_version INTEGER NOT NULL,
  permission_digest TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  not_before INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, grantor_principal_id) REFERENCES authority_principal(workspace_id, id),
  FOREIGN KEY (workspace_id, grantee_principal_id) REFERENCES authority_principal(workspace_id, id),
  FOREIGN KEY (workspace_id, permission_uri, permission_version, permission_digest)
    REFERENCES permission_set(workspace_id, uri, version, implementation_digest)
);

CREATE TABLE authority_delegation (
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  id TEXT NOT NULL,
  subject_principal_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  not_before INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, subject_principal_id) REFERENCES authority_principal(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_principal_id) REFERENCES authority_principal(workspace_id, id)
);

CREATE TABLE authority_eligibility (
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('effect_approver', 'effect_connector')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  not_before INTEGER,
  expires_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, principal_id, kind),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES authority_principal(workspace_id, id)
);

CREATE TABLE authorization_decision (
  decision_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code TEXT NOT NULL,
  subject_principal_id TEXT,
  actor_principal_id TEXT,
  action_uri TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  authority_revision INTEGER,
  envelope_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  decision_json TEXT NOT NULL
);

CREATE TABLE authority_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT,
  occurred_at INTEGER NOT NULL,
  actor_principal_id TEXT,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  authority_revision INTEGER,
  request_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE authority_idempotency (
  operation_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX subject_binding_lookup ON subject_binding(workspace_id, issuer, subject, status);
CREATE INDEX grant_grantee_lookup ON authorization_grant(workspace_id, grantee_principal_id, status);
CREATE INDEX delegation_pair_lookup ON authority_delegation(workspace_id, subject_principal_id, actor_principal_id, status);
CREATE INDEX eligibility_principal_lookup ON authority_eligibility(workspace_id, principal_id, status);
CREATE INDEX authority_decision_request ON authorization_decision(workspace_id, request_id);
CREATE UNIQUE INDEX authority_decision_request_unique ON authorization_decision(workspace_id, request_id);
CREATE INDEX authority_audit_workspace_sequence ON authority_audit(workspace_id, sequence);

CREATE TRIGGER authority_decision_no_update BEFORE UPDATE ON authorization_decision
BEGIN SELECT RAISE(ABORT, 'authorization decisions are immutable'); END;
CREATE TRIGGER authority_decision_no_delete BEFORE DELETE ON authorization_decision
BEGIN SELECT RAISE(ABORT, 'authorization decisions are append-only'); END;
CREATE TRIGGER authority_audit_no_update BEFORE UPDATE ON authority_audit
BEGIN SELECT RAISE(ABORT, 'authority audit is immutable'); END;
CREATE TRIGGER authority_audit_no_delete BEFORE DELETE ON authority_audit
BEGIN SELECT RAISE(ABORT, 'authority audit is append-only'); END;
CREATE TRIGGER authority_idempotency_no_update BEFORE UPDATE ON authority_idempotency
BEGIN SELECT RAISE(ABORT, 'authority idempotency is immutable'); END;
CREATE TRIGGER authority_idempotency_no_delete BEFORE DELETE ON authority_idempotency
BEGIN SELECT RAISE(ABORT, 'authority idempotency is durable'); END;
CREATE TRIGGER host_tenant_lifecycle BEFORE UPDATE ON host_tenant
WHEN NEW.id != OLD.id OR NEW.revision != OLD.revision + 1
  OR OLD.status = 'disabled' OR NEW.status != 'disabled' OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'invalid host tenant lifecycle'); END;
CREATE TRIGGER host_tenant_no_delete BEFORE DELETE ON host_tenant
BEGIN SELECT RAISE(ABORT, 'host tenants cannot be deleted'); END;
CREATE TRIGGER hosted_workspace_lifecycle BEFORE UPDATE ON hosted_workspace
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.host_tenant_id != OLD.host_tenant_id
  OR NEW.storage_binding_id != OLD.storage_binding_id OR NEW.created_at != OLD.created_at
  OR NEW.authority_revision != OLD.authority_revision + 1 OR NEW.updated_at < OLD.updated_at
  OR NOT (NEW.status = OLD.status OR (OLD.status = 'enabled' AND NEW.status = 'disabled'))
BEGIN SELECT RAISE(ABORT, 'invalid hosted workspace lifecycle'); END;
CREATE TRIGGER hosted_workspace_no_delete BEFORE DELETE ON hosted_workspace
BEGIN SELECT RAISE(ABORT, 'hosted workspaces cannot be deleted'); END;
CREATE TRIGGER permission_set_lifecycle BEFORE UPDATE ON permission_set
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.uri != OLD.uri OR NEW.version != OLD.version
  OR NEW.implementation_digest != OLD.implementation_digest OR NEW.actions_json != OLD.actions_json
  OR NEW.revision != OLD.revision + 1 OR OLD.status = 'retired' OR NEW.status != 'retired'
BEGIN SELECT RAISE(ABORT, 'invalid permission set lifecycle'); END;
CREATE TRIGGER permission_set_no_delete BEFORE DELETE ON permission_set
BEGIN SELECT RAISE(ABORT, 'permission set definitions are append-only'); END;
CREATE TRIGGER authority_principal_no_delete BEFORE DELETE ON authority_principal
BEGIN SELECT RAISE(ABORT, 'authority principals cannot be deleted'); END;
CREATE TRIGGER authority_principal_lifecycle BEFORE UPDATE ON authority_principal
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id OR NEW.kind != OLD.kind
  OR NEW.revision != OLD.revision + 1 OR OLD.status = 'disabled' OR NEW.status != 'disabled'
BEGIN SELECT RAISE(ABORT, 'invalid authority principal lifecycle'); END;
CREATE TRIGGER subject_binding_lifecycle BEFORE UPDATE ON subject_binding
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id OR NEW.principal_id != OLD.principal_id
  OR NEW.issuer != OLD.issuer OR NEW.subject != OLD.subject OR NEW.method != OLD.method
  OR NEW.created_at != OLD.created_at OR NEW.revision != OLD.revision + 1
  OR OLD.status = 'disabled' OR NEW.status != 'disabled' OR NEW.disabled_at IS NULL
BEGIN SELECT RAISE(ABORT, 'invalid subject binding lifecycle'); END;
CREATE TRIGGER subject_binding_no_delete BEFORE DELETE ON subject_binding
BEGIN SELECT RAISE(ABORT, 'subject bindings cannot be deleted'); END;
CREATE TRIGGER grant_lifecycle BEFORE UPDATE ON authorization_grant
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id
  OR NEW.grantor_principal_id != OLD.grantor_principal_id OR NEW.grantee_principal_id != OLD.grantee_principal_id
  OR NEW.permission_uri != OLD.permission_uri OR NEW.permission_version != OLD.permission_version
  OR NEW.permission_digest != OLD.permission_digest OR NEW.scope_json != OLD.scope_json
  OR NEW.not_before IS NOT OLD.not_before OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.revision != OLD.revision + 1 OR OLD.status = 'revoked' OR NEW.status != 'revoked'
BEGIN SELECT RAISE(ABORT, 'invalid authorization grant lifecycle'); END;
CREATE TRIGGER grant_no_delete BEFORE DELETE ON authorization_grant
BEGIN SELECT RAISE(ABORT, 'authorization grants cannot be deleted'); END;
CREATE TRIGGER delegation_lifecycle BEFORE UPDATE ON authority_delegation
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id
  OR NEW.subject_principal_id != OLD.subject_principal_id OR NEW.actor_principal_id != OLD.actor_principal_id
  OR NEW.actions_json != OLD.actions_json OR NEW.scope_json != OLD.scope_json
  OR NEW.not_before IS NOT OLD.not_before OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.revision != OLD.revision + 1 OR OLD.status = 'revoked' OR NEW.status != 'revoked'
BEGIN SELECT RAISE(ABORT, 'invalid authority delegation lifecycle'); END;
CREATE TRIGGER delegation_no_delete BEFORE DELETE ON authority_delegation
BEGIN SELECT RAISE(ABORT, 'authority delegations cannot be deleted'); END;
CREATE TRIGGER eligibility_lifecycle BEFORE UPDATE ON authority_eligibility
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id OR NEW.principal_id != OLD.principal_id
  OR NEW.kind != OLD.kind OR NEW.not_before IS NOT OLD.not_before OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.revision != OLD.revision + 1 OR OLD.status = 'revoked' OR NEW.status != 'revoked'
BEGIN SELECT RAISE(ABORT, 'invalid authority eligibility lifecycle'); END;
CREATE TRIGGER eligibility_no_delete BEFORE DELETE ON authority_eligibility
BEGIN SELECT RAISE(ABORT, 'authority eligibility cannot be deleted'); END;
`;

export const AUTHORITY_MIGRATION_DIGEST = `sha256:${createHash("sha256")
  .update(AUTHORITY_MIGRATION_SQL, "utf8").digest("hex")}`;

export const ENROLLMENT_MIGRATION_NAME = "0002_remote_enrollment";

export const ENROLLMENT_MIGRATION_SQL = `
CREATE TABLE hosted_enrollment (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  principal_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('human_device', 'workload_agent')),
  token_digest TEXT NOT NULL UNIQUE,
  action_upper_bound_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  access_expires_at INTEGER NOT NULL CHECK (access_expires_at > created_at),
  consumed_at INTEGER,
  revoked_at INTEGER,
  CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES authority_principal(workspace_id, id),
  FOREIGN KEY (workspace_id, issuer, subject) REFERENCES subject_binding(workspace_id, issuer, subject)
);

CREATE TABLE hosted_access_credential (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES hosted_enrollment(id),
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  principal_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('human_device', 'workload_agent')),
  token_digest TEXT NOT NULL UNIQUE,
  action_upper_bound_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  revoked_at INTEGER,
  FOREIGN KEY (workspace_id, principal_id) REFERENCES authority_principal(workspace_id, id),
  FOREIGN KEY (workspace_id, issuer, subject) REFERENCES subject_binding(workspace_id, issuer, subject),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE INDEX hosted_enrollment_workspace ON hosted_enrollment(workspace_id, expires_at);
CREATE INDEX hosted_access_credential_lookup ON hosted_access_credential(token_digest, status);
CREATE INDEX hosted_access_credential_workspace ON hosted_access_credential(workspace_id, status);

CREATE TRIGGER hosted_enrollment_lifecycle BEFORE UPDATE ON hosted_enrollment
WHEN NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id OR NEW.principal_id != OLD.principal_id
  OR NEW.issuer != OLD.issuer OR NEW.subject != OLD.subject OR NEW.client_kind != OLD.client_kind
  OR NEW.token_digest != OLD.token_digest OR NEW.action_upper_bound_json != OLD.action_upper_bound_json
  OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
  OR NEW.access_expires_at != OLD.access_expires_at
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (OLD.consumed_at IS NULL AND OLD.revoked_at IS NULL
      AND NOT ((NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NULL)
        OR (NEW.consumed_at IS NULL AND NEW.revoked_at IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'invalid enrollment lifecycle'); END;
CREATE TRIGGER hosted_enrollment_no_delete BEFORE DELETE ON hosted_enrollment
BEGIN SELECT RAISE(ABORT, 'enrollment records are retained'); END;
CREATE TRIGGER hosted_access_credential_lifecycle BEFORE UPDATE ON hosted_access_credential
WHEN NEW.id != OLD.id OR NEW.enrollment_id != OLD.enrollment_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.principal_id != OLD.principal_id OR NEW.issuer != OLD.issuer OR NEW.subject != OLD.subject
  OR NEW.client_kind != OLD.client_kind OR NEW.token_digest != OLD.token_digest
  OR NEW.action_upper_bound_json != OLD.action_upper_bound_json OR NEW.issued_at != OLD.issued_at
  OR NEW.expires_at != OLD.expires_at OR NEW.revision != OLD.revision + 1
  OR OLD.status = 'revoked' OR NEW.status != 'revoked' OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT, 'invalid access credential lifecycle'); END;
CREATE TRIGGER hosted_access_credential_no_delete BEFORE DELETE ON hosted_access_credential
BEGIN SELECT RAISE(ABORT, 'access credential records are retained'); END;
`;

export const ENROLLMENT_MIGRATION_DIGEST = `sha256:${createHash("sha256")
  .update(ENROLLMENT_MIGRATION_SQL, "utf8").digest("hex")}`;

export const SIGNING_CREDENTIAL_MIGRATION_NAME = "0003_signing_credentials";
export const SIGNING_CREDENTIAL_MIGRATION_SQL = `
CREATE TABLE signing_credential (
  credential_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES hosted_workspace(workspace_id),
  principal_id TEXT NOT NULL,
  profile_uri TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  public_material_json TEXT NOT NULL CHECK (json_valid(public_material_json)),
  public_material_digest TEXT NOT NULL,
  trust_root_digest TEXT NOT NULL,
  isolation_class TEXT NOT NULL CHECK (isolation_class IN (
    'shared_user_software','isolated_process','hardware','kms','webauthn','workload_identity'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending','active','suspended','revoked','compromised','retired')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  valid_from INTEGER NOT NULL CHECK (valid_from >= 0),
  expires_at INTEGER,
  replaces_credential_id TEXT REFERENCES signing_credential(credential_id),
  replaced_by_credential_id TEXT REFERENCES signing_credential(credential_id),
  enrollment_method TEXT NOT NULL,
  enrollment_evidence_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  activated_at INTEGER,
  suspended_at INTEGER,
  revoked_at INTEGER,
  compromised_at INTEGER,
  retired_at INTEGER,
  compromise_effective_at INTEGER,
  FOREIGN KEY (workspace_id, principal_id) REFERENCES authority_principal(workspace_id, id),
  CHECK (expires_at IS NULL OR expires_at > valid_from)
);

CREATE TABLE signing_credential_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL REFERENCES signing_credential(credential_id),
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'enrolled','activated','rotated','suspended','resumed','revoked','compromised','retired','recovered'
  )),
  prior_status TEXT,
  next_status TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  actor_principal_id TEXT NOT NULL,
  authority_decision_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);

CREATE TABLE signing_credential_authorization_use (
  authority_decision_id TEXT PRIMARY KEY REFERENCES authorization_decision(decision_id),
  workspace_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  used_at INTEGER NOT NULL CHECK (used_at >= 0)
);

CREATE UNIQUE INDEX signing_credential_material_identity
  ON signing_credential(workspace_id, profile_uri, profile_version, public_material_digest);
CREATE INDEX signing_credential_principal
  ON signing_credential(workspace_id, principal_id, status);
CREATE INDEX signing_credential_event_order
  ON signing_credential_event(workspace_id, sequence);
CREATE INDEX signing_credential_authorization_workspace
  ON signing_credential_authorization_use(workspace_id, used_at);

CREATE TRIGGER signing_credential_lifecycle BEFORE UPDATE ON signing_credential
WHEN NEW.credential_id != OLD.credential_id OR NEW.workspace_id != OLD.workspace_id
  OR NEW.principal_id != OLD.principal_id OR NEW.profile_uri != OLD.profile_uri
  OR NEW.profile_version != OLD.profile_version
  OR NEW.public_material_json != OLD.public_material_json
  OR NEW.public_material_digest != OLD.public_material_digest
  OR NEW.trust_root_digest != OLD.trust_root_digest
  OR NEW.isolation_class != OLD.isolation_class
  OR NEW.valid_from != OLD.valid_from OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.replaces_credential_id IS NOT OLD.replaces_credential_id
  OR NEW.enrollment_method != OLD.enrollment_method
  OR NEW.enrollment_evidence_digest != OLD.enrollment_evidence_digest
  OR NEW.created_at != OLD.created_at OR NEW.revision != OLD.revision + 1
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('active','revoked'))
    OR (OLD.status = 'active' AND NEW.status IN ('suspended','revoked','compromised','retired'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active','revoked','compromised','retired'))
  )
BEGIN SELECT RAISE(ABORT, 'invalid signing credential lifecycle'); END;
CREATE TRIGGER signing_credential_no_delete BEFORE DELETE ON signing_credential
BEGIN SELECT RAISE(ABORT, 'signing credentials are retained'); END;
CREATE TRIGGER signing_credential_event_no_update BEFORE UPDATE ON signing_credential_event
BEGIN SELECT RAISE(ABORT, 'signing credential events are immutable'); END;
CREATE TRIGGER signing_credential_event_no_delete BEFORE DELETE ON signing_credential_event
BEGIN SELECT RAISE(ABORT, 'signing credential events are append-only'); END;
CREATE TRIGGER signing_credential_authorization_use_no_update BEFORE UPDATE ON signing_credential_authorization_use
BEGIN SELECT RAISE(ABORT, 'signing credential authority uses are immutable'); END;
CREATE TRIGGER signing_credential_authorization_use_no_delete BEFORE DELETE ON signing_credential_authorization_use
BEGIN SELECT RAISE(ABORT, 'signing credential authority uses are retained'); END;
`;
export const SIGNING_CREDENTIAL_MIGRATION_DIGEST = `sha256:${createHash("sha256")
  .update(SIGNING_CREDENTIAL_MIGRATION_SQL, "utf8").digest("hex")}`;

export async function migrateAuthorityStore(client: Client, appliedAt: number): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS authority_migration (
    name TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  for (const migration of [
    { name: AUTHORITY_MIGRATION_NAME, digest: AUTHORITY_MIGRATION_DIGEST, sql: AUTHORITY_MIGRATION_SQL },
    { name: ENROLLMENT_MIGRATION_NAME, digest: ENROLLMENT_MIGRATION_DIGEST, sql: ENROLLMENT_MIGRATION_SQL },
    { name: SIGNING_CREDENTIAL_MIGRATION_NAME, digest: SIGNING_CREDENTIAL_MIGRATION_DIGEST, sql: SIGNING_CREDENTIAL_MIGRATION_SQL },
  ]) {
    const transaction = await client.transaction("write");
    try {
      const existing = await transaction.execute({
        sql: "SELECT digest FROM authority_migration WHERE name = ?",
        args: [migration.name],
      });
      const found = existing.rows[0]?.["digest"];
      if (found !== undefined) {
        if (String(found) !== migration.digest) {
          throw new Error(`authority migration checksum mismatch for ${migration.name}`);
        }
        await transaction.commit();
        continue;
      }
      await transaction.executeMultiple(migration.sql);
      await transaction.execute({
        sql: "INSERT INTO authority_migration(name, digest, applied_at) VALUES (?, ?, ?)",
        args: [migration.name, migration.digest, appliedAt],
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}
