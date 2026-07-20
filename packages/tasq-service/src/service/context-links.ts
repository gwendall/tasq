/**
 * Append-only links from commitments to reusable context owned elsewhere.
 *
 * Tasq never fetches, indexes, embeds, authorizes or stores the referenced
 * content. A floating link is deliberately reported as floating; a version or
 * digest makes the pointer pinned but still does not authenticate its content.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  AttachExternalContextLinkInput as AttachInputZ,
  DetachExternalContextLinkInput as DetachInputZ,
  EXTERNAL_CONTEXT_LINK_CONTRACT_VERSION,
  ExternalContextLink as LinkZ,
  externalContextLink,
  principal,
  task,
  uuidv7,
  type AttachExternalContextLinkInput,
  type Clock,
  type DetachExternalContextLinkInput,
  type Event,
  type ExternalContextLink,
  type NormalizedAttachExternalContextLinkInput,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";

export const EXTERNAL_CONTEXT_LINK_EVENT_TYPE = "external_context_link_appended" as const;

export interface ExternalContextLinkContext {
  actor?: string;
  principalId?: string;
  idempotencyKey: string;
  clock?: Clock;
  now?: number;
}

export interface ListExternalContextLinksOptions {
  workspaceId: string;
  commitmentId?: string;
  currentOnly?: boolean;
  limit?: number;
}

type LinkRow = typeof externalContextLink.$inferSelect;

function parseLink(row: LinkRow, superseded: boolean): ExternalContextLink {
  return LinkZ.parse({
    contractVersion: EXTERNAL_CONTEXT_LINK_CONTRACT_VERSION,
    id: row.id,
    workspaceId: row.tenantId,
    commitmentId: row.taskId,
    purposeUri: row.purposeUri,
    action: row.action,
    supersedesLinkId: row.supersedesLinkId,
    target: {
      system: row.system,
      resourceType: row.resourceType,
      externalId: row.externalId,
      url: row.url,
      version: row.version,
      digest: row.digest,
    },
    binding: row.version !== null || row.digest !== null ? "pinned" : "floating",
    actorAlias: row.actor,
    principalId: row.principalId,
    createdAt: row.createdAt,
    state: superseded ? "superseded" : row.action === "attach" ? "active" : "detached",
  });
}

async function materializeRows(db: TasqDbOrTx, rows: LinkRow[]): Promise<ExternalContextLink[]> {
  if (rows.length === 0) return [];
  const workspaceId = rows[0]!.tenantId;
  const ids = rows.map((row) => row.id);
  const children = await db.select({ supersedesLinkId: externalContextLink.supersedesLinkId })
    .from(externalContextLink).where(and(
      eq(externalContextLink.tenantId, workspaceId),
      inArray(externalContextLink.supersedesLinkId, ids),
    ));
  const superseded = new Set(children.flatMap((row) =>
    row.supersedesLinkId === null ? [] : [row.supersedesLinkId]));
  return rows.map((row) => parseLink(row, superseded.has(row.id)));
}

export async function getExternalContextLink(
  db: TasqDbOrTx,
  id: string,
  workspaceId: string,
): Promise<ExternalContextLink | null> {
  const rows = await db.select().from(externalContextLink).where(and(
    eq(externalContextLink.id, id),
    eq(externalContextLink.tenantId, workspaceId),
  )).limit(1);
  return (await materializeRows(db, rows))[0] ?? null;
}

export async function listExternalContextLinks(
  db: TasqDbOrTx,
  options: ListExternalContextLinksOptions,
): Promise<ExternalContextLink[]> {
  const limit = options.limit ?? 100;
  const maximum = options.currentOnly ? 500 : 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`context-link limit must be between 1 and ${maximum}`);
  }
  const filters = [eq(externalContextLink.tenantId, options.workspaceId)];
  if (options.commitmentId) filters.push(eq(externalContextLink.taskId, options.commitmentId));
  if (options.currentOnly) {
    filters.push(eq(externalContextLink.action, "attach"));
    filters.push(sql`NOT EXISTS (
      SELECT 1 FROM external_context_link AS child
      WHERE child.tenant_id = ${externalContextLink.tenantId}
        AND child.supersedes_link_id = ${externalContextLink.id}
    )`);
  }
  const rows = await db.select().from(externalContextLink).where(and(...filters))
    .orderBy(asc(externalContextLink.createdAt), asc(externalContextLink.id)).limit(limit);
  return materializeRows(db, rows);
}

async function enabledPrincipal(
  tx: TasqDbOrTx,
  workspaceId: string,
  actor: string,
  principalId: string | undefined,
  now: number,
) {
  const result = principalId
    ? await getPrincipal(tx, principalId, workspaceId)
    : await ensureLocalPrincipal(tx, workspaceId, actor, now);
  if (!result) throw new Error(`Principal not found in workspace: ${principalId}`);
  if (result.status !== "enabled") throw new Error(`Principal is disabled: ${result.id}`);
  return result;
}

async function assertLiveCommitment(tx: TasqDbOrTx, workspaceId: string, commitmentId: string) {
  const rows = await tx.select({ id: task.id }).from(task).where(and(
    eq(task.tenantId, workspaceId), eq(task.id, commitmentId), sql`${task.deletedAt} IS NULL`,
  )).limit(1);
  if (!rows[0]) throw new Error(`Commitment not found: ${commitmentId}`);
}

function sameTarget(left: LinkRow, right: NormalizedAttachExternalContextLinkInput): boolean {
  return left.taskId === right.commitmentId && left.purposeUri === right.purposeUri &&
    left.system === right.target.system && left.resourceType === right.target.resourceType &&
    left.externalId === right.target.externalId;
}

function sameProjection(left: LinkRow, right: NormalizedAttachExternalContextLinkInput): boolean {
  return sameTarget(left, right) && left.action === "attach" &&
    left.url === right.target.url && left.version === right.target.version &&
    left.digest === right.target.digest;
}

export async function attachExternalContextLink(
  db: TasqDb,
  input: AttachExternalContextLinkInput,
  context: ExternalContextLinkContext,
): Promise<ExternalContextLink> {
  const parsed = AttachInputZ.parse(input);
  const actor = context.actor?.trim() || "system";
  if (!context.idempotencyKey?.trim()) throw new Error("idempotencyKey is required");
  const now = serviceNow(context, context.now);
  const identity = prepareIdempotency({
    tenantId: parsed.workspaceId, actor, principalId: context.principalId,
    idempotencyKey: context.idempotencyKey,
  }, "external_context_link.attach", parsed, { now, retentionClass: "durable" });

  const committed = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const replay = await getExternalContextLink(tx, prior.resultId, parsed.workspaceId);
      if (!replay) throw new Error(`Idempotency record points at missing context link ${prior.resultId}`);
      return { link: replay, event: null as Event | null };
    }
    await assertLiveCommitment(tx, parsed.workspaceId, parsed.commitmentId);
    const chain = await tx.select().from(externalContextLink).where(and(
      eq(externalContextLink.tenantId, parsed.workspaceId),
      eq(externalContextLink.taskId, parsed.commitmentId),
      eq(externalContextLink.purposeUri, parsed.purposeUri),
      eq(externalContextLink.system, parsed.target.system),
      eq(externalContextLink.resourceType, parsed.target.resourceType),
      eq(externalContextLink.externalId, parsed.target.externalId),
    )).orderBy(asc(externalContextLink.createdAt), asc(externalContextLink.id));
    const parents = new Set(chain.flatMap((row) => row.supersedesLinkId ? [row.supersedesLinkId] : []));
    const leaf = chain.find((row) => !parents.has(row.id)) ?? null;
    if ((leaf?.id ?? null) !== parsed.expectedPreviousLinkId) {
      throw new Error(
        `Stale context-link chain: expected previous ${parsed.expectedPreviousLinkId ?? "none"}, ` +
        `current leaf is ${leaf?.id ?? "none"}`,
      );
    }
    if (leaf && !sameTarget(leaf, parsed)) throw new Error("Context-link parent target mismatch");
    if (leaf && sameProjection(leaf, parsed)) throw new Error("Context link already has this projection");
    const caller = await enabledPrincipal(tx, parsed.workspaceId, actor, context.principalId, now);
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(externalContextLink).values({
      id, tenantId: parsed.workspaceId, taskId: parsed.commitmentId,
      purposeUri: parsed.purposeUri, action: "attach",
      supersedesLinkId: parsed.expectedPreviousLinkId,
      system: parsed.target.system, resourceType: parsed.target.resourceType,
      externalId: parsed.target.externalId, url: parsed.target.url,
      version: parsed.target.version, digest: parsed.target.digest,
      actor, principalId: caller.id, createdAt: now,
    });
    const auditEvent = await recordEvent(tx, {
      tenantId: parsed.workspaceId, actor, principalId: caller.id,
      entityType: "task", entityId: parsed.commitmentId,
      eventType: EXTERNAL_CONTEXT_LINK_EVENT_TYPE,
      payload: {
        linkId: id, action: "attach", supersedesLinkId: parsed.expectedPreviousLinkId,
        purposeUri: parsed.purposeUri, system: parsed.target.system,
        resourceType: parsed.target.resourceType, externalId: parsed.target.externalId,
        binding: parsed.target.version !== null || parsed.target.digest !== null ? "pinned" : "floating",
      },
    }, { defer: true, now });
    await saveIdempotencyResult(tx, identity, {
      resultType: "external_context_link", resultId: id, resultStatus: "active",
      eventSequence: auditEvent.sequence,
    });
    const link = await getExternalContextLink(tx, id, parsed.workspaceId);
    if (!link) throw new Error(`Failed to read back context link ${id}`);
    return { link, event: auditEvent };
  });
  if (committed.event) emitAfterCommit(committed.event);
  return committed.link;
}

export async function detachExternalContextLink(
  db: TasqDb,
  input: DetachExternalContextLinkInput,
  context: ExternalContextLinkContext,
): Promise<ExternalContextLink> {
  const parsed = DetachInputZ.parse(input);
  const actor = context.actor?.trim() || "system";
  if (!context.idempotencyKey?.trim()) throw new Error("idempotencyKey is required");
  const now = serviceNow(context, context.now);
  const identity = prepareIdempotency({
    tenantId: parsed.workspaceId, actor, principalId: context.principalId,
    idempotencyKey: context.idempotencyKey,
  }, "external_context_link.detach", parsed, { now, retentionClass: "durable" });

  const committed = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const replay = await getExternalContextLink(tx, prior.resultId, parsed.workspaceId);
      if (!replay) throw new Error(`Idempotency record points at missing context link ${prior.resultId}`);
      return { link: replay, event: null as Event | null };
    }
    const parentRows = await tx.select().from(externalContextLink).where(and(
      eq(externalContextLink.tenantId, parsed.workspaceId),
      eq(externalContextLink.id, parsed.expectedPreviousLinkId),
    )).limit(1);
    const parent = parentRows[0];
    if (!parent) throw new Error(`Context link not found: ${parsed.expectedPreviousLinkId}`);
    const children = await tx.select({ id: externalContextLink.id }).from(externalContextLink)
      .where(and(eq(externalContextLink.tenantId, parsed.workspaceId),
        eq(externalContextLink.supersedesLinkId, parent.id))).limit(1);
    if (children[0]) throw new Error(`Stale context-link chain: current leaf is ${children[0].id}`);
    if (parent.action !== "attach") throw new Error("Context link is already detached");
    await assertLiveCommitment(tx, parsed.workspaceId, parent.taskId);
    const caller = await enabledPrincipal(tx, parsed.workspaceId, actor, context.principalId, now);
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(externalContextLink).values({
      id, tenantId: parsed.workspaceId, taskId: parent.taskId,
      purposeUri: parent.purposeUri, action: "detach", supersedesLinkId: parent.id,
      system: parent.system, resourceType: parent.resourceType, externalId: parent.externalId,
      url: parent.url, version: parent.version, digest: parent.digest,
      actor, principalId: caller.id, createdAt: now,
    });
    const auditEvent = await recordEvent(tx, {
      tenantId: parsed.workspaceId, actor, principalId: caller.id,
      entityType: "task", entityId: parent.taskId,
      eventType: EXTERNAL_CONTEXT_LINK_EVENT_TYPE,
      payload: {
        linkId: id, action: "detach", supersedesLinkId: parent.id,
        purposeUri: parent.purposeUri, system: parent.system,
        resourceType: parent.resourceType, externalId: parent.externalId,
      },
    }, { defer: true, now });
    await saveIdempotencyResult(tx, identity, {
      resultType: "external_context_link", resultId: id, resultStatus: "detached",
      eventSequence: auditEvent.sequence,
    });
    const link = await getExternalContextLink(tx, id, parsed.workspaceId);
    if (!link) throw new Error(`Failed to read back context link ${id}`);
    return { link, event: auditEvent };
  });
  if (committed.event) emitAfterCommit(committed.event);
  return committed.link;
}
