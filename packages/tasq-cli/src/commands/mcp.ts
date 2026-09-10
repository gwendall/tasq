/** Self-hosted local MCP transport discovered through autonomous onboarding. */

import { BootstrapActorAlias, CoordinationSpaceId, systemClock, type Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { openRuntime } from "../runtime.js";

export async function mcpCmd(args: ParsedArgs, clock: Clock = systemClock, version?: string): Promise<number> {
  if (args.positional.length > 0) throw new Error("Unexpected positional arguments for mcp");
  if (args.flag("json", "j") !== undefined) {
    throw new Error("--json is not accepted by mcp; stdout is reserved for MCP JSON-RPC frames");
  }
  // Every other command that names a space takes `--space`; this one took
  // `--tenant` only, which the help text itself calls the rare override. Both
  // work now. A space is still required and never inferred from the working
  // directory: `autoDiscoveryFromCwd: false` in the agent contract is
  // deliberate, because a server that guesses its space guesses whose ledger
  // an agent is writing to.
  const workspaceId = CoordinationSpaceId.parse(args.string("space") ?? args.string("tenant"));
  const actor = BootstrapActorAlias.parse(args.string("actor"));
  // Keep the MCP SDK out of every ordinary one-shot CLI process. Cold shell
  // bootstrap must remain sub-second after warm-up.
  const { parseTasqMcpCapabilities, serveTasqMcpStdio } = await import("@tasq-run/mcp");
  const capabilities = parseTasqMcpCapabilities(
    args.string("capabilities") ?? "read,propose,coordinate",
  );
  if (capabilities.includes("effect")) {
    throw new Error("The generic stdio composition root cannot expose effect dispatch authority");
  }
  // The receipt guarantee the product advertises for agent integrations is
  // exactly this: work an agent proposes is closeable only against evidence.
  // `agent install` passes `--completion evidence`; a caller stating its own
  // policy per commitment always wins.
  const completionRaw = args.string("completion");
  if (completionRaw !== undefined && completionRaw !== "assertion" && completionRaw !== "evidence") {
    throw new Error(`Invalid value for --completion: "${completionRaw}". Allowed: assertion, evidence`);
  }
  const rt = await openRuntime(actor, workspaceId, clock, { installReferenceExtension: false });
  try {
    await serveTasqMcpStdio({
      db: rt.db,
      workspaceId,
      actor,
      capabilities,
      defaultCompletionPolicy: completionRaw as "assertion" | "evidence" | undefined,
      clock: rt.ctx.clock,
      version,
    });
    return 0;
  } finally {
    await rt.close();
  }
}
