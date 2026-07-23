/** Deterministic reconciliation between typed waits and normalized facts. */

import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  observation,
  observationRoute,
  reconciliation,
  Reconciliation as ReconciliationZ,
  taskEvidence,
  uuidv7,
  waitCondition,
  Observation as ObservationZ,
  type Event as EventT,
  type Observation,
  type Reconciliation,
  type ReconciliationDecision,
  type ReconciliationEffect,
  type Clock,
} from "@tasq-run/schema";
import {
  REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "@tasq-internal/reference-extension";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import { getObservation } from "./observations.js";
import { conditionRouteKey, evaluateWaitObservation } from "./matchers.js";
import { getWaitCondition } from "./waits.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import { serviceNow } from "../util/clock.js";

function validateUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}

function parseReconciliation(row: typeof reconciliation.$inferSelect): Reconciliation {
  return ReconciliationZ.parse(row);
}

function parseObservationRow(row: typeof observation.$inferSelect): Observation {
  return ObservationZ.parse({
    ...row,
    payload: JSON.parse(row.payload) as unknown,
    metadata: JSON.parse(row.metadata) as unknown,
  });
}

async function reconciliationPrincipal(
  db: TasqDbOrTx,
  tenantId: string,
  actor: string,
  principalId: string | undefined,
  now: number,
) {
  if (!principalId) return ensureLocalPrincipal(db, tenantId, actor, now);
  const result = await getPrincipal(db, principalId, tenantId);
  if (!result) throw new Error(`Principal not found in workspace: ${principalId}`);
  if (result.status !== "enabled") throw new Error(`Principal is disabled: ${result.id}`);
  return result;
}

export interface ReconcileOptions {
  actor?: string;
  /** Stable authenticated subject; actor remains the human-readable alias. */
  principalId?: string;
  tenantId?: string;
  matcherVersion?: number;
  now?: number;
  clock?: Clock;
}

