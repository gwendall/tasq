/**
 * `tasq fleet` - who is holding what, right now.
 *
 * ADR-022 names this as the product: the kernel is why the answer can be
 * trusted, and this is the answer. The lease is what makes it possible without
 * owning a process - the row says whether anyone still owns the work, not
 * whether some process happens to be alive, and it heals itself.
 */

import { buildFleetView, type FleetHolder } from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { color, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function heading(holder: FleetHolder): string {
  const name = holder.client
    ? `${holder.client}${holder.clientVersion ? ` ${holder.clientVersion}` : ""}`
    : holder.actor;
  const where = holder.cwd ? ` ${color.dim("in")} ${holder.cwd}` : "";
  // Say plainly when the ledger only knows an alias, rather than dressing it up.
  const unknown = holder.client ? "" : color.dim("  (no client reported)");
  return `${color.bold(name)}${where}${unknown}`;
}

export async function fleetCmd(args: ParsedArgs): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const view = await buildFleetView(rt.db, rt.config.tenantId, rt.ctx.clock);
    if (args.flag("json", "j") !== undefined) {
      printJson(view);
      return 0;
    }
    if (view.holders.length === 0) {
      printInfo(color.dim("nothing is held right now"));
      printInfo(color.dim("a lease appears here the moment an agent claims work, and lapses on its own"));
      return 0;
    }
    for (const holder of view.holders) {
      printInfo(heading(holder));
      for (const held of holder.held) {
        // Under a minute left is the row a human might act on.
        const lease = held.leaseRemainingMs < 60_000
          ? color.yellow(`lease ${duration(held.leaseRemainingMs)} left`)
          : color.dim(`lease ${duration(held.leaseRemainingMs)} left`);
        printInfo(`  ${color.green("*")} ${held.title}`);
        printInfo(`    ${color.dim(shortId(held.commitmentId))}  ${lease}`
          + color.dim(`  heartbeat ${duration(held.sinceHeartbeatMs)} ago`));
      }
      printInfo("");
    }
    return 0;
  } finally {
    await rt.close();
  }
}
