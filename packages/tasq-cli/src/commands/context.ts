import { buildContextPacket, canonicalJson, type Clock } from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { color, printInfo } from "../output/format.js";
import { openRuntime } from "../runtime.js";

/** Universal bounded state index; unlike `next`, this applies no life-planning profile. */
export async function contextCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    const packet = await buildContextPacket(rt.db, {
      workspaceId: rt.config.tenantId,
      actor: rt.ctx.actor,
      maxRecords: args.number("max-records"),
      maxTokens: args.number("max-tokens"),
      includeDeferred: args.bool("include-deferred"),
      clock,
    });
    if (args.bool("json", "j")) {
      // The packet's hard budget is measured over this exact canonical payload.
      process.stdout.write(`${canonicalJson(packet)}\n`);
      return 0;
    }
    printInfo(
      `${color.bold("Context")}  ${packet.selection.selectedRecords}/${packet.selection.eligibleRecords}` +
      ` records · ${packet.budget.usedTokens}/${packet.budget.maxTokens} portable tokens`,
    );
    for (const item of packet.items) {
      const reasons = item.reasonTrace.map((reason) => reason.code).join(", ");
      printInfo(`${color.dim(item.commitment.id.slice(0, 8))}  ${item.commitment.status.padEnd(11)}  ${item.commitment.title}`);
      printInfo(`          ${color.dim(reasons)}`);
    }
    if (packet.selection.selectedRecords === 0) printInfo(color.dim("(no eligible commitments fit)"));
    return 0;
  } finally {
    await rt.close();
  }
}
