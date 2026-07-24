import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { z } from "zod";
import {
  HostedMutationError,
  HostedMutationOutcomeSchema,
  type HostedMutationOutcome,
} from "./http.js";

export const HOSTED_WORKSPACE_RECEIPT_MIGRATION_NAME = "0001_hosted_workspace_receipts";
export const HOSTED_WORKSPACE_RECEIPT_MIGRATION_SQL = `
CREATE TABLE hosted_mutation_receipt (
  workspace_id TEXT NOT NULL,
  idempotency_key_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (workspace_id, idempotency_key_digest)
);

CREATE TRIGGER hosted_mutation_receipt_no_update BEFORE UPDATE ON hosted_mutation_receipt
BEGIN SELECT RAISE(ABORT, 'hosted mutation receipts are immutable'); END;
CREATE TRIGGER hosted_mutation_receipt_no_delete BEFORE DELETE ON hosted_mutation_receipt
BEGIN SELECT RAISE(ABORT, 'hosted mutation receipts are durable'); END;
`;
export const HOSTED_WORKSPACE_RECEIPT_MIGRATION_DIGEST = `sha256:${createHash("sha256")
  .update(HOSTED_WORKSPACE_RECEIPT_MIGRATION_SQL, "utf8").digest("hex")}`;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Id = z.string().min(1).max(500);

function sqliteConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(text);
}

export interface HostedWorkspaceReceiptStore {
  find(input: {
    workspaceId: string;
    idempotencyKeyDigest: string;
    requestDigest: string;
    operationId: string;
  }): Promise<HostedMutationOutcome | null>;
  save(outcome: HostedMutationOutcome, createdAt: number): Promise<HostedMutationOutcome>;
  close(): Promise<void>;
}

export async function openHostedWorkspaceReceiptStore(url: string): Promise<HostedWorkspaceReceiptStore> {
  if (!url.trim()) throw new Error("hosted workspace receipt URL is required");
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 30000");
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hosted_receipt_schema_migration (
      name TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const found = await client.execute({
    sql: "SELECT digest FROM hosted_receipt_schema_migration WHERE name = ?",
    args: [HOSTED_WORKSPACE_RECEIPT_MIGRATION_NAME],
  });
  if (found.rows.length === 0) {
    const transaction = await client.transaction("write");
    try {
      await transaction.executeMultiple(HOSTED_WORKSPACE_RECEIPT_MIGRATION_SQL);
      await transaction.execute({
        sql: "INSERT INTO hosted_receipt_schema_migration(name, digest, applied_at) VALUES (?, ?, ?)",
        args: [HOSTED_WORKSPACE_RECEIPT_MIGRATION_NAME, HOSTED_WORKSPACE_RECEIPT_MIGRATION_DIGEST, Date.now()],
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      client.close();
      throw error;
    }
  } else if (String(found.rows[0]?.["digest"]) !== HOSTED_WORKSPACE_RECEIPT_MIGRATION_DIGEST) {
    client.close();
    throw new Error("hosted workspace receipt migration digest mismatch");
  }

  async function exact(
    db: Client,
    input: {
      workspaceId: string;
      idempotencyKeyDigest: string;
      requestDigest: string;
      operationId: string;
    },
  ): Promise<HostedMutationOutcome | null> {
    const row = (await db.execute({
      sql: `SELECT request_digest, operation_id, outcome_json
        FROM hosted_mutation_receipt
        WHERE workspace_id = ? AND idempotency_key_digest = ?`,
      args: [
        Id.parse(input.workspaceId),
        Digest.parse(input.idempotencyKeyDigest),
      ],
    })).rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row["request_digest"] !== Digest.parse(input.requestDigest)
      || row["operation_id"] !== Id.parse(input.operationId)) {
      throw new HostedMutationError("conflict");
    }
    const parsed = HostedMutationOutcomeSchema.parse(JSON.parse(String(row["outcome_json"])));
    return { ...parsed, replayed: true };
  }

  return {
    find: (input) => exact(client, input),
    async save(raw, createdAt) {
      const outcome = HostedMutationOutcomeSchema.parse(raw);
      try {
        await client.execute({
          sql: `INSERT INTO hosted_mutation_receipt(
            workspace_id, idempotency_key_digest, request_digest, operation_id, outcome_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            outcome.workspaceId,
            outcome.idempotencyKeyDigest,
            outcome.requestDigest,
            outcome.operationId,
            JSON.stringify(outcome),
            z.number().int().nonnegative().parse(createdAt),
          ],
        });
        return outcome;
      } catch (error) {
        if (!sqliteConflict(error)) throw error;
        const prior = await exact(client, {
          workspaceId: outcome.workspaceId,
          idempotencyKeyDigest: outcome.idempotencyKeyDigest,
          requestDigest: outcome.requestDigest,
          operationId: outcome.operationId,
        });
        if (!prior) throw error;
        return prior;
      }
    },
    async close() {
      client.close();
    },
  };
}
