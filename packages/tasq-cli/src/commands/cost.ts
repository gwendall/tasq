/** `tasq cost` — task budgets and observed attempt-cost receipts. */

import {
  configureTaskCostBudget,
  getTaskCostSummary,
  listTaskAttempts,
  recordAttemptCost,
} from "@tasq-internal/local-service";
import { enumArg, parseDateArg, type ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { COST_USAGE } from "./usage.js";

function micros(args: ParsedArgs, flag: string, required = true): string | undefined {
  const value = args.string(flag);
  if (value === undefined && required) throw new Error(`cost requires --${flag}`);
  if (value !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new Error(`--${flag} must be an unsigned decimal micros string`);
  }
  return value;
}

async function resolveAttemptId(
  db: Parameters<typeof listTaskAttempts>[0],
  tenantId: string,
  raw: string,
): Promise<string | null> {
  const attempts = await listTaskAttempts(db, null, { tenantId, limit: 10_000 });
  const matches = attempts.filter((attempt) => attempt.id === raw || attempt.id.startsWith(raw));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    printError(`ambiguous attempt id prefix '${raw}'`);
    return null;
  }
  printError(`attempt not found: ${raw}`);
  return null;
}

export async function costCmd(args: ParsedArgs): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub || !raw) {
    printError(COST_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "budget") {
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const currency = args.string("currency");
      if (!currency) throw new Error("cost budget requires --currency");
      const task = await configureTaskCostBudget(rt.db, taskId, {
        contract: "tasq.task-cost-budget.v1",
        currency,
        maxGrossMicros: micros(args, "max-micros"),
        renewalReserveMicros: micros(args, "reserve-micros", false) ?? "0",
        metering: enumArg(args.string("metering"), ["required", "best_effort"] as const, "metering") ?? "required",
      }, rt.ctx);
      const summary = await getTaskCostSummary(rt.db, taskId, rt.ctx);
      if (args.bool("json", "j")) printJson({ task, summary });
      else printInfo(`${color.green("✓")} cost bound configured ${color.dim(shortId(taskId))}  ${currency} ${summary.budget?.maxGrossMicros}µ`);
      return 0;
    }
    if (sub === "show") {
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const summary = await getTaskCostSummary(rt.db, taskId, rt.ctx);
      if (args.bool("json", "j")) printJson(summary);
      else printInfo(JSON.stringify(summary, null, 2));
      return 0;
    }
    if (sub === "record") {
      const attemptId = await resolveAttemptId(rt.db, rt.config.tenantId, raw);
      if (!attemptId) return 1;
      const meterUri = args.string("meter");
      const observationId = args.string("observation");
      const currency = args.string("currency");
      const basis = enumArg(
        args.string("basis"),
        ["provider_receipt", "runtime_meter", "operator_attestation"] as const,
        "basis",
      );
      const idempotencyKey = args.string("idempotency-key");
      if (!meterUri || !observationId || !currency || !basis || !idempotencyKey) {
        throw new Error("cost record requires --meter, --observation, --currency, --gross-micros, --basis and --idempotency-key");
      }
      const result = await recordAttemptCost(rt.db, attemptId, {
        meterUri,
        observationId,
        currency,
        grossMicros: micros(args, "gross-micros"),
        observedAt: args.string("observed-at")
          ? parseDateArg(args.string("observed-at")!)
          : rt.ctx.clock.now(),
        basis,
      }, { ...rt.ctx, idempotencyKey });
      if (args.bool("json", "j")) printJson(result);
      else printInfo(`${color.green("✓")} cost observed ${currency} ${result.observation.grossMicros}µ  attempt:${color.dim(shortId(attemptId))}${result.claimReleased ? " · claim released at bound" : ""}`);
      return 0;
    }
    throw new Error(`Unknown cost subcommand: ${sub}`);
  } finally {
    await rt.close();
  }
}
