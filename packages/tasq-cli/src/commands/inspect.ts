import { inspectCommitment, renderCommitmentInspection } from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { printError, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { INSPECT_USAGE } from "./usage.js";

/** Canonical, profile-neutral commitment graph inspection. */
export async function inspectCmd(args: ParsedArgs): Promise<number> {
  const idArg = args.positional[0];
  if (!idArg) {
    printError(INSPECT_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const id = await resolveTaskIdOrError(rt, idArg, "commitment");
    if (!id) return 1;
    const snapshot = await inspectCommitment(rt.db, id, {
      workspaceId: rt.config.tenantId,
      clock: rt.ctx.clock,
    });
    if (!snapshot) {
      printError(`commitment not found: ${idArg}`);
      return 1;
    }
    if (args.bool("json", "j")) printJson(snapshot);
    else process.stdout.write(renderCommitmentInspection(snapshot));
    return 0;
  } finally {
    await rt.close();
  }
}
