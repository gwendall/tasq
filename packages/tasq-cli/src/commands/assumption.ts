/**
 * `tasq wrong` / `tasq why` / `tasq resume` — ADR-021.
 *
 * The kernel noun is `assumption`. The words a user types are `because`,
 * `wrong` and `why`, because those are the words people already use when they
 * ask why work exists and say that a reason turned out false.
 */

import {
  attachAssumption,
  getTaskAssumptions,
  listAssumptions,
  resumeCommitment,
  withdrawAssumption,
} from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, printWarn, shortId } from "../output/format.js";
import { openRuntime, regenerateProjection } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";

function csv(raw: string | undefined): string[] {
  return raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
}

function stamp(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
}

/** `tasq wrong "<the assumption>" --reason "<what you learned>"` */
export async function wrongCmd(args: ParsedArgs): Promise<number> {
  const text = args.positional[0];
  const reason = args.string("reason");
  if (!text || !reason) {
    printError('usage: tasq wrong "<assumption>" --reason "<what you learned>" [--evidence <id,...>]');
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    let result;
    try {
      result = await withdrawAssumption(rt.db, {
        text,
        reason,
        evidenceIds: csv(args.string("evidence")),
      }, rt.ctx);
    } catch (error) {
      // Assumptions are matched by their text, so a near-miss phrasing fails
      // with nothing to act on. Show what this workspace actually believes.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("No standing assumption matches")) throw error;
      const standing = await listAssumptions(rt.db, rt.config.tenantId, { status: "standing" });
      if (standing.length === 0) {
        printError(`no assumption matches "${text}", and this workspace has none recorded`);
        return 1;
      }
      printError(`no assumption matches "${text}". Currently standing:`);
      for (const row of standing) {
        printError(`  "${row.text}"  ${row.activeTaskIds.length} task(s)`);
      }
      printError("withdraw one by its exact text, or run `tasq because list`");
      return 1;
    }
    await regenerateProjection(rt);

    if (args.flag("json", "j") !== undefined) {
      printJson({ contractVersion: "tasq.assumption-withdrawn.v1", ...result });
      return 0;
    }
    if (result.replayed) {
      printWarn(`already withdrawn: "${result.assumption.text}"`);
    } else {
      printInfo(`${color.green("✓")} withdrawn: "${result.assumption.text}"`);
    }
    if (result.pausedTaskIds.length === 0) {
      printInfo(color.dim("  no open work was resting on it"));
      return 0;
    }
    printInfo(`  ${result.pausedTaskIds.length} task(s) were resting on this:`);
    for (const id of result.pausedTaskIds) {
      printInfo(`    ${color.dim(shortId(id))}  ${color.yellow("paused")}`);
    }
    printInfo(color.dim("  nothing was cancelled. `tasq why <id>` to read the chain,"
      + " `tasq resume <id> --reason <text>` to continue anyway."));
    return 0;
  } finally {
    await rt.close();
  }
}

/** `tasq why <id>` — the whole chain in one screen. */
export async function whyCmd(args: ParsedArgs): Promise<number> {
  const raw = args.positional[0];
  if (!raw) {
    printError("usage: tasq why <task-id>");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const taskId = await resolveTaskIdOrError(rt, raw);
    if (!taskId) return 1;
    const state = await getTaskAssumptions(rt.db, taskId, rt.config.tenantId);

    if (args.flag("json", "j") !== undefined) {
      printJson(state);
      return 0;
    }
    if (state.assumptions.length === 0) {
      printInfo(color.dim(`no recorded assumption for ${shortId(taskId)}`));
      printInfo(color.dim("attach one with `tasq add ... --because \"<why this work exists>\"`"));
      return 0;
    }
    const who = (id: string | null): string => (id ? state.principals[id] ?? id : "unknown");
    printInfo(`${shortId(taskId)}  ${state.paused ? color.yellow("paused: assumption withdrawn") : color.green("actionable")}`);
    for (const { assumption, link } of state.assumptions) {
      const live = link.status === "active" && assumption.status === "standing";
      const marker = live ? color.green("●") : color.dim("○");
      printInfo(`\n ${marker} because  "${assumption.text}"`);
      printInfo(`            stated by ${who(assumption.statedByPrincipalId)} on ${stamp(assumption.statedAt)}`);
      if (assumption.status === "withdrawn") {
        const evidence = assumption.withdrawalEvidenceIds.length > 0
          ? `  (${assumption.withdrawalEvidenceIds.map(shortId).join(", ")})`
          : "";
        printInfo(color.red(`            withdrawn by ${who(assumption.withdrawnByPrincipalId)} on ${stamp(assumption.withdrawnAt)}`));
        printInfo(`            ${assumption.withdrawalReason}${evidence}`);
      }
      if (link.status === "unlinked") {
        printInfo(color.dim(`            unlinked on ${stamp(link.unlinkedAt)}: ${link.unlinkReason}`));
      }
    }
    if (state.paused) {
      printInfo(color.dim(`\n  \`tasq resume ${shortId(taskId)} --reason <text>\` to continue anyway`));
    }
    return 0;
  } finally {
    await rt.close();
  }
}

