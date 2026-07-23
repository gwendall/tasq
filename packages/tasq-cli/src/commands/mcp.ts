/** Self-hosted local MCP transport discovered through autonomous onboarding. */

import { BootstrapActorAlias, CoordinationSpaceId, systemClock, type Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { openRuntime } from "../runtime.js";

export async function mcpCmd(args: ParsedArgs, clock: Clock = systemClock): Promise<number> {
  if (args.positional.length > 0) throw new Error("Unexpected positional arguments for mcp");
  if (args.flag("json", "j") !== undefined) {
    throw new Error("--json is not accepted by mcp; stdout is reserved for MCP JSON-RPC frames");
  }
  const workspaceId = CoordinationSpaceId.parse(args.string("tenant"));
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
  const rt = await openRuntime(actor, workspaceId, clock, { installReferenceExtension: false });
  try {
    await serveTasqMcpStdio({
      db: rt.db,
      workspaceId,
      actor,
      capabilities,
      clock: rt.ctx.clock,
    });
    return 0;
  } finally {
    await rt.close();
  }
}
