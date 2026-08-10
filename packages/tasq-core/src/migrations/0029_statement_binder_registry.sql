DROP TRIGGER signed_statement_binding_no_update;
DROP TRIGGER signed_statement_binding_no_delete;
DROP INDEX signed_statement_binding_record;

ALTER TABLE signed_statement_binding RENAME TO signed_statement_binding_closed;

CREATE TABLE signed_statement_binding (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL REFERENCES signed_statement(statement_id),
  verification_id TEXT NOT NULL REFERENCES signature_verification_record(id),
  binding_kind TEXT NOT NULL,
  binder_descriptor_json TEXT NOT NULL CHECK (json_valid(binder_descriptor_json)),
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  UNIQUE (tenant_id, binding_kind, record_type, record_id, statement_id)
);

INSERT INTO signed_statement_binding (
  id, tenant_id, statement_id, verification_id, binding_kind,
  binder_descriptor_json, record_type, record_id, record_digest,
  created_by_principal_id, created_at, metadata_json
)
SELECT
  id, tenant_id, statement_id, verification_id, binding_kind,
  CASE binding_kind
    WHEN 'artifact_authorship' THEN '{"allowedProfileUris":[],"binderImplementationDigest":"sha256:dd8c9cf781298b34919608b33ceb08cc9103ab3ad1a48c1be44e65eb70f425a5","binderUri":"https://schemas.tasq.dev/binders/artifact-authorship/v1","binderVersion":1,"bindingKind":"artifact_authorship","contractVersion":"tasq.statement-binder.v1","expectedRevisionRequired":false,"maximumAgeMs":null,"nonceMode":"unique","onlineAuthorizationRequired":false,"purposeUri":"https://schemas.tasq.dev/purposes/artifact-authorship/v1","purposeVersion":1,"recordType":"artifact","subjectTypeUri":"https://schemas.tasq.dev/subjects/artifact/v1"}'
    WHEN 'artifact_acceptance' THEN '{"allowedProfileUris":[],"binderImplementationDigest":"sha256:32b0e0599764f1eae7e85284a0fcf68ffd0eddf012d78ab2efb048a853ec5b73","binderUri":"https://schemas.tasq.dev/binders/artifact-acceptance/v1","binderVersion":1,"bindingKind":"artifact_acceptance","contractVersion":"tasq.statement-binder.v1","expectedRevisionRequired":false,"maximumAgeMs":null,"nonceMode":"unique","onlineAuthorizationRequired":false,"purposeUri":"https://schemas.tasq.dev/purposes/artifact-acceptance/v1","purposeVersion":1,"recordType":"artifact","subjectTypeUri":"https://schemas.tasq.dev/subjects/artifact/v1"}'
    WHEN 'completion_attestation' THEN '{"allowedProfileUris":[],"binderImplementationDigest":"sha256:2c307cf49cafad16216b92cdae44dbc63cf147fea840ef1308999f050f4d90ae","binderUri":"https://schemas.tasq.dev/binders/completion-attestation/v1","binderVersion":1,"bindingKind":"completion_attestation","contractVersion":"tasq.statement-binder.v1","expectedRevisionRequired":false,"maximumAgeMs":null,"nonceMode":"unique","onlineAuthorizationRequired":false,"purposeUri":"https://schemas.tasq.dev/purposes/completion-attestation/v1","purposeVersion":1,"recordType":"completion_proposal","subjectTypeUri":"https://schemas.tasq.dev/subjects/completion-proposal/v1"}'
    WHEN 'effect_approval' THEN '{"allowedProfileUris":[],"binderImplementationDigest":"sha256:839cd7d86cf0b156ac7b66647c37136a84a1c2fa2d5b37ff199f686a78443b9a","binderUri":"https://schemas.tasq.dev/binders/effect-approval/v1","binderVersion":1,"bindingKind":"effect_approval","contractVersion":"tasq.statement-binder.v1","expectedRevisionRequired":false,"maximumAgeMs":null,"nonceMode":"unique","onlineAuthorizationRequired":false,"purposeUri":"https://schemas.tasq.dev/purposes/effect-approval/v1","purposeVersion":1,"recordType":"effect_approval","subjectTypeUri":"https://schemas.tasq.dev/subjects/effect/v1"}'
    WHEN 'replication_operation_origin' THEN '{"allowedProfileUris":[],"binderImplementationDigest":"sha256:aafde9467f270374a3b7ec9b95a18f0151711e0760e817c0e004113c6271ad44","binderUri":"https://schemas.tasq.dev/binders/replication-operation-origin/v1","binderVersion":1,"bindingKind":"replication_operation_origin","contractVersion":"tasq.statement-binder.v1","expectedRevisionRequired":false,"maximumAgeMs":null,"nonceMode":"unique","onlineAuthorizationRequired":false,"purposeUri":"https://schemas.tasq.dev/purposes/replication-operation-origin/v1","purposeVersion":1,"recordType":"replication_operation","subjectTypeUri":"https://schemas.tasq.dev/subjects/replication-operation/v1"}'
    WHEN 'workspace_checkpoint' THEN '{"allowedProfileUris":[],"binderImplementationDigest":"sha256:e80b9d76bc9e2d6d0dd1ee5a253cebb2fbb33bd2a1b0918a8bccc6c1735db92f","binderUri":"https://schemas.tasq.dev/binders/workspace-checkpoint/v1","binderVersion":1,"bindingKind":"workspace_checkpoint","contractVersion":"tasq.statement-binder.v1","expectedRevisionRequired":false,"maximumAgeMs":null,"nonceMode":"unique","onlineAuthorizationRequired":false,"purposeUri":"https://schemas.tasq.dev/purposes/workspace-checkpoint/v1","purposeVersion":1,"recordType":"workspace_checkpoint","subjectTypeUri":"https://schemas.tasq.dev/subjects/workspace-checkpoint/v1"}'
    ELSE NULL
  END,
  record_type, record_id, record_digest, created_by_principal_id, created_at,
  metadata_json
FROM signed_statement_binding_closed;

DROP TABLE signed_statement_binding_closed;

CREATE INDEX signed_statement_binding_record
  ON signed_statement_binding(tenant_id, record_type, record_id, created_at);
CREATE TRIGGER signed_statement_binding_no_update BEFORE UPDATE ON signed_statement_binding
BEGIN SELECT RAISE(ABORT, 'signed statement bindings are immutable'); END;
CREATE TRIGGER signed_statement_binding_no_delete BEFORE DELETE ON signed_statement_binding
BEGIN SELECT RAISE(ABORT, 'signed statement bindings are append-only'); END;
