/** Headless coordination and execution primitives for agents. */

import {
  ATTEMPT_STATUSES,
  acquireTaskClaim,
  addTaskEvidence,
  getActiveTaskClaim,
  getTaskAttempt,
  getTaskEvidence,
  listTaskAttempts,
  listTaskClaims,
  listTaskEvidence,
  releaseTaskClaim,
  startTaskAttempt,
  transitionTaskAttempt,
  type AttemptStatus,
  type Metadata,
} from "@tasq-internal/local-service";
import { enumArg, parseDateArg, positiveIntegerArg, type ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime, regenerateProjection } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { ATTEMPT_USAGE, CLAIM_USAGE, EVIDENCE_USAGE, RELEASE_USAGE } from "./usage.js";

function parseMetadata(raw: string | undefined): Metadata {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`--metadata must be valid JSON, got: ${raw}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("--metadata must be a JSON object");
  }
  return value as Metadata;
}

function parseDuration(raw: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
  if (!match) throw new Error(`Invalid duration: ${raw} (expected e.g. 30m, 2h, 1d)`);
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}

async function resolveRelatedId(
  raw: string,
  label: string,
  ids: string[],
): Promise<string | null> {
  const matches = ids.filter((id) => id === raw || id.startsWith(raw));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    printError(`ambiguous ${label} id prefix '${raw}':`);
    for (const id of matches) printError(`  ${id}`);
    return null;
  }
  printError(`${label} not found: ${raw}`);
  return null;
}

export async function claimCmd(args: ParsedArgs): Promise<number> {
  const [taskRaw] = args.positional;
  if (!taskRaw) {
    printError(CLAIM_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const taskId = await resolveTaskIdOrError(rt, taskRaw);
    if (!taskId) return 1;
    const until = args.string("until");
    const duration = args.string("for");
    if (until && duration) throw new Error("Cannot combine --until and --for");
    const leaseMs = until
      ? parseDateArg(until) - rt.ctx.clock.now()
      : duration
        ? parseDuration(duration)
        : undefined;
    const claim = await acquireTaskClaim(rt.db, taskId, {
      ...rt.ctx,
      idempotencyKey: args.string("idempotency-key"),
      leaseMs,
      metadata: parseMetadata(args.string("metadata")),
    });
    if (args.bool("json", "j")) printJson(claim);
    else {
      printInfo(
        `${color.green("✓")} claimed ${color.dim(shortId(taskId))} as ${claim.actor} until ${new Date(claim.expiresAt).toISOString()}`,
      );
    }
    return 0;
  } finally {
    await rt.close();
  }
}

export async function releaseCmd(args: ParsedArgs): Promise<number> {
  const [taskRaw] = args.positional;
  if (!taskRaw) {
    printError(RELEASE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const taskId = await resolveTaskIdOrError(rt, taskRaw);
    if (!taskId) return 1;
    const claim = await releaseTaskClaim(rt.db, taskId, {
      ...rt.ctx,
      reason: args.string("reason"),
      force: args.bool("force"),
    });
    if (args.bool("json", "j")) printJson(claim);
    else printInfo(`${color.green("✓")} released claim ${color.dim(shortId(claim.id))}`);
    return 0;
  } finally {
    await rt.close();
  }
}

const ATTEMPT_ALIASES: Record<string, AttemptStatus> = {
  succeed: "succeeded",
  fail: "failed",
  cancel: "cancelled",
  wait: "input_required",
  resume: "running",
};

export async function attemptCmd(args: ParsedArgs): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub) {
    printError(ATTEMPT_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "start") {
      if (!raw) throw new Error(ATTEMPT_USAGE);
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const attempt = await startTaskAttempt(rt.db, taskId, {
        ...rt.ctx,
        idempotencyKey: args.string("idempotency-key"),
        claimId: args.string("claim") ?? null,
        runtime: args.string("runtime") ?? "local",
        externalId: args.string("external-id") ?? null,
        contextId: args.string("context-id") ?? null,
        metadata: parseMetadata(args.string("metadata")),
        occurredAt: args.string("at") ? parseDateArg(args.string("at")!) : undefined,
      });
      if (args.bool("json", "j")) printJson(attempt);
      else printInfo(`${color.green("✓")} attempt started ${color.dim(shortId(attempt.id))}`);
      return 0;
    }

    if (sub === "list") {
      let taskId: string | null = null;
      if (raw) {
        taskId = await resolveTaskIdOrError(rt, raw);
        if (!taskId) return 1;
      }
      const attempts = await listTaskAttempts(rt.db, taskId, {
        tenantId: rt.config.tenantId,
        limit: args.number("limit") ?? 100,
      });
      if (args.bool("json", "j")) printJson(attempts);
      else for (const item of attempts) printInfo(`${color.dim(shortId(item.id))}  ${item.status.padEnd(14)} ${item.runtime}  task:${shortId(item.taskId)}  ${item.actor}`);
      return 0;
    }

    const attempts = await listTaskAttempts(rt.db, null, {
      tenantId: rt.config.tenantId,
      limit: 10_000,
    });
    if (!raw) throw new Error(ATTEMPT_USAGE);
    const id = await resolveRelatedId(raw, "attempt", attempts.map((attempt) => attempt.id));
    if (!id) return 1;
    if (sub === "show") {
      const attempt = await getTaskAttempt(rt.db, id, rt.config.tenantId);
      if (args.bool("json", "j")) printJson(attempt);
      else printInfo(JSON.stringify(attempt, null, 2));
      return 0;
    }

    const target = ATTEMPT_ALIASES[sub] ??
      (sub === "status"
        ? enumArg<AttemptStatus>(args.string("status"), ATTEMPT_STATUSES, "status")
        : undefined);
    if (!target) throw new Error(`Unknown attempt subcommand: ${sub}`);
    const attempt = await transitionTaskAttempt(rt.db, id, target, {
      ...rt.ctx,
      idempotencyKey: args.string("idempotency-key"),
      expectedRevision: positiveIntegerArg(args, "expected-revision"),
      message: args.string("message") ?? null,
      occurredAt: args.string("at") ? parseDateArg(args.string("at")!) : undefined,
    });
    if (args.bool("json", "j")) printJson(attempt);
    else printInfo(`${color.green("✓")} attempt ${color.dim(shortId(id))} → ${attempt.status}`);
    return 0;
  } finally {
    await rt.close();
  }
}

export async function evidenceCmd(args: ParsedArgs): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub) {
    printError(EVIDENCE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "add") {
      if (!raw) throw new Error(EVIDENCE_USAGE);
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const kind = args.string("kind");
      if (!kind) throw new Error("evidence add requires --kind");

      let attemptId: string | null = null;
      const attemptRaw = args.string("attempt");
      if (attemptRaw) {
        const attempts = await listTaskAttempts(rt.db, taskId, {
          tenantId: rt.config.tenantId,
          limit: 10_000,
        });
        attemptId = await resolveRelatedId(attemptRaw, "attempt", attempts.map((attempt) => attempt.id));
        if (!attemptId) return 1;
      }
      let supersedesEvidenceId: string | null = null;
      const supersedesRaw = args.string("supersedes");
      if (supersedesRaw) {
        const evidence = await listTaskEvidence(rt.db, taskId, { ...rt.ctx, limit: 10_000 });
        supersedesEvidenceId = await resolveRelatedId(supersedesRaw, "evidence", evidence.map((item) => item.id));
        if (!supersedesEvidenceId) return 1;
      }

      const item = await addTaskEvidence(
        rt.db,
        {
          taskId,
          attemptId,
          supersedesEvidenceId,
          kind,
          summary: args.string("summary") ?? null,
          uri: args.string("uri") ?? null,
          digest: args.string("digest") ?? null,
          source: args.string("source") ?? null,
          observedAt: args.string("observed-at") ? parseDateArg(args.string("observed-at")!) : undefined,
          metadata: parseMetadata(args.string("metadata")),
        },
        { ...rt.ctx, idempotencyKey: args.string("idempotency-key") },
      );
      if (args.bool("json", "j")) printJson(item);
      else printInfo(`${color.green("✓")} evidence added ${color.dim(shortId(item.id))}  ${item.kind}`);
      return 0;
    }

    if (sub === "list") {
      let taskId: string | null = null;
      if (raw) {
        taskId = await resolveTaskIdOrError(rt, raw);
        if (!taskId) return 1;
      }
      const evidence = await listTaskEvidence(rt.db, taskId, {
        ...rt.ctx,
        kind: args.string("kind"),
        limit: args.number("limit") ?? 100,
      });
      if (args.bool("json", "j")) printJson(evidence);
      else for (const item of evidence) printInfo(`${color.dim(shortId(item.id))}  ${item.kind.padEnd(14)} task:${shortId(item.taskId)}  ${item.summary ?? item.uri ?? ""}`);
      return 0;
    }

    if (sub === "show") {
      if (!raw) throw new Error(EVIDENCE_USAGE);
      const evidence = await listTaskEvidence(rt.db, null, { ...rt.ctx, limit: 10_000 });
      const id = await resolveRelatedId(raw, "evidence", evidence.map((item) => item.id));
      if (!id) return 1;
      const item = await getTaskEvidence(rt.db, id, rt.config.tenantId);
      if (args.bool("json", "j")) printJson(item);
      else printInfo(JSON.stringify(item, null, 2));
      return 0;
    }

    throw new Error(`Unknown evidence subcommand: ${sub}`);
  } finally {
    await rt.close();
  }
}
