/**
 * Recurrence (SPEC §6.4-H) — minimal neutral stored recurrence.
 *
 * Two pieces:
 *   - recurrence calculation belongs to the DB-free life-planning profile;
 *     this module re-exports it for v1 compatibility.
 *   - `materializeNextInstance` — injected into `transitionTaskStatus` ONLY on the
 *     done transition of a recurring task. It spawns a fresh `open` task one
 *     cadence-step from the chosen anchor, copying the template's identity +
 *     recurrence config, carries the streak forward, and records an
 *     `instance_generated` event. The completed instance stays terminal.
 *
 * The scheduling *intelligence* (which exact day, skip policy, on-time vs late)
 * stays L2 — L1 only steps the calendar and materializes the next row.
 */

import {
  task,
  uuidv7,
  type Task as TaskT,
  type Event as EventT,
} from "@tasq-run/schema";
import type { TasqDbOrTx } from "../db.js";
import { recordEvent } from "./events.js";
import type { ServiceContext } from "./context.js";
import {
  nextOccurrence,
  planNextRecurrence,
} from "@tasq-internal/life-planning-profile";

export { nextOccurrence } from "@tasq-internal/life-planning-profile";

export interface MaterializedInstance {
  /** Id of the spawned `open` instance. */
  id: string;
  /**
   * The deferred `instance_generated` event. The caller emits it via
   * `emitAfterCommit` once the surrounding transaction commits (so the external
   * journal mirrors only what durably landed — matching the other mutations).
   */
  event: EventT;
}

/**
 * Materialize the next instance of a just-completed recurring task INSIDE the
 * caller's transaction (so the spawn + its event commit/roll back atomically
 * with the completion). Returns the spawned id + its deferred event.
 *
 * Preconditions (enforced by the caller in `transitionTaskStatus`):
 *   - `completed.recurrence != null`
 *   - the task just transitioned INTO `done` (not a done→done no-op).
 *
 * Anchoring (which timestamp the next instance steps from):
 *   - 'due'        → completed.dueAt        (falls back to now if null)
 *   - 'scheduled'  → completed.scheduledAt  (falls back to now if null)
 *   - 'completion' → now
 * The stepped value is written to the SAME field(s) the template used, so a
 * template with a dueAt keeps a dueAt, one with a scheduledAt keeps that, etc.
 */
export async function materializeNextInstance(
  tx: TasqDbOrTx,
  completed: TaskT,
  now: number,
  ctx: ServiceContext = {},
): Promise<MaterializedInstance> {
  const tenantId = ctx.tenantId ?? completed.tenantId;
  const actor = ctx.actor ?? "system";
  const plan = planNextRecurrence(completed, now);
  const {
    unit,
    interval,
    anchor,
    nextDueAt,
    nextScheduledAt,
    chainRootId: chainRoot,
    streak: newStreak,
  } = plan;
  const newId = uuidv7(now);

  await tx.insert(task).values({
    id: newId,
    tenantId,
    projectId: completed.projectId,
    goalId: completed.goalId,
    areaId: completed.areaId,
    parentTaskId: completed.parentTaskId,
    title: completed.title,
    description: completed.description,
    nextAction: completed.nextAction,
    successCriteria: completed.successCriteria,
    completionMode: completed.completionMode,
    validationRequired: completed.validationRequired,
    status: "open",
    priority: completed.priority,
    estimatedMinutes: completed.estimatedMinutes,
    scheduledAt: nextScheduledAt,
    dueAt: nextDueAt,
    startedAt: null,
    completedAt: null,
    recurrence: completed.recurrence,
    recurrenceInterval: interval,
    recurrenceAnchor: anchor,
    lastDoneAt: now,
    streak: newStreak,
    recurrenceParentId: chainRoot,
    metadata: JSON.stringify(completed.metadata),
    createdAt: now,
    updatedAt: now,
  });

  const event = await recordEvent(
    tx,
    {
      tenantId,
      actor,
      entityType: "task",
      entityId: newId,
      eventType: "instance_generated",
      payload: {
        source: "recurrence",
        after: {
          recurrence: unit,
          anchor,
          interval,
          fromTaskId: completed.id,
          recurrenceParentId: chainRoot,
          streak: newStreak,
          ...(nextDueAt != null ? { nextDueAt } : {}),
          ...(nextScheduledAt != null ? { nextScheduledAt } : {}),
        },
      },
    },
    { defer: true, now },
  );

  return { id: newId, event };
}