/** Internal form used when a deadline sweep already owns the write lock. */
export async function reconcileWaitObservationInTransaction(
  tx: TasqDbOrTx,
  conditionId: string,
  observationId: string,
  options: Required<Pick<ReconcileOptions, "actor" | "tenantId" | "matcherVersion" | "now">>
    & Pick<ReconcileOptions, "principalId">,
): Promise<{ result: Reconciliation; events: EventT[] }> {
  const { tenantId, actor, matcherVersion } = options;
  const now = validateUnixMs(options.now, "now");
  if (!actor.trim()) throw new Error("Reconciliation actor must not be blank");
  if (!Number.isSafeInteger(matcherVersion) || matcherVersion <= 0) {
    throw new Error("matcherVersion must be a positive integer");
  }
  const prior = await getReconciliationByEvaluation(
    tx,
    conditionId,
    observationId,
    matcherVersion,
    tenantId,
  );
  if (prior) return { result: prior, events: [] };

  const condition = await getWaitCondition(tx, conditionId, tenantId);
  if (!condition) throw new Error(`Wait condition not found: ${conditionId}`);
  const observed = await getObservation(tx, observationId, tenantId);
  if (!observed) throw new Error(`Observation not found: ${observationId}`);
  if (now < condition.createdAt || now < observed.recordedAt) {
    throw new Error("reconciledAt cannot precede condition creation or observation ingestion");
  }

  const match = evaluateWaitObservation(condition, observed, matcherVersion);
  const evaluatorIdentity = WAIT_KIND_EXTENSION_IDENTITIES[condition.kind];
  const decision: ReconciliationDecision = match.decision;
  let effect: ReconciliationEffect = "no_change";
  let reasonCode = match.reasonCode;
  let explanation = match.explanation;
  let evidenceId: string | null = null;
  const id = uuidv7(now);

  if (decision === "matched") {
    if (condition.status !== "waiting") {
      effect = "condition_terminal";
      reasonCode = `condition_already_${condition.status}`;
      explanation = `The typed fact matched, but the condition was already ${condition.status}.`;
    } else if (
      condition.deadlineAt != null &&
      (observed.occurredAt >= condition.deadlineAt || observed.recordedAt >= condition.deadlineAt)
    ) {
      reasonCode = "observation_not_before_deadline";
      explanation = "The typed fact matched, but it was not both occurred and recorded strictly before the deadline.";
    } else {
      effect = "satisfied";
      evidenceId = uuidv7(now);
      const attribution = await reconciliationPrincipal(
        tx,
        tenantId,
        actor,
        options.principalId,
        now,
      );
      await tx.update(waitCondition).set({
        status: "satisfied",
        satisfiedAt: now,
        satisfiedByObservationId: observed.id,
        updatedAt: now,
      }).where(and(eq(waitCondition.id, condition.id), eq(waitCondition.status, "waiting")));
      await tx.insert(taskEvidence).values({
        id: evidenceId,
        tenantId,
        taskId: condition.taskId,
        attemptId: null,
        supersedesEvidenceId: null,
        actor,
        principalId: attribution.id,
        kind: "wait_match",
        summary: `Typed ${condition.kind} condition matched observation ${observed.id}`,
        uri: observed.rawRef,
        digest: observed.digest,
        source: observed.source,
        observedAt: observed.occurredAt,
        metadata: JSON.stringify({
          waitConditionId: condition.id,
          observationId: observed.id,
          reconciliationId: id,
          matcherVersion,
          verificationLevel: observed.verificationLevel,
        }),
        createdAt: now,
      });
    }
  }

  await tx.insert(reconciliation).values({
    id,
    tenantId,
    conditionId: condition.id,
    observationId: observed.id,
    matcherKind: condition.kind,
    matcherVersion,
    evaluatorUri: evaluatorIdentity.evaluatorUri,
    evaluatorVersion: matcherVersion,
    evaluatorImplementationDigest: REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
    decision,
    effect,
    reasonCode,
    explanation,
    evidenceId,
    reconciledAt: now,
    reconciledBy: actor,
  });

  const events: EventT[] = [
    await recordEvent(tx, {
      tenantId,
      actor,
      entityType: "task",
      entityId: condition.taskId,
      eventType: "reconciliation_recorded",
      principalId: options.principalId,
      payload: { after: {
        reconciliationId: id,
        waitConditionId: condition.id,
        observationId: observed.id,
        matcherVersion,
        decision,
        effect,
        reasonCode,
        evidenceId,
      } },
    }, { defer: true, now }),
  ];
  if (effect === "satisfied" && evidenceId) {
    events.push(
      await recordEvent(tx, {
        tenantId,
        actor,
        entityType: "task",
        entityId: condition.taskId,
        eventType: "evidence_added",
        principalId: options.principalId,
        payload: { after: {
          evidenceId,
          kind: "wait_match",
          waitConditionId: condition.id,
          observationId: observed.id,
          reconciliationId: id,
        }, source: observed.source },
      }, { defer: true, now }),
      await recordEvent(tx, {
        tenantId,
        actor,
        entityType: "task",
        entityId: condition.taskId,
        eventType: "wait_satisfied",
        principalId: options.principalId,
        payload: {
          before: { waitConditionId: condition.id, status: "waiting" },
          after: {
            waitConditionId: condition.id,
            status: "satisfied",
            observationId: observed.id,
            reconciliationId: id,
            evidenceId,
          },
        },
      }, { defer: true, now }),
    );
  }
  const inserted = await getReconciliation(tx, id, tenantId);
  if (!inserted) throw new Error(`Failed to read back reconciliation ${id}`);
  return { result: inserted, events };
}

