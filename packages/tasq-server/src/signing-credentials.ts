import { createHash, createPublicKey, verify } from "node:crypto";
import { createClient, type Client, type Transaction } from "@libsql/client";
import { ACTION_URIS } from "@tasq-internal/authority";
import {
  SigningCredentialV1,
  canonicalizeEffectJson,
  type Clock,
  type SigningCredentialV1 as Credential,
} from "@tasq-run/schema";
import { z } from "zod";
import { migrateAuthorityStore } from "./migration.js";

const Id = z.string().min(1).max(500);
const Workspace = z.string().min(1).max(200);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Lifecycle = z.enum(["suspended", "active", "revoked", "compromised", "retired"]);
const Context = z.object({
  actorPrincipalId: Id,
  authorityDecisionId: Id,
  reason: z.string().min(1).max(1_000),
  expectedRevision: z.number().int().positive().nullable(),
}).strict();
export type SigningCredentialMutationContext = z.infer<typeof Context>;

function iso(value: number): string {
  return new Date(value).toISOString();
}
function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}`;
}
function materialKey(material: unknown) {
  const value = z.object({
    format: z.literal("jwk-okp-ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict().parse(material);
  const raw = Buffer.from(value.x, "base64url");
  if (raw.byteLength !== 32 || raw.toString("base64url") !== value.x) throw new Error("invalid Ed25519 public material");
  return createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: value.x } });
}
function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid credential ${key}`);
  return value;
}
function nullableInteger(row: Record<string, unknown>, key: string): number | null {
  return row[key] == null ? null : integer(row, key);
}
function parse(row: Record<string, unknown>): Credential {
  return SigningCredentialV1.parse({
    credentialId: row["credential_id"],
    workspaceId: row["workspace_id"],
    principalId: row["principal_id"],
    profileUri: row["profile_uri"],
    profileVersion: integer(row, "profile_version"),
    publicMaterial: JSON.parse(String(row["public_material_json"])),
    publicMaterialDigest: row["public_material_digest"],
    trustRootDigest: row["trust_root_digest"],
    isolationClass: row["isolation_class"],
    status: row["status"],
    revision: integer(row, "revision"),
    validFrom: iso(integer(row, "valid_from")),
    ...(nullableInteger(row, "expires_at") != null ? { expiresAt: iso(nullableInteger(row, "expires_at")!) } : {}),
    ...(row["replaces_credential_id"] != null ? { replacesCredentialId: String(row["replaces_credential_id"]) } : {}),
    enrollmentMethod: row["enrollment_method"],
    enrollmentEvidenceDigest: row["enrollment_evidence_digest"],
  });
}

async function consumeCredentialAuthority(
  transaction: Transaction,
  input: {
    workspaceId: string;
    credentialId: string;
    operationDigest: string;
    now: number;
    context: SigningCredentialMutationContext;
  },
): Promise<void> {
  const decision = await transaction.execute({
    sql: `SELECT decision, workspace_id, subject_principal_id, actor_principal_id,
                 action_uri, resource_kind, resource_id, authority_revision
          FROM authorization_decision WHERE decision_id = ?`,
    args: [input.context.authorityDecisionId],
  });
  const row = decision.rows[0] as Record<string, unknown> | undefined;
  if (!row || row["decision"] !== "allow"
    || row["workspace_id"] !== input.workspaceId
    || row["action_uri"] !== ACTION_URIS["credential.manage"]
    || row["resource_kind"] !== "workspace"
    || row["resource_id"] !== input.workspaceId
    || (row["actor_principal_id"] !== input.context.actorPrincipalId
      && row["subject_principal_id"] !== input.context.actorPrincipalId)) {
    throw new Error("credential mutation lacks an exact live authority decision");
  }
  const workspace = await transaction.execute({
    sql: "SELECT status, authority_revision FROM hosted_workspace WHERE workspace_id = ?",
    args: [input.workspaceId],
  });
  const workspaceRow = workspace.rows[0] as Record<string, unknown> | undefined;
  if (!workspaceRow || workspaceRow["status"] !== "enabled"
    || Number(workspaceRow["authority_revision"]) !== Number(row["authority_revision"])) {
    throw new Error("credential authority decision is stale");
  }
  await transaction.execute({
    sql: `INSERT INTO signing_credential_authorization_use(
            authority_decision_id, workspace_id, credential_id, operation_digest, used_at
          ) VALUES (?, ?, ?, ?, ?)`,
    args: [
      input.context.authorityDecisionId,
      input.workspaceId,
      input.credentialId,
      Digest.parse(input.operationDigest),
      input.now,
    ],
  });
}

export class SigningCredentialAuthority {
  constructor(private readonly client: Client, private readonly clock: Clock) {}
  close(): void { this.client.close(); }

