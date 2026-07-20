/** CLI surface for typed waits, normalized facts and deterministic matching. */

import {
  OBSERVATION_KINDS,
  RECONCILIATION_DECISIONS,
  RECONCILIATION_EFFECTS,
  VERIFICATION_LEVELS,
  WAIT_CONDITION_KINDS,
  WAIT_CONDITION_STATUSES,
  WAIT_FALLBACK_KINDS,
  cancelWaitCondition,
  createWaitCondition,
  getObservation,
  getReconciliation,
  getWaitCondition,
  ingestObservation,
  listCandidateObservations,
  listObservations,
  listReconciliations,
  listWaitConditions,
  reconcileWaitObservation,
  sweepWaitConditionDeadlines,
  type Metadata,
  type ObservationKind,
  type ReconciliationDecision,
  type ReconciliationEffect,
  type VerificationLevel,
  type WaitConditionKind,
  type WaitConditionStatus,
  type WaitFallbackKind,
} from "@tasq-internal/local-service";
import { enumArg, parseDateArg, type ParsedArgs } from "../args.js";
import { color, colorizeStatus, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime, regenerateProjection, type Runtime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { OBSERVATION_USAGE, RECONCILE_USAGE, WAIT_USAGE } from "./usage.js";

type Identified = { id: string };

function jsonObject(raw: string | undefined, flag: string, required = false): Metadata | undefined {
  if (raw === undefined) {
    if (required) throw new Error(`--${flag} is required`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON for --${flag}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--${flag} must be a JSON object`);
  }
  return parsed as Metadata;
}

function enumList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flag: string,
): T[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`--${flag} must not be empty`);
  return values.map((value) => enumArg(value, allowed, flag)!);
}

async function resolveResourceId(
  rt: Runtime,
  raw: string,
  label: string,
  get: (id: string) => Promise<Identified | null>,
  list: () => Promise<Identified[]>,
): Promise<string | null> {
  if (raw.length === 36) {
    const exact = await get(raw);
    if (exact) return exact.id;
  } else if (raw.length >= 4) {
    const matches = (await list()).filter((item) => item.id.startsWith(raw));
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      printError(`ambiguous ${label} id prefix '${raw}' (${matches.length} matches):`);
      for (const match of matches) printError(`  ${match.id}`);
      return null;
    }
  }
  printError(`${label} not found: ${raw}`);
  return null;
}

const waitId = (rt: Runtime, raw: string) => resolveResourceId(
  rt,
  raw,
  "wait condition",
  (id) => getWaitCondition(rt.db, id, rt.config.tenantId),
  () => listWaitConditions(rt.db, null, { tenantId: rt.config.tenantId, limit: 10_000 }),
);

const observationId = (rt: Runtime, raw: string) => resolveResourceId(
  rt,
  raw,
  "observation",
  (id) => getObservation(rt.db, id, rt.config.tenantId),
  () => listObservations(rt.db, { tenantId: rt.config.tenantId, limit: 10_000 }),
);

const reconciliationId = (rt: Runtime, raw: string) => resolveResourceId(
  rt,
  raw,
  "reconciliation",
  (id) => getReconciliation(rt.db, id, rt.config.tenantId),
  () => listReconciliations(rt.db, null, { tenantId: rt.config.tenantId, limit: 10_000 }),
);

export async function waitCmd(args: ParsedArgs): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub) {
    printError(WAIT_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "create" || sub === "add") {
      if (!raw) throw new Error(WAIT_USAGE);
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const kind = enumArg<WaitConditionKind>(
        args.string("kind"),
        WAIT_CONDITION_KINDS,
        "kind",
      );
      if (!kind) throw new Error("wait create requires --kind");
      const fallbackKind = enumArg<WaitFallbackKind>(
        args.string("fallback-kind"),
        WAIT_FALLBACK_KINDS,
        "fallback-kind",
      ) ?? "none";
      let fallbackTargetTaskId: string | null = null;
      const fallbackTask = args.string("fallback-task");
      if (fallbackTask) {
        fallbackTargetTaskId = await resolveTaskIdOrError(rt, fallbackTask, "fallback task");
        if (!fallbackTargetTaskId) return 1;
      }
      let supersedesConditionId: string | null = null;
      const supersedes = args.string("supersedes");
      if (supersedes) {
        supersedesConditionId = await waitId(rt, supersedes);
        if (!supersedesConditionId) return 1;
      }
      const condition = await createWaitCondition(rt.db, {
        taskId,
        kind,
        schemaVersion: args.number("schema-version") ?? 1,
        parameters: jsonObject(args.string("parameters"), "parameters", true),
        notBefore: args.string("not-before")
          ? parseDateArg(args.string("not-before")!)
          : undefined,
        deadlineAt: args.string("deadline")
          ? parseDateArg(args.string("deadline")!)
          : null,
        fallbackKind,
        fallbackSpec: jsonObject(args.string("fallback-spec"), "fallback-spec") ?? null,
        fallbackTargetTaskId,
        supersedesConditionId,
      }, { ...rt.ctx, idempotencyKey: args.string("idempotency-key") });
      await regenerateProjection(rt);
      if (args.bool("json", "j")) printJson(condition);
      else printInfo(`${color.green("✓")} waiting ${color.dim(shortId(condition.id))}  ${condition.kind}${condition.deadlineAt == null ? "" : `  deadline ${new Date(condition.deadlineAt).toISOString()}`}`);
      return 0;
    }

    if (sub === "list") {
      let taskId: string | null = null;
      if (raw) {
        taskId = await resolveTaskIdOrError(rt, raw);
        if (!taskId) return 1;
      }
      const conditions = await listWaitConditions(rt.db, taskId, {
        ...rt.ctx,
        statuses: enumList<WaitConditionStatus>(args.string("status"), WAIT_CONDITION_STATUSES, "status"),
        kinds: enumList<WaitConditionKind>(args.string("kind"), WAIT_CONDITION_KINDS, "kind"),
        ascending: args.bool("ascending"),
        limit: args.number("limit") ?? 100,
      });
      if (args.bool("json", "j")) printJson(conditions);
      else for (const item of conditions) {
        printInfo(`${color.dim(shortId(item.id))}  ${colorizeStatus(item.status).padEnd(12)} ${item.kind}  task:${shortId(item.taskId)}`);
      }
      return 0;
    }

    if (sub === "show") {
      if (!raw) throw new Error(WAIT_USAGE);
      const id = await waitId(rt, raw);
      if (!id) return 1;
      const condition = await getWaitCondition(rt.db, id, rt.config.tenantId);
      if (args.bool("json", "j")) printJson(condition);
      else printInfo(JSON.stringify(condition, null, 2));
      return 0;
    }

    if (sub === "cancel") {
      if (!raw) throw new Error(WAIT_USAGE);
      const id = await waitId(rt, raw);
      if (!id) return 1;
      const reason = args.string("reason");
      if (!reason) throw new Error("wait cancel requires --reason");
      const condition = await cancelWaitCondition(rt.db, id, { ...rt.ctx, reason });
      await regenerateProjection(rt);
      if (args.bool("json", "j")) printJson(condition);
      else printInfo(`${color.green("✓")} wait ${color.dim(shortId(id))} → ${condition.status}`);
      return 0;
    }

    if (sub === "candidates") {
      if (!raw) throw new Error(WAIT_USAGE);
      const id = await waitId(rt, raw);
      if (!id) return 1;
      const candidates = await listCandidateObservations(rt.db, id, {
        tenantId: rt.config.tenantId,
        matcherVersion: args.number("matcher-version") ?? 1,
        limit: args.number("limit") ?? 100,
      });
      if (args.bool("json", "j")) printJson(candidates);
      else for (const item of candidates) printInfo(`${color.dim(shortId(item.id))}  ${item.kind}  ${item.source}  ${item.subjectRef}`);
      return 0;
    }

    if (sub === "sweep") {
      if (raw) throw new Error("wait sweep does not accept a positional id");
      const result = await sweepWaitConditionDeadlines(rt.db, {
        ...rt.ctx,
        sweepNow: args.string("at") ? parseDateArg(args.string("at")!) : undefined,
        matcherVersion: args.number("matcher-version") ?? 1,
        limit: args.number("limit") ?? 100,
      });
      await regenerateProjection(rt);
      if (args.bool("json", "j")) printJson(result);
      else {
        printInfo(`${result.errors.length === 0 ? color.green("✓") : color.yellow("!")} sweep ${new Date(result.sweepNow).toISOString()}: ${result.satisfied} satisfied, ${result.expired} expired, ${result.errors.length} errors`);
        for (const error of result.errors) printError(`${shortId(error.conditionId)}: ${error.message}`);
      }
      return result.errors.length === 0 ? 0 : 1;
    }

    throw new Error(`Unknown wait subcommand: ${sub}`);
  } finally {
    await rt.close();
  }
}

export async function observationCmd(args: ParsedArgs): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub) {
    printError(OBSERVATION_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "ingest" || sub === "add") {
      if (raw) throw new Error("observation ingest uses flags, not positional payloads");
      const source = args.string("source");
      const externalEventId = args.string("external-event-id");
      const kind = enumArg<ObservationKind>(args.string("kind"), OBSERVATION_KINDS, "kind");
      const occurredAt = args.string("occurred-at");
      if (!source || !externalEventId || !kind || !occurredAt) {
        throw new Error("observation ingest requires --source, --external-event-id, --kind, --payload and --occurred-at");
      }
      const observation = await ingestObservation(rt.db, {
        source,
        externalEventId,
        kind,
        schemaVersion: args.number("schema-version") ?? 1,
        payload: jsonObject(args.string("payload"), "payload", true),
        occurredAt: parseDateArg(occurredAt),
        verificationLevel: enumArg<VerificationLevel>(
          args.string("verification-level"),
          VERIFICATION_LEVELS,
          "verification-level",
        ) ?? "unverified",
        verificationMethod: args.string("verification-method") ?? null,
        rawRef: args.string("raw-ref") ?? null,
        digest: args.string("digest") ?? null,
        metadata: jsonObject(args.string("metadata"), "metadata") ?? {},
      }, rt.ctx);
      if (args.bool("json", "j")) printJson(observation);
      else printInfo(`${color.green("✓")} observed ${color.dim(shortId(observation.id))}  ${observation.kind}  ${observation.subjectRef}`);
      return 0;
    }

    if (sub === "list") {
      if (raw) throw new Error("observation list does not accept a positional id");
      const afterRecordedAt = args.string("after-recorded-at");
      const afterId = args.string("after-id");
      if ((afterRecordedAt == null) !== (afterId == null)) {
        throw new Error("--after-recorded-at and --after-id must be supplied together");
      }
      const observations = await listObservations(rt.db, {
        tenantId: rt.config.tenantId,
        source: args.string("source"),
        kinds: enumList<ObservationKind>(args.string("kind"), OBSERVATION_KINDS, "kind"),
        verificationLevels: enumList<VerificationLevel>(args.string("verification-level"), VERIFICATION_LEVELS, "verification-level"),
        occurredFrom: args.string("occurred-from") ? parseDateArg(args.string("occurred-from")!) : undefined,
        occurredTo: args.string("occurred-to") ? parseDateArg(args.string("occurred-to")!) : undefined,
        after: afterRecordedAt && afterId
          ? { recordedAt: parseDateArg(afterRecordedAt), id: afterId }
          : undefined,
        ascending: args.bool("ascending"),
        limit: args.number("limit") ?? 100,
      });
      if (args.bool("json", "j")) printJson(observations);
      else for (const item of observations) printInfo(`${color.dim(shortId(item.id))}  ${item.kind}  ${item.source}  ${new Date(item.recordedAt).toISOString()}`);
      return 0;
    }

    if (sub === "show") {
      if (!raw) throw new Error(OBSERVATION_USAGE);
      const id = await observationId(rt, raw);
      if (!id) return 1;
      const observation = await getObservation(rt.db, id, rt.config.tenantId);
      if (args.bool("json", "j")) printJson(observation);
      else printInfo(JSON.stringify(observation, null, 2));
      return 0;
    }
    throw new Error(`Unknown observation subcommand: ${sub}`);
  } finally {
    await rt.close();
  }
}

export async function reconcileCmd(args: ParsedArgs): Promise<number> {
  const [first, second] = args.positional;
  if (!first) {
    printError(RECONCILE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (first === "list") {
      let conditionId: string | null = null;
      if (second) {
        conditionId = await waitId(rt, second);
        if (!conditionId) return 1;
      }
      let observedId: string | undefined;
      const observedRaw = args.string("observation");
      if (observedRaw) {
        observedId = (await observationId(rt, observedRaw)) ?? undefined;
        if (!observedId) return 1;
      }
      const rows = await listReconciliations(rt.db, conditionId, {
        tenantId: rt.config.tenantId,
        observationId: observedId,
        decisions: enumList<ReconciliationDecision>(args.string("decision"), RECONCILIATION_DECISIONS, "decision"),
        effects: enumList<ReconciliationEffect>(args.string("effect"), RECONCILIATION_EFFECTS, "effect"),
        ascending: args.bool("ascending"),
        limit: args.number("limit") ?? 100,
      });
      if (args.bool("json", "j")) printJson(rows);
      else for (const item of rows) printInfo(`${color.dim(shortId(item.id))}  ${item.decision.padEnd(10)} ${item.effect.padEnd(18)} wait:${shortId(item.conditionId)} obs:${shortId(item.observationId)}`);
      return 0;
    }

    if (first === "show") {
      if (!second) throw new Error(RECONCILE_USAGE);
      const id = await reconciliationId(rt, second);
      if (!id) return 1;
      const row = await getReconciliation(rt.db, id, rt.config.tenantId);
      if (args.bool("json", "j")) printJson(row);
      else printInfo(JSON.stringify(row, null, 2));
      return 0;
    }

    if (!second) throw new Error(RECONCILE_USAGE);
    const conditionId = await waitId(rt, first);
    if (!conditionId) return 1;
    const observedId = await observationId(rt, second);
    if (!observedId) return 1;
    const result = await reconcileWaitObservation(rt.db, conditionId, observedId, {
      ...rt.ctx,
      matcherVersion: args.number("matcher-version") ?? 1,
    });
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(result);
    else printInfo(`${color.green("✓")} ${result.decision} → ${result.effect}  ${color.dim(shortId(result.id))}  ${result.reasonCode}`);
    return 0;
  } finally {
    await rt.close();
  }
}
