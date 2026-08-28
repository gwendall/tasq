/**
 * `tasq contention` — what the ledger refused.
 *
 * Everything else in this CLI reports work that happened. This reports work
 * that was PREVENTED, which is the only thing a shared ledger does that a
 * shared folder does not, and which left no trace at all until now.
 */

import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { color, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { contentionSummary, listContention } from "@tasq-internal/local-service";

const WINDOWS: Record<string, number> = {
  h: 3_600_000, d: 86_400_000, w: 604_800_000,
};

/** `--since 7d`, `--since 24h`. Absent means everything ever refused. */
function windowStart(raw: string | undefined, now: number): number {
  if (!raw) return 0;
  const match = /^(\d+)([hdw])$/.exec(raw.trim());
  if (!match) throw new Error("--since takes a window like 24h, 7d or 2w");
  return now - Number(match[1]) * WINDOWS[match[2]!]!;
}

function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const READS: Record<string, string> = {
  claim_held_by_another: "tried to take work someone else was holding",
  claim_blocked_by_unresolved: "tried to take work whose blockers are not resolved",
  complete_not_holder: "tried to close work someone else was holding",
  complete_without_evidence: "tried to close work without the receipt it requires",
};

export async function contentionCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  if (args.positional.length > 0) throw new Error("contention accepts flags only");
  const json = args.flag("json", "j") !== undefined;
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    const now = clock.now();
    const since = windowStart(args.string("since"), now);
    const tenantId = rt.config.tenantId;
    const [rows, summary] = await Promise.all([
      listContention(rt.db, tenantId, since),
      contentionSummary(rt.db, tenantId, since),
    ]);
    // The stored label wins. A refused caller's principal row does not exist -
    // the only place it would have been created is the transaction that rolled
    // back - so a lookup returns the raw urn for exactly the people this
    // command is about.
    const label = (stored: string, id: string) => stored || (id ? shortId(id) : "nobody");

    if (json) {
      printJson({
        contractVersion: "tasq.contention.v1",
        ...summary,
        situations: rows.map((row) => ({
          ...row,
          requestedBy: label(row.requestedByLabel, row.requestedByPrincipalId),
          holder: row.holderPrincipalId ? label(row.holderLabel, row.holderPrincipalId) : null,
        })),
      });
      return 0;
    }

    if (rows.length === 0) {
      printInfo(color.dim(
        args.string("since")
          ? `Nothing was refused in the last ${args.string("since")}.`
          : "Nothing has ever been refused in this space.",
      ));
      // Said plainly, because an empty result here is a real answer: either
      // nobody is sharing this ledger, or nobody has collided yet.
      printInfo(color.dim("  Either nothing is shared here yet, or nothing has collided."));
      return 0;
    }

    printInfo(
      `${color.bold(String(summary.attempts))} refusal(s) across `
      + `${summary.situations} standoff(s) on ${summary.commitments} commitment(s).`,
    );
    printInfo("");
    for (const row of rows) {
      const repeated = row.attempts > 1 ? color.yellow(`  ×${row.attempts}`) : "";
      printInfo(
        `  ${color.bold(label(row.requestedByLabel, row.requestedByPrincipalId))} `
        + `${READS[row.kind] ?? row.kind}${repeated}`,
      );
      printInfo(color.dim(
        `    ${shortId(row.commitmentId)}`
        + (row.holderPrincipalId ? `  held by ${label(row.holderLabel, row.holderPrincipalId)}` : "")
        + `  ${ago(row.lastAt, now)}`,
      ));
    }
    return 0;
  } finally {
    await rt.close();
  }
}
