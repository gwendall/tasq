/** Stable principals for attribution. Authentication and authority are separate. */

import { and, asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  Principal as PrincipalZ,
  PrincipalInsert,
  principal,
  uuidv7,
  type Principal,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import { parseRow } from "../util/row.js";
import type { ServiceContext } from "./context.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";

function parsePrincipal(row: typeof principal.$inferSelect): Principal {
  return PrincipalZ.parse(parseRow(row));
}

/** Deterministic compatibility identity for a workspace-local actor alias. */
export function localPrincipalId(tenantId: string, alias: string): string {
  const legacy = `urn:tasq:local-principal:${Buffer.from(tenantId).toString("hex")}:${Buffer.from(alias).toString("hex")}`;
  // Preserve every already-valid compatibility identifier byte-for-byte. At
  // the public 200-byte/character boundaries the reversible hex form can
  // exceed Principal.id's 500-character contract, so use a domain-separated
  // digest only for identities that could never previously have been stored.
  if (legacy.length <= 500) return legacy;
  const digest = createHash("sha256")
    .update("tasq.local-principal.v1\0", "utf8")
    .update(JSON.stringify([tenantId, alias]), "utf8")
    .digest("hex");
  return `urn:tasq:local-principal:sha256:${digest}`;
}

/** Resolve/create local attribution inside an existing transaction. */
export async function ensureLocalPrincipal(
  db: TasqDbOrTx,
  tenantId: string,
  alias: string,
  now: number,
): Promise<Principal> {
  if (!alias.trim()) throw new Error("actor alias must not be blank");
  const id = localPrincipalId(tenantId, alias);
  await db.insert(principal).values({
    id,
    tenantId,
    kind: alias === "system" ? "service" : "agent",
    displayName: alias,
    localAlias: alias,
    status: "enabled",
    metadata: "{}",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const rows = await db.select().from(principal)
    .where(and(eq(principal.tenantId, tenantId), eq(principal.localAlias, alias)))
    .limit(1);
  const result = rows[0] ? parsePrincipal(rows[0]) : null;
  if (!result) throw new Error(`Failed to resolve local principal for ${alias}`);
  if (result.status !== "enabled") throw new Error(`Principal is disabled: ${result.id}`);
  return result;
}

export async function createPrincipal(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<Principal> {
  const parsed = PrincipalInsert.parse(input);
  const tenantId = parsed.tenantId;
  const now = serviceNow(ctx, ctx.now);
  const retryRequest = {
    input: parsed,
    caller: ctx.principalId ?? ctx.actor ?? "system",
  };
  const identity = prepareIdempotency({ ...ctx, tenantId }, "principal.create", retryRequest, {
    now,
    legacyRequest: retryRequest,
  });
  return runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const result = await getPrincipal(tx, prior.resultId, tenantId);
      if (!result) throw new Error(`Idempotency record points at missing principal ${prior.resultId}`);
      return result;
    }
    const id = parsed.id ?? (parsed.localAlias
      ? localPrincipalId(tenantId, parsed.localAlias)
      : uuidv7(now));
    await tx.insert(principal).values({
      id,
      tenantId,
      kind: parsed.kind,
      displayName: parsed.displayName,
      localAlias: parsed.localAlias,
      status: parsed.status,
      metadata: JSON.stringify(parsed.metadata),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const result = await getPrincipal(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back principal ${id}`);
    await saveIdempotencyResult(tx, identity, {
      resultType: "principal",
      resultId: id,
      resultStatus: result.status,
      resultRevision: result.revision,
    });
    return result;
  });
}

export async function getPrincipal(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<Principal | null> {
  const rows = await db.select().from(principal)
    .where(and(eq(principal.id, id), eq(principal.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parsePrincipal(rows[0]) : null;
}

export async function listPrincipals(
  db: TasqDb,
  options: { tenantId?: string; status?: "enabled" | "disabled" } = {},
): Promise<Principal[]> {
  const filters = [eq(principal.tenantId, options.tenantId ?? "gwendall")];
  if (options.status) filters.push(eq(principal.status, options.status));
  return (await db.select().from(principal).where(and(...filters)).orderBy(asc(principal.createdAt)))
    .map(parsePrincipal);
}

export async function setPrincipalStatus(
  db: TasqDb,
  id: string,
  status: "enabled" | "disabled",
  options: ServiceContext & { expectedRevision: number },
): Promise<Principal> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  return runInTransaction(db, async (tx) => {
    const before = await getPrincipal(tx, id, tenantId);
    if (!before) throw new Error(`Principal not found: ${id}`);
    if (before.status === status) return before;
    const rows = await tx.update(principal).set({
      status,
      updatedAt: now,
      revision: sql`${principal.revision} + 1`,
    }).where(and(
      eq(principal.id, id),
      eq(principal.tenantId, tenantId),
      eq(principal.revision, options.expectedRevision),
    )).returning();
    if (!rows[0]) throw new Error(`Stale principal revision or principal not found: ${id}`);
    return parsePrincipal(rows[0]);
  });
}
