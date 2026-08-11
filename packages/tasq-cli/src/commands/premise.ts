/** `tasq premise` — inspect and independently refute motivating premises. */

import {
  challengeTaskPremise,
  decideTaskPremise,
  getTaskPremiseState,
  proposeTaskPremise,
} from "@tasq-internal/local-service";
import { enumArg, type ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { PREMISE_USAGE } from "./usage.js";

function csv(raw: string | undefined, label: string): string[] {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (values.length === 0) throw new Error(`--${label} requires at least one id`);
  return values;
}

export async function premiseCmd(args: ParsedArgs): Promise<number> {
  const [sub, raw] = args.positional;
  if (!sub || !raw) {
    printError(PREMISE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const taskId = await resolveTaskIdOrError(rt, raw);
    if (!taskId) return 1;
    if (sub === "show") {
      const state = await getTaskPremiseState(rt.db, taskId, rt.config.tenantId);
      if (!state) throw new Error(`Task has no motivating premise: ${taskId}`);
      if (args.bool("json", "j")) printJson(state);
      else printInfo(`${state.actionable ? color.green("actionable") : color.red("invalidated")} premise ${color.dim(shortId(state.premise.id))}\n${state.premise.value.proposition}`);
      return 0;
    }
    const idempotencyKey = args.string("idempotency-key");
    if (!idempotencyKey) throw new Error(`premise ${sub} requires --idempotency-key`);
    if (sub === "propose") {
      const verdict = enumArg(args.string("verdict"), ["uphold", "refute"] as const, "verdict");
      const rationale = args.string("reason");
      if (!verdict || !rationale) throw new Error(PREMISE_USAGE);
      const result = await proposeTaskPremise(rt.db, taskId, {
        verdict, evidenceIds: csv(args.string("evidence"), "evidence"), rationale,
      }, { ...rt.ctx, idempotencyKey });
      if (args.bool("json", "j")) printJson(result);
      else printInfo(`${color.green("✓")} premise ${verdict} proposed ${color.dim(shortId(result.id))}`);
      return 0;
    }
    if (sub === "challenge") {
      const proposalId = args.string("proposal");
      const rationale = args.string("reason");
      if (!proposalId || !rationale) throw new Error(PREMISE_USAGE);
      const result = await challengeTaskPremise(rt.db, taskId, {
        proposalId, counterEvidenceIds: csv(args.string("counter-evidence"), "counter-evidence"), rationale,
      }, { ...rt.ctx, idempotencyKey });
      if (args.bool("json", "j")) printJson(result);
      else printInfo(`${color.green("✓")} premise challenged ${color.dim(shortId(result.id))}`);
      return 0;
    }
    if (sub === "decide") {
      const proposalId = args.string("proposal");
      const outcome = enumArg(args.string("outcome"), ["accepted", "rejected", "challenged", "indeterminate"] as const, "outcome");
      const rationale = args.string("reason");
      if (!proposalId || !outcome || !rationale) throw new Error(PREMISE_USAGE);
      const result = await decideTaskPremise(rt.db, taskId, { proposalId, outcome, rationale }, {
        ...rt.ctx, idempotencyKey,
      });
      if (args.bool("json", "j")) printJson(result);
      else printInfo(`${color.green("✓")} premise decision ${outcome} ${color.dim(shortId(result.id))}`);
      return 0;
    }
    throw new Error(`Unknown premise subcommand: ${sub}`);
  } finally {
    await rt.close();
  }
}