export async function reconcileWaitObservation(
  db: TasqDb,
  conditionId: string,
  observationId: string,
  options: ReconcileOptions = {},
): Promise<Reconciliation> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  if (!actor.trim()) throw new Error("Reconciliation actor must not be blank");
  const matcherVersion = options.matcherVersion ?? 1;
  if (!Number.isSafeInteger(matcherVersion) || matcherVersion <= 0) {
    throw new Error("matcherVersion must be a positive integer");
  }
  const now = validateUnixMs(serviceNow(options, options.now), "now");

  const { result, events } = await runInTransaction(db, async (tx) => {
    const prior = await getReconciliationByEvaluation(
      tx,
      conditionId,
      observationId,
      matcherVersion,
      tenantId,
    );
    if (prior) return { result: prior, events: [] as EventT[] };

    const condition = await getWaitCondition(tx, conditionId, tenantId);
    if (!condition) throw new Error(`Wait condition not found: ${conditionId}`);
    const observed = await getObservation(tx, observationId, tenantId);
    if (!observed) throw new Error(`Observation not found: ${observationId}`);
    if (now < condition.createdAt || now < observed.recordedAt) {
      throw new Error("reconciledAt cannot precede condition creation or observation ingestion");
    }

    const match = evaluateWaitObservation(condition, observed, matcherVersion);
    const evaluatorIdentity = WAIT_KIND_EXTENSION_IDENTITIES[condition.kind];
    let decision: ReconciliationDecision = match.decision;
    let effect: ReconciliationEffect = "no_change";
    let reasonCode = match.reasonCode;
    let explanation = match.explanation;
    let evidenceId: string | null = null;
    const id = uuidv7(now);

    if (decision === "matched") {
      if (condition.status !== "waiting") {
        effect = "condition_terminal";
        reasonCode = `condition_already_${condition.status}`;
        explanation = `The typed fact matched, but the condition was already ${condition.status}.`;
      } else if (
        condition.deadlineAt != null &&
        (observed.occurredAt >= condition.deadlineAt || observed.recordedAt >= condition.deadlineAt)
      ) {
        effect = "no_change";
        reasonCode = "observation_not_before_deadline";
        explanation = "The typed fact matched, but it was not both occurred and recorded strictly before the deadline.";
      } else {
        effect = "satisfied";
        evidenceId = uuidv7(now);
        const attribution = await reconciliationPrincipal(
          tx,
          tenantId,
          actor,
          options.principalId,
          now,
        );
        await tx
          .update(waitCondition)
          .set({
            status: "satisfied",
            satisfiedAt: now,
            satisfiedByObservationId: observed.id,
            updatedAt: now,
          })
          .where(and(eq(waitCondition.id, condition.id), eq(waitCondition.status, "waiting")));
        await tx.insert(taskEvidence).values({
          id: evidenceId,
          tenantId,
          taskId: condition.taskId,
          attemptId: null,
          supersedesEvidenceId: null,
          actor,
          principalId: attribution.id,
          kind: "wait_match",
          summary: `Typed ${condition.kind} condition matched observation ${observed.id}`,
          uri: observed.rawRef,
          digest: observed.digest,
          source: observed.source,
          observedAt: observed.occurredAt,
          metadata: JSON.stringify({
            waitConditionId: condition.id,
            observationId: observed.id,
            reconciliationId: id,
            matcherVersion,
            verificationLevel: observed.verificationLevel,
          }),
          createdAt: now,
        });
      }
    }

    await tx.insert(reconciliation).values({
      id,
      tenantId,
      conditionId: condition.id,
      observationId: observed.id,
      matcherKind: condition.kind,
      matcherVersion,
      evaluatorUri: evaluatorIdentity.evaluatorUri,
      evaluatorVersion: matcherVersion,
      evaluatorImplementationDigest: REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
      decision,
      effect,
      reasonCode,
      explanation,
      evidenceId,
      reconciledAt: now,
      reconciledBy: actor,
    });

    const events: EventT[] = [];
    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "task",
          entityId: condition.taskId,
          eventType: "reconciliation_recorded",
          principalId: options.principalId,
          payload: {
            after: {
              reconciliationId: id,
              waitConditionId: condition.id,
              observationId: observed.id,
              matcherVersion,
              decision,
              effect,
              reasonCode,
              evidenceId,
            },
          },
        },
        { defer: true, now },
      ),
    );
    if (effect === "satisfied" && evidenceId) {
      events.push(
        await recordEvent(
          tx,
          {
            tenantId,
            actor,
            entityType: "task",
            entityId: condition.taskId,
            eventType: "evidence_added",
            principalId: options.principalId,
            payload: {
              after: {
                evidenceId,
                kind: "wait_match",
                waitConditionId: condition.id,
                observationId: observed.id,
                reconciliationId: id,
              },
              source: observed.source,
            },
          },
          { defer: true, now },
        ),
      );
      events.push(
        await recordEvent(
          tx,
          {
            tenantId,
            actor,
            entityType: "task",
            entityId: condition.taskId,
            eventType: "wait_satisfied",
            principalId: options.principalId,
            payload: {
              before: { waitConditionId: condition.id, status: "waiting" },
              after: {
                waitConditionId: condition.id,
                status: "satisfied",
                observationId: observed.id,
                reconciliationId: id,
                evidenceId,
              },
            },
          },
          { defer: true, now },
        ),
      );
    }

    const inserted = await getReconciliation(tx, id, tenantId);
    if (!inserted) throw new Error(`Failed to read back reconciliation ${id}`);
    return { result: inserted, events };
  });

  for (const event of events) emitAfterCommit(event);
  return result;
}

