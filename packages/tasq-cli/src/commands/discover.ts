import {
  getDiscoverySchema,
  getTasqDiscovery,
  negotiateOnboarding,
} from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { printError, printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { DISCOVER_USAGE } from "./usage.js";

function parseHello(raw: string | undefined): unknown {
  if (raw === undefined) throw new Error("Missing value for --hello");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid JSON for --hello");
  }
}

export async function discoverCmd(args: ParsedArgs): Promise<number> {
  const subcommand = args.positional[0] ?? "show";
  if (!new Set(["show", "schema", "negotiate"]).has(subcommand)) {
    printError(DISCOVER_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    if (subcommand === "schema") {
      const resourceId = args.positional[1];
      if (!resourceId) {
        printError(DISCOVER_USAGE);
        return 1;
      }
      const resource = await getDiscoverySchema(rt.db, resourceId, {
        workspaceId: rt.config.tenantId,
      });
      if (!resource) {
        printError(`discovery schema not found: ${resourceId}`);
        return 1;
      }
      if (args.bool("json", "j")) printJson(resource);
      else printInfo(`${resource.typeUri}@${resource.schemaVersion}\n${resource.schemaDigest}\n${JSON.stringify(resource.schema, null, 2)}`);
      return 0;
    }

    const document = await getTasqDiscovery(rt.db, {
      workspaceId: rt.config.tenantId,
      transportBoundary: "local_process",
      capabilityProfile: "compatibility",
      clock: rt.ctx.clock,
    });
    if (subcommand === "negotiate") {
      const response = negotiateOnboarding(document, parseHello(args.string("hello")));
      if (args.bool("json", "j")) printJson(response);
      else printInfo(`${response.status}: protocol ${response.selectedProtocolVersion ?? "none"}; ${response.problems.length} problem(s)`);
      return response.status === "compatible" ? 0 : 1;
    }
    if (args.bool("json", "j")) printJson(document);
    else printInfo([
      `Tasq discovery ${document.contractVersion}`,
      `Workspace: ${document.workspaceId}`,
      `Compatibility: ${document.compatibilityDigest}`,
      `Capabilities: ${document.capabilities.length}`,
      `Extensions / types / evaluators: ${document.extensions.length} / ${document.extensions.flatMap((item) => item.types).length} / ${document.extensions.flatMap((item) => item.evaluators).length}`,
      `Expires at: ${document.expiresAt}`,
    ].join("\n"));
    return 0;
  } finally {
    await rt.close();
  }
}
