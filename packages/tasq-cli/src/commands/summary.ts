import {
  appendCommitmentSummary,
  getCommitmentSummary,
  listCommitmentSummaries,
  listCurrentCommitmentSummaries,
  type Clock,
} from "@tasq-internal/local-service";
import { COMMITMENT_SUMMARY_PAGE_CONTRACT_VERSION } from "@tasq/schema";
import type { ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { SUMMARY_USAGE } from "./usage.js";

export async function summaryCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const action = args.positional[0];
  if (!action || !["add", "list", "current", "show"].includes(action)) {
    printError(SUMMARY_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    if (action === "show") {
      const id = args.positional[1];
      if (!id) { printError(SUMMARY_USAGE); return 1; }
      const item = await getCommitmentSummary(rt.db, id, rt.config.tenantId);
      if (!item) { printError(`summary not found: ${id}`); return 1; }
      if (args.bool("json", "j")) printJson(item);
      else printInfo(`${color.bold(item.state)} ${item.summary}\n${color.dim(item.id)}`);
      return 0;
    }

    if (action === "current") {
      const items = await listCurrentCommitmentSummaries(rt.db, {
        workspaceId: rt.config.tenantId,
        limit: args.number("limit"),
      });
      if (args.bool("json", "j")) printJson({
        contractVersion: COMMITMENT_SUMMARY_PAGE_CONTRACT_VERSION,
        items,
        selection: {
          mode: "current_only",
          excludes: ["stale", "superseded"],
          emptyDoesNotProveNoHistory: true,
          historyRecipeId: "summary.list",
        },
      });
      else if (items.length === 0) printInfo(color.dim(
        "(no current summaries; use summary list <commitment-id> for stale/history)",
      ));
      else for (const item of items) {
        printInfo(`${color.dim(shortId(item.commitmentId))}  ${item.summary}`);
      }
      return 0;
    }
    const commitmentArg = args.positional[1];
    if (!commitmentArg) { printError(SUMMARY_USAGE); return 1; }
    const commitmentId = await resolveTaskIdOrError(rt, commitmentArg, "commitment");
    if (!commitmentId) return 1;
    if (action === "list") {
      const items = await listCommitmentSummaries(rt.db, {
        workspaceId: rt.config.tenantId,
        commitmentId,
        limit: args.number("limit"),
      });
      if (args.bool("json", "j")) printJson({
        contractVersion: COMMITMENT_SUMMARY_PAGE_CONTRACT_VERSION, items,
      });
      else if (items.length === 0) printInfo(color.dim("(no summaries)"));
      else for (const item of items) {
        printInfo(`${color.dim(shortId(item.id))}  ${item.state.padEnd(10)}  ${item.summary}`);
      }
      return 0;
    }

    const summary = args.string("text");
    const idempotencyKey = args.string("idempotency-key");
    if (!summary || !idempotencyKey) { printError(SUMMARY_USAGE); return 1; }
    const item = await appendCommitmentSummary(rt.db, {
      workspaceId: rt.config.tenantId,
      commitmentId,
      summary,
      expectedPreviousSummaryId: args.string("supersedes") ?? null,
    }, {
      actor: rt.ctx.actor,
      principalId: rt.ctx.principalId,
      idempotencyKey,
      clock,
    });
    if (args.bool("json", "j")) printJson(item);
    else printInfo(`${color.green("summary appended")} ${color.dim(item.id)}`);
    return 0;
  } finally {
    await rt.close();
  }
}
