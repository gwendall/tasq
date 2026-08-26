/** Atomic, local-first capture of work discovered while executing a task. */

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentRelation,
  TaskInsert,
  uuidv7,
  type Task,
  type TaskDependency,
} from "@tasq-run/schema";
import type { TasqDb } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import type { TaskServiceContext } from "./tasks.js";
import { createTaskInTransaction, getTask } from "./tasks.js";
import { ensureLocalPrincipal } from "./principals.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";

export const DISCOVERY_CAPTURE_CONTEXT_MAX_BYTES = 16_384;

const CaptureDiscoveryInput = z.object({
  sourceTaskId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  nextAction: z.string().trim().min(1).max(2_000).nullable().default(null),
  sourceCommand: z.string().trim().min(1).max(500).nullable().default(null),
  context: z.record(z.unknown()).default({}),
});

export interface CaptureDiscoveryResult {
  task: Task;
  relation: TaskDependency;
  replayed: boolean;
}

/**
 * Create one follow-up and its provenance edge in the same writer transaction.
 * The source task and any active claim are read-only: capture never widens,
 * releases, renews or otherwise mutates execution authority.
 */
export async function captureDiscovery(
  db: TasqDb,
  input: unknown,
  context: TaskServiceContext = {},
): Promise<CaptureDiscoveryResult> {
  const parsed = CaptureDiscoveryInput.parse(input);
  const encodedContext = JSON.stringify(parsed.context);
  if (Buffer.byteLength(encodedContext, "utf8") > DISCOVERY_CAPTURE_CONTEXT_MAX_BYTES) {
    throw new Error(
      `Discovery context exceeds ${DISCOVERY_CAPTURE_CONTEXT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const tenantId = context.tenantId ?? "gwendall";
  const actor = context.actor ?? "system";
  const now = serviceNow(context, context.now);
  const retryRequest = { ...parsed, tenantId, actor, principalId: context.principalId ?? null };
  const retry = prepareIdempotency(
    { ...context, tenantId, actor },
    "discovery.capture",
    retryRequest,
    { now },
  );

  const outcome = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const existing = await getTask(tx, prior.resultId, tenantId);
      if (!existing) throw new Error(`Idempotency record points at missing task ${prior.resultId}`);
      const relations = await tx.select().from(commitmentRelation).where(and(
        eq(commitmentRelation.tenantId, tenantId),
        eq(commitmentRelation.fromTaskId, existing.id),
        eq(commitmentRelation.toTaskId, parsed.sourceTaskId),
        eq(commitmentRelation.relationType, "discovered_from"),
        isNull(commitmentRelation.endedAt),
      )).limit(1);
      const relation = relations[0];
      if (!relation) throw new Error(`Idempotent discovery ${existing.id} is missing its provenance relation`);
      return {
        result: {
          task: existing,
          relation: {
            id: relation.id,
            tenantId,
            fromTaskId: relation.fromTaskId,
            toTaskId: relation.toTaskId,
            type: "discovered_from" as const,
            createdAt: relation.createdAt,
            updatedAt: relation.createdAt,
            deletedAt: null,
          },
          replayed: true,
        },
        events: [],
      };
    }

    const source = await getTask(tx, parsed.sourceTaskId, tenantId);
    if (!source) throw new Error(`Task not found: ${parsed.sourceTaskId}`);
    if (source.deletedAt !== null) throw new Error(`Task is deleted: ${parsed.sourceTaskId}`);

    const taskInput = TaskInsert.parse({
      tenantId,
      title: parsed.title,
      nextAction: parsed.nextAction,
      areaId: source.areaId,
      goalId: source.goalId,
      projectId: source.projectId,
      metadata: {
        discovery: {
          contract: "tasq.discovery-capture.v1",
          sourceTaskId: source.id,
          sourceTaskRevision: source.revision,
          sourceCommand: parsed.sourceCommand,
          context: parsed.context,
        },
      },
    });
    const created = await createTaskInTransaction(tx, taskInput, {
      tenantId,
      actor,
      principalId: context.principalId,
      now,
      hierarchyPolicy: context.hierarchyPolicy,
      eventContext: { source: `discovery:${source.id}` },
    });
    const principal = await ensureLocalPrincipal(tx, tenantId, actor, now);
    const relationId = uuidv7(now);
    await tx.insert(commitmentRelation).values({
      id: relationId,
      tenantId,
      fromTaskId: created.result.id,
      relationType: "discovered_from",
      toTaskId: source.id,
      revision: 1,
      createdByPrincipalId: principal.id,
      createdAt: now,
      endedByPrincipalId: null,
      endedAt: null,
    });
    const relationEvent = await recordEvent(tx, {
      tenantId,
      actor,
      principalId: context.principalId,
      entityType: "task",
      entityId: created.result.id,
      eventType: "dependency_added",
      payload: { after: { toTaskId: source.id, type: "discovered_from" } },
    }, { defer: true, now });
    await saveIdempotencyResult(tx, retry, {
      resultType: "commitment",
      resultId: created.result.id,
      resultStatus: created.result.status,
      resultRevision: created.result.revision,
      eventSequence: created.event.sequence,
    });
    return {
      result: {
        task: created.result,
        relation: {
          id: relationId,
          tenantId,
          fromTaskId: created.result.id,
          toTaskId: source.id,
          type: "discovered_from" as const,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        replayed: false,
      },
      events: [created.event, relationEvent],
    };
  });

  for (const event of outcome.events) emitAfterCommit(event);
  return outcome.result;
}