export async function getReconciliation(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<Reconciliation | null> {
  const rows = await db
    .select()
    .from(reconciliation)
    .where(and(eq(reconciliation.id, id), eq(reconciliation.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parseReconciliation(rows[0]) : null;
}

export async function getReconciliationByEvaluation(
  db: TasqDbOrTx,
  conditionId: string,
  observationId: string,
  matcherVersion = 1,
  tenantId = "gwendall",
): Promise<Reconciliation | null> {
  const rows = await db
    .select()
    .from(reconciliation)
    .where(
      and(
        eq(reconciliation.tenantId, tenantId),
        eq(reconciliation.conditionId, conditionId),
        eq(reconciliation.observationId, observationId),
        eq(reconciliation.matcherVersion, matcherVersion),
      ),
    )
    .limit(1);
  return rows[0] ? parseReconciliation(rows[0]) : null;
}

export interface ListReconciliationsOptions {
  tenantId?: string;
  observationId?: string;
  decisions?: ReconciliationDecision[];
  effects?: ReconciliationEffect[];
  ascending?: boolean;
  limit?: number;
}

export async function listReconciliations(
  db: TasqDb,
  conditionId: string | null,
  options: ListReconciliationsOptions = {},
): Promise<Reconciliation[]> {
  const filters = [eq(reconciliation.tenantId, options.tenantId ?? "gwendall")];
  if (conditionId) filters.push(eq(reconciliation.conditionId, conditionId));
  if (options.observationId) filters.push(eq(reconciliation.observationId, options.observationId));
  if (options.decisions?.length) filters.push(inArray(reconciliation.decision, options.decisions));
  if (options.effects?.length) filters.push(inArray(reconciliation.effect, options.effects));
  const rows = await db
    .select()
    .from(reconciliation)
    .where(and(...filters))
    .orderBy((options.ascending ? asc : desc)(reconciliation.reconciledAt))
    .limit(options.limit ?? 100);
  return rows.map(parseReconciliation);
}

export async function listCandidateObservations(
  db: TasqDbOrTx,
  conditionId: string,
  options: {
    tenantId?: string;
    matcherVersion?: number;
    limit?: number;
    occurredBefore?: number;
    recordedBefore?: number;
  } = {},
): Promise<Observation[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const condition = await getWaitCondition(db, conditionId, tenantId);
  if (!condition) throw new Error(`Wait condition not found: ${conditionId}`);
  const route = conditionRouteKey(condition, options.matcherVersion ?? 1);
  const filters = [
    eq(observation.tenantId, tenantId),
    eq(observationRoute.kind, route.observationKind),
    eq(observationRoute.routeKey, route.routeKey),
    gte(observation.occurredAt, condition.notBefore),
  ];
  if (options.occurredBefore != null) {
    filters.push(lt(observation.occurredAt, validateUnixMs(options.occurredBefore, "occurredBefore")));
  }
  if (options.recordedBefore != null) {
    filters.push(lt(observation.recordedAt, validateUnixMs(options.recordedBefore, "recordedBefore")));
  }
  const rows = await db
    .select()
    .from(observation)
    .innerJoin(
      observationRoute,
      and(
        eq(observationRoute.observationId, observation.id),
        eq(observationRoute.tenantId, observation.tenantId),
      ),
    )
    .where(and(...filters))
    .orderBy(asc(observation.recordedAt), asc(observation.id))
    .limit(options.limit ?? 100);
  return rows.map((row) => parseObservationRow(row.observation));
}