/** `tasq resume <id> --reason <text>` — the recovery path from a withdrawal. */
export async function resumeCmd(args: ParsedArgs): Promise<number> {
  const raw = args.positional[0];
  const reason = args.string("reason");
  if (!raw || !reason) {
    printError("usage: tasq resume <task-id> --reason \"<why this work still stands>\"");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const taskId = await resolveTaskIdOrError(rt, raw);
    if (!taskId) return 1;
    const result = await resumeCommitment(rt.db, { taskId, reason }, rt.ctx);
    await regenerateProjection(rt);
    if (args.flag("json", "j") !== undefined) {
      printJson({ contractVersion: "tasq.commitment-resumed.v1", ...result });
      return 0;
    }
    printInfo(`${color.green("✓")} ${shortId(taskId)} resumed, `
      + `${result.unlinked.length} withdrawn assumption(s) unlinked`);
    return 0;
  } finally {
    await rt.close();
  }
}

/** `tasq because list|attach` — what this workspace believes, and binding one. */
export async function becauseCmd(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0] ?? "list";
  if (sub !== "list" && sub !== "attach") {
    printError('usage: tasq because list [--status standing|withdrawn]\n'
      + '       tasq because attach <task-id> "<why this work exists>"');
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (sub === "attach") {
      const raw = args.positional[1];
      const text = args.positional[2];
      if (!raw || !text) {
        printError('usage: tasq because attach <task-id> "<why this work exists>"');
        return 1;
      }
      const taskId = await resolveTaskIdOrError(rt, raw);
      if (!taskId) return 1;
      const result = await attachAssumption(rt.db, { taskId, text }, rt.ctx);
      if (args.flag("json", "j") !== undefined) {
        printJson({ contractVersion: "tasq.assumption-attached.v1", ...result });
        return 0;
      }
      printInfo(`${color.green("✓")} ${shortId(taskId)} because "${result.assumption.text}"`);
      return 0;
    }
    const status = args.string("status") as "standing" | "withdrawn" | undefined;
    if (status && status !== "standing" && status !== "withdrawn") {
      printError("--status must be standing or withdrawn");
      return 1;
    }
    const rows = await listAssumptions(rt.db, rt.config.tenantId, status ? { status } : {});
    if (args.flag("json", "j") !== undefined) {
      printJson({ contractVersion: "tasq.assumption-list.v1", assumptions: rows });
      return 0;
    }
    if (rows.length === 0) {
      printInfo(color.dim("no assumptions recorded"));
      return 0;
    }
    for (const row of rows) {
      const marker = row.status === "standing" ? color.green("●") : color.dim("○");
      const resting = row.activeTaskIds.length;
      printInfo(`${marker} "${row.text}"  ${color.dim(`${resting} task(s)`)}`);
      if (row.status === "withdrawn") {
        printInfo(color.dim(`   withdrawn ${stamp(row.withdrawnAt)}: ${row.withdrawalReason}`));
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}