  async get(id: string): Promise<Credential | null> {
    const result = await this.client.execute({ sql: "SELECT * FROM signing_credential WHERE credential_id = ?", args: [Id.parse(id)] });
    return result.rows[0] ? parse(result.rows[0] as Record<string, unknown>) : null;
  }

  async enrollEd25519(input: {
    credentialId: string;
    workspaceId: string;
    principalId: string;
    publicMaterial: unknown;
    trustRootDigest: string;
    isolationClass: Credential["isolationClass"];
    challenge: string;
    proofOfPossession: string;
    validFrom?: number;
    expiresAt?: number | null;
    replacesCredentialId?: string | null;
    enrollmentMethod: string;
    enrollmentEvidenceDigest: string;
  }, contextInput: SigningCredentialMutationContext): Promise<Credential> {
    const context = Context.parse(contextInput);
    if (context.expectedRevision !== null) {
      throw new Error("new signing credential enrollment requires expectedRevision null");
    }
    const now = this.clock.now();
    const credentialId = Id.parse(input.credentialId);
    const workspaceId = Workspace.parse(input.workspaceId);
    const principalId = Id.parse(input.principalId);
    const trustRootDigest = Digest.parse(input.trustRootDigest);
    const enrollmentEvidenceDigest = Digest.parse(input.enrollmentEvidenceDigest);
    const publicMaterialDigest = digest(input.publicMaterial);
    const challenge = z.string().min(32).max(500).parse(input.challenge);
    const proof = Buffer.from(z.string().regex(/^[A-Za-z0-9_-]{86}$/).parse(input.proofOfPossession), "base64url");
    const possessionBytes = Buffer.from([
      "tasq-credential-enrollment-v1", workspaceId, principalId, credentialId, challenge,
    ].join("\0"), "utf8");
    if (!verify(null, possessionBytes, materialKey(input.publicMaterial), proof)) {
      throw new Error("credential proof of possession failed");
    }
    const validFrom = input.validFrom ?? now;
    const operationDigest = digest({
      operation: "signing_credential.enroll",
      credentialId,
      workspaceId,
      principalId,
      publicMaterialDigest,
      trustRootDigest,
      isolationClass: input.isolationClass,
      validFrom,
      expiresAt: input.expiresAt ?? null,
      replacesCredentialId: input.replacesCredentialId ?? null,
      enrollmentMethod: input.enrollmentMethod,
      enrollmentEvidenceDigest,
    });
    const transaction = await this.client.transaction("write");
    try {
      await consumeCredentialAuthority(transaction, {
        workspaceId, credentialId, operationDigest, now, context,
      });
      const principal = await transaction.execute({
        sql: "SELECT 1 FROM authority_principal WHERE workspace_id = ? AND id = ? AND status = 'enabled'",
        args: [workspaceId, principalId],
      });
      if (!principal.rows[0]) throw new Error("credential principal is not enabled");
      if (input.replacesCredentialId) {
        const prior = await transaction.execute({
          sql: "SELECT * FROM signing_credential WHERE credential_id = ? AND workspace_id = ? AND principal_id = ?",
          args: [input.replacesCredentialId, workspaceId, principalId],
        });
        if (!prior.rows[0]) throw new Error("replacement credential does not match principal");
      }
      await transaction.execute({
        sql: `INSERT INTO signing_credential(
          credential_id, workspace_id, principal_id, profile_uri, profile_version,
          public_material_json, public_material_digest, trust_root_digest, isolation_class, status, revision,
          valid_from, expires_at, replaces_credential_id, replaced_by_credential_id,
          enrollment_method, enrollment_evidence_digest, created_at, activated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        args: [credentialId, workspaceId, principalId,
          "https://schemas.tasq.dev/signatures/ed25519/v1",
          canonicalizeEffectJson(input.publicMaterial as never), publicMaterialDigest, trustRootDigest,
          input.isolationClass,
          validFrom, input.expiresAt ?? null, input.replacesCredentialId ?? null,
          z.string().min(1).max(200).parse(input.enrollmentMethod), enrollmentEvidenceDigest, now, now],
      });
      if (input.replacesCredentialId) {
        const oldRows = await transaction.execute({
          sql: "SELECT revision, status FROM signing_credential WHERE credential_id = ?",
          args: [input.replacesCredentialId],
        });
        const oldRow = oldRows.rows[0] as Record<string, unknown> | undefined;
        if (!oldRow) throw new Error("replacement credential disappeared");
        const oldRevision = Number(oldRow["revision"]) + 1;
        await transaction.execute({
          sql: `UPDATE signing_credential SET status = 'retired', revision = revision + 1,
            replaced_by_credential_id = ?, retired_at = ? WHERE credential_id = ?`,
          args: [credentialId, now, input.replacesCredentialId],
        });
        await transaction.execute({
          sql: `INSERT INTO signing_credential_event(
            event_id, credential_id, workspace_id, principal_id, event_type, prior_status,
            next_status, credential_revision, occurred_at, actor_principal_id,
            authority_decision_id, reason, payload_json
          ) VALUES (?, ?, ?, ?, 'retired', ?, 'retired', ?, ?, ?, ?, ?, ?)`,
          args: [
            `credential:${input.replacesCredentialId}:${oldRevision}`,
            input.replacesCredentialId,
            workspaceId,
            principalId,
            String(oldRow["status"]),
            oldRevision,
            now,
            context.actorPrincipalId,
            context.authorityDecisionId,
            context.reason,
            canonicalizeEffectJson({ replacedByCredentialId: credentialId }),
          ],
        });
      }
      await transaction.execute({
        sql: `INSERT INTO signing_credential_event(
          event_id, credential_id, workspace_id, principal_id, event_type, prior_status,
          next_status, credential_revision, occurred_at, actor_principal_id,
          authority_decision_id, reason, payload_json
        ) VALUES (?, ?, ?, ?, ?, NULL, 'active', 1, ?, ?, ?, ?, ?)`,
        args: [`credential:${credentialId}:1`, credentialId, workspaceId, principalId,
          input.replacesCredentialId ? "recovered" : "enrolled", now, context.actorPrincipalId,
          context.authorityDecisionId, context.reason,
          canonicalizeEffectJson({ publicMaterialDigest, trustRootDigest, replacesCredentialId: input.replacesCredentialId ?? null })],
      });
      await transaction.commit();
      return (await this.get(credentialId))!;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async transition(id: string, nextStatusInput: z.input<typeof Lifecycle>, contextInput: SigningCredentialMutationContext & {
    compromiseEffectiveAt?: number | null;
  }): Promise<Credential> {
    const context = Context.parse({
      actorPrincipalId: contextInput.actorPrincipalId,
      authorityDecisionId: contextInput.authorityDecisionId,
      reason: contextInput.reason,
      expectedRevision: contextInput.expectedRevision,
    });
    const nextStatus = Lifecycle.parse(nextStatusInput);
    const now = this.clock.now();
    const transaction = await this.client.transaction("write");
    try {
      const found = await transaction.execute({ sql: "SELECT * FROM signing_credential WHERE credential_id = ?", args: [Id.parse(id)] });
      if (!found.rows[0]) throw new Error("signing credential not found");
      const prior = parse(found.rows[0] as Record<string, unknown>);
      if (context.expectedRevision !== prior.revision) throw new Error("signing credential revision conflict");
      const operationDigest = digest({
        operation: "signing_credential.transition",
        credentialId: prior.credentialId,
        workspaceId: prior.workspaceId,
        priorStatus: prior.status,
        nextStatus,
        expectedRevision: context.expectedRevision,
        compromiseEffectiveAt: contextInput.compromiseEffectiveAt ?? null,
      });
      await consumeCredentialAuthority(transaction, {
        workspaceId: prior.workspaceId,
        credentialId: prior.credentialId,
        operationDigest,
        now,
        context,
      });
      const column = nextStatus === "active" ? "activated_at" : `${nextStatus}_at`;
      const compromise = nextStatus === "compromised" ? contextInput.compromiseEffectiveAt ?? now : null;
      await transaction.execute({
        sql: `UPDATE signing_credential SET status = ?, revision = revision + 1,
          ${column} = ?, compromise_effective_at = CASE WHEN ? = 'compromised' THEN ? ELSE compromise_effective_at END
          WHERE credential_id = ?`,
        args: [nextStatus, now, nextStatus, compromise, id],
      });
      const revision = prior.revision + 1;
      await transaction.execute({
        sql: `INSERT INTO signing_credential_event(
          event_id, credential_id, workspace_id, principal_id, event_type, prior_status,
          next_status, credential_revision, occurred_at, actor_principal_id,
          authority_decision_id, reason, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [`credential:${id}:${revision}`, id, prior.workspaceId, prior.principalId,
          nextStatus === "active" ? "resumed" : nextStatus, prior.status, nextStatus,
          revision, now, context.actorPrincipalId, context.authorityDecisionId, context.reason,
          canonicalizeEffectJson({ compromiseEffectiveAt: compromise })],
      });
      await transaction.commit();
      return (await this.get(id))!;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

export async function openSigningCredentialAuthority(input: {
  url: string;
  clock: Clock;
}): Promise<SigningCredentialAuthority> {
  const client = createClient({ url: input.url });
  await client.execute("PRAGMA foreign_keys = ON");
  await migrateAuthorityStore(client, input.clock.now());
  return new SigningCredentialAuthority(client, input.clock);
}
